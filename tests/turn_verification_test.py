"""turn 端验证门（Hermes verification_stop 的 MP 最小版，纯 policy）。

社区调研 P0："结果不能靠模型一句完成了"。模型执行过写入类操作、又没有
任何新鲜验证证据（通过的 verify_result 回执）就想以 completed 收尾时，
第一次拦截并注入一次有界 nudge；第二次放行（防死循环）。纯读回合不拦。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.tool_registry import Effect  # noqa: E402
from app.agent_runtime.turn_verification import (  # noqa: E402
    VerificationGate,
    should_nudge_before_completion,
)


def test_pure_read_turn_never_nudges() -> None:
    gate = VerificationGate()
    gate.record_executed(effect=Effect.READ, verified=False)
    assert should_nudge_before_completion(gate) is None


def test_write_without_evidence_nudges_once() -> None:
    gate = VerificationGate()
    gate.record_executed(effect=Effect.REVERSIBLE_WRITE, verified=False)
    nudge = should_nudge_before_completion(gate)
    assert nudge is not None and "验证" in nudge
    # 第二次（nudged 之后）放行，防死循环
    gate.mark_nudged()
    assert should_nudge_before_completion(gate) is None


def test_write_with_fresh_verification_passes() -> None:
    gate = VerificationGate()
    gate.record_executed(effect=Effect.REVERSIBLE_WRITE, verified=False)
    gate.record_executed(effect=Effect.READ, verified=True)  # 后来的验证回执
    assert should_nudge_before_completion(gate) is None


def test_stronger_effects_also_gate() -> None:
    for effect in (Effect.LOCAL_IRREVERSIBLE, Effect.EXTERNAL_SEND, Effect.DESTRUCTIVE):
        gate = VerificationGate()
        gate.record_executed(effect=effect, verified=False)
        assert should_nudge_before_completion(gate) is not None, effect


def test_failed_verification_is_not_evidence() -> None:
    gate = VerificationGate()
    gate.record_executed(effect=Effect.REVERSIBLE_WRITE, verified=False)
    gate.record_executed(effect=Effect.READ, verified=False)  # 验证失败
    assert should_nudge_before_completion(gate) is not None


def test_purchase_gates_too() -> None:
    gate = VerificationGate()
    gate.record_executed(effect=Effect.PURCHASE, verified=False)
    assert should_nudge_before_completion(gate) is not None


# ---- loop 端到端 ------------------------------------------------------------


def test_loop_nudges_write_without_verification_then_completes() -> None:
    import asyncio
    import importlib.util as ilu

    spec = ilu.spec_from_file_location(
        "_loop_test_fakes", Path(__file__).resolve().parent / "agent_runtime_loop_test.py")
    mod = ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)

    from app.agent_runtime.loop import LoopStopped, VerificationNudged, run_agent_loop
    from app.agent_runtime.model_client import (
        LoopModelClient, MessageDelta, ToolCallArrived, TurnDone,
    )
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
    from app.agent_runtime.types import ToolCall

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="write_thing", description="w",
        input_schema=mod.EMPTY_SCHEMA,
        execute=lambda **kw: "written",
        effect=Effect.REVERSIBLE_WRITE,
    ))
    registry.register(ToolSpec(
        name="read_thing", description="r",
        input_schema=mod.EMPTY_SCHEMA,
        execute=lambda **kw: "content",
        effect=Effect.READ,
        verify_result=lambda value: None,
    ))

    backend = mod.ScriptedBackend(
        # 第一轮：模型执行写入（无验证的写）
        [ToolCallArrived(call=ToolCall(id="c1", name="write_thing", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        # 第二轮：模型想收工 → 验证门拦截 → 注入 nudge
        [MessageDelta(text="写完了。"), TurnDone(usage=None, raw_text=None)],
        # 第三轮：模型跑验证工具后收工
        [ToolCallArrived(call=ToolCall(id="c2", name="read_thing", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        # 第四轮：真收工
        [MessageDelta(text="已写入并读回验证一致。"), TurnDone(usage=None, raw_text=None)],
    )
    params = mod.make_params(
        "把这个写进去", registry=registry, client=LoopModelClient(backend))

    async def collect():
        out = []
        async for event in run_agent_loop(params):
            out.append(event)
        return out

    events = asyncio.run(collect())
    nudges = [e for e in events if isinstance(e, VerificationNudged)]
    assert len(nudges) == 1, "写后无验证想收工，必须恰好 nudge 一次"
    terminal = events[-1].terminal
    assert terminal.reason.value == "completed"
    assert "读回验证" in terminal.message
    # nudge 注入后的那一轮模型请求必须看得见验证门文本
    third_round_text = " ".join(m.content or "" for m in backend.received[2][0])
    assert "验证门" in third_round_text


def test_loop_no_nudge_when_write_has_verify() -> None:
    import asyncio
    import importlib.util as ilu

    spec = ilu.spec_from_file_location(
        "_loop_test_fakes", Path(__file__).resolve().parent / "agent_runtime_loop_test.py")
    mod = ilu.module_from_spec(spec)
    spec.loader.exec_module(mod)

    from app.agent_runtime.loop import LoopStopped, VerificationNudged, run_agent_loop
    from app.agent_runtime.model_client import (
        LoopModelClient, MessageDelta, ToolCallArrived, TurnDone,
    )
    from app.agent_runtime.tool_registry import ToolRegistry, ToolSpec
    from app.agent_runtime.types import ToolCall

    registry = ToolRegistry()
    registry.register(ToolSpec(
        name="write_verified", description="w",
        input_schema=mod.EMPTY_SCHEMA,
        execute=lambda **kw: "written",
        effect=Effect.REVERSIBLE_WRITE,
        verify_result=lambda value: None,  # 写入自带读回校验
    ))
    backend = mod.ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="c1", name="write_verified", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        [MessageDelta(text="写入并已校验。"), TurnDone(usage=None, raw_text=None)],
    )
    params = mod.make_params(
        "写吧", registry=registry, client=LoopModelClient(backend))

    async def collect():
        out = []
        async for event in run_agent_loop(params):
            out.append(event)
        return out

    events = asyncio.run(collect())
    assert not [e for e in events if isinstance(e, VerificationNudged)]
    assert events[-1].terminal.reason.value == "completed"
