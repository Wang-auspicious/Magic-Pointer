from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


_VISUAL_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".webp",
    ".heic",
    ".avif",
}
_MAX_CAPTURE_HASH_BYTES = 64 * 1024 * 1024


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime | None) -> datetime:
    current = value or _utc_now()
    if current.tzinfo is None:
        return current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="milliseconds")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_json(value: Any) -> str:
    raw = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return _sha256_bytes(raw)


def _bounded_text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _source_for(obj: dict[str, Any]) -> dict[str, Any]:
    source = obj.get("source")
    return dict(source) if isinstance(source, dict) else {}


def _process_id(source: dict[str, Any]) -> int:
    try:
        return int(source.get("processId") or source.get("process_id") or source.get("pid") or 0)
    except (TypeError, ValueError):
        return 0


def _hwnd(source: dict[str, Any]) -> int:
    try:
        return int(source.get("hwnd") or 0)
    except (TypeError, ValueError):
        return 0


def _desktop_id(source: dict[str, Any]) -> str:
    return _bounded_text(
        source.get("desktopId")
        or source.get("desktop_id")
        or source.get("spaceId")
        or source.get("space_id"),
        240,
    )


def _canonical_objects(objects: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    canonical: list[dict[str, Any]] = []
    for index, raw in enumerate(objects, 1):
        obj = dict(raw)
        source = _source_for(obj)
        content = str(obj.get("content") or obj.get("text") or "")
        elements = obj.get("elements") if isinstance(obj.get("elements"), list) else []
        canonical.append({
            "id": _bounded_text(obj.get("id") or obj.get("objectId") or f"object-{index}", 240),
            "referenceLabel": _bounded_text(obj.get("referenceLabel"), 12).upper(),
            "kind": _bounded_text(obj.get("kind"), 120),
            "label": _bounded_text(obj.get("label"), 500),
            "bbox": obj.get("bbox"),
            "contentSha256": _sha256_bytes(content.encode("utf-8")),
            "elementsSha256": _sha256_json(elements),
            "source": {
                "app": _bounded_text(source.get("app"), 300),
                "title": _bounded_text(source.get("title"), 1000),
                "hwnd": _hwnd(source),
                "processId": _process_id(source),
                "path": _bounded_text(
                    source.get("documentPath")
                    or source.get("document_path")
                    or source.get("path"),
                    4000,
                ),
                "url": _bounded_text(source.get("url"), 4000),
                "page": source.get("page"),
                "fileSha256": _bounded_text(
                    source.get("fileSha256") or source.get("file_sha256"),
                    128,
                ),
            },
        })
    return canonical


def _capture_paths(objects: Iterable[dict[str, Any]]) -> list[Path]:
    values: list[Path] = []
    seen: set[str] = set()
    for obj in objects:
        source = _source_for(obj)
        for candidate in (
            obj.get("path"),
            source.get("imagePath"),
            source.get("screenshotPath"),
            source.get("capturePath"),
            source.get("annotatedPath"),
            source.get("path"),
        ):
            raw = str(candidate or "").strip()
            if not raw:
                continue
            path = Path(raw).expanduser()
            key = str(path).casefold()
            if key in seen or path.suffix.casefold() not in _VISUAL_SUFFIXES:
                continue
            seen.add(key)
            values.append(path)
    return values


def _file_fingerprint(path: Path) -> dict[str, Any] | None:
    try:
        resolved = path.resolve()
        stat = resolved.stat()
        if not resolved.is_file():
            return None
        digest = hashlib.sha256()
        read_bytes = 0
        with resolved.open("rb") as handle:
            while read_bytes < _MAX_CAPTURE_HASH_BYTES:
                chunk = handle.read(min(1024 * 1024, _MAX_CAPTURE_HASH_BYTES - read_bytes))
                if not chunk:
                    break
                digest.update(chunk)
                read_bytes += len(chunk)
        return {
            "path": str(resolved),
            "size": int(stat.st_size),
            "mtimeNs": int(stat.st_mtime_ns),
            "sha256Prefix64MiB": digest.hexdigest(),
            "truncated": stat.st_size > _MAX_CAPTURE_HASH_BYTES,
        }
    except OSError:
        return None


def _capture_fingerprint(objects: Iterable[dict[str, Any]]) -> str:
    fingerprints = _capture_files(objects)
    return _sha256_json(fingerprints) if fingerprints else ""


def _capture_files(objects: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        value
        for value in (_file_fingerprint(path) for path in _capture_paths(objects))
        if value is not None
    ]


def _windows(objects: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    seen: set[tuple[int, int]] = set()
    for obj in objects:
        source = _source_for(obj)
        attestation = source.get("captureAttestation") or source.get("capture_attestation")
        attestation = dict(attestation) if isinstance(attestation, dict) else {}
        expected = attestation.get("expected")
        expected = dict(expected) if isinstance(expected, dict) else {}
        hwnd = _hwnd(source)
        process_id = _process_id(source)
        identity = (hwnd, process_id)
        if hwnd and process_id and identity not in seen:
            seen.add(identity)
            window = {
                "hwnd": hwnd,
                "processId": process_id,
                "app": _bounded_text(source.get("app"), 300),
                "title": _bounded_text(source.get("title"), 1000),
            }
            desktop_id = _desktop_id(source) or _desktop_id(expected)
            process_name = _bounded_text(
                source.get("processName") or source.get("process_name") or expected.get("processName"),
                300,
            )
            if desktop_id:
                window["desktopId"] = desktop_id
            if process_name:
                window["processName"] = process_name
            results.append(window)
    return results


@dataclass(frozen=True)
class LeaseValidation:
    valid: bool
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {"valid": self.valid, "reason": self.reason}


@dataclass(frozen=True)
class TargetLease:
    lease_id: str
    selection_session_id: str
    created_at: str
    expires_at: str
    window: dict[str, Any]
    windows: tuple[dict[str, Any], ...]
    object_ids: tuple[str, ...]
    object_fingerprint: str
    capture_fingerprint: str
    capture_files: tuple[dict[str, Any], ...]
    requires_live_validation: bool

    @classmethod
    def create(
        cls,
        objects: Iterable[dict[str, Any]],
        *,
        selection_session_id: str = "",
        ttl_seconds: int = 600,
        now: datetime | None = None,
    ) -> "TargetLease":
        clean_objects = [dict(item) for item in objects if isinstance(item, dict)]
        created = _aware_utc(now)
        ttl = max(1, min(int(ttl_seconds), 3600))
        canonical = _canonical_objects(clean_objects)
        windows = _windows(clean_objects)
        window = windows[0] if windows else {}
        capture_files = _capture_files(clean_objects)
        return cls(
            lease_id=str(uuid.uuid4()),
            selection_session_id=_bounded_text(selection_session_id, 240),
            created_at=_iso(created),
            expires_at=_iso(created + timedelta(seconds=ttl)),
            window=window,
            windows=tuple(windows),
            object_ids=tuple(str(item["id"]) for item in canonical),
            object_fingerprint=_sha256_json(canonical),
            capture_fingerprint=_sha256_json(capture_files) if capture_files else "",
            capture_files=tuple(capture_files),
            requires_live_validation=bool(window),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "leaseId": self.lease_id,
            "selectionSessionId": self.selection_session_id,
            "createdAt": self.created_at,
            "expiresAt": self.expires_at,
            "window": dict(self.window),
            "windows": [dict(item) for item in self.windows],
            "objectIds": list(self.object_ids),
            "objectFingerprint": self.object_fingerprint,
            "captureFingerprint": self.capture_fingerprint,
            "captureFiles": [dict(item) for item in self.capture_files],
            "requiresLiveValidation": self.requires_live_validation,
            "revision": 1,
        }


def _validate_capture_files(value: dict[str, Any]) -> LeaseValidation | None:
    raw_files = value.get("captureFiles")
    if not isinstance(raw_files, list):
        return None
    expected = [dict(item) for item in raw_files if isinstance(item, dict)]
    if not expected and not str(value.get("captureFingerprint") or ""):
        return None
    current = [
        fingerprint
        for fingerprint in (
            _file_fingerprint(Path(str(item.get("path") or "")).expanduser())
            for item in expected
        )
        if fingerprint is not None
    ]
    if len(current) != len(expected) or _sha256_json(current) != str(value.get("captureFingerprint") or ""):
        return LeaseValidation(False, "target_capture_changed")
    return None


def _live_identity(window: dict[str, Any]) -> dict[str, Any]:
    return {
        "hwnd": _hwnd(window),
        "processId": _process_id(window),
        "app": _bounded_text(window.get("app"), 300),
        "processName": _bounded_text(window.get("processName") or window.get("process_name"), 300),
        "title": _bounded_text(window.get("title"), 1000),
        "desktopId": _desktop_id(window),
    }


def _match_expected_window(
    expected: dict[str, Any],
    live: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, str]:
    identity = (_hwnd(expected), _process_id(expected))
    match = next(
        (item for item in live if (_hwnd(item), _process_id(item)) == identity),
        None,
    )
    if match is None:
        return None, "stale_target_window"
    expected_title = _bounded_text(expected.get("title"), 1000)
    actual_title = _bounded_text(match.get("title"), 1000)
    if expected_title and actual_title and actual_title != expected_title:
        return None, "target_window_title_changed"
    expected_desktop = _desktop_id(expected)
    actual_desktop = _desktop_id(match)
    if expected_desktop and not actual_desktop:
        return None, "target_desktop_unverified"
    if expected_desktop and actual_desktop != expected_desktop:
        return None, "target_desktop_changed"
    return match, "live_target_match"


def validate_target_lease(
    value: dict[str, Any],
    *,
    live_windows: Iterable[dict[str, Any]] | None,
    now: datetime | None = None,
) -> LeaseValidation:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        return LeaseValidation(False, "invalid_target_lease")
    try:
        expires_at = datetime.fromisoformat(str(value.get("expiresAt") or "").replace("Z", "+00:00"))
    except ValueError:
        return LeaseValidation(False, "invalid_target_lease")
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= _aware_utc(now):
        return LeaseValidation(False, "target_lease_expired")
    capture_validation = _validate_capture_files(value)
    if capture_validation is not None:
        return capture_validation
    if value.get("requiresLiveValidation") is not True:
        return LeaseValidation(True, "lease_does_not_require_live_window")
    if live_windows is None:
        return LeaseValidation(False, "target_lease_probe_unavailable")

    raw_windows = value.get("windows")
    expected_windows = [dict(item) for item in raw_windows if isinstance(item, dict)] if isinstance(raw_windows, list) else []
    if not expected_windows:
        expected_windows = [dict(value.get("window") or {})]
    if not expected_windows or any(not _hwnd(item) or not _process_id(item) for item in expected_windows):
        return LeaseValidation(False, "invalid_target_lease")
    live = [dict(window) for window in live_windows if isinstance(window, dict)]
    for expected in expected_windows:
        _match, reason = _match_expected_window(expected, live)
        if _match is None:
            return LeaseValidation(False, reason)
    return LeaseValidation(True, "live_target_match")


def reconfirm_target_lease(
    value: dict[str, Any],
    *,
    confirmed_windows: Iterable[dict[str, Any]],
    now: datetime | None = None,
    ttl_seconds: int = 600,
) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("invalid_target_lease")
    expected_windows = [
        dict(item)
        for item in value.get("windows") or [value.get("window") or {}]
        if isinstance(item, dict)
    ]
    live = [_live_identity(dict(item)) for item in confirmed_windows if isinstance(item, dict)]
    selected: list[dict[str, Any]] = []
    used: set[tuple[int, int]] = set()
    for expected in expected_windows:
        exact = [
            item for item in live
            if (_hwnd(item), _process_id(item)) == (_hwnd(expected), _process_id(expected))
            and (_hwnd(item), _process_id(item)) not in used
        ]
        candidates = exact
        if not candidates:
            title = _bounded_text(expected.get("title"), 1000)
            candidates = [
                item for item in live
                if title and item.get("title") == title
                and (_hwnd(item), _process_id(item)) not in used
            ]
        if len(candidates) != 1:
            raise ValueError("target_reconfirmation_ambiguous")
        chosen = dict(candidates[0])
        if not _hwnd(chosen) or not _process_id(chosen):
            raise ValueError("target_reconfirmation_invalid")
        if not chosen.get("app"):
            chosen["app"] = _bounded_text(expected.get("app"), 300)
        selected.append({key: item for key, item in chosen.items() if item not in (None, "", 0)})
        used.add((_hwnd(chosen), _process_id(chosen)))

    created = _aware_utc(now)
    ttl = max(1, min(int(ttl_seconds), 3600))
    renewed = {
        **dict(value),
        "leaseId": str(uuid.uuid4()),
        "previousLeaseId": str(value.get("leaseId") or ""),
        "createdAt": _iso(created),
        "expiresAt": _iso(created + timedelta(seconds=ttl)),
        "window": dict(selected[0]) if selected else {},
        "windows": selected,
        "requiresLiveValidation": bool(selected),
        "revision": int(value.get("revision") or 1) + 1,
    }
    validation = validate_target_lease(renewed, live_windows=live, now=created)
    if not validation.valid:
        raise ValueError(validation.reason)
    return renewed
