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

import difflib
import fnmatch
import hashlib
import json
import os
import re
import shutil
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
_DEFAULT_COMMAND_TIMEOUT_S = 300.0
"""CC Bash 默认 30 分钟、Hermes 前台语义"配长超时但快完成秒回"；MP 给 5 分钟
默认值，长命令仍可用 timeout_s 顶到 600。"""
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


def _numbered(path: Path, offset: int, limit: int) -> tuple[str, bool]:
    """返回 (渲染文本, 是否截断)。截断 = 模型没看到完整范围（帽截断或越界）。"""
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.splitlines()
    total = len(lines)
    start = max(1, int(offset or 1))
    end = min(total, start + max(1, int(limit or _MAX_READ_LINES)) - 1)
    picked = lines[start - 1 : end]
    body = "\n".join(f"{index + start}\t{line}" for index, line in enumerate(picked))
    truncated = False
    if start > total:
        truncated = True
    if len(body) > _MAX_READ_CHARS:
        body = body[:_MAX_READ_CHARS] + (
            f"\n[Read output truncated at {_MAX_READ_CHARS} chars: "
            "re-read with a smaller limit or use offset to page through the file]"
        )
        truncated = True
    note = ""
    if start > 1 or end < total:
        note = f"\n[showing lines {start}-{end} of {total}]"
    return f"{path.name}\n{body}{note}", truncated


def _credential_mask(rel: str, text: str) -> str:
    """凭据文件（.env/secrets/key）命中只报位置，不回显内容（Hermes 同款）。"""
    lowered = rel.casefold()
    if (
        ".env" in lowered
        or "secret" in lowered
        or lowered.endswith((".pem", ".key"))
    ):
        return "[redacted]"
    return text


def _rg_search(
    space: "WorkspaceSpace",
    base: Path,
    pattern: str,
    glob_filter: str,
    max_results: int,
    context: int,
    offset: int,
    rg_path: str,
    case_sensitive: bool,
    output_mode: str,
) -> str | None:
    """ripgrep --json 主路；进程失败返回 None 让调用方退回纯 Python。"""
    args = [rg_path, "--json", "--no-messages"]
    if not case_sensitive:
        args.append("-i")
    if context and output_mode == "content":
        args.append(f"-C{context}")
    if glob_filter:
        args.extend(["--glob", glob_filter])
    args.extend(["-e", pattern, str(base)])
    try:
        completed = subprocess.run(
            args, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode not in (0, 1):
        return None  # 2 = 出错；让 Python 兜底给一个确定可用的行为
    entries: list[tuple[bool, str, int, str]] = []
    root_text = str(space.root)
    for line in (completed.stdout or "").splitlines():
        if not line.strip() or not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind not in ("match", "context"):
            continue
        data = event.get("data") or {}
        path_text = str(((data.get("path") or {}).get("text")) or "")
        line_number = int(data.get("line_number") or 0)
        body = str(((data.get("lines") or {}).get("text")) or "").rstrip("\r\n")
        rel = _display(space.root, Path(path_text)) if path_text.startswith(root_text) else path_text
        entries.append((kind == "match", rel, line_number, body))
    return _render_search(entries, pattern, max_results, offset, output_mode)


def _py_search(
    space: "WorkspaceSpace",
    base: Path,
    pattern: str,
    glob_filter: str,
    max_results: int,
    context: int,
    offset: int,
    case_sensitive: bool,
    output_mode: str,
) -> str:
    """纯 Python 兜底（无 ripgrep 的机器）：与 rg 路同一种输出形状。"""
    try:
        regex = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
    except re.error as exc:
        raise ValueError(f"invalid pattern: {exc}") from exc
    files: list[Path] = (
        [base] if base.is_file() else sorted(_walk_files(base, glob_filter))
    )
    entries: list[tuple[bool, str, int, str]] = []
    truncated = False
    for full in files:
        rel = _display(space.root, full)
        try:
            if full.stat().st_size > 2_000_000:
                continue
            lines = full.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        hits = [number for number, line in enumerate(lines, 1) if regex.search(line)]
        if not hits:
            continue
        wanted: set[int] = set()
        for number in hits:
            if context and output_mode == "content":
                wanted.update(range(max(1, number - context), number + context + 1))
            else:
                wanted.add(number)
        for number in sorted(wanted):
            if number > len(lines):
                continue
            entries.append((number in hits, rel, number, lines[number - 1]))
    return _render_search(entries, pattern, max_results, offset, output_mode)


def _render_search(
    entries: list[tuple[bool, str, int, str]],
    pattern: str,
    max_results: int,
    offset: int,
    output_mode: str,
) -> str:
    """Render both search backends with one deterministic paging contract."""
    ordered = sorted(
        set(entries),
        key=lambda entry: (entry[1], entry[2], not entry[0], entry[3]),
    )
    matches = [entry for entry in ordered if entry[0]]
    if not matches:
        return f"no matches for {pattern!r}"

    if output_mode == "files_with_matches":
        files = sorted({entry[1] for entry in matches})
        selected = files[offset:offset + max_results]
        if not selected:
            return (
                f"page exhausted for {pattern!r}: "
                f"offset={offset}, total={len(files)} files"
            )
        truncated = len(files) > offset + max_results
        suffix = (
            f"\n[files truncated at {max_results} after offset {offset}]"
            if truncated
            else ""
        )
        return "\n".join(selected) + suffix

    if output_mode == "count":
        counts: dict[str, int] = {}
        for _, rel, _, _ in matches:
            counts[rel] = counts.get(rel, 0) + 1
        items = sorted(counts.items())
        selected = items[offset:offset + max_results]
        if not selected:
            return (
                f"page exhausted for {pattern!r}: "
                f"offset={offset}, total={len(items)} files"
            )
        truncated = len(items) > offset + max_results
        suffix = (
            f"\n[files truncated at {max_results} after offset {offset}]"
            if truncated
            else ""
        )
        return "\n".join(f"{rel}: {count}" for rel, count in selected) + suffix

    selected_entries = ordered[offset:offset + max_results]
    if not selected_entries:
        return (
            f"page exhausted for {pattern!r}: "
            f"offset={offset}, total={len(ordered)} results"
        )
    rows = []
    for is_match, rel, number, body in selected_entries:
        body = _credential_mask(rel, body.strip()[:200])
        rows.append(f"{rel}:{number}: {body}" if is_match else f"{rel}-{number}- {body}")
    truncated = len(ordered) > offset + max_results
    suffix = (
        f"\n[results truncated at {max_results} after offset {offset}]"
        if truncated
        else ""
    )
    return "\n".join(rows) + suffix


def _walk_files(root: Path, glob_filter: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            name
            for name in dirnames
            if name not in {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}
        ]
        for filename in filenames:
            if glob_filter and not fnmatch.fnmatch(filename, glob_filter):
                continue
            yield Path(dirpath) / filename


def _do_search(
    space: "WorkspaceSpace",
    base: Path,
    pattern: str,
    glob_filter: str,
    max_results: int,
    context: int = 0,
    offset: int = 0,
    case_sensitive: bool = False,
    output_mode: str = "content",
) -> str:
    rg_path = shutil.which("rg")
    if rg_path:
        result = _rg_search(
            space,
            base,
            pattern,
            glob_filter,
            max_results,
            context,
            offset,
            rg_path,
            case_sensitive,
            output_mode,
        )
        if result is not None:
            return result
    return _py_search(
        space,
        base,
        pattern,
        glob_filter,
        max_results,
        context,
        offset,
        case_sensitive,
        output_mode,
    )


def _do_grep(root: Path, pattern: str, glob_filter: str, max_results: int) -> str:
    """search_history 的旧入口：工作区根全文搜索（无上下文、无 offset）。"""
    fake_space = WorkspaceSpace(root)
    return _do_search(fake_space, root, pattern, glob_filter, max_results)


def _display(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root)).replace(os.sep, "/")
    except ValueError:
        return str(path)


