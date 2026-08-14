"""Agent hooks (CC PreToolUse/PostToolUse/Stop/UserPromptSubmit pattern).

Claude Code's hooks are user/session-configurable interceptors: before a tool
runs (can block or mutate input), after it runs (can block or append context),
and around turns. This module is the harness-side contract: a
:class:`HookManager` holds ordered hook lists per event kind, runs them with
the same semantics (a ``block`` decision stops the action and the reason is
fed back to the model), and never lets a raising hook kill the loop.

Pure Python; the hook callables themselves are injected (real
user-configured hooks are a later config-layer task).
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

__all__ = [
    "HookDecision",
    "HookManager",
    "HookOutcome",
    "PostToolUseHook",
    "PreToolUseHook",
]


class HookDecision(Protocol):
    """One hook callable; see each event kind for the exact input shape."""

    def __call__(self, payload: dict[str, Any]) -> dict[str, Any] | None: ...


PreToolUseHook = Callable[[dict[str, Any]], dict[str, Any] | None]
PostToolUseHook = Callable[[dict[str, Any]], dict[str, Any] | None]


@dataclass(frozen=True)
class HookOutcome:
    """The manager's verdict after running every hook of one kind."""

    allowed: bool
    reason: str
    input: dict[str, Any]
    extra_context: str
    decisions: tuple[dict[str, Any], ...]


@dataclass
class HookManager:
    """Ordered hook lists; the first blocking decision wins (CC semantics)."""

    pre_tool_use: list[PreToolUseHook] = field(default_factory=list)
    post_tool_use: list[PostToolUseHook] = field(default_factory=list)

    def register_pre_tool_use(self, hook: PreToolUseHook) -> PreToolUseHook:
        self.pre_tool_use.append(hook)
        return hook

    def unregister_pre_tool_use(self, hook: PreToolUseHook) -> bool:
        for index, current in enumerate(self.pre_tool_use):
            if current is hook:
                del self.pre_tool_use[index]
                return True
        return False

    def register_post_tool_use(self, hook: PostToolUseHook) -> PostToolUseHook:
        self.post_tool_use.append(hook)
        return hook

    def unregister_post_tool_use(self, hook: PostToolUseHook) -> bool:
        for index, current in enumerate(self.post_tool_use):
            if current is hook:
                del self.post_tool_use[index]
                return True
        return False

    def scope_for(self, context: Any) -> _ScopedHookManager:
        """Return a plugin-scope view whose hook additions auto-unwind."""
        return _ScopedHookManager(self, context)

    def run_pre_tool_use(self, tool_name: str, arguments: dict[str, Any]) -> HookOutcome:
        """Run PreToolUse hooks. A hook returning ``{"decision": "block",
        "reason": ...}`` blocks the tool; a ``decision: "approve"`` short-
        circuits the remaining hooks; ``None`` = pass. Mutated ``input`` is
        carried forward hook to hook."""
        payload = {"tool_name": tool_name, "input": copy.deepcopy(arguments or {})}
        decisions: list[dict[str, Any]] = []
        for hook in self.pre_tool_use:
            try:
                decision = hook({
                    "tool_name": payload["tool_name"],
                    "input": copy.deepcopy(payload["input"]),
                })
            except Exception as exc:  # noqa: BLE001 - hooks never kill the loop
                decisions.append({"error": f"{type(exc).__name__}: {exc}"})
                continue
            if not isinstance(decision, dict):
                continue
            decisions.append(decision)
            if isinstance(decision.get("input"), dict):
                payload["input"] = copy.deepcopy(decision["input"])
            verdict = str(decision.get("decision") or "")
            if verdict == "block":
                return HookOutcome(
                    allowed=False,
                    reason=str(decision.get("reason") or "blocked by hook"),
                    input=payload["input"],
                    extra_context="",
                    decisions=tuple(decisions),
                )
            if verdict == "approve":
                break
        return HookOutcome(
            allowed=True,
            reason="",
            input=payload["input"],
            extra_context="",
            decisions=tuple(decisions),
        )

    def run_post_tool_use(
        self, tool_name: str, arguments: dict[str, Any], result: Any
    ) -> HookOutcome:
        """Run PostToolUse hooks; ``extraContext`` accumulates into feedback
        appended to the tool result; a ``block`` marks the outcome blocked."""
        payload = {
            "tool_name": tool_name,
            "input": copy.deepcopy(arguments or {}),
            "result": result,
        }
        decisions: list[dict[str, Any]] = []
        extra_parts: list[str] = []
        blocked_reason = ""
        for hook in self.post_tool_use:
            try:
                decision = hook({
                    "tool_name": payload["tool_name"],
                    "input": copy.deepcopy(payload["input"]),
                    "result": payload["result"],
                })
            except Exception as exc:  # noqa: BLE001
                decisions.append({"error": f"{type(exc).__name__}: {exc}"})
                continue
            if not isinstance(decision, dict):
                continue
            decisions.append(decision)
            extra = str(decision.get("extraContext") or "")
            if extra:
                extra_parts.append(extra)
            if str(decision.get("decision") or "") == "block":
                blocked_reason = str(decision.get("reason") or "blocked by post-tool hook")
        return HookOutcome(
            allowed=not blocked_reason,
            reason=blocked_reason,
            input=payload["input"],
            extra_context="\n".join(extra_parts),
            decisions=tuple(decisions),
        )


class _ScopedHookManager:
    """Context-bound hook registry view."""

    def __init__(self, manager: HookManager, context: Any) -> None:
        self._manager = manager
        self._context = context

    def register_pre_tool_use(self, hook: PreToolUseHook) -> PreToolUseHook:
        def owned(payload: dict[str, Any]) -> dict[str, Any] | None:
            with self._context.work():
                return hook(payload)

        registered = self._manager.register_pre_tool_use(owned)
        try:
            self._context.effect(
                lambda: self._manager.unregister_pre_tool_use(registered)
            )
        except Exception:
            self._manager.unregister_pre_tool_use(registered)
            raise
        return registered

    def register_post_tool_use(self, hook: PostToolUseHook) -> PostToolUseHook:
        def owned(payload: dict[str, Any]) -> dict[str, Any] | None:
            with self._context.work():
                return hook(payload)

        registered = self._manager.register_post_tool_use(owned)
        try:
            self._context.effect(
                lambda: self._manager.unregister_post_tool_use(registered)
            )
        except Exception:
            self._manager.unregister_post_tool_use(registered)
            raise
        return registered

    def __getattr__(self, name: str) -> Any:
        return getattr(self._manager, name)
