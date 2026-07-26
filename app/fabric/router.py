from __future__ import annotations

import re

from app.fabric.catalog import RECIPE_CATALOG, get_recipe
from app.fabric.schema import IntentMatch, RecipeDefinition


_EXPLICIT_RE = re.compile(r"^\s*recipe\s*:\s*([a-z0-9_.-]+)\s*$", re.IGNORECASE)


class RecipeRouter:
    """Deterministic first-pass router. A model may only resolve remaining ambiguity."""

    def reference_mode(self, command: str) -> str:
        value = command.casefold()
        if any(token in value for token in ("这里", "这儿", "here")):
            return "here"
        if any(token in value for token in ("这些", "these")):
            return "these"
        if any(token in value for token in ("刚才那个", "上一个", "那个", "that", "previous")):
            return "that"
        return "this"

    def _priority_match(self, value: str) -> str | None:
        rules = (
            ("agent.background_task", ("在后台", "后台处理", "完成后提醒", "run in background")),
            ("research.evidence_card", ("保存到项目笔记", "保存这段和图", "证据卡", "research note")),
            ("image.compose", ("放进这个房间", "组合这两张", "放到这张图", "put this in")),
            ("image.style_transfer", ("用那张图的风格", "风格迁移", "变成这种风格", "style transfer")),
            ("canvas.transform", ("移动到这里", "挪到这里", "变成橙色", "make this orange")),
            ("formula.to_latex", ("latex", "公式", "mathml")),
            ("table.merge", ("两个表合并", "合并这些表", "表接起来", "merge tables")),
            ("table.to_spreadsheet", ("放进 excel", "转成 excel", "导出 csv", "to excel", "to csv")),
            ("text.ocr_clean", ("去掉空格", "清洗文字", "号码空格", "remove spaces")),
            ("text.translate_in_place", ("翻成", "翻译成", "译成", "translate")),
            ("text.rewrite_in_place", ("改得更正式", "改写", "润色", "重写", "rewrite")),
            ("calendar.create_from_screen", ("加到日历", "创建日程", "安排会议", "add to calendar")),
            ("map.route", ("怎么走", "路线", "从这里到", "导航", "directions")),
            ("agent.handoff", ("让 codex", "让 pi", "让 claude", "让 gemini", "agent 修", "修这个", "send to codex")),
            ("text.ocr_copy", ("识别这个屏幕对象中的文字", "复制这段文字", "识别文字", "提取文字", "复制这段", "copy text", "ocr")),
        )
        for recipe_id, phrases in rules:
            if any(phrase in value for phrase in phrases):
                return recipe_id
        return None

    def _score(self, value: str, recipe: RecipeDefinition) -> float:
        score = 0.0
        for keyword in (*recipe.keywords_zh, *recipe.keywords_en):
            token = keyword.casefold().strip()
            if not token or token not in value:
                continue
            score += 1.0 + min(len(token), 12) / 20.0
        return score

    def route(self, command: str, *, object_count: int | None = None) -> IntentMatch:
        value = str(command or "").strip().casefold()
        mode = self.reference_mode(value)
        if not value:
            return IntentMatch(None, 0.0, mode, "empty_command")

        explicit = _EXPLICIT_RE.match(value)
        if explicit:
            recipe_id = explicit.group(1)
            try:
                recipe = get_recipe(recipe_id)
            except KeyError:
                return IntentMatch(None, 0.0, mode, "unknown_recipe")
            if object_count is not None and object_count < recipe.min_objects:
                return IntentMatch(None, 0.0, mode, "insufficient_objects")
            return IntentMatch(recipe.id, 1.0, mode, "explicit_recipe")

        recipe_id = self._priority_match(value)
        ranked = sorted(
            ((self._score(value, recipe), recipe.id) for recipe in RECIPE_CATALOG),
            reverse=True,
        )
        if recipe_id is None and ranked and ranked[0][0] > 0:
            recipe_id = ranked[0][1]
        if recipe_id is None:
            return IntentMatch(None, 0.12, mode, "ambiguous_command")

        recipe = get_recipe(recipe_id)
        if object_count is not None and object_count < recipe.min_objects:
            return IntentMatch(None, 0.0, mode, "insufficient_objects")

        raw_score = next((score for score, item_id in ranked if item_id == recipe_id), 1.0)
        confidence = min(0.98, max(0.64, 0.58 + raw_score * 0.12))
        alternatives = tuple(item_id for score, item_id in ranked if item_id != recipe_id and score > 0)[:3]
        return IntentMatch(recipe_id, confidence, mode, "deterministic_match", alternatives)
