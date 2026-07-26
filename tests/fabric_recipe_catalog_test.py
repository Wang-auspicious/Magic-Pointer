from __future__ import annotations

from app.fabric.catalog import RECIPE_CATALOG, get_recipe, public_recipe_catalog
from app.fabric.schema import RiskLevel


def test_catalog_contains_thirty_concrete_unique_recipes() -> None:
    assert len(RECIPE_CATALOG) == 30
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

