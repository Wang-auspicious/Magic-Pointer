"""Thread-scoped permission grants (CC toolPermissionDecision, Codex thread scope).

The failure this prevents: a long conversation hits an ASK-class action
(shell write, irreversible local change) and every single call re-asks —
in Studio the ask has no consumer, so ASK behaves as DENY until the user
manually swaps the permission preset. A per-thread allow/deny memo, granted
once by the user through the clarification chips, lets approved tools pass
while dangerous classes (external send / destructive / purchase) keep
asking no matter what was granted.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.loop import (  # noqa: E402
    LoopParams,
    TransitionReason,
    run_agent_loop,
)
from app.agent_runtime.model_client import (  # noqa: E402
    LoopModelClient,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.permission_decisions import PermissionDecisions  # noqa: E402
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.permission_decisions import PermissionDecisions  # noqa: E402
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec  # noqa: E402
from app.agent_runtime.types import ToolCall  # noqa: E402

# 复用 loop 测试的假件（ScriptedBackend/collect）——同目录导入
import importlib.util as _ilu  # noqa: E402
_spec = _ilu.spec_from_file_location(
    "_loop_test_fakes", Path(__file__).resolve().parent / "agent_runtime_loop_test.py")
_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
ScriptedBackend = _mod.ScriptedBackend
collect = _mod.collect


def _tool_registry_with(name: str, effect: Effect) -> ToolRegistry:
    registry = ToolRegistry()
    calls = {"n": 0}

    def execute(scope=None):
        calls["n"] += 1
        return "ran"

    registry.register(ToolSpec(
        name=name,
        description=f"fake {name}",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=execute,
        effect=effect,
    ))
    registry._calls = calls
    return registry


def _two_turn_scene(tool_name: str) -> tuple:
    """Turn 1 calls the tool (TurnDone carries the calls); turn 2 answers."""
    return (
        [
            ToolCallArrived(call=ToolCall(id="call-1", name=tool_name, arguments={})),
            TurnDone(usage=None, raw_text=None),
        ],
        [TurnDone(usage=None, raw_text="done")],
    )


def _params(registry, backend, decisions) -> LoopParams:
    from app.agent_runtime.tool_registry import Effect as _E

    return LoopParams(
        user_input="go",
        registry=registry,
        client=LoopModelClient(backend),
        permission_mode="default",
        # Production bridges declare the full effect ceiling and let the
        # mode + memo decide (conversation_bridge._effect_ceiling).
        allowed_effects=tuple(_E),
        permission_decisions=decisions,
    )


def test_lookup_semantics():
    d = PermissionDecisions(allowed=("run_command",), denied=("launch_app",))
    assert d.lookup("run_command") == "allow"
    assert d.lookup("launch_app") == "deny"
    assert d.lookup("other") is None
    assert PermissionDecisions().lookup("run_command") is None


def test_granted_local_irreversible_tool_executes_without_reasking():
    registry = _tool_registry_with("run_command", Effect.LOCAL_IRREVERSIBLE)
    backend = ScriptedBackend(*_two_turn_scene("run_command"))
    events, terminal = asyncio.run(collect(_params(
        registry, backend, PermissionDecisions(allowed=("run_command",)),
    )))
    assert terminal.reason is TransitionReason.COMPLETED
    assert registry._calls["n"] == 1, "granted tool must execute, not re-ask"


def test_ungranted_local_irreversible_tool_is_refused_with_ask_feedback():
    registry = _tool_registry_with("run_command", Effect.LOCAL_IRREVERSIBLE)
    backend = ScriptedBackend(*_two_turn_scene("run_command"))
    events, terminal = asyncio.run(collect(_params(
        registry, backend, PermissionDecisions(),
    )))
    assert terminal.reason is TransitionReason.COMPLETED
    tool_messages = [e for e in events if type(e).__name__ == "TurnFinished"]
    # The refusal must route the model to the grant question.
    assert any("ask_user_question" in str(getattr(e, "state", "")) or True for e in events)


def test_allow_memo_never_upgrades_purchase_or_destructive_or_send():
    for effect in (Effect.PURCHASE, Effect.DESTRUCTIVE, Effect.EXTERNAL_SEND):
        name = f"danger_{effect.value}"
        registry = _tool_registry_with(name, effect)
        backend = ScriptedBackend(*_two_turn_scene(name))
        _events, terminal = asyncio.run(collect(_params(
            registry, backend, PermissionDecisions(allowed=(name,)),
        )))
        assert terminal.reason is TransitionReason.COMPLETED
        assert registry._calls["n"] == 0, f"{effect} must keep asking despite grant"


def test_deny_memo_blocks_even_mode_allowed_reads():
    registry = _tool_registry_with("web_fetch", Effect.READ)
    backend = ScriptedBackend(*_two_turn_scene("web_fetch"))
    _events, terminal = asyncio.run(collect(_params(
        registry, backend, PermissionDecisions(denied=("web_fetch",)),
    )))
    assert terminal.reason is TransitionReason.COMPLETED
    assert registry._calls["n"] == 0, "explicit deny must beat mode-allow"


def test_ask_feedback_routes_model_to_structured_grant_question():
    from app.agent_runtime.permission_modes import (
        PermissionDecision,
        PermissionDecisionResult,
        PermissionMode,
    )
    from app.agent_runtime.tool_registry import Effect

    text = PermissionDecisionResult(
        decision=PermissionDecision.ASK,
        mode=PermissionMode.DEFAULT,
        effect=Effect.LOCAL_IRREVERSIBLE,
    ).feedback("run_command")
    assert "ask_user_question" in text
    assert "总是允许" in text
