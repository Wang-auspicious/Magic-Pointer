"""C2 integration: write-back tools declare compensation slots (undo).

The fabric registry's write-back tools (rewrite_in_place,
translate_in_place, selection_expand, selection_condense) must carry a
``compensate`` slot so the ActionLease/action_guard caller can record a
:class:`Compensation` before the write-back runs and restore the target on
undo. Everything here is fake: the executor methods are monkeypatched, the
undo restore runs the test's fake :func:`_undo_write_back`, and no real
clipboard, model, file or target state is touched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.action_guard.undo_log import Compensation, UndoLog
from app.agent_runtime.tool_registry import Effect, GLOBAL_REGISTRY, ToolRegistry, ToolSpec
from app.fabric import executors as fabric_executors
from app.fabric.executors import FabricExecutors, register_fabric_tools
from app.fabric.schema import ExecutionReceipt

WRITE_BACK_TOOLS = (
    "rewrite_in_place",
    "translate_in_place",
    "selection_expand",
    "selection_condense",
)

READ_TOOLS = ("ocr_copy", "screen_translate", "memory_recall")

COMPENSATION_KEYS = {
    "action_id",
    "tool_name",
    "target_ref",
    "prior_content",
    "cursor_position",
    "was_created",
    "captured_at_utc",
}


@pytest.fixture
def registry(tmp_path: Path) -> ToolRegistry:
    _runner, reg = _fresh_registry(tmp_path)
    return reg


def _receipt_for(plan) -> ExecutionReceipt:
    return ExecutionReceipt(
        id="receipt-1",
        plan_id=plan.id,
        recipe_id=plan.recipe_id,
        status="succeeded",
        provider=plan.provider,
        output={"ok": True},
        verified=True,
    )


def _fresh_registry(tmp_path: Path) -> tuple[FabricExecutors, ToolRegistry]:
    runner = FabricExecutors(root=tmp_path)
    registry = ToolRegistry()
    register_fabric_tools(registry, executors=runner)
    return runner, registry


def _write_back_compensation(
    *,
    action_id: str = "act-1",
    tool_name: str = "rewrite_in_place",
    target_ref: str | None = "doc-1",
    prior_content: str | None = "original",
    was_created: bool = False,
    compensate,
) -> Compensation:
    return Compensation(
        action_id=action_id,
        tool_name=tool_name,
        target_ref=target_ref,
        prior_content=prior_content,
        cursor_position=(10, 20),
        was_created=was_created,
        captured_at_utc="2026-08-13T00:00:00Z",
        compensate=compensate,
    )


# -- 1. registration surface --------------------------------------------------


@pytest.mark.parametrize("name", WRITE_BACK_TOOLS)
def test_write_back_tools_declare_compensate(registry: ToolRegistry, name: str) -> None:
    spec = registry.get(name)
    assert spec.compensate is not None
    assert callable(spec.compensate)


@pytest.mark.parametrize("name", READ_TOOLS)
def test_read_tools_have_no_compensate(registry: ToolRegistry, name: str) -> None:
    spec = registry.get(name)
    assert spec.compensate is None


def test_register_rejects_non_callable_compensate() -> None:
    spec = ToolSpec(
        name="bad_slot",
        description="d",
        input_schema={
            "type": "object",
            "properties": {},
            "required": [],
        },
        execute=lambda **kwargs: "ok",
        effect=Effect.REVERSIBLE_WRITE,
        compensate="not-callable",  # type: ignore[arg-type]
    )
    with pytest.raises(ValueError, match="compensate"):
        ToolRegistry().register(spec)


def test_register_accepts_callable_compensate() -> None:
    def compensate(args: dict) -> None:
        pass

    spec = ToolSpec(
        name="good_slot",
        description="d",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda **kwargs: "ok",
        effect=Effect.REVERSIBLE_WRITE,
        compensate=compensate,
    )
    registry = ToolRegistry()
    assert registry.register(spec) is spec
    assert registry.get("good_slot").compensate is compensate


# -- 2. compensation slot forwarding (fake stub) ------------------------------


def test_compensate_forwards_args_dict_to_undo_stub(
    monkeypatch, registry: ToolRegistry
) -> None:
    received: list = []
    monkeypatch.setattr(fabric_executors, "_undo_write_back", lambda args: received.append(args))
    spec = registry.get("rewrite_in_place")
    args = {"target_ref": "doc-1", "prior_content": "old", "was_created": False}
    spec.compensate(args)
    assert len(received) == 1
    assert received[0] == args


def test_compensate_accepts_compensation_object(
    monkeypatch, registry: ToolRegistry
) -> None:
    received: list = []
    monkeypatch.setattr(fabric_executors, "_undo_write_back", lambda args: received.append(args))
    spec = registry.get("rewrite_in_place")
    comp = _write_back_compensation(
        prior_content="old",
        was_created=False,
        compensate=spec.compensate,
    )
    comp.compensate(comp)
    assert len(received) == 1
    got = received[0]
    assert isinstance(got, dict)
    assert got["target_ref"] == "doc-1"
    assert got["prior_content"] == "old"
    assert got["was_created"] is False
    assert got["action_id"] == "act-1"
    assert got["tool_name"] == "rewrite_in_place"
    assert COMPENSATION_KEYS <= set(got)


# -- 3. UndoLog integration ---------------------------------------------------


def test_undo_log_chain_reaches_executors_stub(
    monkeypatch, registry: ToolRegistry
) -> None:
    received: list = []
    monkeypatch.setattr(fabric_executors, "_undo_write_back", lambda args: received.append(args))
    spec = registry.get("rewrite_in_place")
    log = UndoLog()
    comp = _write_back_compensation(
        prior_content="original", was_created=False, compensate=spec.compensate
    )
    log.record(comp)
    restored = log.undo()
    assert restored is comp
    assert len(received) == 1
    got = received[0]
    assert got["target_ref"] == "doc-1"
    assert got["prior_content"] == "original"
    assert got["was_created"] is False


def _restore_stub(targets: dict[str, str]) -> object:
    def restore(args: dict) -> None:
        if args["was_created"]:
            targets.pop(args["target_ref"], None)
        else:
            targets[args["target_ref"]] = args["prior_content"]

    return restore


def test_full_flow_execute_record_undo_restores_content(
    monkeypatch, tmp_path: Path
) -> None:
    runner, registry = _fresh_registry(tmp_path)
    targets: dict[str, str] = {}

    def fake_inplace(plan):
        targets["doc-1"] = "rewritten"
        return _receipt_for(plan)

    monkeypatch.setattr(runner, "_inplace_text", fake_inplace)
    monkeypatch.setattr(fabric_executors, "_undo_write_back", _restore_stub(targets))

    spec = registry.get("rewrite_in_place")
    result = registry.execute_tool(
        "rewrite_in_place",
        {
            "command": "rewrite",
            "objects": [
                {"id": "obj-1", "kind": "text", "content": "hello", "source": {"app": "notepad"}}
            ],
        },
    )
    assert result.is_error is False
    assert targets["doc-1"] == "rewritten"

    log = UndoLog()
    log.record(
        _write_back_compensation(
            tool_name="rewrite_in_place",
            target_ref="doc-1",
            prior_content="original",
            was_created=False,
            compensate=spec.compensate,
        )
    )
    log.undo()
    assert targets["doc-1"] == "original"


def test_full_flow_was_created_undo_deletes_target(
    monkeypatch, tmp_path: Path
) -> None:
    runner, registry = _fresh_registry(tmp_path)
    targets: dict[str, str] = {}

    def fake_inplace(plan):
        targets["doc-2"] = "brand-new"
        return _receipt_for(plan)

    monkeypatch.setattr(runner, "_inplace_text", fake_inplace)
    monkeypatch.setattr(fabric_executors, "_undo_write_back", _restore_stub(targets))

    spec = registry.get("selection_expand")
    result = registry.execute_tool(
        "selection_expand",
        {
            "objects": [
                {"id": "obj-1", "kind": "text", "content": "hi", "source": {"app": "notepad"}}
            ]
        },
    )
    assert result.is_error is False
    assert "doc-2" in targets

    log = UndoLog()
    log.record(
        _write_back_compensation(
            action_id="act-2",
            tool_name="selection_expand",
            target_ref="doc-2",
            prior_content=None,
            was_created=True,
            compensate=spec.compensate,
        )
    )
    log.undo()
    assert "doc-2" not in targets


# -- 4. process-wide registry -------------------------------------------------


def test_global_registry_declares_compensate_slots() -> None:
    register_fabric_tools(GLOBAL_REGISTRY)  # idempotent
    for name in WRITE_BACK_TOOLS:
        assert GLOBAL_REGISTRY.get(name).compensate is not None
