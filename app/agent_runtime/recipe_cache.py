"""Recipe cache: compile recipe manifests into loop trajectories (L1 JIT).

Per ``docs/harness-gap-review-20260812.md`` L1: *recipe is the cache, the
loop is the interpreter*. A manifest entry is compiled into a
:class:`~app.agent_runtime.types.Trajectory` (guided first message,
recommended tool vocabulary, turn budget, risk) that the agent loop can
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

    def match_keywords(
        self, text: str, lang: str = "zh"
    ) -> list[tuple[str, float]]:
        """Rank recipes by keyword hits: full set 1.0, any hit 0.5, none [].

        Results are (recipe_id, score) pairs sorted by score descending,
        recipe id ascending as the tiebreaker.
        """
        if not text:
            return []
        if not self._compiled:
            self.compile_all()
        results: list[tuple[str, float]] = []
        for recipe_id, entry in self._raw_by_id.items():
            keywords = (entry.get("keywords") or {}).get(lang)
            if not isinstance(keywords, list) or not keywords:
                continue
            hits = [kw for kw in keywords if isinstance(kw, str) and kw in text]
            if not hits:
                continue
            score = _FULL_MATCH_SCORE if len(hits) == len(keywords) else _PARTIAL_MATCH_SCORE
            results.append((recipe_id, score))
        results.sort(key=lambda item: (-item[1], item[0]))
        return results

    def all_ids(self) -> list[str]:
        if not self._compiled:
            self.compile_all()
        return list(self._compiled)

    def _compile_entry(self, entry: dict) -> Trajectory:
        recipe_id = entry["id"]
        input_kinds = [k for k in entry["inputKinds"] if isinstance(k, str) and k]
        first_user_message = _FIRST_MESSAGE_TEMPLATE.format(
            description=entry["description"].rstrip("。"),
            input_kinds="、".join(input_kinds),
        )
        strategies = [s for s in entry["providerStrategies"] if isinstance(s, str)]
        risk = entry["risk"]
        provider = entry.get("provider") or ""
        external_send = (
            "external_send" in {risk, provider} or "external_send" in strategies
        )
        try:
            min_objects = int(entry.get("minObjects", 0))
        except (TypeError, ValueError):
            min_objects = 0
        max_turns = 4 if (min_objects >= 2 or external_send) else 3
        return Trajectory(
            recipe_id=recipe_id,
            first_user_message=first_user_message,
            recommended_tools=self._recommended_tools(strategies),
            max_turns=max_turns,
            risk=risk,
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


__all__ = ["BUILTIN_RECIPES_PATH", "TrajectoryCompiler"]
