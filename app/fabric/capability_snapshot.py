from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Sequence

from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.engine import provider_for_recipe
from app.fabric.schema import RecipeDefinition


CapabilityState = Literal[
    "ready",
    "needs_setup",
    "needs_agent",
    "experimental",
    "blocked",
    "unavailable",
]

AGENT_PROVIDERS = frozenset({
    "codex", "pi", "claude", "gemini", "cursor", "opencode", "aider", "generic",
})
EXPERIMENTAL_PROVIDERS = frozenset({
    "omniparser", "vision_model", "vision_ocr", "vision_math", "vision_table",
    "vision_digitizer", "vision_place", "image_model", "canvas_agent",
})
EXPERIMENTAL_RECIPES = frozenset({"vision.prompt_bridge"})


@dataclass(frozen=True)
class CapabilityStatus:
    id: str
    state: CapabilityState
    reason: str
    evidence: dict[str, Any]
    repair_action: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "reason": self.reason,
            "evidence": dict(self.evidence),
            "repairAction": None if self.repair_action is None else dict(self.repair_action),
        }


@dataclass(frozen=True)
class CapabilitySnapshot:
    platform: str
    capabilities: tuple[CapabilityStatus, ...]

    def by_id(self, capability_id: str) -> CapabilityStatus:
        for status in self.capabilities:
            if status.id == capability_id:
                return status
        raise KeyError(f"unknown capability: {capability_id}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "platform": self.platform,
            "capabilities": [status.to_dict() for status in self.capabilities],
        }


def _current_platform() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def _repair(target: str, reason: str) -> dict[str, str]:
    return {"type": "open_settings", "target": target, "reason": reason}


def _status_for_recipe(
    recipe: RecipeDefinition,
    *,
    platform: str,
    provider_availability: Mapping[str, bool],
    verifier_availability: Mapping[str, bool],
    permission_availability: Mapping[str, bool],
    required_permissions: Mapping[str, Sequence[str]],
) -> CapabilityStatus:
    providers = tuple(recipe.provider_strategies)
    available = tuple(provider for provider in providers if provider_availability.get(provider) is True)
    permissions = tuple(required_permissions.get(recipe.id, ()))
    missing_permissions = tuple(
        permission for permission in permissions if permission_availability.get(permission) is not True
    )
    verifier_ready = verifier_availability.get(recipe.verification) is True
    evidence = {
        "platform": platform,
        "platformSupported": platform in recipe.platforms,
        "providerStrategies": list(providers),
        "availableProviders": list(available),
        "verification": recipe.verification,
        "verifierReady": verifier_ready,
        "requiredPermissions": list(permissions),
        "missingPermissions": list(missing_permissions),
    }

    if platform not in recipe.platforms:
        return CapabilityStatus(recipe.id, "unavailable", "platform_unsupported", evidence)
    if not available:
        if AGENT_PROVIDERS.intersection(providers):
            return CapabilityStatus(
                recipe.id,
                "needs_agent",
                "agent_provider_unavailable",
                evidence,
                _repair("agents", "agent_provider_unavailable"),
            )
        return CapabilityStatus(
            recipe.id,
            "needs_setup",
            "provider_unavailable",
            evidence,
            _repair("connections", "provider_unavailable"),
        )
    if missing_permissions:
        return CapabilityStatus(
            recipe.id,
            "blocked",
            "permission_unavailable",
            evidence,
            _repair("permissions", "permission_unavailable"),
        )
    if not verifier_ready:
        return CapabilityStatus(
            recipe.id,
            "blocked",
            "verifier_unavailable",
            evidence,
            _repair("diagnostics", "verifier_unavailable"),
        )
    if recipe.id in EXPERIMENTAL_RECIPES or all(
        provider in EXPERIMENTAL_PROVIDERS for provider in available
    ):
        return CapabilityStatus(
            recipe.id,
            "experimental",
            "experimental_provider",
            evidence,
            _repair("capabilities", "experimental_provider"),
        )
    return CapabilityStatus(recipe.id, "ready", "executable_and_verifiable", evidence)


def build_capability_snapshot(
    *,
    provider_availability: Mapping[str, bool],
    verifier_availability: Mapping[str, bool],
    permission_availability: Mapping[str, bool] | None = None,
    required_permissions: Mapping[str, Sequence[str]] | None = None,
    platform: str | None = None,
    recipes: Sequence[RecipeDefinition] = RECIPE_CATALOG,
) -> CapabilitySnapshot:
    current_platform = str(platform or _current_platform()).strip().casefold()
    permissions = permission_availability or {}
    requirements = required_permissions or {}
    statuses = tuple(
        _status_for_recipe(
            recipe,
            platform=current_platform,
            provider_availability=provider_availability,
            verifier_availability=verifier_availability,
            permission_availability=permissions,
            required_permissions=requirements,
        )
        for recipe in recipes
    )
    return CapabilitySnapshot(platform=current_platform, capabilities=statuses)


_LOCAL_EXECUTORS = frozenset({
    "internal",
    "clipboard",
    "native.ocr",
    "artifact.table",
    "artifact.evidence",
    "artifact.compare",
    "artifact.visual_context",
    "artifact.list",
    "local.task",
    "maps.deep_link",
})


