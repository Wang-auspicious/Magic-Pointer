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
        if line.startswith(MOVE_TO_MARKER.strip()) and hunk.move_path is None and not hunk.chunks:
            hunk.move_path = line[len(MOVE_TO_MARKER.strip()):].strip()
            index += 1
            continue
        if line == END_PATCH_MARKER or (line.startswith("*** ") and line != EOF_MARKER):
            return index
        index += 1
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


def _line_number(line_index: int) -> int:
    return line_index + 1


def _near_miss_lines(
    original_lines: list[str],
    pattern: list[str],
    limit: int = 3,
) -> list[tuple[int, int]]:
    """Best guesses for where ``pattern`` was meant to go: ``(line, score)``.

    A failed chunk currently reports the expected text and nothing about the
    file, so the model has to re-read the whole file to find out what moved.
    Scoring every offset by how many leading lines still match — under the same
    whitespace tolerance ``seek_sequence`` uses — turns that into one line
    number it can act on immediately. Scores are counted on the first line of
    each non-empty pattern line so a single stale line early in the block does
    not sink an otherwise obvious location.
    """
    if not pattern or not original_lines:
        return []
    probe = next((line for line in pattern if line.strip()), pattern[0])
    scored: list[tuple[int, int]] = []
    for index, line in enumerate(original_lines):
        score = 0
        for mode in (0, 1, 2, 3):
            # Same mode on both sides: comparing a normalized file line against
            # the raw probe would call "x  " and "x" different at mode 0.
            if _match_mode(mode, line) == _match_mode(mode, probe):
                score = 4 - mode
                break
        if not score:
            # Fall back to the longest shared prefix, ignoring whitespace and
            # case, so the hint survives a word edited inside the line
            # ("beta" vs "betta"). Requiring half the shorter string keeps a
            # coincidental two-character opener from matching everything.
            left = line.strip().casefold()
            right = probe.strip().casefold()
            shortest = min(len(left), len(right))
            shared = 0
            while shared < shortest and left[shared] == right[shared]:
                shared += 1
            score = 1 if shared >= 3 and shared * 2 >= shortest else 0
        if score:
            scored.append((index, score))
    scored.sort(key=lambda item: (-item[1], item[0]))
    return scored[:limit]


def _locate_hint(
    original_lines: list[str],
    pattern: list[str],
) -> str:
    misses = _near_miss_lines(original_lines, pattern)
    if not misses:
        return " No similar lines in the current file; re-read it before retrying."
    parts = [f"line {_line_number(index)}: {original_lines[index]}" for index, _ in misses]
    return " Closest lines in the current file:\n" + "\n".join(parts)


def _other_match_lines(
    original_lines: list[str],
    pattern: list[str],
    start: int,
    stop_at: int,
    eof: bool,
    limit: int = 3,
) -> list[int]:
    """Line numbers of further matches for an already-applied chunk pattern."""
    if not pattern:
        return []
    found: list[int] = []
    cursor = start
    while len(found) < limit:
        hit = seek_sequence(original_lines, pattern, cursor, eof)
        if hit is None or hit >= stop_at:
            break
        found.append(_line_number(hit))
        cursor = hit + 1
    return found