def _detect_newline(path: Path) -> str:
    """The file's own newline convention, so edits don't rewrite CRLF→LF.

    read_text default-translates (CRLF→LF) and write_text with newline=""
    preserves whatever it was given — so the old edit_file turned a one-line
    change to a Windows repo into a whole-file diff. Detect once and reuse.
    """
    try:
        with path.open("rb") as handle:
            chunk = handle.read(65536)
    except OSError:
        return "\n"
    if b"\r\n" in chunk:
        return "\r\n"
    if b"\r" in chunk:
        return "\r"
    return "\n"


_QUOTE_TABLE = str.maketrans({
    "\u201c": '"', "\u201d": '"',  # “ ”
    "\u2018": "'", "\u2019": "'",  # ‘ ’
    "\u201a": "'", "\u201b": "'",  # ‚ ‛
    "\u201e": '"', "\u201f": '"',  # „ ‟
})


def _quote_normalized(text: str) -> str:
    return text.translate(_QUOTE_TABLE)


def _normalized_quote_matches(raw: str, needle: str) -> list[str]:
    """文件里所有归一化引号后等于 needle 的**真实**子串（保留原字符）。

    精确匹配失败后的第二级匹配（对齐 CC FileEditTool/utils.ts）：模型常把
    文件里的直引号吐成弯引号。命中时替换的是文件里的原字符，所以替换后
    原有引号风格不丢。
    """
    normalized_needle = _quote_normalized(needle)
    normalized_chars: list[str] = []
    index_map: list[int] = []
    for index, char in enumerate(raw):
        normalized_chars.append(_quote_normalized(char))
        index_map.append(index)
    normalized_raw = "".join(normalized_chars)
    if normalized_needle not in normalized_raw:
        return []
    matches: list[str] = []
    start = normalized_raw.find(normalized_needle)
    while start != -1:
        end = start + len(normalized_needle)
        matches.append(raw[index_map[start]:index_map[end - 1] + 1])
        start = normalized_raw.find(normalized_needle, start + 1)
    return matches


# 退出码 1 自有语义的命令族（对齐 CC commandSemantics.ts）：退出码 1 表示
# "没找到/有差异/条件为假"，不是执行错误。
_EXIT_ONE_SEMANTIC_COMMANDS = frozenset({
    "grep", "egrep", "fgrep", "rg", "find", "diff", "cmp", "test", "[",
})


def _exit_code_semantics(command: str, returncode: int) -> str | None:
    if returncode != 1:
        return None
    first = str(command or "").strip()
    for token in first.split():
        if "=" in token and token.split("=", 1)[0].isidentifier():
            continue  # 跳过 FOO=bar 前缀
        if token.casefold() in _EXIT_ONE_SEMANTIC_COMMANDS:
            return (
                "exit 1 means no matches / differences / condition false — "
                "not an execution error"
            )
        break
    return None


# ---------------------------------------------------------------------------
# 读状态（readFileState，CC FileReadTool/FileEditTool 契约）
#
# 工具按"本轮"重注册，闭包级状态活不过一轮——而未读先写门、读去重、连读
# 熔断都要求跨轮记忆。状态按 workspace 根放模块级（进程寿命），与
# FileCheckpointStore 的跨进程 seq 同一个理由。
# ---------------------------------------------------------------------------

_READ_LOOP_WARN_AT = 3
"""同一区间连读到第 N 次在结果里加警告（Hermes 是 3 警 4 断；MP 的硬断
放宽到 6，因为 MP 没有它那套 dispatcher 级重置，只靠工具执行信号）。"""
_READ_LOOP_BLOCK_AT = 6
_READ_FINGERPRINT_CAP = 4_000_000
"""超过这个字节数不做 sha 摘要（只比 mtime/size；大文件 hash 每次编辑
都付一遍不值）。"""


class _FileReadState:
    """一个 workspace 的读状态：条目 + 连读守卫。"""

    def __init__(self) -> None:
        self.entries: dict[str, dict[str, Any]] = {}
        self.last_key: str | None = None
        self.last_count: int = 0


_READ_STATES: dict[str, _FileReadState] = {}


def _read_state_for(root: Path) -> _FileReadState:
    key = str(root)
    store = _READ_STATES.get(key)
    if store is None:
        store = _READ_STATES[key] = _FileReadState()
    # 有界： workspace 切换累积的旧条目按插入序淘汰。
    if len(_READ_STATES) > 8:
        for stale in list(_READ_STATES)[:-8]:
            _READ_STATES.pop(stale, None)
    return store


def _file_fingerprint(path: Path) -> tuple[int, int, str | None]:
    data = path.read_bytes()
    digest = (
        None
        if len(data) > _READ_FINGERPRINT_CAP
        else hashlib.sha256(data).hexdigest()[:16]
    )
    return path.stat().st_mtime_ns, len(data), digest


def _state_mark_read(
    store: _FileReadState,
    path: Path,
    *,
    offset: int,
    limit: int,
    truncated: bool,
) -> None:
    try:
        mtime_ns, size, digest = _file_fingerprint(path)
    except OSError:
        return
    store.entries[str(path)] = {
        "mtime_ns": mtime_ns,
        "size": size,
        "sha": digest,
        "offset": offset,
        "limit": limit,
        "truncated": truncated,
    }
    if len(store.entries) > 512:
        for stale in list(store.entries)[:-512]:
            store.entries.pop(stale, None)


