from __future__ import annotations

import re
import sys
from typing import Any, Iterable

from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.schema import RecipeDefinition


_TOKEN_RE = re.compile(r"[a-z0-9_.-]+|[\u3400-\u9fff]", re.IGNORECASE)


def _tokens(value: str) -> set[str]:
    return {item.casefold() for item in _TOKEN_RE.findall(str(value or ""))}


def _object_kinds(objects: Iterable[dict[str, Any]]) -> set[str]:
    return {
        str(item.get("kind") or "").strip().casefold()
        for item in objects
        if isinstance(item, dict) and str(item.get("kind") or "").strip()
    }


def _kind_compatibility(input_kind: str, object_kinds: set[str]) -> float:
    value = input_kind.casefold()
    if value in object_kinds:
        return 4.0
    visual = {"image", "screen_region", "chart_image", "formula_image", "video_frame"}
    textual = {"text", "text_selection", "document_region", "recipe_text", "entity"}
    if value in visual and object_kinds.intersection(visual):
        return 2.0
    if value in textual and object_kinds.intersection(textual):
        return 2.0
    if value == "grounded_object" and object_kinds:
        return 1.5
    return 0.0


def _score(
    recipe: RecipeDefinition,
    *,
    command: str,
    kinds: set[str],
    selected_recipe_id: str | None,
    platform: str,
) -> float:
    score = 1000.0 if recipe.id == selected_recipe_id else 0.0
    command_folded = str(command or "").casefold()
    command_tokens = _tokens(command_folded)
    recipe_tokens = _tokens(
        " ".join((
            recipe.id,
            recipe.title_zh,
            recipe.description_zh,
            *recipe.keywords_zh,
            *recipe.keywords_en,
        ))
    )
    score += len(command_tokens.intersection(recipe_tokens)) * 1.25
    for keyword in (*recipe.keywords_zh, *recipe.keywords_en):
        token = keyword.casefold().strip()
        if token and token in command_folded:
            score += 3.0 + min(len(token), 16) / 8.0
    score += max(
        (_kind_compatibility(item, kinds) for item in recipe.input_kinds),
        default=0.0,
    )
    if platform in recipe.platforms:
        score += 0.5
    return max(0.0, score)


def _availability(
    recipe: RecipeDefinition,
    provider_availability: dict[str, bool] | None,
) -> tuple[str, bool | None, list[str]]:
    if provider_availability is None:
        return "unknown", None, []
    available = [
        provider
        for provider in recipe.provider_strategies
        if provider_availability.get(provider) is True
    ]
    return ("available" if available else "unavailable"), bool(available), available


class CapabilityRegistry:
    """Return a small, deterministic capability set for the current object and intent."""

    def search(
        self,
        command: str,
        *,
        objects: Iterable[dict[str, Any]] = (),
        selected_recipe_id: str | None = None,
        platform: str | None = None,
        provider_availability: dict[str, bool] | None = None,
        limit: int = 6,
    ) -> list[dict[str, Any]]:
        bounded_limit = max(3, min(int(limit), 8))
        current_platform = (
            str(platform).casefold()
            if platform
            else ("windows" if sys.platform.startswith("win") else "macos" if sys.platform == "darwin" else "linux")
        )
        kinds = _object_kinds(objects)
        ranked = sorted(
            (
                (
                    _score(
                        recipe,
                        command=command,
                        kinds=kinds,
                        selected_recipe_id=selected_recipe_id,
                        platform=current_platform,
                    ),
                    recipe,
                )
                for recipe in RECIPE_CATALOG
            ),
            key=lambda pair: (-pair[0], pair[1].id),
        )
        results: list[dict[str, Any]] = []
        for score, recipe in ranked[:bounded_limit]:
            availability, available, providers = _availability(recipe, provider_availability)
            results.append({
                "id": recipe.id,
                "title": recipe.title_zh,
                "description": recipe.description_zh,
                "inputKinds": list(recipe.input_kinds),
                "outputKind": recipe.output_kind,
                "risk": recipe.risk.value,
                "verification": recipe.verification,
                "providerStrategies": list(recipe.provider_strategies),
                "availability": availability,
                "available": available,
                "availableProviders": providers,
                "platformSupported": current_platform in recipe.platforms,
                "selected": recipe.id == selected_recipe_id,
                "score": round(score, 4),
            })
        return results
