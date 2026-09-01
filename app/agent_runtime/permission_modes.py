"""Permission modes (CC permission mode pattern).

CC gates every tool call through a permission mode (default / acceptEdits /
plan / bypassPermissions) plus per-tool permission rules. The loop already
enforces ``allowed_effects``; this module adds the mode layer: each mode maps
an effect class to allow / ask / deny, where "ask" in the loop means the
model is told to produce a confirmation proposal instead (the UI confirm
card is harness-owned, the model can never self-confirm).
"""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass
from typing import Any, Mapping

from app.agent_runtime.tool_registry import Effect

__all__ = ["PermissionMode", "PermissionDecision", "decide_effect"]


class PermissionMode(enum.StrEnum):
    DEFAULT = "default"
    PLAN = "plan"
    ACCEPT_REVERSIBLE = "accept_reversible"
    SAFE = "safe"
    BYPASS = "bypass"


class PermissionDecision(enum.StrEnum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


# Effect class -> (default, plan, accept_reversible, safe, bypass)
# DEFAULT: the review-confirmed target — reads direct, machine-verifiable
# reversible writes in-loop, everything else a proposal (the model can never
# self-confirm; the confirm card is harness-owned).
# SAFE: the conservative stepping stone — reads direct, everything else
# propose/confirm. Used while the guard chain awaits real-machine verification.
_MODE_TABLE: dict[PermissionMode, dict[Effect, PermissionDecision]] = {
    PermissionMode.DEFAULT: {
        Effect.READ: PermissionDecision.ALLOW,
        Effect.REVERSIBLE_WRITE: PermissionDecision.ALLOW,
        Effect.LOCAL_IRREVERSIBLE: PermissionDecision.ASK,
        Effect.EXTERNAL_SEND: PermissionDecision.ASK,
        Effect.DESTRUCTIVE: PermissionDecision.ASK,
        Effect.PURCHASE: PermissionDecision.ASK,
    },
    PermissionMode.PLAN: {
        Effect.READ: PermissionDecision.ALLOW,
        Effect.REVERSIBLE_WRITE: PermissionDecision.ASK,
        Effect.LOCAL_IRREVERSIBLE: PermissionDecision.ASK,
        Effect.EXTERNAL_SEND: PermissionDecision.ASK,
        Effect.DESTRUCTIVE: PermissionDecision.DENY,
        Effect.PURCHASE: PermissionDecision.DENY,
    },
    PermissionMode.ACCEPT_REVERSIBLE: {
        Effect.READ: PermissionDecision.ALLOW,
        Effect.REVERSIBLE_WRITE: PermissionDecision.ALLOW,
        Effect.LOCAL_IRREVERSIBLE: PermissionDecision.ASK,
        Effect.EXTERNAL_SEND: PermissionDecision.ASK,
        Effect.DESTRUCTIVE: PermissionDecision.ASK,
        Effect.PURCHASE: PermissionDecision.ASK,
    },
    PermissionMode.SAFE: {
        Effect.READ: PermissionDecision.ALLOW,
        Effect.REVERSIBLE_WRITE: PermissionDecision.ASK,
        Effect.LOCAL_IRREVERSIBLE: PermissionDecision.ASK,
        Effect.EXTERNAL_SEND: PermissionDecision.ASK,
        Effect.DESTRUCTIVE: PermissionDecision.ASK,
        Effect.PURCHASE: PermissionDecision.ASK,
    },
    PermissionMode.BYPASS: {
        Effect.READ: PermissionDecision.ALLOW,
        Effect.REVERSIBLE_WRITE: PermissionDecision.ALLOW,
        Effect.LOCAL_IRREVERSIBLE: PermissionDecision.ALLOW,
        Effect.EXTERNAL_SEND: PermissionDecision.ALLOW,
        Effect.DESTRUCTIVE: PermissionDecision.ALLOW,
        Effect.PURCHASE: PermissionDecision.ASK,
    },
}


@dataclass(frozen=True)
class PermissionDecisionResult:
    decision: PermissionDecision
    mode: PermissionMode
    effect: Effect

    @property
    def allowed(self) -> bool:
        return self.decision is PermissionDecision.ALLOW

    def feedback(
        self,
        tool_name: str,
        arguments: Mapping[str, Any] | None = None,
    ) -> str:
        if self.decision is PermissionDecision.ALLOW:
            return ""
        if self.decision is PermissionDecision.ASK:
            # Hermes/Codex plan-mode split: grantable local writes may offer
            # the quick user-grant channel; external sends, destructive and
            # purchase actions are script-level changes — only a plan
            # proposal (harness-owned confirm card) can ever run them.
            from app.agent_runtime.permission_decisions import GRANTABLE_EFFECTS

            if self.effect in GRANTABLE_EFFECTS:
                prefix = _bash_permission_prefix(tool_name, arguments)
                prefix_instruction = (
                    f'，prefix="{prefix}"（会保存为 Bash({prefix})）'
                    if prefix
                    else ""
                )
                return (
                    f"tool {tool_name!r} needs user confirmation: propose a plan "
                    "through a capability tool instead of executing directly, or call "
                    "AskUser（question 说明要执行什么，options 固定为："
                    "[\"仅这一次允许\", \"本会话总是允许\"+工具名, \"拒绝\"]"
                    f"{prefix_instruction}）——"
                    "用户点选后授权会随下一条消息生效。"
                )
            return (
                f"tool {tool_name!r} needs user confirmation: propose a plan "
                "through a capability tool instead of executing directly"
            )
        return f"tool {tool_name!r} is denied in permission mode {self.mode.value}"


_UNSAFE_PREFIX_COMMAND = re.compile(r"[|&;<>`]|\$\(|[\r\n]")


def _bash_permission_prefix(
    tool_name: str,
    arguments: Mapping[str, Any] | None,
) -> str:
    if str(tool_name or "") != "Bash":
        return ""
    command = str((arguments or {}).get("command") or "").strip()
    if not command or _UNSAFE_PREFIX_COMMAND.search(command):
        return ""
    tokens = command.split()
    if not tokens:
        return ""
    first = tokens[0].casefold()
    if first in {"pytest", "py.test", "ruff", "mypy"}:
        count = 1
    elif first in {"python", "python3", "py"} and len(tokens) >= 3 and tokens[1] == "-m":
        count = 3
    elif first in {"npm", "pnpm", "yarn"} and len(tokens) >= 3 and tokens[1].casefold() == "run":
        count = 3
    else:
        count = min(2, len(tokens))
    return " ".join(tokens[:count])[:160]


def decide_effect(
    mode: PermissionMode | str,
    effect: Effect,
) -> PermissionDecision:
    """One effect class through one mode (never allows more than the mode)."""
    resolved = PermissionMode(mode)
    table = _MODE_TABLE[resolved]
    return table.get(effect, PermissionDecision.ASK)