def _engine_provider_for_recipe(
    recipe_id: str,
    *,
    agent_available: bool,
    ocr_available: bool,
    voice_available: bool,
) -> tuple[str, str]:
    provider = provider_for_recipe(recipe_id)
    if recipe_id in {"text.ocr_copy", "text.ocr_clean"}:
        if ocr_available:
            return "native.ocr", "local_ocr_available"
        if agent_available:
            return "agent.task", "native_ocr_missing_agent_fallback"
        return "unavailable:native_ocr_not_configured", "native_ocr_not_configured"
    if recipe_id == "voice.short_command":
        return (
            ("voice.resident", "resident_voice_worker_ready")
            if voice_available
            else ("unavailable:speech_provider_not_configured", "voice_worker_not_ready")
        )
    if recipe_id == "vision.prompt_bridge":
        return "artifact.visual_context", "structured_visual_context_only"
    if provider == "agent.task":
        return (
            (provider, "agent_executable_found")
            if agent_available
            else ("unavailable:agent_not_available", "agent_not_available")
        )
    if provider == "inplace.text":
        # No agent fallback, for the same reason engine.py refuses one: an agent
        # asked to "rewrite this in place" writes somewhere else, leaving the
        # user's own text untouched. Reporting it as agent-executable would
        # advertise a capability that cannot be delivered.
        return provider, "engine_provider_contract"
    if provider == "model.text" or provider.startswith("unavailable:"):
        if agent_available:
            return "agent.task", "agent_fallback_available"
    return provider, "engine_provider_contract"


def _permission_decision(recipe: RecipeDefinition, permission_defaults: Mapping[str, str]) -> str:
    key = {
        "read": "default_read",
        "local_write": "default_write",
        "external_send": "default_send",
        "destructive": "default_destructive",
        "purchase": "default_purchase",
    }[recipe.risk.value]
    return str(permission_defaults.get(key) or "confirm")


def build_engine_capability_snapshot(
    *,
    agent_availability: Mapping[str, bool],
    ocr_available: bool,
    voice_available: bool,
    recipe_enabled: Mapping[str, bool] | None = None,
    permission_defaults: Mapping[str, str] | None = None,
    permission_overrides: Mapping[str, str] | None = None,
    platform: str | None = None,
    recipes: Sequence[RecipeDefinition] = RECIPE_CATALOG,
) -> CapabilitySnapshot:
    """Describe the providers the current FabricEngine can actually dispatch.

    This intentionally does not infer availability from the public recipe's
    aspirational provider list.  It uses the engine dispatch contract, cheap
    local executable/module evidence, and the persisted policy only.
    """
    current_platform = str(platform or _current_platform()).strip().casefold()
    enabled = recipe_enabled or {}
    defaults = permission_defaults or {}
    overrides = permission_overrides or {}
    available_agents = sorted(
        provider for provider, available in agent_availability.items() if available is True
    )
    any_agent = bool(available_agents)
    statuses: list[CapabilityStatus] = []
    for recipe in recipes:
        provider, provider_reason = _engine_provider_for_recipe(
            recipe.id,
            agent_available=any_agent,
            ocr_available=ocr_available,
            voice_available=voice_available,
        )
        permission = str(overrides.get(recipe.id) or _permission_decision(recipe, defaults))
        executable = (
            provider in _LOCAL_EXECUTORS
            or provider in {"agent.task", "voice.resident"}
        )
        evidence = {
            "platform": current_platform,
            "platformSupported": current_platform in recipe.platforms,
            "engineProvider": provider,
            "providerReason": provider_reason,
            "availableAgents": available_agents,
            "ocrAvailable": ocr_available,
            "voiceAvailable": voice_available,
            "verification": recipe.verification,
            "verifierReady": executable,
            "permissionDecision": permission,
            "recipeEnabled": enabled.get(recipe.id, True) is not False,
        }
        if current_platform not in recipe.platforms:
            status = CapabilityStatus(recipe.id, "unavailable", "platform_unsupported", evidence)
        elif enabled.get(recipe.id, True) is False:
            status = CapabilityStatus(
                recipe.id,
                "blocked",
                "recipe_disabled",
                evidence,
                _repair("capabilities", "recipe_disabled"),
            )
        elif permission == "deny":
            status = CapabilityStatus(
                recipe.id,
                "blocked",
                "permission_denied_by_policy",
                evidence,
                _repair("permissions", "permission_denied_by_policy"),
            )
        elif provider.startswith("unavailable:agent"):
            status = CapabilityStatus(
                recipe.id,
                "needs_agent",
                provider.split(":", 1)[1],
                evidence,
                _repair("agents", "agent_provider_unavailable"),
            )
        elif provider.startswith("unavailable:"):
            status = CapabilityStatus(
                recipe.id,
                "needs_setup",
                provider.split(":", 1)[1],
                evidence,
                _repair("connections", provider.split(":", 1)[1]),
            )
        elif recipe.id in EXPERIMENTAL_RECIPES:
            status = CapabilityStatus(
                recipe.id,
                "experimental",
                provider_reason,
                evidence,
                _repair("capabilities", "experimental_provider"),
            )
        elif executable:
            status = CapabilityStatus(recipe.id, "ready", provider_reason, evidence)
        else:
            status = CapabilityStatus(
                recipe.id,
                "needs_setup",
                "executor_not_wired",
                evidence,
                _repair("connections", "executor_not_wired"),
            )
        statuses.append(status)
    return CapabilitySnapshot(platform=current_platform, capabilities=tuple(statuses))
