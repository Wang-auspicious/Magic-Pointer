"""The recipe catalog. Loaded from JSON manifests, not hardcoded here.

The tuples that used to live in this file are now
`data/recipes/builtin.recipes.json`, and plugins can add their own manifests
without a rebuild (see `recipe_manifest.py`). Every existing import —
`get_recipe`, `RECIPE_CATALOG`, `public_recipe_catalog` — keeps working
unchanged.
"""

from __future__ import annotations

from app.fabric.recipe_manifest import RecipeManifestError, load_all_recipes
from app.fabric.schema import JsonDict, RecipeDefinition

RECIPE_CATALOG: tuple[RecipeDefinition, ...]
CATALOG_WARNINGS: list[str]

RECIPE_CATALOG, CATALOG_WARNINGS = load_all_recipes()

_BY_ID = {recipe.id: recipe for recipe in RECIPE_CATALOG}

# These recipes are plumbing or task-state operations, not destinations the
# model should be offered as user-facing capabilities.  Keep this catalogue
# judgement next to recipe metadata; natural-language routing no longer owns it.
NON_DESTINATION_RECIPES = frozenset({
    "activate.wiggle",
    "ground.this",
    "ground.references",
    "governance.dashboard",
    "integration.mcp",
    "voice.short_command",
})
NON_DESTINATION_OUTPUT_KINDS = frozenset({
    "activation_intent",
    "grounded_object",
    "interaction_episode",
})


def is_non_destination_recipe(recipe: object) -> bool:
    if str(getattr(recipe, "id", "") or "") in NON_DESTINATION_RECIPES:
        return True
    return str(getattr(recipe, "output_kind", "") or "") in NON_DESTINATION_OUTPUT_KINDS


def reload_catalog() -> list[str]:
    """Re-read the manifests (after installing a plugin) and return warnings."""
    global RECIPE_CATALOG, CATALOG_WARNINGS, _BY_ID
    RECIPE_CATALOG, CATALOG_WARNINGS = load_all_recipes()
    _BY_ID = {recipe.id: recipe for recipe in RECIPE_CATALOG}
    return list(CATALOG_WARNINGS)


def get_recipe(recipe_id: str) -> RecipeDefinition:
    try:
        return _BY_ID[recipe_id]
    except KeyError as exc:
        raise KeyError(f"unknown recipe: {recipe_id}") from exc


def has_recipe(recipe_id: str) -> bool:
    return recipe_id in _BY_ID


def public_recipe_catalog() -> list[JsonDict]:
    return [recipe.to_public_dict() for recipe in RECIPE_CATALOG]


__all__ = [
    "CATALOG_WARNINGS",
    "NON_DESTINATION_OUTPUT_KINDS",
    "NON_DESTINATION_RECIPES",
    "RECIPE_CATALOG",
    "RecipeManifestError",
    "get_recipe",
    "has_recipe",
    "is_non_destination_recipe",
    "public_recipe_catalog",
    "reload_catalog",
]
