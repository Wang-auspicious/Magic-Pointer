"""SurfaceAdapter manifest: declarative display metadata (design §8).

Behaviour lives in the adapter code (single source of truth, like the
capability-tool schemas); the manifest keeps only data-shaped facts used
for discovery, listing and the Reuse Gate review.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = ["SurfaceAdapterManifest", "load_manifest"]

_REQUIRED = ("id", "display_name", "app_ids")


@dataclass(frozen=True)
class SurfaceAdapterManifest:
    id: str
    display_name: str
    app_ids: tuple[str, ...]
    window_class_patterns: tuple[str, ...] = ()
    title_patterns: tuple[str, ...] = ()
    object_kinds: tuple[str, ...] = ("surface_object",)
    capabilities: tuple[str, ...] = ("read_raw_objects",)
    version: int = 1
    notes: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SurfaceAdapterManifest":
        if not isinstance(data, dict):
            raise ValueError("surface adapter manifest must be an object")
        missing = [key for key in _REQUIRED if not data.get(key)]
        if missing:
            raise ValueError(f"surface adapter manifest missing {missing}")
        app_ids = cls._string_tuple(data.get("app_ids"), "app_ids")
        if not app_ids:
            raise ValueError("surface adapter manifest needs at least one app id")
        version_raw = data.get("version", 1)
        if isinstance(version_raw, bool) or not isinstance(version_raw, int):
            raise ValueError("surface adapter manifest version must be an integer")
        return cls(
            id=str(data["id"]).strip(),
            display_name=str(data["display_name"]).strip(),
            app_ids=app_ids,
            window_class_patterns=cls._string_tuple(
                data.get("window_class_patterns"), "window_class_patterns"
            ),
            title_patterns=cls._string_tuple(data.get("title_patterns"), "title_patterns"),
            object_kinds=cls._string_tuple(data.get("object_kinds"), "object_kinds")
            or ("surface_object",),
            capabilities=cls._string_tuple(data.get("capabilities"), "capabilities")
            or ("read_raw_objects",),
            version=version_raw,
            notes=str(data.get("notes") or ""),
        )

    @staticmethod
    def _string_tuple(value: Any, field_name: str) -> tuple[str, ...]:
        # A manifest that writes "app_ids": "wechat" (string instead of array)
        # used to iterate into single characters and claim nearly every window
        # (perception-audit P2: type-confused manifest -> adapter matches all).
        if value is None:
            return ()
        if not isinstance(value, (list, tuple)):
            raise ValueError(
                f"surface adapter manifest {field_name} must be an array"
            )
        return tuple(
            str(item).strip() for item in value if str(item).strip()
        )

    def matches_window(self, window: dict[str, Any]) -> bool:
        """True when this manifest claims the given window identity.

        Process names match the executable basename exactly (``evilwechat.exe``
        is not ``wechat.exe``); title/class patterns are deliberately
        substring signals but only fire when the window actually exposes them.
        """
        process = str(window.get("process_name") or "").casefold()
        app = str(window.get("app") or "").casefold()
        class_name = str(window.get("class_name") or "").casefold()
        title = str(window.get("title") or "").casefold()
        if not process and not class_name and not title:
            return False
        process_basename = process.rsplit("\\", 1)[-1].rsplit("/", 1)[-1]
        app_ids = {app_id.casefold().strip() for app_id in self.app_ids}
        if process_basename and process_basename in app_ids:
            return True
        if app and app in app_ids:
            return True
        if class_name and any(
            pattern.casefold() in class_name for pattern in self.window_class_patterns
        ):
            return True
        if title and any(
            _title_claims(pattern, title) for pattern in self.title_patterns
        ):
            return True
        return False


def _title_claims(pattern: str, title: str) -> bool:
    """A title pattern claims a window when the title IS the pattern or the
    pattern leads the title (separator follows) — a bare substring match
    claimed '微信使用技巧 - Chrome' as WeChat (perception-audit P2)."""
    folded_pattern = pattern.casefold()
    folded_title = title.casefold()
    if folded_title == folded_pattern:
        return True
    if not folded_title.startswith(folded_pattern):
        return False
    tail = folded_title[len(folded_pattern):]
    return not tail or tail[0] in (" ", "-", "—", ":", "：", "·", "/", "|", "_")


def load_manifest(path: Path) -> SurfaceAdapterManifest:
    """Load + validate one manifest JSON; raises on malformed input."""
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    manifest = SurfaceAdapterManifest.from_dict(data)
    expected_id = path.stem.split(".")[0]
    if manifest.id != expected_id:
        raise ValueError(
            f"surface adapter manifest id {manifest.id!r} must match file name {expected_id!r}"
        )
    return manifest
