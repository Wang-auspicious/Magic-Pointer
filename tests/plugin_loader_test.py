"""插件加载器：本地文件夹即插件，坏了必须说出来。

P3 #10。加载链路本身早就通了（`RECIPE_CATALOG` 启动即扫 plugins 目录），
真正缺的是**警告没有任何地方显示**——用户放了个坏插件，界面上什么都不会发生，
他分不清是插件写错了还是自己装错了位置。
"""

from __future__ import annotations

import json

import pytest

VALID_PLUGIN = {
    "version": 1,
    "recipes": [{
        "id": "demo.hello",
        "title": "插件冒烟能力",
        "description": "验证本地文件夹即插件。",
        "inputKinds": ["text_selection"],
        "outputKind": "clipboard_text",
        "providerStrategies": ["native_clipboard"],
        "risk": "read",
        "verification": "none",
        "keywords": {"zh": ["插件冒烟"], "en": ["plugin smoke"]},
        "minObjects": 1,
        "maxObjects": 1,
        "platforms": ["windows", "macos"],
        "version": 1,
        "provider": "internal",
    }],
}


@pytest.fixture()
def plugin_dir(tmp_path):
    directory = tmp_path / "recipes" / "plugins"
    directory.mkdir(parents=True)
    return directory


def _load(plugin_dir):
    from app.fabric.recipe_manifest import load_all_recipes

    return load_all_recipes(plugin_dir=plugin_dir)


def test_a_folder_of_recipes_becomes_capabilities(plugin_dir) -> None:
    (plugin_dir / "demo.recipes.json").write_text(json.dumps(VALID_PLUGIN), encoding="utf-8")
    recipes, warnings = _load(plugin_dir)
    ids = [recipe.id for recipe in recipes]
    assert "demo.hello" in ids
    assert warnings == []


def test_the_builtins_survive_a_plugin(plugin_dir) -> None:
    (plugin_dir / "demo.recipes.json").write_text(json.dumps(VALID_PLUGIN), encoding="utf-8")
    recipes, _ = _load(plugin_dir)
    assert "image.to_prompt" in [recipe.id for recipe in recipes]


def test_one_broken_plugin_does_not_disable_every_capability(plugin_dir) -> None:
    (plugin_dir / "demo.recipes.json").write_text(json.dumps(VALID_PLUGIN), encoding="utf-8")
    (plugin_dir / "broken.recipes.json").write_text("{ not json", encoding="utf-8")
    recipes, warnings = _load(plugin_dir)
    ids = [recipe.id for recipe in recipes]
    assert "demo.hello" in ids and "image.to_prompt" in ids
    assert len(warnings) == 1
    assert "broken.recipes.json" in warnings[0]


def test_a_broken_plugin_names_the_file_and_the_reason(plugin_dir) -> None:
    """"有个插件坏了"没有用；用户要知道是哪个文件、错在哪。"""
    (plugin_dir / "broken.recipes.json").write_text("{ not json", encoding="utf-8")
    _, warnings = _load(plugin_dir)
    assert "broken.recipes.json" in warnings[0]
    assert "JSON" in warnings[0] or "json" in warnings[0]


def test_no_plugin_folder_is_not_an_error(tmp_path) -> None:
    recipes, warnings = _load(tmp_path / "nothing" / "here")
    assert recipes and warnings == []


def test_the_warnings_reach_the_capability_snapshot() -> None:
    """本条是这次补的缺口：算出来了但没人看得见，等于没算。"""
    from app.fabric.capability_snapshot import build_capability_snapshot

    snapshot = build_capability_snapshot(
        provider_availability={},
        verifier_availability={},
    ).to_dict()
    assert "pluginWarnings" in snapshot
    assert isinstance(snapshot["pluginWarnings"], list)


def test_a_plugin_recipe_is_routable_like_any_other(plugin_dir) -> None:
    """插件能力如果进不了路由，加载成功也没有意义。"""
    recipes, _ = _load(plugin_dir)
    from app.fabric.intent_router import is_non_destination_recipe

    plugin_like = [recipe for recipe in recipes if recipe.output_kind == "clipboard_text"]
    assert plugin_like, "没有任何可路由的剪贴板类能力"
    assert all(not is_non_destination_recipe(recipe) for recipe in plugin_like)
