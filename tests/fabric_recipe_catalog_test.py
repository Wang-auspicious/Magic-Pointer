from __future__ import annotations

import json
from pathlib import Path

from app.fabric.catalog import RECIPE_CATALOG, get_recipe, public_recipe_catalog
from app.fabric.schema import RiskLevel


def test_catalog_entries_are_concrete_and_unique() -> None:
    # The count is no longer pinned: recipes live in JSON manifests now, so a
    # new capability adds a manifest entry rather than editing Python. What must
    # hold is that every entry is complete and no id repeats.
    assert len(RECIPE_CATALOG) >= 30
    ids = [recipe.id for recipe in RECIPE_CATALOG]
    assert len(ids) == len(set(ids))

    for recipe in RECIPE_CATALOG:
        assert recipe.id
        assert recipe.title_zh
        assert recipe.description_zh
        assert recipe.input_kinds
        assert recipe.output_kind
        assert recipe.provider_strategies
        assert recipe.verification
        assert recipe.keywords_zh or recipe.keywords_en
        assert isinstance(recipe.risk, RiskLevel)
        assert recipe.min_objects >= 0
        assert recipe.max_objects >= recipe.min_objects


def test_catalog_covers_activation_transform_routing_and_governance() -> None:
    expected = {
        "activate.wiggle",
        "ground.this",
        "ground.references",
        "text.ocr_copy",
        "text.rewrite_in_place",
        "table.to_spreadsheet",
        "image.compose",
        "calendar.create_from_screen",
        "agent.handoff",
        "agent.background_task",
        "integration.mcp",
        "governance.dashboard",
    }
    assert expected.issubset({recipe.id for recipe in RECIPE_CATALOG})


def test_public_catalog_is_serializable_and_excludes_matcher_internals() -> None:
    item = public_recipe_catalog()[0]
    assert isinstance(item, dict)
    assert set(item) >= {
        "id",
        "title",
        "description",
        "inputKinds",
        "outputKind",
        "providerStrategies",
        "risk",
        "verification",
    }
    assert "keywords_zh" not in item
    assert get_recipe(item["id"]).id == item["id"]



def test_catalog_is_loaded_from_the_json_manifest_not_hardcoded() -> None:
    """Recipes are data. A plugin (or a saved instruction) must be able to add
    one without a rebuild, which is only true while this stays a manifest."""
    manifest = Path(__file__).resolve().parents[1] / "data" / "recipes" / "builtin.recipes.json"
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    assert raw["schemaVersion"] == 1
    manifest_ids = {entry["id"] for entry in raw["recipes"]}
    assert manifest_ids.issubset({recipe.id for recipe in RECIPE_CATALOG})
    assert len(manifest_ids) == len(raw["recipes"])
