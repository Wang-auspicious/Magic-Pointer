"""Coding tool surface for the agent loop (CC/Codex contract port).

The real-machine audit found the loop had 22 tools, ALL desktop/perception —
zero file/shell/code tools, so the harness could not fix a bug in any repo.
This module ports the mature contracts: CC's Read/Edit (exact-unique-match),
Codex's workspace confinement, Hermes' bounded shell output.

Effects follow the existing permission ladder: reads are free, file writes
are reversible_write (allowed in default), shell is local_irreversible
(needs full-access/bypass — same shape as Codex sandbox modes).
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["WorkspaceSpace", "FileCheckpointStore", "register_coding_tools"]

_MAX_READ_CHARS = 50_000
_MAX_READ_LINES = 2_000
_MAX_OUTPUT_CHARS = 64_000
_MAX_GREP_RESULTS = 200
_MAX_GLOB_RESULTS = 500
_DEFAULT_COMMAND_TIMEOUT_S = 60.0
_MAX_COMMAND_TIMEOUT_S = 600.0


class WorkspaceSpace:
    """Path confinement: every tool path must stay inside the workspace."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def resolve(self, raw: object) -> Path:
        value = str(raw or "").strip()
        if not value:
            raise ValueError("path is required")
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise ValueError(
                f"path escapes the workspace ({self.root}): {value}"
            )
        return resolved

    def display(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.root)).replace(os.sep, "/")
        except ValueError:
            return str(path)


def _text(result_value: Any) -> str:
    inner = getattr(result_value, "value", None)
    return "" if inner is None else str(inner)


def _numbered(path: Path, offset: int, limit: int) -> str:
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()
    total = len(lines)
    start = max(1, int(offset or 1))
    end = min(total, start + max(1, int(limit or _MAX_READ_LINES)) - 1)
    picked = lines[start - 1 : end]
    body = "\n".join(f"{index + start}\t{line}" for index, line in enumerate(picked))
    note = ""
    if start > 1 or end < total:
        note = f"\n[showing lines {start}-{end} of {total}]"
    if len(body) > _MAX_READ_CHARS:
        body = body[:_MAX_READ_CHARS] + "\n[truncated]"
    return f"{path.name}\n{body}{note}"


def _do_grep(root: Path, pattern: str, glob_filter: str, max_results: int) -> str:
    regex = re.compile(pattern, re.IGNORECASE)
    hits: list[str] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            name
            for name in dirnames
            if name
            not in {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}
        ]
        for filename in filenames:
            if glob_filter and not fnmatch.fnmatch(filename, glob_filter):
                continue
            full = Path(dirpath) / filename
            try:
                if full.stat().st_size > 2_000_000:
                    continue
                lines = full.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for number, line in enumerate(lines, 1):
                if regex.search(line):
                    if len(hits) >= max_results:
                        truncated = True
                        break
                    hits.append(f"{_display(root, full)}:{number}: {line.strip()[:200]}")
            if truncated:
                break
        if truncated:
            break
    if not hits:
        return f"no matches for {pattern!r}"
    suffix = f"\n[results truncated at {max_results}]" if truncated else ""
    return "\n".join(hits) + suffix


