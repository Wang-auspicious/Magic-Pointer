
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable

from app.fabric.schema import RecipeDefinition, RiskLevel

ROOT = Path(__file__).resolve().parents[2]
BUILTIN_MANIFEST_PATH = ROOT / "data" / "recipes" / "builtin.recipes.json"

REQUIRED_FIELDS = ("id", "title", "description", "inputKinds", "outputKind", "risk", "verification")


class RecipeManifestError(ValueError):
    pass


def _plugin_manifest_dir() -> Path:
    return Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime") / "recipes" / "plugins"


def _coerce_str_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    if isinstance(value, (list, tuple)):
        return tuple(str(item) for item in value if str(item).strip())
    raise RecipeManifestError(f"expected a string or list of strings, got {type(value).__name__}")


def _recipe_from_entry(entry: dict[str, Any], *, source: str) -> RecipeDefinition:
    missing = [field for field in REQUIRED_FIELDS if not entry.get(field)]
    if missing:
        raise RecipeManifestError(f"{source}: recipe missing required field(s) {missing}")
    try:
        risk = RiskLevel(str(entry["risk"]))
    except ValueError as exc:
        raise RecipeManifestError(f"{source}: unknown risk level {entry['risk']!r}") from exc

    keywords = entry.get("keywords") or {}
    if not isinstance(keywords, dict):
        raise RecipeManifestError(f"{source}: 'keywords' must be an object with zh/en lists")

    return RecipeDefinition(
        id=str(entry["id"]),
        title_zh=str(entry["title"]),
        description_zh=str(entry["description"]),
        input_kinds=_coerce_str_tuple(entry.get("inputKinds")),
        output_kind=str(entry["outputKind"]),
        provider_strategies=_coerce_str_tuple(entry.get("providerStrategies")),
        risk=risk,
        verification=str(entry["verification"]),
        provider=str(entry.get("provider") or "internal"),
        keywords_zh=_coerce_str_tuple(keywords.get("zh")),
        keywords_en=_coerce_str_tuple(keywords.get("en")),
        min_objects=int(entry.get("minObjects", 1)),
        max_objects=int(entry.get("maxObjects", 1)),
        platforms=_coerce_str_tuple(entry.get("platforms")) or ("windows", "macos"),
        version=int(entry.get("version", 1)),
    )


def load_manifest_file(path: Path) -> list[RecipeDefinition]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RecipeManifestError(f"{path}: could not be read ({exc})") from exc
    except ValueError as exc:
        raise RecipeManifestError(f"{path}: not valid JSON ({exc})") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("recipes"), list):
        raise RecipeManifestError(f"{path}: expected an object with a 'recipes' array")

    recipes: list[RecipeDefinition] = []
    for index, entry in enumerate(raw["recipes"]):
        if not isinstance(entry, dict):
            raise RecipeManifestError(f"{path}: recipes[{index}] must be an object")
        recipes.append(_recipe_from_entry(entry, source=f"{path}#{index}"))
    return recipes


def _discover_plugin_manifests(plugin_dir: Path) -> list[Path]:
    if not plugin_dir.is_dir():
        return []
    return sorted(plugin_dir.glob("*.recipes.json"))


def load_all_recipes(*, plugin_dir: Path | None = None) -> tuple[tuple[RecipeDefinition, ...], list[str]]:
    warnings: list[str] = []
    builtin = load_manifest_file(BUILTIN_MANIFEST_PATH)

    by_id: dict[str, RecipeDefinition] = {recipe.id: recipe for recipe in builtin}
    for path in _discover_plugin_manifests(plugin_dir if plugin_dir is not None else _plugin_manifest_dir()):
        try:
            plugin_recipes = load_manifest_file(path)
        except RecipeManifestError as exc:
            warnings.append(str(exc))
            continue
        for recipe in plugin_recipes:
            if recipe.id in by_id:
                warnings.append(f"{path}: recipe id '{recipe.id}' collides with an existing recipe, skipped")
                continue
            by_id[recipe.id] = recipe

    return tuple(by_id.values()), warnings


def iter_plugin_manifest_paths() -> Iterable[Path]:
    return _discover_plugin_manifests(_plugin_manifest_dir())
