"""Memory layer (CC CLAUDE.md / memory files pattern) + compaction.

CC reads layered memory files (user-level, project-level) into the system
prompt and compacts the conversation when context grows. Here:
- :class:`MemoryLoader` reads user ``MAGIC_POINTER.md``, approved Hermes-style
  ``learning/MEMORY.md``, then workspace ``MAGIC_POINTER.md``. All layers are
  concatenated in that order, deduplicated by resolved path and mtime-cached.
- :func:`compact_messages` summarizes older rounds into a single condensed
  user message using an injected summary callable (the loop's compact
  callback consumes it on the token-withheld path).

Both are pure Python; file I/O only in MemoryLoader.
"""

from __future__ import annotations

import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Callable

from app.agent_runtime.types import AgentMessage, Role

__all__ = ["MemoryLoader", "SkillLoader", "compact_messages"]

MEMORY_FILE_NAME = "MAGIC_POINTER.md"
LEARNED_MEMORY_RELATIVE = Path("learning") / "MEMORY.md"
MEMORY_LIMIT_CHARS = 4000
SKILL_FILE_NAME = "SKILL.md"
SKILL_COUNT_LIMIT = 6
SKILL_FILE_LIMIT_CHARS = 3500
SKILL_TOTAL_LIMIT_CHARS = 12000
COMPACTION_MESSAGE_LIMIT_CHARS = 12000
COMPACTION_SOURCE_LIMIT_CHARS = 160000

SummarizeFn = Callable[[str], str]


class MemoryLoader:
    """Layered user rules, approved learning and workspace rules."""

    def __init__(
        self,
        *,
        user_dir: Path | None = None,
        workspace_root: Path | None = None,
    ) -> None:
        self._user_dir = user_dir
        self._workspace_root = workspace_root
        self._cache: tuple[tuple[Path, float], ...] | None = None
        self._cached_text = ""

    def load(self) -> str:
        files: list[tuple[Path, float]] = []
        candidates: list[Path] = []
        if self._user_dir is not None:
            user_dir = Path(self._user_dir)
            candidates.extend((
                user_dir / MEMORY_FILE_NAME,
                user_dir / LEARNED_MEMORY_RELATIVE,
            ))
        if self._workspace_root is not None:
            candidates.append(Path(self._workspace_root) / MEMORY_FILE_NAME)
        seen: set[Path] = set()
        for path in candidates:
            try:
                identity = path.resolve(strict=False)
            except OSError:
                identity = path.absolute()
            if identity in seen:
                continue
            seen.add(identity)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            files.append((path, mtime))
        if files == self._cache:
            return self._cached_text
        parts: list[str] = []
        for path, _mtime in files:
            try:
                text = path.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if text:
                parts.append(text)
        self._cached_text = "\n\n".join(parts)[:MEMORY_LIMIT_CHARS]
        self._cache = files
        return self._cached_text


class SkillLoader:
    """Select bounded, user-approved skills relevant to the current command."""

    def __init__(self, user_dir: Path | str, *, command: str) -> None:
        self._root = Path(user_dir) / "skills"
        self._command = str(command or "").strip()

    def load(self) -> str:
        if not self._command or not self._root.is_dir() or _is_reparse(self._root):
            return ""
        command_tokens = _routing_tokens(self._command)
        ranked: list[tuple[int, str, str]] = []
        try:
            directories = sorted(self._root.iterdir(), key=lambda path: path.name.casefold())
        except OSError:
            return ""
        for directory in directories:
            if not directory.is_dir() or _is_reparse(directory):
                continue
            skill_path = directory / SKILL_FILE_NAME
            if not skill_path.is_file() or _is_reparse(skill_path):
                continue
            try:
                content = skill_path.read_text(encoding="utf-8")[:SKILL_FILE_LIMIT_CHARS]
            except (OSError, UnicodeError):
                continue
            skill_tokens = _routing_tokens(f"{directory.name}\n{content[:1000]}")
            score = len(command_tokens.intersection(skill_tokens))
            if directory.name.casefold() in self._command.casefold():
                score += 4
            if score > 0:
                ranked.append((score, directory.name, content.strip()))
        ranked.sort(key=lambda item: (-item[0], item[1].casefold()))
        blocks: list[str] = []
        remaining = SKILL_TOTAL_LIMIT_CHARS
        for _score, name, content in ranked[:SKILL_COUNT_LIMIT]:
            block = f"## skill: {name}\n{content}".strip()
            if not block or remaining <= 0:
                break
            block = block[:remaining]
            blocks.append(block)
            remaining -= len(block)
        return "\n\n".join(blocks)