def _display(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace(os.sep, "/")
    except ValueError:
        return str(path)


_CATASTROPHIC_COMMANDS = (
    re.compile(r"rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+/(?:\s|$)"),
    re.compile(r"rm\s+-[a-z]*r[a-z]*\s+/(?:\s|$)"),
    re.compile(r"Remove-Item\b[^\n]*-Recurse[^\n]*\s+[A-Za-z]:\\\s*(?:$|['\"|;])"),
    re.compile(r"\bformat\s+[A-Za-z]:", re.IGNORECASE),
    re.compile(r"\bdiskpart\b", re.IGNORECASE),
    re.compile(r"\b(shutdown|Restart-Computer|Stop-Computer)\b", re.IGNORECASE),
    re.compile(r"\bcipher\s+/w\b", re.IGNORECASE),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s+if=", re.IGNORECASE),
)
"""Catastrophic, never-legitimate-dev-work commands (handoff §A2 minimal
blacklist). Everything else goes through the permission ladder unchanged."""


class FileCheckpointStore:
    """Before-images of every file our tools touch (CC /rewind contract).

    Backups live under ``<workspace>/.mp/backups``: one content file per
    mutation plus a JSONL manifest. ``restore`` rewinds the last N mutations
    so an agent that went down the wrong path is one call from clean.
    """

    def __init__(self, root: Path) -> None:
        self.dir = Path(root).resolve() / ".mp" / "backups"
        self.manifest = self.dir / "manifest.jsonl"
        self._seq = 0

    def record(self, path: Path, *, existed: bool) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        self._seq += 1
        entry = {
            "seq": self._seq,
            "path": str(path),
            "existed": existed,
            "ts": time.time(),
        }
        if existed and path.is_file():
            backup = self.dir / f"{self._seq:06d}.bak"
            backup.write_bytes(path.read_bytes())
            entry["backup"] = backup.name
        with self.manifest.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def restore(self, steps: int = 0) -> str:
        """Undo the last ``steps`` mutations (0 = every recorded one)."""
        if not self.manifest.is_file():
            return "no file edits recorded to restore"
        entries: list[dict[str, Any]] = []
        for line in self.manifest.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                entries.append(json.loads(line))
        pending = entries[-steps:] if steps > 0 else entries
        if not pending:
            return "nothing to restore"
        restored: list[str] = []
        for entry in reversed(pending):  # undo newest-first
            target = Path(str(entry["path"]))
            backup = entry.get("backup")
            if backup:
                source = self.dir / str(backup)
                if source.is_file():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
                    restored.append(f"reverted {target.name}")
            elif entry.get("existed") is False and target.exists():
                target.unlink()
                restored.append(f"removed {target.name} (was created by the agent)")
        remaining = entries[: len(entries) - len(pending)]
        with self.manifest.open("w", encoding="utf-8") as handle:
            for entry in remaining:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        return "restored: " + "; ".join(restored) if restored else "nothing changed on disk"


def register_coding_tools(
    registry: ToolRegistry,
    *,
    workspace_root: Path | str,
) -> None:
    """Register the file/shell tool set, confined to ``workspace_root``."""
    space = WorkspaceSpace(Path(workspace_root))
    checkpoints = FileCheckpointStore(space.root)

    def read_file(path: str, offset: int = 1, limit: int = _MAX_READ_LINES, **_: Any) -> str:
        target = space.resolve(path)
        if not target.is_file():
            raise FileNotFoundError(f"not found: {space.display(target)}")
        return _numbered(target, int(offset or 1), int(limit or _MAX_READ_LINES))

    def write_file(path: str, content: str, **_: Any) -> str:
        target = space.resolve(path)
        checkpoints.record(target, existed=target.exists())
        target.parent.mkdir(parents=True, exist_ok=True)
        text = str(content or "")
        target.write_text(text, encoding="utf-8", newline="\n")
        return f"wrote {len(text.encode('utf-8'))} bytes to {space.display(target)}"

    def edit_file(
        path: str,
        old_string: str,
        new_string: str,
        replace_all: bool = False,
        **_: Any,
    ) -> str:
        target = space.resolve(path)
        if not target.is_file():
            raise FileNotFoundError(f"not found: {space.display(target)}")
        raw = target.read_text(encoding="utf-8")
        old = str(old_string or "")
        new = str(new_string or "")
        if not old:
            raise ValueError("old_string is required")
        count = raw.count(old)
        if count == 0:
            raise ValueError(
                f"old_string not found in {space.display(target)}; "
                "read the file again and copy the exact text"
            )
        if count > 1 and not replace_all:
            raise ValueError(
                f"old_string matches {count} times in {space.display(target)}; "
                "it must be unique (add surrounding context) or pass replace_all"
            )
        checkpoints.record(target, existed=True)
        updated = raw.replace(old, new) if replace_all else raw.replace(old, new, 1)
        target.write_text(updated, encoding="utf-8", newline="")
        return f"edited {space.display(target)} ({count} replacement(s))"

    def apply_patch(patch: str, **_: Any) -> str:
        from app.agent_runtime.apply_patch import ApplyPatchError, apply_patch_text, parse_patch

        text = str(patch or "")
        if not text.strip():
            raise ValueError("patch is required")
        try:
            for hunk in parse_patch(text):
                if hunk.kind == "delete":
                    checkpoints.record(space.resolve(hunk.path), existed=True)
                    continue
                target = space.resolve(hunk.path)
                checkpoints.record(target, existed=target.exists())
                if hunk.kind == "update" and hunk.move_path:
                    checkpoints.record(space.resolve(hunk.move_path), existed=False)
            return apply_patch_text(text, space.root)
        except ApplyPatchError as exc:
            raise ValueError(f"apply_patch failed: {exc}") from exc

    def restore_files(steps: int = 0, **_: Any) -> str:
        try:
            bounded = max(0, int(steps or 0))
        except (TypeError, ValueError):
            bounded = 0
        return checkpoints.restore(bounded)

    def glob(pattern: str, **_: Any) -> str:
        pattern = str(pattern or "").strip()
        if not pattern:
            raise ValueError("pattern is required")
        matches: list[str] = []
        for dirpath, dirnames, filenames in os.walk(space.root):
            dirnames[:] = [
                name
                for name in dirnames
                if name not in {".git", "__pycache__", "node_modules", ".venv", "venv"}
            ]
            for filename in filenames:
                full = Path(dirpath) / filename
                rel = _display(space.root, full)
                if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(filename, pattern):
                    matches.append(rel)
                    if len(matches) >= _MAX_GLOB_RESULTS:
                        return "\n".join(matches) + f"\n[truncated at {_MAX_GLOB_RESULTS}]"
        return "\n".join(matches) if matches else f"no files match {pattern!r}"

    def grep(
        pattern: str,
        glob_filter: str = "",
        max_results: int = _MAX_GREP_RESULTS,
        **_: Any,
    ) -> str:
        return _do_grep(
            space.root,
            str(pattern or ""),
            str(glob_filter or ""),
            max(1, min(int(max_results or _MAX_GREP_RESULTS), _MAX_GREP_RESULTS)),
        )

    def run_command(
        command: str,
        cwd: str = ".",
        timeout_s: float = _DEFAULT_COMMAND_TIMEOUT_S,
        **_: Any,
    ) -> str:
        text = str(command or "").strip()
        if not text:
            raise ValueError("command is required")
        workdir = space.resolve(cwd or ".")
        if not workdir.is_dir():
            raise NotADirectoryError(f"cwd not found: {space.display(workdir)}")
        for rule in _CATASTROPHIC_COMMANDS:
            if rule.search(text):
                raise ValueError(
                    "command rejected by the catastrophic-command guard: "
                    + text[:120]
                )
        bounded = max(1.0, min(float(timeout_s or _DEFAULT_COMMAND_TIMEOUT_S), _MAX_COMMAND_TIMEOUT_S))
        try:
            completed = subprocess.run(
                text,
                shell=True,
                cwd=str(workdir),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=bounded,
            )
        except subprocess.TimeoutExpired:
            raise TimeoutError(f"command timed out after {bounded:.0f}s: {text[:120]}")
        out = (completed.stdout or "")[-_MAX_OUTPUT_CHARS:]
        err = (completed.stderr or "")[-8000:]
        header = f"exit={completed.returncode}"
        parts = [header]
        if out.strip():
            parts.append(f"stdout:\n{out}")
        if err.strip():
            parts.append(f"stderr:\n{err}")
        return "\n".join(parts)

    registry.register(ToolSpec(
        name="read_file",
        description=(
            "读取工作区内一个文本文件，带行号。大文件用 offset/limit 分页读，"
            "不要一次读整个大文件。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "起始行，从 1 开始"},
                "limit": {"type": "integer", "description": "最多读多少行"},
            },
            "required": ["path"],
        },
        execute=read_file,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="workspace_fs",
        timeout_ms=10_000,
    ))
    registry.register(ToolSpec(
        name="write_file",
        description=(
            "在工作区内创建或整体覆盖一个文本文件。修改现有文件优先用 "
            "edit_file（精确替换），整体重写才用这个。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
        execute=write_file,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=10_000,
    ))
    registry.register(ToolSpec(
        name="edit_file",
        description=(
            "精确字符串替换修改文件：old_string 必须与文件内容逐字符唯一匹配，"
            "否则报错。多处相同时传 replace_all=true 或加长 old_string。"
            "修改前先 read_file 拿到准确文本。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
            },
            "required": ["path", "old_string", "new_string"],
        },
        execute=edit_file,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=10_000,
    ))
    registry.register(ToolSpec(
        name="glob",
        description="按通配模式（如 **/*.py）列出工作区内匹配的文件路径。",
        input_schema={
            "type": "object",
            "properties": {"pattern": {"type": "string"}},
            "required": ["pattern"],
        },
        execute=glob,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="workspace_fs",
        timeout_ms=10_000,
    ))
    registry.register(ToolSpec(
        name="grep",
        description=(
            "在工作区文件内容里做正则搜索，返回 file:line: text 匹配列表。"
            "找代码、找报错文本、找定义都用它。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "glob_filter": {"type": "string", "description": "如 *.py，可选"},
                "max_results": {"type": "integer"},
            },
            "required": ["pattern"],
        },
        execute=grep,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="workspace_fs",
        timeout_ms=30_000,
    ))
    registry.register(ToolSpec(
        name="run_command",
        description=(
            "在工作区内执行一条 shell 命令（跑测试、构建、git 等），返回 "
            "exit code 与有界输出。属于不可逆本地操作：需要 full-access 权限。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "cwd": {"type": "string", "description": "相对工作区，默认 ."},
                "timeout_s": {"type": "number"},
            },
            "required": ["command"],
        },
        execute=run_command,
        effect=Effect.LOCAL_IRREVERSIBLE,
        is_concurrency_safe=False,
        used_backend="shell",
        timeout_ms=620_000,
    ))
    registry.register(ToolSpec(
        name="apply_patch",
        description=(
            "用 Codex apply_patch 格式一次修改多个文件（Add/Delete/Update + "
            "@@ 上下文 + -/+ 行）。比多次 edit_file 更适合跨文件改动；"
            "补丁里的上下文行必须与文件内容逐字匹配。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "patch": {
                    "type": "string",
                    "description": (
                        "以 *** Begin Patch 开头、*** End Patch 结尾的完整补丁文本"
                    ),
                },
            },
            "required": ["patch"],
        },
        execute=apply_patch,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=30_000,
    ))
    registry.register(ToolSpec(
        name="restore_files",
        description=(
            "把本会话内被 write_file/edit_file/apply_patch 改过的文件回滚到"
            "改动前状态。steps=N 只撤销最近 N 次改动，默认全部撤销。"
            "走错方向时用它回到干净状态，不要手工反向编辑。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "steps": {"type": "integer", "description": "撤销最近 N 次改动，0=全部"},
            },
            "required": [],
        },
        execute=restore_files,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=30_000,
    ))