def _state_mark_written(store: _FileReadState, path: Path) -> None:
    """写/编辑成功 = 模型对结果内容有完整最新认知（CC：Edit/Write 存全量视图）。"""
    _state_mark_read(store, path, offset=1, limit=_MAX_READ_LINES, truncated=False)


def _state_freshness(store: _FileReadState, path: Path) -> str:
    """'fresh' | 'not-read' | 'truncated' | 'modified' | 'gone'。"""
    entry = store.entries.get(str(path))
    if entry is None:
        return "not-read"
    if entry.get("truncated"):
        return "truncated"
    try:
        mtime_ns, size, digest = _file_fingerprint(path)
    except OSError:
        return "gone"
    if mtime_ns == entry["mtime_ns"] and size == entry["size"]:
        return "fresh"
    if (
        digest is not None
        and entry.get("sha") is not None
        and digest == entry["sha"]
    ):
        # mtime 被云同步/杀软拨动但内容逐字节未变（CC content fallback）。
        return "fresh"
    return "modified"


def _gate_message(reason: str, display: str) -> str:
    if reason == "not-read":
        return (
            f"File has not been read yet: {display}. Call Read first — "
            "editing a file you have not read is a blind edit."
        )
    if reason == "truncated":
        return (
            f"Your earlier read of {display} was truncated. Re-read the "
            "region you intend to change (Read with offset/limit) "
            "before editing."
        )
    if reason == "gone":
        return f"File no longer exists: {display}."
    return (
        f"File has been modified since read (by the user, a linter or "
        f"another process): {display}. Read it again before editing."
    )


# --- 连读守卫 ----------------------------------------------------------------


def _read_guard_bump(store: _FileReadState, key: str) -> int:
    if store.last_key == key:
        store.last_count += 1
    else:
        store.last_key = key
        store.last_count = 1
    return store.last_count


def _read_guard_reset(store: _FileReadState) -> None:
    store.last_key = None
    store.last_count = 0


# --- 相似文件 / 设备 / 二进制守卫 ------------------------------------------------

_WINDOWS_DEVICE_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)

_OFFICE_IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
}
_OFFICE_DOC_EXTENSIONS = {
    ".docx", ".xlsx", ".pptx", ".pdf", ".zip", ".7z", ".rar", ".exe", ".dll",
    ".sqlite", ".db", ".mp3", ".mp4", ".wav", ".woff", ".woff2",
}


def _similar_file_hint(space: "WorkspaceSpace", target: Path) -> str:
    """ENOENT 时给一个"是不是拼错了"的建议（CC findSimilarFile）。"""
    parent = target.parent if target.parent.is_dir() else space.root
    try:
        siblings = [p.name for p in parent.iterdir() if p.is_file()]
    except OSError:
        siblings = []
    close = difflib.get_close_matches(target.name, siblings, n=1, cutoff=0.6)
    if close:
        return f"Did you mean {space.display(parent / close[0])}?"
    direct = space.root / target.name
    if direct.is_file() and direct != target:
        return f"A file with this name exists at {space.display(direct)}."
    return ""


def _device_guard(target: Path) -> None:
    """会挂死/产生无限输出的设备名（路径判断，无 I/O；CC BLOCKED_DEVICE_PATHS）。"""
    text = str(target)
    if "\\\\.\\" in text or "\\\\" in text[:7]:
        raise ValueError(f"cannot read a Windows device path: {text}")
    if os.name == "nt" and target.stem.upper() in _WINDOWS_DEVICE_NAMES:
        raise ValueError(
            f"cannot read {target.stem.upper()}: it is a Windows device name, "
            "not a file"
        )


def _binary_guard(target: Path) -> None:
    """诚实拒绝：read_file 渲染不了的东西就直说用什么替代。"""
    ext = target.suffix.casefold()
    if ext in _OFFICE_IMAGE_EXTENSIONS:
        raise ValueError(
            f"{target.name} is an image; Read renders text only. "
            "Use Look (vision) on the frozen frame, or view it in the UI."
        )
    if ext in _OFFICE_DOC_EXTENSIONS:
        raise ValueError(
            f"{target.name} is a binary document ({ext}); Read cannot "
            "render it. Extract its text with a script, e.g. Bash: "
            f"python -c \"...\" (zipfile/html2text for docx/xlsx), or ask "
            "the user to export it."
        )
    try:
        with target.open("rb") as handle:
            chunk = handle.read(8192)
    except OSError:
        return
    if b"\x00" in chunk:
        raise ValueError(
            f"{target.name} looks binary (NUL byte in the first 8KB); "
            "Read renders text only. Inspect it with Bash "
            "(strings/hexdump) instead."
        )


# --- 行级模糊匹配阶梯（Hermes 策略 2/3/4 的行锚定变体）---------------------------


def _line_spans(raw: str) -> list[tuple[int, int, int]]:
    """每行 (body_start, body_end, line_end)；line_end 含换行符。"""
    spans: list[tuple[int, int, int]] = []
    start = 0
    for line in raw.splitlines(keepends=True):
        newline_len = len(line) - len(line.rstrip("\r\n"))
        spans.append((start, start + len(line) - newline_len, start + len(line)))
        start += len(line)
    return spans


def _normalize_line_trimmed(line: str) -> str:
    return line.rstrip()