def _compute_replacements(
    original_lines: list[str],
    display_path: str,
    chunks: list[UpdateFileChunk],
) -> tuple[list[tuple[int, int, list[str]]], list[str]]:
    """Locate every chunk. Returns replacements plus ambiguity notes.

    ``seek_sequence`` takes the first match at or after the cursor, which is the
    Codex contract and usually right: earlier chunks move the cursor past text
    that has already been used. It is a guess when a chunk carries no
    ``change_context`` and its block occurs again later in the file — the patch
    then edits one of several identical regions with nothing in the patch
    saying which. That case is reported rather than silently resolved, so the
    caller can confirm the intended region without re-reading the file.
    """
    replacements: list[tuple[int, int, list[str]]] = []
    notes: list[str] = []
    line_index = 0
    for position, chunk in enumerate(chunks):
        where = f"chunk {position + 1}/{len(chunks)}"
        if chunk.change_context is not None:
            found = seek_sequence(
                original_lines, [chunk.change_context], line_index, False
            )
            if found is None:
                raise ApplyPatchError(
                    f"Failed to find context {chunk.change_context!r} in {display_path} ({where})."
                    + _locate_hint(original_lines, [chunk.change_context])
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
                f"Failed to find expected lines in {display_path} ({where}, "
                f"searched from line {_line_number(line_index)}):\n"
                + "\n".join(chunk.old_lines[:8])
                + _locate_hint(original_lines, pattern)
            )
        if chunk.change_context is None:
            others = _other_match_lines(
                original_lines, pattern, found + 1, len(original_lines), chunk.is_end_of_file
            )
            if others:
                notes.append(
                    f"{display_path} {where} also matches at line(s) "
                    + ", ".join(str(line) for line in others)
                    + f"; applied at line {_line_number(found)}."
                )
        replacements.append((found, len(pattern), list(chunk.new_lines)))
        line_index = found + len(pattern)
    return replacements, notes


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


def apply_patch_text(patch: str, root: Path, *, before_write=None) -> str:
    """Parse and apply ``patch`` confined to ``root``; return a summary."""
    from app.agent_runtime.coding_tools import WorkspaceSpace

    space = WorkspaceSpace(root)
    hunks = parse_patch(patch)
    reports: list[str] = []
    ambiguity: list[str] = []
    changes: dict[Path, bytes | None] = {}

    def current(path: Path) -> bytes | None:
        return changes[path] if path in changes else path.read_bytes() if path.is_file() else None

    for hunk in hunks:
        target = space.resolve(hunk.path)
        display = space.display(target)
        if hunk.kind == "add":
            if current(target) is not None:
                raise ApplyPatchError(f"{display} already exists; use Update File")
            content = "\n".join(hunk.contents or []) + "\n"
            changes[target] = content.encode("utf-8")
            reports.append(f"Add {display}: {len(hunk.contents or [])} lines")
        elif hunk.kind == "delete":
            if current(target) is None:
                raise FileNotFoundError(f"not found: {display}")
            changes[target] = None
            reports.append(f"Delete {display}")
        else:
            original = current(target)
            if original is None:
                raise FileNotFoundError(f"not found: {display}")
            newline = "\r\n" if b"\r\n" in original else "\r" if b"\r" in original else "\n"
            bom = original.startswith(b"\xef\xbb\xbf")
            raw = original.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
            original_lines = raw.split("\n")
            if original_lines and original_lines[-1] == "":
                original_lines.pop()
            replacements, notes = _compute_replacements(original_lines, display, hunk.chunks)
            ambiguity.extend(notes)
            updated = _apply_replacements(original_lines, replacements)
            if not raw.endswith("\n"):
                updated = updated.removesuffix("\n")
            final_target = space.resolve(hunk.move_path) if hunk.move_path else target
            if final_target != target and current(final_target) is not None:
                raise ApplyPatchError(f"move destination already exists: {space.display(final_target)}")
            changes[final_target] = (("\ufeff" if bom else "") + updated.replace("\n", newline)).encode("utf-8")
            if hunk.move_path and final_target != target:
                changes[target] = None
                reports.append(f"Update {display} -> {space.display(final_target)}")
            else:
                reports.append(f"Update {display}: {len(hunk.chunks)} chunk(s)")
    # Parse and resolve every hunk before recording undo history or changing files.
    for path, content in changes.items():
        if before_write is not None:
            before_write(path, existed=path.exists())
        if content is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    summary = "Success. " + "; ".join(reports)
    if ambiguity:
        summary += "\nAmbiguous placement (the patch did not say which region; verify):\n" + "\n".join(
            f"- {note}" for note in ambiguity
        )
    return summary
