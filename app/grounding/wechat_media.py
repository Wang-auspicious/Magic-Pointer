"""Resolve the real bytes behind a WeChat message bubble.

WeChat exposes almost nothing through UIA: a file card is a rectangle with a
name drawn on it, and an image is a downscaled thumbnail. Sending either of
those to a model as "the file the user pointed at" would be a lie. This module
turns a pointed-at bubble into evidence with an explicit honesty level:

- ``resolved``   — we found the original file on disk and copied it. Full quality.
- ``crop_only``  — we only have rendered pixels, cropped from the frozen capture.
- ``unresolved`` — we could not get anything trustworthy, and we say why.

Nothing here guesses. Two accounts holding a file with the same name is
``filename_ambiguous``, not a coin flip, because picking the wrong one would
hand a different conversation's document to a model.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any, Iterable, Sequence

# Process names WeChat has shipped under. Weixin is the 4.x rewrite.
WECHAT_PROCESS_NAMES = ("weixin", "wechat", "wechatapp", "wechatwin")

# Default install locations. Callers pass explicit roots in tests and when the
# user has moved the store; these are the fallbacks for a normal machine.
DEFAULT_DATA_ROOT_NAMES = ("WeChat Files", "xwechat_files", "WeChatFiles")

# Below this, a crop carries no information a model could use, and shipping it
# would let a caller believe it had the picture when it had a postage stamp.
MIN_USEFUL_CROP_EDGE_PX = 64

# Placeholders WeChat's accessibility layer puts where media should be.
MEDIA_PLACEHOLDERS = ("[图片]", "[图片]", "[视频]", "[动画表情]", "[文件]", "[image]", "[video]")

_FILENAME_RE = re.compile(
    r"[^\s\\/:*?\"<>|]{1,120}\.(?:docx?|xlsx?|pptx?|pdf|txt|csv|zip|rar|7z|md|json|png|jpe?g|gif|webp|mp4|mov|mp3|wav|apk|exe)",
    re.IGNORECASE,
)


def is_wechat_window(window: dict[str, Any] | None) -> bool:
    process = str((window or {}).get("process_name") or "").casefold()
    process = process[:-4] if process.endswith(".exe") else process
    return process in WECHAT_PROCESS_NAMES


def _candidate_filenames(text: str) -> list[str]:
    seen: list[str] = []
    for match in _FILENAME_RE.finditer(text or ""):
        name = match.group(0).strip()
        if name and name not in seen:
            seen.append(name)
    return seen[:4]


def _mentions_media_placeholder(text: str) -> bool:
    value = str(text or "")
    return any(token in value for token in MEDIA_PLACEHOLDERS)


def default_data_roots() -> list[Path]:
    roots: list[Path] = []
    home = Path.home()
    for parent in (home / "Documents", home, Path("C:/Users/Public/Documents")):
        for name in DEFAULT_DATA_ROOT_NAMES:
            candidate = parent / name
            if candidate.is_dir():
                roots.append(candidate)
    return roots


def _search_filename(roots: Sequence[Path], filename: str, *, limit: int = 8) -> list[Path]:
    """Find every copy of this exact filename under the WeChat store."""
    hits: list[Path] = []
    target = filename.casefold()
    for root in roots:
        if not root or not Path(root).is_dir():
            continue
        for path in Path(root).rglob("*"):
            if len(hits) >= limit:
                return hits
            try:
                if path.is_file() and path.name.casefold() == target:
                    hits.append(path)
            except OSError:
                continue
    return hits


def _distinct_by_content(paths: Iterable[Path]) -> list[Path]:
    """WeChat keeps per-account copies of the same bytes; those are not ambiguous."""
    seen: dict[tuple[int, bytes], Path] = {}
    ordered: list[Path] = []
    for path in paths:
        try:
            size = path.stat().st_size
            with path.open("rb") as handle:
                head = handle.read(4096)
        except OSError:
            continue
        key = (size, head)
        if key in seen:
            continue
        seen[key] = path
        ordered.append(path)
    return ordered


def _media_dir(output_root: Path, snapshot_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", str(snapshot_id or "selection"))[:64] or "selection"
    directory = Path(output_root) / "wechat-media" / safe
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _copy_original(source: Path, output_root: Path, snapshot_id: str, index: int) -> Path:
    destination = _media_dir(output_root, snapshot_id) / f"{index:02d}-{source.name}"
    shutil.copy2(source, destination)
    return destination.resolve()


def _crop_from_capture(
    snapshot: dict[str, Any],
    output_root: Path,
    index: int,
) -> dict[str, Any] | None:
    """Cut the pointed-at region out of the frozen capture. Rendered pixels only."""
    capture_path = str(snapshot.get("capture_path") or "").strip()
    selection_bbox = snapshot.get("selection_bbox")
    capture_bbox = snapshot.get("capture_bbox")
    if not capture_path or not isinstance(selection_bbox, (list, tuple)) or len(selection_bbox) != 4:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None

    sx, sy, sw, sh = (int(round(float(value))) for value in selection_bbox)
    ox, oy = 0, 0
    if isinstance(capture_bbox, (list, tuple)) and len(capture_bbox) == 4:
        ox, oy = int(round(float(capture_bbox[0]))), int(round(float(capture_bbox[1])))

    if sw < MIN_USEFUL_CROP_EDGE_PX or sh < MIN_USEFUL_CROP_EDGE_PX:
        return {
            "status": "unresolved",
            "reason": "thumbnail_too_small",
            "observedCropPx": [sw, sh],
            "localPath": None,
        }

    try:
        with Image.open(capture_path) as image:
            left = max(0, sx - ox)
            top = max(0, sy - oy)
            right = min(image.width, left + sw)
            bottom = min(image.height, top + sh)
            if right - left < MIN_USEFUL_CROP_EDGE_PX or bottom - top < MIN_USEFUL_CROP_EDGE_PX:
                return {
                    "status": "unresolved",
                    "reason": "thumbnail_too_small",
                    "observedCropPx": [max(0, right - left), max(0, bottom - top)],
                    "localPath": None,
                }
            crop = image.crop((left, top, right, bottom))
            destination = _media_dir(output_root, str(snapshot.get("snapshot_id") or "")) / f"{index:02d}-crop.png"
            crop.save(destination, format="PNG")
    except (OSError, ValueError):
        return {
            "status": "unresolved",
            "reason": "capture_unreadable",
            "localPath": None,
        }

    return {
        "status": "crop_only",
        "acquisition": "screenshot_crop",
        "quality": "rendered_crop",
        "observedCropPx": [right - left, bottom - top],
        "localPath": str(destination.resolve()),
    }


def resolve_wechat_media_evidence(
    *,
    window: dict[str, Any] | None,
    context: dict[str, Any] | None,
    snapshot: dict[str, Any] | None,
    output_root: Path | str,
    data_roots: Sequence[Path] | None = None,
) -> list[dict[str, Any]]:
    """Return one evidence record per media item referenced by the bubble.

    An empty list means "this is not a WeChat window with media in it", not
    "nothing was found" — a caller can tell the difference by the window check.
    """
    if not is_wechat_window(window):
        return []

    content = str((context or {}).get("content") or "")
    snapshot = snapshot or {}
    output_root = Path(output_root)
    roots = [Path(root) for root in (data_roots if data_roots is not None else default_data_roots())]
    snapshot_id = str(snapshot.get("snapshot_id") or "selection")

    evidence: list[dict[str, Any]] = []

    for index, filename in enumerate(_candidate_filenames(content), start=1):
        matches = _distinct_by_content(_search_filename(roots, filename))
        record: dict[str, Any] = {
            "kind": "file",
            "name": filename,
            "snapshotId": snapshot_id,
        }
        if len(matches) == 1:
            try:
                copied = _copy_original(matches[0], output_root, snapshot_id, index)
            except OSError as exc:
                record.update({
                    "status": "unresolved",
                    "reason": "copy_failed",
                    "detail": str(exc)[:200],
                    "localPath": None,
                })
            else:
                record.update({
                    "status": "resolved",
                    "acquisition": "verified_filename_search",
                    "quality": "original_file_copy",
                    "localPath": str(copied),
                    "sourcePath": str(matches[0].resolve()),
                    "bytes": copied.stat().st_size,
                })
        elif len(matches) > 1:
            record.update({
                "status": "unresolved",
                "reason": "filename_ambiguous",
                "candidateCount": len(matches),
                "localPath": None,
            })
        else:
            record.update({
                "status": "unresolved",
                "reason": "file_not_found",
                "localPath": None,
            })
        evidence.append(record)

    if not evidence and _mentions_media_placeholder(content):
        crop = _crop_from_capture(snapshot, output_root, index=1)
        if crop is None:
            crop = {"status": "unresolved", "reason": "no_frozen_capture", "localPath": None}
        crop.update({"kind": "image", "name": content.strip()[:60], "snapshotId": snapshot_id})
        evidence.append(crop)

    return evidence
