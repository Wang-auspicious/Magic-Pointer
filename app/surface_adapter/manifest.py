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
        app_ids = tuple(
            str(item).strip() for item in data.get("app_ids") or [] if str(item).strip()
        )
        if not app_ids:
            raise ValueError("surface adapter manifest needs at least one app id")
        return cls(
            id=str(data["id"]).strip(),
            display_name=str(data["display_name"]).strip(),
            app_ids=app_ids,
            window_class_patterns=tuple(
                str(item).strip()
                for item in data.get("window_class_patterns") or []
                if str(item).strip()
            ),
            title_patterns=tuple(
                str(item).strip()
                for item in data.get("title_patterns") or []
                if str(item).strip()
            ),
            object_kinds=tuple(
                str(item).strip()
                for item in data.get("object_kinds") or []
                if str(item).strip()
            ) or ("surface_object",),
            capabilities=tuple(
                str(item).strip()
                for item in data.get("capabilities") or []
                if str(item).strip()
            ) or ("read_raw_objects",),
            version=int(data.get("version") or 1),
            notes=str(data.get("notes") or ""),
        )

    def matches_window(self, window: dict[str, Any]) -> bool:
        """True when this manifest claims the given window identity."""
        process = str(window.get("process_name") or "").casefold()
        app = str(window.get("app") or "").casefold()
        class_name = str(window.get("class_name") or "").casefold()
        title = str(window.get("title") or "").casefold()
        if not process and not class_name and not title:
            return False
        if any(app_id.casefold() in process for app_id in self.app_ids):
            return True
        if app and any(app_id.casefold() in app for app_id in self.app_ids):
            return True
        if class_name and any(
            pattern.casefold() in class_name for pattern in self.window_class_patterns
        ):
            return True
        if title and any(pattern.casefold() in title for pattern in self.title_patterns):
            return True
        return False


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