def _is_reparse(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return True
    attributes = int(getattr(info, "st_file_attributes", 0) or 0)
    reparse_flag = int(getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
    return path.is_symlink() or bool(attributes & reparse_flag)


def _routing_tokens(value: str) -> set[str]:
    folded = str(value or "").casefold()
    tokens = set(re.findall(r"[a-z0-9][a-z0-9_+.-]{1,}", folded))
    for run in re.findall(r"[\u3400-\u9fff]+", folded):
        if len(run) == 1:
            tokens.add(run)
            continue
        tokens.update(run[index:index + 2] for index in range(len(run) - 1))
    return tokens


def compact_messages(
    messages: list[AgentMessage],
    summarize: SummarizeFn,
    *,
    keep_last: int = 6,
) -> list[AgentMessage]:
    """Condense history: everything before the last ``keep_last`` messages is
    summarized into one user-role data message (CC compact). Assistant tool
    calls and tool results retain explicit provenance in the summary source;
    the append-only session remains the lossless record. Returns the compacted
    list or the original when there is nothing to compact."""
    if len(messages) <= keep_last:
        return list(messages)
    cutoff = len(messages) - keep_last
    # A tool result is only valid when the assistant tool call that created it
    # is still present.  Move the compaction boundary to the beginning of that
    # tool exchange instead of emitting an orphaned ``tool`` message.
    while cutoff > 0 and messages[cutoff].role is Role.TOOL:
        cutoff -= 1
    head = messages[:cutoff]
    tail = messages[cutoff:]
    source = "\n".join(
        line for message in head if (line := _compaction_source_line(message))
    )
    if len(source) > COMPACTION_SOURCE_LIMIT_CHARS:
        prefix = source[:40000]
        suffix = source[-(COMPACTION_SOURCE_LIMIT_CHARS - 40000):]
        source = prefix + "\n[older compaction source truncated]\n" + suffix
    if not source.strip():
        return list(messages)
    summary = str(summarize(source) or "").strip()
    if not summary:
        return list(messages)
    condensed = AgentMessage(
        role=Role.USER,
        content=f"[前文摘要]\n{summary}",
        tool_call_id=None,
        name=None,
        origin="data",
        injected=True,
    )
    return [condensed, *tail]


def _compaction_source_line(message: AgentMessage) -> str:
    """Render one bounded, provenance-labelled item for the summarizer."""
    content = (message.content or "").strip()
    if len(content) > COMPACTION_MESSAGE_LIMIT_CHARS:
        content = content[:COMPACTION_MESSAGE_LIMIT_CHARS] + "\n[message truncated]"
    if message.role is Role.TOOL:
        return (
            "[tool_result untrusted_data "
            f"name={message.name or '?'} call_id={message.tool_call_id or '?'}] "
            + content
        ).rstrip()
    parts: list[str] = []
    if content:
        parts.append(f"[{message.role.value}] {content}")
    if message.role is Role.ASSISTANT and message.tool_calls:
        for call in message.tool_calls:
            parts.append(
                "[assistant_tool_call "
                f"name={str(call.get('name') or '?')} "
                f"call_id={str(call.get('id') or '?')}] "
                + json.dumps(
                    call.get("arguments") or {},
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                )[:COMPACTION_MESSAGE_LIMIT_CHARS]
            )
    return "\n".join(parts)
