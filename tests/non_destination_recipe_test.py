"""一个提问不能被"点选"这类感知步骤接走。

实测（2026-08-05，真微信）：在一条会话上划线并问「这是什么」，L2 把每条 recipe
当工具交给模型挑，模型挑了 `element.pick`，于是气泡回了一句

    点选元素追问：已锁定 1 个对象，provider=internal。 将直接执行并验证。

用户问的是"这是什么"，拿到的是一句关于我们内部状态的通告。

`element.pick` 的 outputKind 是 `grounded_object`——和早就被排除掉的 `ground.this`
一模一样。两者都是**把对象锁定下来**，而锁定在用户敲下这条指令之前就已经发生了。
所以判据不该是手工维护的名字清单（漏了一个就复发），而该是 recipe 自己声明的产物类型。
"""

from __future__ import annotations

from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.intent_router import (
    NON_DESTINATION_OUTPUT_KINDS,
    NON_DESTINATION_RECIPES,
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
    """新增一条产出 grounded_object 的能力时不该需要有人记得改名单。"""
    assert "grounded_object" in NON_DESTINATION_OUTPUT_KINDS
    for recipe in load_recipes():
        if recipe.output_kind in NON_DESTINATION_OUTPUT_KINDS:
            assert is_non_destination_recipe(recipe) is True, recipe.id


def test_the_named_exceptions_still_hold() -> None:
    recipes = _recipes()
    for recipe_id in NON_DESTINATION_RECIPES:
        if recipe_id in recipes:
            assert is_non_destination_recipe(recipes[recipe_id]) is True, recipe_id


def test_the_tool_list_offered_to_the_model_excludes_them() -> None:
    from app.fabric.intent_router import recipe_tool_schemas

    names = {
        str((tool.get("function") or {}).get("name") or "")
        for tool in recipe_tool_schemas()
    }
    assert names, "没有向模型提供任何工具"
    for recipe in load_recipes():
        if is_non_destination_recipe(recipe):
            from app.fabric.intent_router import tool_name_for_recipe

            assert tool_name_for_recipe(recipe.id) not in names, recipe.id
