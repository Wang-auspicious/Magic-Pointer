"""Three-tier intent routing. Never answers "unsupported".

The old shape was: match a keyword rule, or fail. That is why the app felt
rigid — the listed phrases worked and anything a few words off died with
`ambiguous_command`. A user who says "帮我把这段变成小红书文案" instead of
"改写" got nothing, and that is the single most unacceptable state for this
product.

Three tiers, in order:

L0  Deterministic. A dozen-odd unmistakable intents (copy, OCR, screenshot,
    translate-to-default) resolved by keyword with no model call at all. Target
    is well under 300ms, because the answer is a local operation.

L1  Classification. One cheap model call turns `command + object summary` into
    a recipe id plus parameters. Low confidence or a failed call does NOT
    error — it falls to L2.

L2  General fallback. Every recipe is offered to the model as a tool it may
    compose freely; if it composes nothing, it still answers in plain text
    about the grounded object. There is always an answer.

Long tail: L2 patterns that recur get offered as saved custom instructions, so
the third time you phrase something your own way it becomes an L0 fast path.

Nothing here performs the work. `route()` decides *how* to handle a command and
the caller executes it, which keeps the decision testable without a screen, a
gateway or a model.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from app.fabric.catalog import RECIPE_CATALOG, get_recipe, has_recipe
from app.fabric.router import RecipeRouter
from app.fabric.schema import IntentMatch, JsonDict

ROOT = Path(__file__).resolve().parents[2]

TIER_DETERMINISTIC = "L0"
TIER_CLASSIFIED = "L1"
TIER_GENERAL = "L2"

# L0 is for intents where the words leave no room for interpretation AND the
# work needs no model. Anything requiring judgement (rewrite, summarize,
# compare) belongs in L1/L2 even when the phrasing looks certain, because the
# model call is unavoidable there and pretending otherwise buys nothing.
DETERMINISTIC_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("text.ocr_copy", (
        "ocr一下", "ocr 一下", "ocr这个", "ocr 这个", "ocr", "识别文字", "提取文字",
        "复制这段文字", "复制这段", "把文字复制", "认一下字", "读一下这段字",
        "copy this text", "copy the text", "extract text", "read the text",
    )),
    ("text.ocr_clean", (
        "去掉空格", "去掉换行", "清洗文字", "号码空格", "整理后复制",
        "remove spaces", "clean up the text",
    )),
    ("table.to_spreadsheet", (
        "放进excel", "放进 excel", "转成excel", "转成 excel", "导出csv", "导出 csv",
        "to excel", "to csv", "export as csv",
    )),
    ("formula.to_latex", ("转成latex", "转成 latex", "复制latex", "to latex", "mathml")),
    # Every phrase here names an image. "生成提示词" on its own is the
    # context-pack compile command ("生成提示词：修复结账错误"), so claiming it
    # would hijack a different feature.
    ("image.to_prompt", (
        "图转提示词", "这张图的提示词", "图片提示词", "描述这张图", "描述这幅图",
        "image to prompt", "describe this image", "prompt from image",
    )),
    ("agent.handoff", (
        "让 codex", "让codex", "让 claude", "让claude", "让 gemini", "让gemini",
        "交给 codex", "交给codex", "交给 agent", "交给agent", "丢给 agent", "丢给agent",
        "send to codex", "send to claude", "hand off to", "handoff to",
    )),
)

# Deterministic intents that are *not* recipes: they are local actions the
# caller performs directly. Keeping them here means "截图" never has to reach a
# model to be understood.
LOCAL_ACTION_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("copy_object_text", ("复制这个", "复制内容", "copy this", "copy it")),
    ("save_screenshot", ("截图", "存成图片", "保存截图", "screenshot", "save a screenshot")),
    ("show_source", ("这是哪个窗口", "来源是哪", "哪来的", "where is this from")),
)

# What a routing decision may ask the caller to do.
ACT_RECIPE = "recipe"          # run this recipe with these parameters
ACT_LOCAL = "local_action"     # perform this local action, no model
ACT_MODEL = "model_answer"     # answer with the text model, given the object
ACT_TOOLS = "model_tools"      # let the model compose recipes as tools

# Plumbing, not destinations. `ground.this` keywords are the bare pronouns
# ("这个", "这段"), so the legacy keyword router scores it above zero for nearly
# every sentence a user says — which made "帮我看看这段写得怎么样" resolve to
# "lock the object" and go no further. Grounding already happened before the
# command was submitted; a command must never route *to* it.
NON_DESTINATION_RECIPES = frozenset({
    "activate.wiggle",
    "ground.this",
    "ground.references",
    "governance.dashboard",
    "integration.mcp",
    "voice.short_command",
})

# The same judgement, taken from what a recipe says it produces rather than from
# a list someone has to remember to extend. `element.pick` was missing from the
# names above, so on 2026-08-05 the question "这是什么" over a WeChat message came
# back as "点选元素追问：已锁定 1 个对象，provider=internal" — a notice about our
# own bookkeeping in place of an answer. Its outputKind is `grounded_object`,
# exactly like `ground.this`, which had been excluded for the same reason years
# of one at a time.
NON_DESTINATION_OUTPUT_KINDS = frozenset({
    "grounded_object",
    "activation_intent",
    "interaction_episode",
})


def is_non_destination_recipe(recipe: Any) -> bool:
    """Is this recipe plumbing rather than somewhere a command can end up?"""
    if str(getattr(recipe, "id", "") or "") in NON_DESTINATION_RECIPES:
        return True
    return str(getattr(recipe, "output_kind", "") or "") in NON_DESTINATION_OUTPUT_KINDS


def tool_name_for_recipe(recipe_id: str) -> str:
    return str(recipe_id or "").replace(".", "__")


@dataclass
class RouteDecision:
    tier: str
    action: str
    recipe_id: str | None = None
    local_action: str | None = None
    parameters: JsonDict = field(default_factory=dict)
    confidence: float = 0.0
    reason: str = ""
    reference_mode: str = "this"
    alternatives: tuple[str, ...] = ()
    # True when this command has now been seen often enough that offering to
    # save it as a named instruction is worthwhile.
    suggest_saving: bool = False
    saved_instruction_id: str | None = None
    notes: str = ""

    def to_dict(self) -> JsonDict:
        return {
            "tier": self.tier,
            "action": self.action,
            "recipeId": self.recipe_id,
            "localAction": self.local_action,
            "parameters": dict(self.parameters),
            "confidence": round(float(self.confidence), 4),
            "reason": self.reason,
            "referenceMode": self.reference_mode,
            "alternatives": list(self.alternatives),
            "suggestSaving": self.suggest_saving,
            "savedInstructionId": self.saved_instruction_id,
            "notes": self.notes,
        }


def _normalize(command: str) -> str:
    """Fold a command for matching without losing what the user actually said."""
    value = str(command or "").strip().casefold()
    # Full-width punctuation and stray spacing should not decide whether an
    # intent is recognised.
    value = value.replace("，", ",").replace("。", ".").replace("！", "!").replace("？", "?")
    return re.sub(r"\s+", " ", value)


_QUESTION_PREFIXES = (
    "what ", "which ", "who ", "where ", "when ", "why ", "how ",
    "is this ", "are these ", "does this ", "did i ", "tell me ",
    "什么", "哪个", "哪一", "为什么", "怎么", "是否", "这是什么", "这段是什么",
)
_QUESTION_ACTION_MARKERS = (
    "copy", "extract", "save", "translate", "rewrite", "summarize", "create",
    "add to", "send to", "open ", "run ", "ocr this", "ocr it",
    "复制", "提取", "保存", "翻译", "改写", "重写", "总结", "创建", "添加", "发送", "打开", "运行", "识别",
)


def _is_information_question(command: str) -> bool:
    value = _normalize(command)
    looks_like_question = (
        "?" in value
        or "？" in value
        or value.startswith(_QUESTION_PREFIXES)
        or any(token in value for token in (
            "是什么意思", "是哪一", "是什么内容", "吗",
            # Short spoken commands are how this product is actually used.
            # They are requests for an answer about the grounded objects, not
            # requests to pick a capability from the entire Recipe catalog.
            "对比", "比较", "区别", "解释", "分析", "评价", "评估", "哪个好",
        ))
    )
    if not looks_like_question:
        return False
    return not any(marker in value for marker in _QUESTION_ACTION_MARKERS)


# ---------------------------------------------------------------------------
# Saved instructions (the long-tail learning store)
# ---------------------------------------------------------------------------


def _library_path() -> Path:
    runtime = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
    return runtime / "instruction-library.json"


class InstructionLibrary:
    """Commands the user phrases their own way, learned by repetition.

    Every command that reaches L2 is counted. Once the same shape appears
    `suggest_after` times, the router flags it so the UI can offer "save this as
    an instruction?". Saved instructions become L0 fast paths.
    """

    def __init__(self, path: Path | None = None, *, suggest_after: int = 3) -> None:
        self.path = path if path is not None else _library_path()
        self.suggest_after = max(2, int(suggest_after))
        self._data = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"saved": {}, "counts": {}}
        if not isinstance(raw, dict):
            return {"saved": {}, "counts": {}}
        raw.setdefault("saved", {})
        raw.setdefault("counts", {})
        if not isinstance(raw["saved"], dict):
            raw["saved"] = {}
        if not isinstance(raw["counts"], dict):
            raw["counts"] = {}
        return raw

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            # Learning is a nicety; never let it fail a command.
            pass

    @staticmethod
    def signature(command: str) -> str:
        """A loose shape key, so "帮我改成小红书风格" and "改成小红书风格" count together."""
        value = _normalize(command)
        value = re.sub(r"^(帮我|请|麻烦|你|能不能|可以|给我)+", "", value)
        value = re.sub(r"[,.!?、；;:]+", " ", value)
        tokens = [token for token in value.split(" ") if token]
        return " ".join(tokens[:8])

    def lookup(self, command: str) -> dict[str, Any] | None:
        entry = self._data["saved"].get(self.signature(command))
        return dict(entry) if isinstance(entry, dict) else None

    def note_general_use(self, command: str, *, recipe_id: str | None = None) -> int:
        """Count one L2 use of this command shape and return the new count."""
        key = self.signature(command)
        if not key:
            return 0
        record = self._data["counts"].get(key)
        if not isinstance(record, dict):
            record = {"count": 0, "lastCommand": "", "recipeId": None}
        record["count"] = int(record.get("count", 0)) + 1
        record["lastCommand"] = str(command)[:400]
        record["lastSeen"] = time.time()
        if recipe_id:
            record["recipeId"] = recipe_id
        self._data["counts"][key] = record
        self._save()
        return int(record["count"])

    def should_suggest(self, command: str) -> bool:
        key = self.signature(command)
        if not key or key in self._data["saved"]:
            return False
        record = self._data["counts"].get(key)
        count = int(record.get("count", 0)) if isinstance(record, dict) else 0
        return count >= self.suggest_after

    def save(self, command: str, *, recipe_id: str | None, parameters: JsonDict | None = None, title: str = "") -> str:
        key = self.signature(command)
        # builtin hash() is salted per process (PYTHONHASHSEED), so the same
        # instruction got a different id every time a fresh bridge saved it;
        # use a deterministic digest instead.
        instruction_id = "saved." + hashlib.sha256(key.encode("utf-8")).hexdigest()[:10]
        self._data["saved"][key] = {
            "id": instruction_id,
            "title": title or str(command)[:60],
            "command": str(command)[:400],
            "recipeId": recipe_id,
            "parameters": dict(parameters or {}),
            "savedAt": time.time(),
        }
        self._data["counts"].pop(key, None)
        self._save()
        return instruction_id

    def forget(self, command: str) -> bool:
        key = self.signature(command)
        removed = self._data["saved"].pop(key, None) is not None
        if removed:
            self._save()
        return removed

    def saved_entries(self) -> list[dict[str, Any]]:
        return [dict(value) for value in self._data["saved"].values() if isinstance(value, dict)]


# ---------------------------------------------------------------------------
# Tool schema for L2
# ---------------------------------------------------------------------------


def recipe_tool_schemas(*, enabled: dict[str, bool] | None = None, limit: int = 40) -> list[JsonDict]:
    """Describe recipes as OpenAI-style function tools for the L2 model call."""
    tools: list[JsonDict] = []
    for recipe in RECIPE_CATALOG:
        if enabled is not None and enabled.get(recipe.id, True) is False:
            continue
        # System plumbing is not something a model should invoke on a user's
        # behalf mid-command.
        if is_non_destination_recipe(recipe):
            continue
        tools.append({
            "type": "function",
            "function": {
                "name": tool_name_for_recipe(recipe.id),
                "description": f"{recipe.title_zh}：{recipe.description_zh}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "instruction": {
                            "type": "string",
                            "description": "用户这次要做的事，用一句话表达",
                        },
                    },
                    "required": ["instruction"],
                },
            },
        })
        if len(tools) >= limit:
            break
    return tools


def recipe_id_from_tool_name(name: str) -> str | None:
    candidate = str(name or "").replace("__", ".")
    return candidate if has_recipe(candidate) else None


# ---------------------------------------------------------------------------
# The router
# ---------------------------------------------------------------------------


ClassifierFn = Callable[[str, str, list[JsonDict]], JsonDict | None]


class IntentRouter:
    """Route a command to a tier. Always produces a decision."""

    def __init__(
        self,
        *,
        library: InstructionLibrary | None = None,
        classifier: ClassifierFn | None = None,
        recipe_enabled: dict[str, bool] | None = None,
        min_classified_confidence: float = 0.55,
    ) -> None:
        self.library = library if library is not None else InstructionLibrary()
        self.classifier = classifier
        self.recipe_enabled = dict(recipe_enabled or {})
        self.min_classified_confidence = float(min_classified_confidence)
        self._keyword_router = RecipeRouter()

    # -- L0 ---------------------------------------------------------------

    def _deterministic(self, command: str, *, object_count: int) -> RouteDecision | None:
        value = _normalize(command)
        if not value:
            return None

        saved = self.library.lookup(command)
        if saved is not None:
            recipe_id = saved.get("recipeId")
            if recipe_id and has_recipe(str(recipe_id)):
                return RouteDecision(
                    tier=TIER_DETERMINISTIC,
                    action=ACT_RECIPE,
                    recipe_id=str(recipe_id),
                    parameters=dict(saved.get("parameters") or {}),
                    confidence=0.99,
                    reason="saved_instruction",
                    reference_mode=self._keyword_router.reference_mode(value),
                    saved_instruction_id=str(saved.get("id") or "") or None,
                )

        for action, phrases in LOCAL_ACTION_RULES:
            if any(phrase in value for phrase in phrases):
                return RouteDecision(
                    tier=TIER_DETERMINISTIC,
                    action=ACT_LOCAL,
                    local_action=action,
                    confidence=0.97,
                    reason="deterministic_local_action",
                    reference_mode=self._keyword_router.reference_mode(value),
                )

        # Questions about the grounded object are destinations in their own
        # right. Sending "What is OCR?" through the OCR-copy recipe creates a
        # clipboard confirmation instead of an answer and can spend two model
        # timeouts getting there.
        if _is_information_question(command):
            return RouteDecision(
                tier=TIER_DETERMINISTIC,
                action=ACT_MODEL,
                confidence=0.98,
                reason="information_question",
                reference_mode=self._keyword_router.reference_mode(value),
            )

        for recipe_id, phrases in DETERMINISTIC_RULES:
            if not any(phrase in value for phrase in phrases):
                continue
            if not has_recipe(recipe_id):
                continue
            if self.recipe_enabled.get(recipe_id, True) is False:
                continue
            recipe = get_recipe(recipe_id)
            if object_count and object_count < recipe.min_objects:
                continue
            return RouteDecision(
                tier=TIER_DETERMINISTIC,
                action=ACT_RECIPE,
                recipe_id=recipe_id,
                confidence=0.96,
                reason="deterministic_keyword",
                reference_mode=self._keyword_router.reference_mode(value),
            )
        return None

    # -- L1 ---------------------------------------------------------------

    def _keyword_confident(self, command: str, *, object_count: int) -> IntentMatch | None:
        match = self._keyword_router.route(command, object_count=object_count or None)
        if match.recipe_id is None or is_non_destination_recipe(get_recipe(match.recipe_id)):
            return None
        if self.recipe_enabled.get(match.recipe_id, True) is False:
            return None
        return match if match.confidence >= 0.70 else None

    def _classify(self, command: str, object_summary: str, *, object_count: int) -> RouteDecision | None:
        if self.classifier is None:
            return None
        tools = recipe_tool_schemas(enabled=self.recipe_enabled)
        try:
            raw = self.classifier(command, object_summary, tools)
        except Exception:
            # A failed classification is not an error the user should see; L2
            # will still answer.
            return None
        if not isinstance(raw, dict):
            return None
        recipe_id = recipe_id_from_tool_name(str(raw.get("recipeId") or raw.get("name") or ""))
        if recipe_id is None or is_non_destination_recipe(get_recipe(recipe_id)):
            return None
        if self.recipe_enabled.get(recipe_id, True) is False:
            return None
        confidence = float(raw.get("confidence") or 0.0)
        if confidence < self.min_classified_confidence:
            return None
        recipe = get_recipe(recipe_id)
        if object_count and object_count < recipe.min_objects:
            return None
        parameters = raw.get("parameters")
        return RouteDecision(
            tier=TIER_CLASSIFIED,
            action=ACT_RECIPE,
            recipe_id=recipe_id,
            parameters=dict(parameters) if isinstance(parameters, dict) else {},
            confidence=confidence,
            reason="model_classified",
            reference_mode=self._keyword_router.reference_mode(_normalize(command)),
        )

    # -- L2 ---------------------------------------------------------------

    def _general(self, command: str, *, has_tools: bool) -> RouteDecision:
        self.library.note_general_use(command)
        return RouteDecision(
            tier=TIER_GENERAL,
            action=ACT_TOOLS if has_tools else ACT_MODEL,
            confidence=0.4,
            reason="general_fallback",
            reference_mode=self._keyword_router.reference_mode(_normalize(command)),
            suggest_saving=self.library.should_suggest(command),
            notes="没有匹配到确定的能力，交给通用路径处理；结果仍然基于当前锁定的对象。",
        )

    # -- public -----------------------------------------------------------

    def route(
        self,
        command: str,
        *,
        object_summary: str = "",
        object_count: int = 1,
        allow_model: bool = True,
    ) -> RouteDecision:
        """Decide how to handle `command`. Always returns a decision.

        `allow_model=False` (a refusing gateway, or a user who turned model
        calls off) still produces an answerable decision: L0 if the words are
        unmistakable, otherwise a local-only general path.
        """
        value = _normalize(command)
        if not value:
            return RouteDecision(
                tier=TIER_DETERMINISTIC,
                action=ACT_LOCAL,
                local_action="show_source",
                confidence=0.5,
                reason="empty_command",
                notes="没有收到命令内容，先说明当前锁定的是什么。",
            )

        decided = self._deterministic(command, object_count=object_count)
        if decided is not None:
            return decided

        keyword_match = self._keyword_confident(command, object_count=object_count)
        if keyword_match is not None:
            return RouteDecision(
                tier=TIER_CLASSIFIED,
                action=ACT_RECIPE,
                recipe_id=keyword_match.recipe_id,
                confidence=keyword_match.confidence,
                reason="keyword_match",
                reference_mode=keyword_match.reference_mode,
                alternatives=keyword_match.alternatives,
            )

        if allow_model:
            classified = self._classify(command, object_summary, object_count=object_count)
            if classified is not None:
                return classified

        return self._general(command, has_tools=allow_model)