def _normalize_whitespace(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def _normalize_indent_flexible(line: str) -> str:
    return line.strip()


_LINE_STRATEGIES: tuple[tuple[str, Any], ...] = (
    ("line-trimmed", _normalize_line_trimmed),
    ("whitespace-normalized", _normalize_whitespace),
    ("indent-flexible", _normalize_indent_flexible),
)


def _line_strategy_spans(
    raw: str, needle: str, normalizer: Any
) -> list[tuple[int, int, int]]:
    """行锚定匹配：返回每个命中的 (body_start, body_end, line_end) 三元组。

    body_end 不含换行；line_end 含换行（删除整行时用）。替换时保首行缩进
    与末行尾随空白——行策略比较的是剥掉空白后的内容，真实子串替换保证
    文件里其余空白原样不动。
    """
    spans = _line_spans(raw)
    raw_lines_norm = [normalizer(raw[s:e]) for (s, e, _e) in spans]
    needle_lines = needle.split("\n")
    trailing_newline = needle.endswith("\n")
    if trailing_newline:
        needle_lines = needle_lines[:-1]
    needle_norm = [normalizer(line) for line in needle_lines]
    n = len(needle_norm)
    if n == 0 or n > len(spans):
        return []
    hits: list[tuple[int, int, int]] = []
    index = 0
    while index + n <= len(spans):
        if raw_lines_norm[index:index + n] == needle_norm:
            first = spans[index]
            last = spans[index + n - 1]
            hits.append((first[0], last[1] if not trailing_newline else last[2], last[2]))
            index += n
        else:
            index += 1
    return hits


def _all_spans(raw: str, needle: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    start = raw.find(needle)
    while start != -1:
        spans.append((start, start + len(needle)))
        start = raw.find(needle, start + 1)
    return spans


def _spans_of_parts(raw: str, parts: list[str]) -> list[tuple[int, int]]:
    """按出现顺序把每个真实子串定位回原文 span（顺序 find）。"""
    spans: list[tuple[int, int]] = []
    position = 0
    for part in parts:
        index = raw.find(part, position)
        if index == -1:
            index = raw.find(part)
            if index == -1:
                continue
        spans.append((index, index + len(part)))
        position = index + len(part)
    return spans


def _locate_matches(
    raw: str, old: str, new: str, replace_all: bool
) -> tuple[list[tuple[int, int, int]] | None, str]:
    """匹配阶梯：exact → 删行扩展 → 弯引号归一化 → 三级行策略。

    返回 (spans, strategy)；spans 是三元组 (body_start, body_end, line_end)，
    未命中返回 (None, "")。行策略在 new 为空时直接给 line_end（删整行）。
    """
    # CC applyEditToFile：删行语义——new 为空且 old 不带尾换行时，优先把
    # 连同换行符一起删（否则留下空行）。这条检查先于普通精确匹配。
    if new == "" and not old.endswith("\n") and raw.count(old + "\n"):
        return [(s, e, e) for (s, e) in _all_spans(raw, old + "\n")], "exact"
    if raw.count(old):
        return [(s, e, e) for (s, e) in _all_spans(raw, old)], "exact"
    quote_actuals = _normalized_quote_matches(raw, old)
    if quote_actuals:
        spans = _spans_of_parts(raw, quote_actuals)
        return [(s, e, e) for (s, e) in spans], "quote-normalized"
    for name, normalizer in _LINE_STRATEGIES:
        triples = _line_strategy_spans(raw, old, normalizer)
        if triples:
            resolved = [
                (s, e if new != "" else line_end, line_end)
                for (s, e, line_end) in triples
            ]
            return resolved, name
    return None, ""


def _plan_edits(
    raw: str, edit_list: list[dict[str, Any]], display: str
) -> tuple[list[tuple[int, int, str]], str]:
    """把每条 edit 定位成原文 span + 替换文本，做唯一性与重叠校验。

    全部编辑对**原文**匹配（Pi edit-diff 契约），倒序应用由调用方完成。
    返回 (planned spans, 策略备注)；有任何错误直接 raise ValueError。
    """
    planned: list[tuple[int, int, str, int]] = []
    note = ""
    for entry in edit_list:
        old, new = entry["old"], entry["new"]
        all_flag, idx = entry["all"], entry["index"]
        label = f"edits[{idx}]: " if idx is not None else ""
        if old == new:
            continue  # 批量里的 no-op 直接跳过；整体无变化在最后兜住
        spans, strategy = _locate_matches(raw, old, new, all_flag)
        if spans is None:
            raise ValueError(
                f"{label}old_string not found in {display} "
                "(tried exact, quote-normalized, line-trimmed, "
                "whitespace-normalized, indent-flexible matching); "
                "read the file again and copy the exact text"
            )
        if len(spans) > 1 and not all_flag:
            raise ValueError(
                f"{label}old_string matches {len(spans)} times in {display} "
                f"(after {strategy} matching); it must be unique (add "
                "surrounding context) or pass replace_all"
            )
        if strategy != "exact" and note == "":
            note = f"matched after {strategy} matching"
        if not all_flag:
            spans = spans[:1]
        quote_template: str | None = None
        if strategy == "quote-normalized":
            for s, e, _e in spans:
                actual = raw[s:e]
                if any(c in actual for c in "\u201c\u201d\u2018\u2019"):
                    quote_template = actual
                    break
        for owner, (s, e, _le) in zip(
            [idx if idx is not None else 0] * len(spans), spans
        ):
            if strategy == "exact":
                replacement = new
            elif strategy == "quote-normalized":
                replacement = (
                    _preserve_quote_style(quote_template, new)
                    if quote_template
                    else new
                )
            else:
                replacement = _preserve_outer_whitespace(raw[s:e], new)
            planned.append((s, e, replacement, owner))
    if not planned:
        raise ValueError(f"edit produces no changes to {display}")
    ordered = sorted(planned, key=lambda item: item[0])
    for left, right in zip(ordered, ordered[1:]):
        if right[0] < left[1]:
            raise ValueError(
                f"edits overlap in {display} (edit[{left[3]}] and "
                f"edit[{right[3]}]); merge them into one edit or target "
                "disjoint regions"
            )
    return [(s, e, rep) for (s, e, rep, _owner) in planned], note



def _preserve_outer_whitespace(actual: str, replacement: str) -> str:
    """首行缩进与末行尾随空白跟随文件真实行（new_string 提供内容本身）。"""
    if not actual or not replacement:
        return replacement
    first_nl = actual.find("\n")
    first_line = actual if first_nl == -1 else actual[:first_nl]
    leading = first_line[: len(first_line) - len(first_line.lstrip())]
    last_nl = actual.rfind("\n")
    last_line = actual if last_nl == -1 else actual[last_nl + 1:]
    trailing = last_line[len(last_line.rstrip()):]
    if replacement.endswith("\n"):
        replacement = replacement[:-1]
        suffix = trailing + "\n"
    else:
        suffix = trailing
    return leading + replacement + suffix


def _preserve_quote_style(actual_old: str, new_string: str) -> str:
    """文件用弯引号而模型发直引号时，new_string 的引号跟随文件风格
    （CC FileEditTool preserveQuoteStyle：开/闭启发 + 缩写词撇号）。"""
    has_double = "\u201c" in actual_old or "\u201d" in actual_old
    has_single = "\u2018" in actual_old or "\u2019" in actual_old
    if not has_double and not has_single:
        return new_string

    def opening(chars: list[str], index: int) -> bool:
        if index == 0:
            return True
        prev = chars[index - 1]
        # CJK 标点后跟随的引号是开引号（他说：“…”）；CC 的 ASCII 启发式
        # （空格/括号/破折号）不覆盖中文标点，中文文案文件是 MP 主场景。
        if prev in "：，。、；！？（《「『【〈…":
            return True
        return prev in " \t\n\r([{—–\u2014\u2013"

    chars = list(new_string)
    result: list[str] = []
    for index, char in enumerate(chars):
        if char == '"' and has_double:
            result.append("\u201c" if opening(chars, index) else "\u201d")
        elif char == "'" and has_single:
            prev = chars[index - 1] if index > 0 else ""
            nxt = chars[index + 1] if index + 1 < len(chars) else ""
            if prev.isalpha() and nxt.isalpha():
                result.append("\u2019")  # don't / it's 的撇号
            else:
                result.append("\u2018" if opening(chars, index) else "\u2019")
        else:
            result.append(char)
    return "".join(result)


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


# Read-only shell-command allowlist (Codex sandboxMode:read-only + CC Bash
# readonly subset). Anything not on this list falls back to the static
# LOCAL_IRREVERSIBLE declaration (default-closed), so a missed entry costs
# a confirmation prompt, never silent data loss.
_READ_ONLY_COMMANDS = frozenset({
    "ls", "dir", "pwd", "echo", "cat", "type", "head", "tail",
    "wc", "find", "tree", "date", "whoami", "hostname", "env",
    "printenv", "set", "get-childitem", "get-location", "get-content",
    "get-date", "get-item", "test-path", "select-object", "where-object",
    "rg", "which", "where",
})
_GIT_READ_SUBCOMMANDS = frozenset({
    "status", "log", "diff", "show", "branch", "tag", "blame", "remote",
    "rev-parse", "describe", "ls-files", "config",  # config 读；写形式带参数罕见，链式/写配置回落 IRREVERSIBLE 由链式守卫兜
})
"""Allowlist of commands with no observable mutation effect (Codex
sandboxMode=readOnly + CC Bash readonly subset). Comparison is lowercase
(Linux + Windows PowerShell). First whitespace-separated token must hit
this set; anything chained (| / ; / && / || / $( / backtick) falls back to
LOCAL_IRREVERSIBLE because the static check cannot prove the right-hand
side is also benign."""

_CHAIN_OPERATORS = re.compile(r"[|&;]|&&|\|\||`|\$\(")


def _classify_command_effect(arguments: dict) -> "Effect":
    """``run_command`` 的动态 effect_for:把纯只读 shell 当作 READ,其余按静态声明。

    Codex 把任何不可证明为只读的命令当作 sandbox=workspace-write 不可触发的
    操作;CC Bash 走 readonly 子集允许列目录/读文件。这两条折在一起就是:
    命令首 token 在 ``_READ_ONLY_COMMANDS`` 白名单、且不含 shell 链式操作符,
    才返回 ``Effect.READ``。其余一律回落 ``LOCAL_IRREVERSIBLE``,让权限链
    用默认值拦住,而不是把误判当放行凭据。
    """
    from app.agent_runtime.tool_registry import Effect

    command = str((arguments or {}).get("command") or "").strip()
    if not command:
        return Effect.LOCAL_IRREVERSIBLE
    if _CHAIN_OPERATORS.search(command):
        return Effect.LOCAL_IRREVERSIBLE
    tokens = command.split()
    first = tokens[0].lower()
    if first == "git" and len(tokens) > 1 and tokens[1].lower() in _GIT_READ_SUBCOMMANDS:
        return Effect.READ
    if first in _READ_ONLY_COMMANDS:
        return Effect.READ
    return Effect.LOCAL_IRREVERSIBLE


class _ShellSession:
    """会话内 shell 状态：cwd 跨调用保持（CC Shell.ts 的 `pwd -P` 回读）。

    按 workspace 根共享（进程寿命，与读状态同一理由——工具按轮重注册，
    闭包状态活不过一轮；而 `cd` 的意义正是跨轮保持）。子代理与父会话
    共享同一 workspace 的 shell 状态：可见、可 cd 回来，无隐藏隔离。
    """

    def __init__(self) -> None:
        self.cwd: Path | None = None  # None = workspace 根


_SHELL_SESSIONS: dict[str, _ShellSession] = {}

_CWD_MARKER = "@@MP_CWD"
_CD_SPLIT = re.compile(r"&&|\|\||[&;|\n]")


def _resolve_cd_target(
    command: str, start: Path, space: "WorkspaceSpace"
) -> Path | None:
    """词法跟踪命令里的 `cd` 段，返回最终 cwd（没有 cd 段返回 None）。

    cmd 的 `%CD%` 在整条命令解析时就展开，echo-marker 方案测不到 `cd` 的
    效果；改为把命令按 `&&`/`&`/`;`/`|`/换行切段，逐段解析 `cd [-d] 目标`，
    相对目标按累计 cwd 解析。pushd/for-do 内的 cd 不识别——漏跟只损失
    一次持久化，不会改错目录。
    """
    current: Path | None = None
    for segment in _CD_SPLIT.split(str(command or "")):
        tokens = segment.strip().split()
        if not tokens:
            continue
        if tokens[0].casefold() != "cd":
            continue
        args = [t for t in tokens[1:] if t.casefold() != "/d"]
        if not args:
            continue  # `cd` 无参 = 打印当前目录，不改变
        raw_target = args[-1].strip('"')
        try:
            base = current or start
            candidate = Path(raw_target)
            resolved = (
                candidate
                if candidate.is_absolute()
                else Path(os.path.abspath(Path(base) / candidate))
            )
            resolved = space.resolve(resolved)
            if resolved.is_dir():
                current = resolved
        except (ValueError, OSError):
            continue
    return current


def _shell_session_for(root: Path) -> _ShellSession:
    key = str(root)
    session = _SHELL_SESSIONS.get(key)
    if session is None:
        session = _SHELL_SESSIONS[key] = _ShellSession()
    if len(_SHELL_SESSIONS) > 8:
        for stale in list(_SHELL_SESSIONS)[:-8]:
            _SHELL_SESSIONS.pop(stale, None)
    return session


class BackgroundJobs:
    """Detached child processes owned by one coding-tools registration."""

    def __init__(self, root: Path, notify: Callable[[str], None] | None = None) -> None:
        self.dir = Path(root) / ".mp" / "background"
        self._seq = 0
        self._notify = notify

    def start(self, command: str, cwd: Path) -> int:
        self.dir.mkdir(parents=True, exist_ok=True)
        self._seq += 1
        job_id = int(time.time()) % 100000 * 100 + self._seq
        log_path = self.dir / f"{job_id}.log"
        meta_path = self.dir / f"{job_id}.json"
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                command,
                shell=True,
                cwd=str(cwd),
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
        meta_path.write_text(json.dumps({
            "id": job_id,
            "pid": process.pid,
            "log": str(log_path),
            "command": command[:500],
            "started": time.time(),
        }, ensure_ascii=False), encoding="utf-8")

        def watch() -> None:
            """Hermes notify_on_complete：结束时记录 exit code 并推一次消息。

            推送走 durable inbox（target=next-step），活跃 loop 下一模型轮
            即携带；loop 已结束则随会话留到下一次运行，不丢。
            """
            try:
                code = process.wait()
            except Exception:  # noqa: BLE001 - watcher 死了不连累工具
                return
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                meta["exit"] = code
                meta["finished"] = time.time()
                meta_path.write_text(
                    json.dumps(meta, ensure_ascii=False), encoding="utf-8"
                )
            except (OSError, ValueError):
                pass
            if self._notify is not None:
                try:
                    self._notify(
                        f"background job {job_id} finished (exit={code}); "
                        f"poll BashRead(id={job_id}) for its output"
                    )
                except Exception:  # noqa: BLE001
                    pass

        import threading

        threading.Thread(target=watch, daemon=True).start()
        return job_id

    def status(self, job_id: int) -> str:
        try:
            meta = json.loads((self.dir / f"{job_id}.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return f"background job {job_id} not found"
        tail = ""
        try:
            tail = Path(str(meta["log"])).read_text(encoding="utf-8", errors="replace")[-8000:]
        except OSError:
            pass
        alive = _pid_alive(int(meta.get("pid") or 0))
        state = "RUNNING" if alive else "FINISHED"
        if not alive and meta.get("exit") is not None:
            state = f"FINISHED (exit={meta['exit']})"
        header = f"job {job_id}: {state} — {str(meta.get('command'))[:120]}"
        return f"{header}\n{tail or '(no output yet)'}"


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class FileCheckpointStore:
    """Before-images of every file our tools touch (CC /rewind contract).

    Backups live under ``<workspace>/.mp/backups``: one content file per
    mutation plus a JSONL manifest. ``restore`` rewinds the last N mutations
    so an agent that went down the wrong path is one call from clean.
    """

    def __init__(self, root: Path) -> None:
        self.dir = Path(root).resolve() / ".mp" / "backups"
        self.manifest = self.dir / "manifest.jsonl"
        # seq must continue across processes, not from 0 every boot. The
        # manifest is append-only and the backups are per-seq files (000001.bak,
        # ...); restarting _seq at 0 on the next run overwrote earlier backups
        # while the manifest still pointed at them, so /rewind restored content
        # from the wrong file. Start past every seq already recorded.
        self._seq = self._max_recorded_seq()

    def _max_recorded_seq(self) -> int:
        if not self.manifest.is_file():
            return 0
        largest = 0
        try:
            for line in self.manifest.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    seq = int(json.loads(line).get("seq", 0))
                except (ValueError, TypeError):
                    continue
                largest = max(largest, seq)
        except OSError:
            return 0
        return largest

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
    inbox: Callable[[str], None] | None = None,
) -> None:
    """``inbox``：后台 job 完成时推一条 durable 消息（Hermes
    notify_on_complete 契约）。桥接线在 builtin_bundle 的 coding-tools 行。"""
    """Register the file/shell tool set, confined to ``workspace_root``."""
    space = WorkspaceSpace(Path(workspace_root))
    checkpoints = FileCheckpointStore(space.root)
    read_store = _read_state_for(space.root)
    try:
        registry.add_execution_listener(
            lambda name: None if name == "Read" else _read_guard_reset(read_store)
        )
    except Exception:  # noqa: BLE001 - 监听只是提示信号，注册失败不拦工具面
        pass

    def read_file(
        path: str, offset: int = 1, limit: int = _MAX_READ_LINES, force: bool = False,
        **_: Any,
    ) -> str:
        target = space.resolve(path)
        _device_guard(target)
        if not target.is_file():
            raise FileNotFoundError(
                f"File does not exist: {space.display(target)}. "
                f"{_similar_file_hint(space, target)}"
            )
        _binary_guard(target)
        store = _read_state_for(space.root)
        key = f"{space.display(target)}#{int(offset or 1)}#{int(limit or _MAX_READ_LINES)}"
        streak = _read_guard_bump(store, key)
        if streak >= _READ_LOOP_BLOCK_AT and not force:
            raise ValueError(
                f"BLOCKED: you have read this exact range of "
                f"{space.display(target)} {streak} times in a row and the "
                "content has NOT changed. STOP re-reading — use what you "
                "already have and proceed with the task. (If you truly need "
                "the content again because it left your context, pass "
                "force=true once.)"
            )
        entry = store.entries.get(str(target))
        same_range = (
            entry is not None
            and entry.get("offset") == int(offset or 1)
            and entry.get("limit") == int(limit or _MAX_READ_LINES)
        )
        if same_range and _state_freshness(store, target) == "fresh" and not force:
            stub = (
                f"[{space.display(target)} is unchanged since your last read "
                f"of this exact range (read {streak}x in a row); the earlier "
                "tool result is still accurate — do not re-read. If it is no "
                "longer in your context, call Read again with force=true.]"
            )
            if streak >= _READ_LOOP_WARN_AT:
                stub = (
                    f"[notice: you have already read this exact range "
                    f"{streak} times in a row; the content has not changed — "
                    "use the information you already have.]\n" + stub
                )
            return stub
        text, truncated = _numbered(target, int(offset or 1), int(limit or _MAX_READ_LINES))
        _state_mark_read(
            store, target, offset=int(offset or 1),
            limit=int(limit or _MAX_READ_LINES), truncated=truncated,
        )
        if force:
            _read_guard_reset(store)
        if streak >= _READ_LOOP_WARN_AT:
            text = (
                f"[notice: you have read this exact range {streak} times in a "
                "row; the content has not changed — use the information you "
                "already have.]\n" + text
            )
        return text

    def write_file(path: str, content: str, **_: Any) -> str:
        target = space.resolve(path)
        _device_guard(target)
        store = _read_state_for(space.root)
        if target.exists():
            freshness = _state_freshness(store, target)
            if freshness != "fresh":
                raise ValueError(
                    f"Write refused: {_gate_message(freshness, space.display(target))}"
                )
        checkpoints.record(target, existed=target.exists())
        target.parent.mkdir(parents=True, exist_ok=True)
        text = str(content or "")
        target.write_text(text, encoding="utf-8", newline="\n")
        _state_mark_written(store, target)
        return f"wrote {len(text.encode('utf-8'))} bytes to {space.display(target)}"

    def edit_file(
        path: str,
        old_string: str | None = None,
        new_string: str | None = None,
        replace_all: bool = False,
        edits: list | None = None,
        **_: Any,
    ) -> str:
        target = space.resolve(path)
        _device_guard(target)
        if not target.is_file():
            raise FileNotFoundError(
                f"File does not exist: {space.display(target)}. "
                f"{_similar_file_hint(space, target)}"
            )
        store = _read_state_for(space.root)
        freshness = _state_freshness(store, target)
        if freshness != "fresh":
            raise ValueError(f"Edit refused: {_gate_message(freshness, space.display(target))}")

        if edits is not None and (old_string is not None or new_string is not None):
            raise ValueError(
                "pass either edits[] (batch) or old_string/new_string (single), not both"
            )
        if edits is not None:
            edit_list: list[dict[str, Any]] = []
            if not isinstance(edits, list) or not edits:
                raise ValueError("edits must be a non-empty array of {old_string, new_string}")
            for index, item in enumerate(edits):
                if not isinstance(item, dict):
                    raise ValueError(f"edits[{index}] must be an object")
                edit_list.append({
                    "old": str(item.get("old_string") or ""),
                    "new": str(item.get("new_string") or ""),
                    "all": bool(item.get("replace_all")),
                    "index": index,
                })
        else:
            single_old = str(old_string or "")
            if not single_old:
                raise ValueError("old_string is required")
            edit_list = [{
                "old": single_old,
                "new": str(new_string or ""),
                "all": bool(replace_all),
                "index": None,
            }]
            if single_old == str(new_string or ""):
                raise ValueError(
                    "No changes to make: old_string and new_string are exactly the same."
                )

        # read_text default-translates to LF, which is the view the model saw
        # through read_file — so old_string matches, and matching happens in
        # LF space. The write side restores the file's own newline convention
        # (CRLF repos stay CRLF). Decoding bytes without translation would
        # keep literal CRLF here and the re-expansion below would double it.
        newline = _detect_newline(target)
        raw_bytes = target.read_bytes()
        bom = raw_bytes.startswith(b"\xef\xbb\xbf")
        raw = raw_bytes[3:] if bom else raw_bytes
        raw = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")

        planned, note = _plan_edits(raw, edit_list, space.display(target))
        checkpoints.record(target, existed=True)
        for span_start, span_end, replacement in sorted(planned, reverse=True):
            raw = raw[:span_start] + replacement + raw[span_end:]
        if newline != "\n":
            raw = raw.replace("\n", newline)
        with target.open("w", encoding="utf-8", newline="") as handle:
            handle.write(("\ufeff" + raw) if bom else raw)
        _state_mark_written(store, target)
        _read_guard_reset(store)
        suffix = f" [{note}]" if note else ""
        return f"edited {space.display(target)} ({len(planned)} replacement(s)){suffix}"

    def apply_patch(patch: str | list[str], **_: Any) -> str:
        from app.agent_runtime.apply_patch import ApplyPatchError, apply_patch_text, parse_patch

        if isinstance(patch, (list, tuple)):
            blocks = [str(p) for p in patch if str(p).strip()]
        else:
            blocks = [str(patch or "")]
        if not blocks:
            raise ValueError("patch is required")
        store = _read_state_for(space.root)
        touched: list[Path] = []
        try:
            for block in blocks:
                text = str(block).strip()
                if not text:
                    continue
                for hunk in parse_patch(text):
                    if hunk.kind == "delete":
                        checkpoints.record(space.resolve(hunk.path), existed=True)
                        continue
                    target = space.resolve(hunk.path)
                    checkpoints.record(target, existed=target.exists())
                    touched.append(target)
                    if hunk.kind == "update" and hunk.move_path:
                        checkpoints.record(space.resolve(hunk.move_path), existed=False)
                apply_patch_text(text, space.root)
        except ApplyPatchError as exc:
            raise ValueError(f"Patch failed: {exc}") from exc
        for target in dict.fromkeys(touched):
            # patch 成功 = 补丁内容模型刚写的，视为已读最新，省一轮重读。
            if target.is_file():
                _state_mark_written(store, target)
        return f"applied {len(blocks)} patch block(s)"

    def restore_files(steps: int = 0, **_: Any) -> str:
        try:
            bounded = max(0, int(steps or 0))
        except (TypeError, ValueError):
            bounded = 0
        result = checkpoints.restore(bounded)
        if "nothing" not in result:
            # 回滚是 harness 动的文件：读状态全部作废，后续编辑必须重读。
            _read_state_for(space.root).entries.clear()
            _read_guard_reset(_read_state_for(space.root))
        return result

    def glob(pattern: str, **_: Any) -> str:
        pattern = str(pattern or "").strip()
        if not pattern:
            raise ValueError("pattern is required")
        matches: list[tuple[str, float]] = []
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
                    try:
                        mtime = full.stat().st_mtime
                    except OSError:
                        mtime = 0.0
                    matches.append((rel, mtime))
        if not matches:
            return f"no files match {pattern!r}"
        # mtime 降序：模型找"刚才那个文件"时最近的排前（CC Glob 同款）。
        matches.sort(key=lambda item: -item[1])
        shown = matches[:_MAX_GLOB_RESULTS]
        suffix = (
            f"\n[truncated at {_MAX_GLOB_RESULTS}]"
            if len(matches) > _MAX_GLOB_RESULTS
            else ""
        )
        return "\n".join(rel for rel, _ in shown) + suffix

    def grep(
        pattern: str,
        glob_filter: str = "",
        max_results: int = _MAX_GREP_RESULTS,
        context: int = 0,
        offset: int = 0,
        path: str = ".",
        case_sensitive: bool = False,
        output_mode: str = "content",
        **_: Any,
    ) -> str:
        base = space.resolve(path or ".")
        if not base.exists():
            raise FileNotFoundError(f"path not found: {space.display(base)}")
        mode = str(output_mode or "content")
        if mode not in {"content", "files_with_matches", "count"}:
            raise ValueError(
                "output_mode must be content, files_with_matches, or count"
            )
        return _do_search(
            space,
            base,
            str(pattern or ""),
            str(glob_filter or ""),
            max(1, min(int(max_results or _MAX_GREP_RESULTS), _MAX_GREP_RESULTS)),
            context=max(0, min(int(context or 0), 5)),
            offset=max(0, int(offset or 0)),
            case_sensitive=bool(case_sensitive),
            output_mode=mode,
        )

    backgrounds = BackgroundJobs(space.root, notify=inbox)

    def read_background(id: int, **_: Any) -> str:
        return backgrounds.status(int(id or 0))

    def run_command(
        command: str,
        cwd: str = ".",
        timeout_s: float = _DEFAULT_COMMAND_TIMEOUT_S,
        background: bool = False,
        **_: Any,
    ) -> str:
        text = str(command or "").strip()
        if not text:
            raise ValueError("command is required")
        shell = _shell_session_for(space.root)
        if str(cwd or ".").strip() not in ("", "."):
            workdir = space.resolve(cwd)
        else:
            workdir = shell.cwd or space.root
        if not workdir.is_dir():
            raise NotADirectoryError(f"cwd not found: {space.display(workdir)}")
        if background:
            job_id = backgrounds.start(text, workdir)
            return (
                f"started in background as job {job_id}; "
                f"poll with BashRead(id={job_id})"
            )
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
        shell.cwd = _resolve_cd_target(text, workdir, space) or shell.cwd
        out = (completed.stdout or "")[-_MAX_OUTPUT_CHARS:]
        err = (completed.stderr or "")[-8000:]
        header = f"exit={completed.returncode}"
        # 退出码语义（对齐 CC commandSemantics）：这批工具退出码 1 的含义是
        # "没找到/有差异/条件为假"，不是执行错误。不注明，模型会把无命中
        # 当成失败，下一轮胡乱重试。
        semantic = _exit_code_semantics(text, completed.returncode)
        if semantic:
            header += f" ({semantic})"
        parts = [header, f"cwd: {space.display(shell.cwd or space.root)}"]
        if out.strip():
            parts.append(f"stdout:\n{out}")
        if err.strip():
            parts.append(f"stderr:\n{err}")
        return "\n".join(parts)

    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("read_file", "Read")
    registry.register_alias("write_file", "Write")
    registry.register_alias("edit_file", "Edit")
    registry.register_alias("apply_patch", "Patch")
    registry.register_alias("glob", "Glob")
    registry.register_alias("grep", "Grep")
    registry.register_alias("run_command", "Bash")
    registry.register_alias("read_background", "BashRead")
    registry.register_alias("restore_files", "Rewind")
    registry.register(ToolSpec(
        name="Read",
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
                "force": {
                    "type": "boolean",
                    "description": (
                        "内容没变时同区间重读会被去重成 stub、连读过多会被阻断；"
                        "确实需要再看一遍时传 true 强制返回真实内容"
                    ),
                },
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
        name="Write",
        description=(
            "在工作区内创建或整体覆盖一个文本文件。修改现有文件优先用 "
            "Edit（精确替换），整体重写才用这个。"
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
        name="Edit",
        description=(
            "精确字符串替换修改文件。修改前必须先 Read（未读先写会被拒绝；"
            "读后文件被外部改动也要重读）。old_string 必须逐字符唯一匹配；"
            "匹配失败会自动尝试弯/直引号、行尾空白、空白压缩、缩进放宽四级"
            "归一化。多处相同时传 replace_all=true 或加长 old_string。"
            "同一文件多处改动用 edits 数组一次完成。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
                "edits": {
                    "type": "array",
                    "description": (
                        "批量模式：一次调用改同一文件的多处。每个元素 "
                        "{old_string, new_string, replace_all?}，全部对原文匹配，"
                        "重叠会整批拒绝。与 old_string/new_string 二选一。"
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "old_string": {"type": "string"},
                            "new_string": {"type": "string"},
                            "replace_all": {"type": "boolean"},
                        },
                        "required": ["old_string", "new_string"],
                    },
                },
            },
            "required": ["path"],
        },
        execute=edit_file,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=10_000,
    ))
    registry.register(ToolSpec(
        name="Glob",
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
        name="Grep",
        description=(
            "在工作区文件内容里做正则搜索，返回 file:line: text 匹配列表。"
            "找代码、找报错文本、找定义都用它。探索大仓库时先用 "
            "output_mode=files_with_matches 定位文件，再对具体文件用 content "
            "模式读细节，不要一开始就拉取大量匹配正文。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "glob_filter": {"type": "string", "description": "如 *.py，可选"},
                "max_results": {"type": "integer"},
                "context": {
                    "type": "integer",
                    "description": "每个命中带 N 行上下文（0-5，默认 0）",
                },
                "offset": {
                    "type": "integer",
                    "description": "跳过前 N 条命中后再取（分页）",
                },
                "path": {
                    "type": "string",
                    "description": "搜索起点（文件或目录），默认工作区根",
                },
                "case_sensitive": {
                    "type": "boolean",
                    "description": "默认 false（不区分大小写）；查标识符时传 true",
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["content", "files_with_matches", "count"],
                    "description": (
                        "默认 content；files_with_matches 只列唯一文件，"
                        "count 输出每个文件的命中行数"
                    ),
                },
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
        name="Bash",
        description=(
            "在工作区内执行一条 shell 命令（跑测试、构建、git 等），返回 "
            "exit code 与有界输出。长驻进程（dev server、watch、大构建）传 "
            "background=true 立即返回，结束后会收到通知，也可用 BashRead 轮询。"
            "需要 full-access 权限。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "cwd": {"type": "string", "description": "本条命令的工作目录（相对工作区或绝对）。要持久切换目录，在 command 里用 cd——会话内跨调用保持。"},
                "timeout_s": {"type": "number"},
                "background": {
                    "type": "boolean",
                    "description": "true=后台启动立即返回（默认 false）",
                },
            },
            "required": ["command"],
        },
        execute=run_command,
        effect=Effect.LOCAL_IRREVERSIBLE,
        effect_for=_classify_command_effect,
        is_concurrency_safe=False,
        used_backend="shell",
        timeout_ms=620_000,
    ))
    registry.register(ToolSpec(
        name="Patch",
        description=(
            "用 Codex Patch 格式一次修改多个文件（Add/Delete/Update + "
            "@@ 上下文 + -/+ 行）。比多次 Edit 更适合跨文件改动；"
            "补丁里的上下文行必须与文件内容逐字匹配。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "patch": {
                    "oneOf": [
                        {"type": "string"},
                        {"type": "array", "items": {"type": "string"}},
                    ],
                    "description": (
                        "以 *** Begin Patch 开头、*** End Patch 结尾的完整补丁"
                        "文本；也可以传多个补丁块的数组，逐段依次应用"
                    ),
                },
            },
            "required": ["patch"],
        },
        execute=apply_patch,
        effect=Effect.REVERSIBLE_WRITE,
        examples=(
            {
                "patch": (
                    "*** Begin Patch\n"
                    "*** Update File: app/agent_runtime/loop.py\n"
                    "@@\n"
                    "-    old_line = 1\n"
                    "+    new_line = 2\n"
                    "*** End Patch"
                )
            },
        ),
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=30_000,
    ))
    registry.register(ToolSpec(
        name="Rewind",
        description=(
            "把本会话内被 Write/Edit/Patch 改过的文件回滚到"
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
    registry.register(ToolSpec(
        name="BashRead",
        description="读取一个后台命令的运行状态与最近输出。",
        input_schema={
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
        execute=read_background,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="shell",
        timeout_ms=10_000,
    ))
