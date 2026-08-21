"""Codex apply_patch contract, ported to Python (Apache-2.0, openai/codex).

Source of truth: ``codex-rs/apply-patch/src/{parser.rs,streaming_parser.rs,
seek_sequence.rs,file_update.rs}`` at HEAD 536f86e. The patch format is what
frontier models were trained on, so supporting it verbatim removes a whole
class of edit-fumbling that per-file string replacement suffers from:

    *** Begin Patch
    *** Add File: path
    +line
    *** Delete File: path
    *** Update File: path
    @@ optional context
    -old line
     kept line
    +new line
    *** End of File
    *** End Patch

Matching follows Codex ``seek_sequence``: exact → rstrip → trim →
unicode-punctuation-normalised, with end-of-file anchoring. All paths are
resolved against and confined to the caller-provided workspace root.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

__all__ = [
    "ApplyPatchError",
    "Hunk",
    "UpdateFileChunk",
    "parse_patch",
    "apply_patch_text",
]

BEGIN_PATCH_MARKER = "*** Begin Patch"
END_PATCH_MARKER = "*** End Patch"
ADD_FILE_MARKER = "*** Add File: "
DELETE_FILE_MARKER = "*** Delete File: "
UPDATE_FILE_MARKER = "*** Update File: "
MOVE_TO_MARKER = "*** Move to: "
EOF_MARKER = "*** End of File"
CHANGE_CONTEXT_MARKER = "@@ "
EMPTY_CHANGE_CONTEXT_MARKER = "@@"


class ApplyPatchError(ValueError):
    """Raised for malformed patches or failed application."""


@dataclass
class UpdateFileChunk:
    change_context: str | None = None
    old_lines: list[str] = field(default_factory=list)
    new_lines: list[str] = field(default_factory=list)
    is_end_of_file: bool = False

    @property
    def is_empty(self) -> bool:
        return not self.old_lines and not self.new_lines


@dataclass
class Hunk:
    kind: str  # "add" | "delete" | "update"
    path: str
    contents: list[str] | None = None  # add
    move_path: str | None = None  # update rename target
    chunks: list[UpdateFileChunk] = field(default_factory=list)  # update


# ---------------------------------------------------------------------------
# Parsing (Codex streaming_parser.rs, lenient boundaries)
# ---------------------------------------------------------------------------


def _strip_heredoc(lines: list[str]) -> list[str]:
    """Lenient mode: models sometimes wrap the patch in a shell heredoc."""
    if (
        len(lines) >= 4
        and lines[0] in {"<<EOF", "<<'EOF'", '<<"EOF"'}
        and lines[-1].rstrip().endswith("EOF")
    ):
        return lines[1:-1]
    return lines


def parse_patch(patch: str) -> list[Hunk]:
    text = str(patch or "").strip()
    if not text:
        raise ApplyPatchError("invalid patch: empty input")
    lines = _strip_heredoc(text.splitlines())
    if not lines or lines[0].strip() != BEGIN_PATCH_MARKER:
        raise ApplyPatchError(f"invalid patch: must start with {BEGIN_PATCH_MARKER!r}")
    hunks: list[Hunk] = []
    index = 1
    while index < len(lines):
        raw = lines[index]
        line = raw.strip()
        index += 1
        if line == END_PATCH_MARKER:
            break
        if line.startswith(ADD_FILE_MARKER):
            hunk = Hunk("add", line[len(ADD_FILE_MARKER):].strip(), contents=[])
            _parse_add_body(lines, index, hunk)
            index += len(hunk.contents or [])
            hunks.append(hunk)
        elif line.startswith(DELETE_FILE_MARKER):
            hunks.append(Hunk("delete", line[len(DELETE_FILE_MARKER):].strip()))
        elif line.startswith(UPDATE_FILE_MARKER):
            hunk = Hunk("update", line[len(UPDATE_FILE_MARKER):].strip())
            index = _parse_update_body(lines, index, hunk)
            hunks.append(hunk)
        else:
            raise ApplyPatchError(
                f"invalid patch line outside any file hunk: {raw[:80]}"
            )
    for hunk in hunks:
        if hunk.kind == "add" and not (hunk.contents or []):
            raise ApplyPatchError(
                f"invalid hunk for {hunk.path}: Add File requires content lines"
            )
        if hunk.kind == "update" and not any(
            not chunk.is_empty or chunk.change_context for chunk in hunk.chunks
        ):
            raise ApplyPatchError(
                f"invalid hunk for {hunk.path}: Update File requires at least one chunk"
            )
    if not hunks:
        raise ApplyPatchError("invalid patch: no file changes")
    return hunks


def _parse_add_body(lines: list[str], index: int, hunk: Hunk) -> None:
    contents: list[str] = []
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if stripped == END_PATCH_MARKER or stripped.startswith("*** "):
            break
        if not raw.startswith("+"):
            raise ApplyPatchError(
                f"invalid Add File line for {hunk.path} (expected '+'): {raw[:80]}"
            )
        contents.append(raw[1:])
        index += 1
    hunk.contents = contents


def _parse_update_body(lines: list[str], index: int, hunk: Hunk) -> int:
    while index < len(lines):
        raw = lines[index]
        line = raw.strip()
        if line == END_PATCH_MARKER or (line.startswith("*** ") and line != EOF_MARKER):
            return index
        index += 1
        if line.startswith(MOVE_TO_MARKER.strip()) and hunk.move_path is None and not hunk.chunks:
            hunk.move_path = line[len(MOVE_TO_MARKER.strip()):].strip()
            continue
        if line == EMPTY_CHANGE_CONTEXT_MARKER:
            hunk.chunks.append(UpdateFileChunk())
            continue
        if line.startswith(CHANGE_CONTEXT_MARKER):
            hunk.chunks.append(
                UpdateFileChunk(change_context=line[len(CHANGE_CONTEXT_MARKER):])
            )
            continue
        if line == EOF_MARKER:
            if hunk.chunks and hunk.chunks[-1].is_empty:
                raise ApplyPatchError(
                    f"Update hunk for {hunk.path} ends with an empty chunk"
                )
            if hunk.chunks:
                hunk.chunks[-1].is_end_of_file = True
            continue
        tag = raw[:1]
        body = raw[1:]
        if not hunk.chunks:
            hunk.chunks.append(UpdateFileChunk())
        chunk = hunk.chunks[-1]
        if tag == "+":
            chunk.new_lines.append(body)
        elif tag == "-":
            chunk.old_lines.append(body)
        elif tag == " ":
            chunk.old_lines.append(body)
            chunk.new_lines.append(body)
        else:
            raise ApplyPatchError(
                f"invalid line in Update File {hunk.path} (expected ' ', '+' or '-'): {raw[:80]}"
            )
    return index


# ---------------------------------------------------------------------------
# Matching (Codex seek_sequence.rs)
# ---------------------------------------------------------------------------

_PUNCTUATION_MAP = str.maketrans({
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-",
    "\u2014": "-", "\u2015": "-", "\u2212": "-",
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    "\u00A0": " ", "\u2002": " ", "\u2003": " ", "\u2004": " ",
    "\u2005": " ", "\u2006": " ", "\u2007": " ", "\u2008": " ",
    "\u2009": " ", "\u200A": " ", "\u202F": " ", "\u205F": " ",
    "\u3000": " ",
})


def _match_mode(mode: int, value: str) -> str:
    if mode == 1:
        return value.rstrip()
    if mode == 2:
        return value.strip()
    if mode == 3:
        return value.strip().translate(_PUNCTUATION_MAP)
    return value


def seek_sequence(
    lines: list[str],
    pattern: list[str],
    start: int,
    eof: bool,
) -> int | None:
    """Find ``pattern`` in ``lines`` at/after ``start`` (Codex contract)."""
    if not pattern:
        return start
    if len(pattern) > len(lines):
        return None
    search_start = max(start, len(lines) - len(pattern)) if eof else start
    for mode in (0, 1, 2, 3):
        for i in range(search_start, len(lines) - len(pattern) + 1):
            for offset, pat in enumerate(pattern):
                if _match_mode(mode, lines[i + offset]) != _match_mode(mode, pat):
                    break
            else:
                return i
    return None


# ---------------------------------------------------------------------------
# Application (Codex file_update.rs compute_replacements)
# ---------------------------------------------------------------------------


def _compute_replacements(
    original_lines: list[str],
    display_path: str,
    chunks: list[UpdateFileChunk],
) -> list[tuple[int, int, list[str]]]:
    replacements: list[tuple[int, int, list[str]]] = []
    line_index = 0
    for chunk in chunks:
        if chunk.change_context is not None:
            found = seek_sequence(
                original_lines, [chunk.change_context], line_index, False
            )
            if found is None:
                raise ApplyPatchError(
                    f"Failed to find context {chunk.change_context!r} in {display_path}"
                )
            line_index = found + 1
        if not chunk.old_lines:
            replacements.append((min(line_index, len(original_lines)), 0, list(chunk.new_lines)))
            continue
        pattern = list(chunk.old_lines)
        found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file)
        if found is None and pattern and pattern[-1] == "":
            # Trailing empty element represents the region's terminating
            # newline; retry without it so EOF edits can be located.
            pattern = pattern[:-1]
            found = seek_sequence(original_lines, pattern, line_index, chunk.is_end_of_file)
        if found is None:
            raise ApplyPatchError(
                f"Failed to find expected lines in {display_path}:\n"
                + "\n".join(chunk.old_lines[:8])
            )
        replacements.append((found, len(pattern), list(chunk.new_lines)))
        line_index = found + len(pattern)
    return replacements


def _apply_replacements(
    original_lines: list[str],
    replacements: list[tuple[int, int, list[str]]],
) -> str:
    new_lines: list[str] = []
    cursor = 0
    for start, old_len, inserted in replacements:
        new_lines.extend(original_lines[cursor:start])
        new_lines.extend(inserted)
        cursor = start + old_len
    new_lines.extend(original_lines[cursor:])
    return "\n".join(new_lines) + ("\n" if new_lines else "")


def apply_patch_text(patch: str, root: Path) -> str:
    """Parse and apply ``patch`` confined to ``root``; return a summary."""
    from app.agent_runtime.coding_tools import WorkspaceSpace

    space = WorkspaceSpace(root)
    hunks = parse_patch(patch)
    reports: list[str] = []
    for hunk in hunks:
        target = space.resolve(hunk.path)
        display = space.display(target)
        if hunk.kind == "add":
            if target.exists():
                raise ApplyPatchError(f"{display} already exists; use Update File")
            target.parent.mkdir(parents=True, exist_ok=True)
            content = "\n".join(hunk.contents or []) + "\n"
            target.write_text(content, encoding="utf-8", newline="\n")
            reports.append(f"Add {display}: {len(hunk.contents or [])} lines")
        elif hunk.kind == "delete":
            if not target.is_file():
                raise FileNotFoundError(f"not found: {display}")
            target.unlink()
            reports.append(f"Delete {display}")
        else:
            if not target.is_file():
                raise FileNotFoundError(f"not found: {display}")
            raw = target.read_text(encoding="utf-8")
            original_lines = raw.split("\n")
            if original_lines and original_lines[-1] == "":
                original_lines.pop()
            replacements = _compute_replacements(original_lines, display, hunk.chunks)
            updated = _apply_replacements(original_lines, replacements)
            final_target = space.resolve(hunk.move_path) if hunk.move_path else target
            final_target.parent.mkdir(parents=True, exist_ok=True)
            final_target.write_text(updated, encoding="utf-8", newline="\n")
            if hunk.move_path and final_target != target:
                target.unlink()
                reports.append(f"Update {display} -> {space.display(final_target)}")
            else:
                reports.append(f"Update {display}: {len(hunk.chunks)} chunk(s)")
    return "Success. " + "; ".join(reports)
