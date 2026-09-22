
from __future__ import annotations

from app.fabric.catalog import (
    NON_DESTINATION_OUTPUT_KINDS,
    NON_DESTINATION_RECIPES,
    RECIPE_CATALOG,
    is_non_destination_recipe,
)


def load_recipes():
    return RECIPE_CATALOG


def _recipes():
    return {recipe.id: recipe for recipe in load_recipes()}


def test_the_recipe_that_hijacked_the_question_is_not_a_destination() -> None:
    assert is_non_destination_recipe(_recipes()["element.pick"]) is True


def test_locking_an_object_was_never_a_destination_and_still_is_not() -> None:
    assert is_non_destination_recipe(_recipes()["ground.this"]) is True


def test_real_capabilities_remain_reachable() -> None:
    recipes = _recipes()
    for recipe_id in ("image.to_prompt", "selection.expand", "screen.translate"):
        if recipe_id in recipes:
            assert is_non_destination_recipe(recipes[recipe_id]) is False, recipe_id


def test_every_grounded_object_recipe_is_excluded_by_kind_not_by_name() -> None:
    assert "grounded_object" in NON_DESTINATION_OUTPUT_KINDS
    for recipe in load_recipes():
        if recipe.output_kind in NON_DESTINATION_OUTPUT_KINDS:
            assert is_non_destination_recipe(recipe) is True, recipe.id


def test_the_named_exceptions_still_hold() -> None:
    recipes = _recipes()
    for recipe_id in NON_DESTINATION_RECIPES:
        if recipe_id in recipes:
            assert is_non_destination_recipe(recipes[recipe_id]) is True, recipe_id
