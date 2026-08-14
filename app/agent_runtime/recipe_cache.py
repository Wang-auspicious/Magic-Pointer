"""Recipe cache: compile recipe manifests into loop trajectories (L1 JIT).

Per ``docs/harness-gap-review-20260812.md`` L1: *recipe is the cache, the
loop is the interpreter*. A manifest entry is compiled into a
:class:`~app.agent_runtime.types.Trajectory` (guided first message,
recommended tool vocabulary, risk) that the agent loop can
consume. Manifests are read-only inputs; nothing here mutates them.

Honesty rules:
- Entries with a missing id or missing compile-required fields are skipped
  and recorded in ``errors`` — never silently dropped.
- An unknown recipe id returns ``None`` (no fabricated empty trajectory).
- A missing manifest file raises ``FileNotFoundError`` at construction —
  never an empty catalog.

Pure Python, stdlib-only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.agent_runtime.types import Trajectory

BUILTIN_RECIPES_PATH = (
    Path(__file__).resolve().parents[2] / "data" / "recipes" / "builtin.recipes.json"
)

_FULL_MATCH_SCORE = 1.0
_PARTIAL_MATCH_SCORE = 0.5


def score_keyword_entry(keywords: Any, text: str, lang: str) -> tuple[float | None, list[str]]:
    """Score one manifest entry's keyword sets against ``text``.

    Matching is case-insensitive. The default ``lang="zh"`` covers zh+en as an
    unordered union (the legacy router scored both languages unconditionally);
    an explicit ``lang`` matches only that set. Per set: all keywords hit ->
    1.0, any hit -> 0.5, none -> no match. The returned score is the best
    across sets, with the matched keywords in their original casing.

    Returns ``(None, [])`` when nothing hits.
    """
    folded = str(text).casefold()
    languages = ("zh", "en") if lang == "zh" else (lang,)
    best: float | None = None
    hits: list[str] = []
    if not isinstance(keywords, dict):
        return None, []
    for lang_name in languages:
        kws = keywords.get(lang_name)
        if not isinstance(kws, list) or not kws:
            continue
        tokens = [k for k in kws if isinstance(k, str) and k]
        matched = [k for k in tokens if k.casefold() in folded]
        if not matched:
            continue
        set_score = _FULL_MATCH_SCORE if len(matched) == len(tokens) else _PARTIAL_MATCH_SCORE
        if best is None or set_score > best:
            best = set_score
        hits.extend(matched)
    return (best, hits) if best is not None else (None, [])


_BASE_TOOL = "describe_capabilities"
"""Every trajectory exposes the capability-discovery tool (L16)."""

_PROVIDER_TOOL_MAP: dict[str, str | None] = {
    "structured_grounder": "read_around",
    "vision_fallback": "look",
    "native_ocr": "read_around",
    "model_provider": None,
    "office_adapter": None,
}
"""Provider strategy -> suggested loop tool; None/unknown map to nothing."""

_REQUIRED_FIELDS = ("id", "description", "inputKinds", "providerStrategies", "risk")

_FIRST_MESSAGE_TEMPLATE = (
    "目标：{description}。对象：{input_kinds}。请执行该任务，必要时使用感知工具确认对象。"
)


class TrajectoryCompiler:
    """Compile recipe manifest entries into loop-consumable trajectories."""

    def __init__(self, recipes_path: Path | None = None) -> None:
        self._path = (
            BUILTIN_RECIPES_PATH if recipes_path is None else Path(recipes_path)
        )
        if not self._path.is_file():
            raise FileNotFoundError(f"recipe manifest not found: {self._path}")
        try:
            with self._path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except json.JSONDecodeError as exc:
            raise ValueError(f"recipe manifest is not valid JSON: {self._path}") from exc
        if not isinstance(data, dict) or not isinstance(data.get("recipes"), list):
            raise ValueError(f"recipe manifest has no 'recipes' list: {self._path}")
        self._raw_recipes: list[Any] = data["recipes"]
        self._compiled: dict[str, Trajectory] = {}
        self._raw_by_id: dict[str, dict] = {}
        self.errors: list[str] = []

    def compile_all(self) -> dict[str, Trajectory]:
        """Compile every manifest entry; skip and record corrupt ones."""
        self._compiled = {}
        self._raw_by_id = {}
        self.errors = []
        for index, entry in enumerate(self._raw_recipes):
            if not isinstance(entry, dict):
                self.errors.append(f"recipe entry at index {index} is not an object")
                continue
            missing = [f for f in _REQUIRED_FIELDS if not entry.get(f)]
            if missing:
                label = entry.get("id", f"<index {index}>")
                self.errors.append(f"recipe {label} missing field(s): {missing}")
                continue
            trajectory = self._compile_entry(entry)
            recipe_id = trajectory.recipe_id
            assert recipe_id is not None
            self._compiled[recipe_id] = trajectory
            self._raw_by_id[recipe_id] = entry
        return dict(self._compiled)

    def compile_trajectory(self, recipe_id: str) -> Trajectory | None:
        """Return the compiled trajectory for ``recipe_id`` or None (honest)."""
        if not self._compiled:
            self.compile_all()
        return self._compiled.get(recipe_id)

    def match_keywords(self, text: str, lang: str = "zh") -> list[tuple[str, float]]:
        """Rank recipes by keyword hits: full set 1.0, any hit 0.5, none [].

        Default ``lang="zh"`` scores the zh+en keyword union (legacy router
        behaviour); ``lang="en"`` matches the en set only. Matching is
        case-insensitive. Results are (recipe_id, score) pairs sorted by
        score descending, recipe id ascending as the tiebreaker.
        """
        if not text:
            return []
        if not self._compiled:
            self.compile_all()
        results: list[tuple[str, float]] = []
        for recipe_id, entry in self._raw_by_id.items():
            score, _ = score_keyword_entry(entry.get("keywords"), text, lang)
            if score is None:
                continue
            results.append((recipe_id, score))
        results.sort(key=lambda item: (-item[1], item[0]))
        return results

    def compile_extra_entry(self, recipe_id: str, entry: dict) -> Trajectory | None:
        """Compile a plugin/instruction-library entry without registering it.

        ``entry`` is a manifest-shaped dict keyed by ``recipe_id``; the id is
        forced onto the entry so the compiled trajectory always matches the
        key. Returns None (honest) for a missing id or missing compile-required
        fields; never raises.
        """
        if not isinstance(recipe_id, str) or not recipe_id:
            return None
        if not isinstance(entry, dict):
            return None
        missing = [f for f in _REQUIRED_FIELDS if not entry.get(f)]
        if missing:
            return None
        working = dict(entry)
        working["id"] = recipe_id
        return self._compile_entry(working)

    def all_ids(self) -> list[str]:
        if not self._compiled:
            self.compile_all()
        return list(self._compiled)

    def matched_keywords(self, recipe_id: str, text: str, lang: str = "zh") -> list[str]:
        """The manifest keywords of ``recipe_id`` that hit ``text``.

        Public counterpart of :meth:`match_keywords` (same raw entries, same
        scoring semantics), so callers can report *why* a recipe matched
        without reading compiler internals. Returns [] for unknown recipes
        or no hits; the matched keywords keep their original casing.
        """
        if not text:
            return []
        if not self._compiled:
            self.compile_all()
        entry = self._raw_by_id.get(recipe_id)
        if not isinstance(entry, dict):
            return []
        _, hits = score_keyword_entry(entry.get("keywords"), text, lang)
        return hits

    def _compile_entry(self, entry: dict) -> Trajectory:
        recipe_id = entry["id"]
        input_kinds = [k for k in entry["inputKinds"] if isinstance(k, str) and k]
        first_user_message = _FIRST_MESSAGE_TEMPLATE.format(
            description=entry["description"].rstrip("。"),
            input_kinds="、".join(input_kinds),
        )
        strategies = [s for s in entry["providerStrategies"] if isinstance(s, str)]
        risk = entry["risk"]
        return Trajectory(
            recipe_id=recipe_id,
            first_user_message=first_user_message,
            recommended_tools=self._recommended_tools(strategies),
            risk=_risk_label(risk),
        )

    @staticmethod
    def _recommended_tools(strategies: list[str]) -> tuple[str, ...]:
        tools: list[str] = [_BASE_TOOL]
        seen = {_BASE_TOOL}
        for strategy in strategies:
            tool = _PROVIDER_TOOL_MAP.get(strategy)
            if tool is None or tool in seen:
                continue
            seen.add(tool)
            tools.append(tool)
        return tuple(tools)


def _risk_label(risk: Any) -> str:
    """A stable string label for the trajectory risk field."""
    if isinstance(risk, str):
        return risk
    if isinstance(risk, (list, tuple)):
        return ",".join(str(t) for t in risk)
    return "read"


__all__ = ["BUILTIN_RECIPES_PATH", "TrajectoryCompiler", "score_keyword_entry"]
