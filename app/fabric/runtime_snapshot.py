from __future__ import annotations

import importlib.util
import shutil
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from app.fabric.capability_snapshot import build_engine_capability_snapshot
from app.fabric.catalog import public_recipe_catalog
from app.fabric.settings import FabricSettings
from app.models.capability_resolver import ModelCapabilityResolver


_AGENT_COMMANDS = {
    "codex": "codex",
    "pi": "pi",
    "claude": "claude",
    "gemini": "gemini",
    "cursor": "cursor-agent",
    "opencode": "opencode",
    "aider": "aider",
}


def _platform_name() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def build_runtime_snapshot(
    *,
    settings: FabricSettings,
    runtime_evidence: dict[str, Any] | None = None,
    which: Callable[[str], str | None] = shutil.which,
) -> dict[str, Any]:
    evidence = dict(runtime_evidence or {})
    voice = dict(evidence.get("voiceWorker") or {})
    permissions = dict(evidence.get("permissions") or {})
    agents = {
        provider: {
            "state": "ready" if which(command) else "unavailable",
            "command": command,
            "source": "path_lookup",
        }
        for provider, command in _AGENT_COMMANDS.items()
    }
    agent_availability = {
        provider: item["state"] == "ready" for provider, item in agents.items()
    }
    ocr_available = _module_available("rapidocr") or which("tesseract") is not None
    voice_available = str(voice.get("state") or "") == "ready"
    permission_settings = settings.permissions
    capabilities = build_engine_capability_snapshot(
        agent_availability=agent_availability,
        ocr_available=ocr_available,
        voice_available=voice_available,
        recipe_enabled=settings.recipe_enabled,
        permission_defaults={
            "default_read": permission_settings.default_read,
            "default_write": permission_settings.default_write,
            "default_send": permission_settings.default_send,
            "default_destructive": permission_settings.default_destructive,
            "default_purchase": permission_settings.default_purchase,
        },
        permission_overrides=permission_settings.recipe_overrides,
        platform=_platform_name(),
    )
    statuses = capabilities.to_dict()["capabilities"]
    repairs: list[dict[str, Any]] = []
    seen_repairs: set[tuple[str, str, str]] = set()
    for item in statuses:
        repair = item.get("repairAction")
        if not isinstance(repair, dict):
            continue
        key = (
            str(repair.get("type") or ""),
            str(repair.get("target") or ""),
            str(repair.get("reason") or ""),
        )
        if key not in seen_repairs:
            seen_repairs.add(key)
            repairs.append(dict(repair))
    resolver = ModelCapabilityResolver()
    model_items = [
        replace(profile, resolved=resolver.resolve(profile)).to_dict()
        for profile in settings.models.profiles
    ]
    blocked = sum(item["state"] in {"blocked", "unavailable"} for item in statuses)
    return {
        "readiness": {
            "state": "ready" if blocked == 0 else "degraded",
            "blockedCapabilityCount": blocked,
            "source": "bounded_local_probe",
        },
        "workers": {
            "voice": voice or {"state": "unknown"},
            "agents": agents,
        },
        "models": {
            "items": model_items,
            "defaultProfileId": settings.models.default_profile_id,
            "source": "persisted_profiles_and_local_resolution",
        },
        "permissions": permissions,
        "capabilities": statuses,
        "repairs": repairs,
        "diagnostics": {
            "source": "runtime_snapshot_v1",
            "platform": _platform_name(),
            "networkRequests": 0,
            "spawnedProcesses": 0,
            "probeKind": "filesystem_and_module_presence_only",
        },
        "settings": settings.to_dict(),
        "recipes": public_recipe_catalog(),
    }
