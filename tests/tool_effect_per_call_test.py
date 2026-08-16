"""工具效果按调用分级（CC Tool 契约：isDestructive(input) 的 MP 版）。

CC 的效果分级是**按调用**的：同一工具不同入参可以有不同后果。MP 的
``ToolSpec.effect`` 是静态档；本批加 ``effect_for``（按入参解析），权限门、
guardrail 分类、验证门全部改走解析后的效果。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from app.agent_runtime.tool_registry import (  # noqa: E402
    Effect,
    ToolRegistry,
    ToolSpec,
    spec_effect,
)

EMPTY_SCHEMA = {"type": "object", "properties": {}, "required": []}


def make_registry(effect_for=None, static=Effect.READ) -> tuple[ToolRegistry, ToolSpec]:
    registry = ToolRegistry()
    spec = ToolSpec(
        name="file_op",
        description="file operation",
        input_schema={
            "type": "object",
            "properties": {"delete": {"type": "boolean"}},
            "required": [],
        },
        execute=lambda **kwargs: "ok",
        effect=static,
        effect_for=effect_for,
    )
    registry.register(spec)
    return registry, spec


def test_effect_for_overrides_static_per_call() -> None:
    def classify(args: dict) -> Effect:
        return Effect.DESTRUCTIVE if args.get("delete") else Effect.READ

    registry, spec = make_registry(effect_for=classify)
    assert spec_effect(spec, {"delete": True}) is Effect.DESTRUCTIVE
    assert spec_effect(spec, {}) is Effect.READ
    assert registry.resolve_effect("file_op", {"delete": True}) is Effect.DESTRUCTIVE


def test_effect_for_falls_back_to_static() -> None:
    registry, spec = make_registry(effect_for=lambda args: Effect.READ, static=Effect.REVERSIBLE_WRITE)
    assert spec_effect(spec, {}) is Effect.READ  # 显式回落值优先
    registry2, spec2 = make_registry(effect_for=None, static=Effect.REVERSIBLE_WRITE)
    assert spec_effect(spec2, {"delete": True}) is Effect.REVERSIBLE_WRITE


def test_invalid_effect_for_return_falls_back_to_static() -> None:
    # effect_for 返回非 Effect（实现 bug）→ 回落静态档，不炸权限链
    registry, spec = make_registry(effect_for=lambda args: "bogus", static=Effect.READ)
    assert spec_effect(spec, {}) is Effect.READ
    def raising(args: dict) -> Effect:
        raise RuntimeError("boom")
    _, spec2 = make_registry(effect_for=raising, static=Effect.LOCAL_IRREVERSIBLE)
    assert spec_effect(spec2, {}) is Effect.LOCAL_IRREVERSIBLE


def test_registration_rejects_non_callable_effect_for() -> None:
    registry = ToolRegistry()
    with pytest.raises(ValueError):
        registry.register(ToolSpec(
            name="bad", description="b", input_schema=EMPTY_SCHEMA,
            execute=lambda **kw: "ok", effect=Effect.READ,
            effect_for="not-callable",
        ))


def test_permission_gate_uses_per_call_effect() -> None:
    """静态 READ、按参 DESTRUCTIVE 的调用必须被默认 allowed_effects 拒绝。"""
    import asyncio
    import importlib.util as ilu

    fakes = ilu.spec_from_file_location(
        "_loop_test_fakes", Path(__file__).resolve().parent / "agent_runtime_loop_test.py")
    mod = ilu.module_from_spec(fakes)
    fakes.loader.exec_module(mod)

    from app.agent_runtime.loop import LoopStopped, ToolCallFinished, run_agent_loop
    from app.agent_runtime.model_client import (
        LoopModelClient, ToolCallArrived, TurnDone,
    )
    from app.agent_runtime.types import ToolCall

    registry, _ = make_registry(effect_for=lambda args: (
        Effect.DESTRUCTIVE if args.get("delete") else Effect.READ))

    backend = mod.ScriptedBackend(
        [ToolCallArrived(call=ToolCall(id="d1", name="file_op", arguments={"delete": True})),
         ToolCallArrived(call=ToolCall(id="r1", name="file_op", arguments={})),
         TurnDone(usage=None, raw_text=None)],
        _answer_scene(),
    )
    params = mod.make_params(
        "操作文件", registry=registry, client=LoopModelClient(backend))

    async def collect():
        out = []
        async for event in run_agent_loop(params):
            out.append(event)
        return out

    events = asyncio.run(collect())
    finishes = [e for e in events if isinstance(e, ToolCallFinished)]
    assert finishes[0].result.is_error is True
    assert "permission denied" in str(finishes[0].result.value)
    assert finishes[1].result.is_error is False


def _answer_scene():
    from app.agent_runtime.model_client import MessageDelta, TurnDone
    return [MessageDelta(text="完成。"), TurnDone(usage=None, raw_text=None)]
