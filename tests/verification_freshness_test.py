
from __future__ import annotations

import asyncio
import json

import pytest

from app.agent_runtime.loop import LoopParams, VerificationNudged, run_agent_loop
from app.agent_runtime.model_client import (
    LoopModelClient,
    MessageDelta,
    ToolCallArrived,
    TurnDone,
)
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry
from app.agent_runtime.turn_verification import VerificationGate, should_nudge_before_completion
from app.agent_runtime.types import ToolCall
from app.desktop_actions import DesktopActionSession, register_desktop_action_tools
from app.receipts.projection import project_receipts
from app.receipts.schema import ReceiptStatus


@pytest.mark.parametrize("name", ["Write", "Click", "click"])
def test_later_mutation_invalidates_earlier_verification(name):
    gate = VerificationGate()
    gate.record_executed(effect=Effect.REVERSIBLE_WRITE, verified=True, tool_name="SetValue")
    gate.record_executed(
        effect=Effect.REVERSIBLE_WRITE,
        verified=name in {"Click", "click"},
        tool_name=name,
    )
    assert gate.wrote
    assert not gate.verified
    assert should_nudge_before_completion(gate) is not None


@pytest.mark.parametrize("name", ["Observe", "get_app_state"])
def test_observation_without_a_postcondition_is_not_verification(name):
    gate = VerificationGate()
    gate.record_executed(effect=Effect.REVERSIBLE_WRITE, verified=False, tool_name="Type")
    gate.record_executed(effect=Effect.READ, verified=False, tool_name=name)
    assert not gate.verified
    assert should_nudge_before_completion(gate) is not None


class _Driver:
    def __init__(self):
        self.calls = []
        self.uia_calls = []
        self.values = {}

    def click(self, point, **kwargs):
        self.calls.append(("click", point))

    def type_text(self, text):
        self.calls.append(("type", text))

    def key_down(self, key):
        self.calls.append(("key_down", key))

    def key_up(self, key):
        self.calls.append(("key_up", key))

    def scroll(self, point, *, delta):
        self.calls.append(("scroll", point, delta))

    def drag(self, start, end, *, duration_ms):
        self.calls.append(("drag", start, end, duration_ms))

    def uia(self, action, element, value=None):
        self.uia_calls.append(action)
        if action == "value":
            self.values[element["index"]] = value
        elif action == "read_value":
            value = self.values.get(element["index"])
        return {"ok": True, "backend": f"test_uia_{action}", "value": value}


class _Scripted:
    def __init__(self, calls):
        self.rounds = [
            [*(ToolCallArrived(call=call) for call in calls), TurnDone(usage=None, raw_text=None)],
            [MessageDelta(text="已执行。"), TurnDone(usage=None, raw_text=None)],
            [MessageDelta(text="已执行但未验证。"), TurnDone(usage=None, raw_text=None)],
        ]

    def generate(self, messages, tools, budget_ms=None, cancel_scope=None):
        yield from self.rounds.pop(0)


def _desktop_registry():
    driver = _Driver()
    desktop = DesktopActionSession(
        driver=driver,
        windows_probe=lambda: [{"hwnd": 42, "pid": 1001, "window_id": "w-42", "rect": [0, 0, 500, 400]}],
        elements_probe=lambda hwnd: [{"index": 1, "role": "edit", "name": "Body", "value": driver.values.get(1, ""), "rect": [10, 10, 400, 350], "patterns": ["Value"]}],
        launcher=lambda app: {"ok": True},
        uia_act=driver.uia,
        session_id="verification-test",
    )
    registry = ToolRegistry()
    register_desktop_action_tools(registry, desktop)
    snapshot = json.loads(desktop.get_app_state(window_id="w-42"))["snapshot_id"]
    return registry, driver, snapshot


def _run(tmp_path, registry, calls):
    session = FileSessionStore(tmp_path).create("verification-freshness")
    params = LoopParams(
        user_input="执行这些操作并核对结果",
        registry=registry,
        client=LoopModelClient(_Scripted(calls)),
        session=session,
        request_header={"systemPrompt": "system"},
    )

    async def collect():
        return [event async for event in run_agent_loop(params)]

    events = asyncio.run(collect())
    return events, project_receipts(session.events)[-1]


@pytest.mark.parametrize("click_name,observe_name", [("Click", "Observe"), ("click", "get_app_state")])
def test_real_desktop_registration_click_then_observe_keeps_receipt_unverified(tmp_path, click_name, observe_name):
    registry, driver, snapshot = _desktop_registry()
    events, receipt = _run(tmp_path, registry, [
        ToolCall(id="click", name=click_name, arguments={"snapshot_id": snapshot, "index": 1}),
        ToolCall(id="observe", name=observe_name, arguments={"window_id": "w-42"}),
    ])
    assert driver.calls == [("click", (205, 180))]
    assert sum(isinstance(event, VerificationNudged) for event in events) == 1
    assert receipt.status is ReceiptStatus.UNVERIFIED
    assert receipt.wrote and not receipt.verified


def test_loop_later_unverified_write_cannot_reuse_first_write_receipt(tmp_path):
    registry, driver, snapshot = _desktop_registry()
    events, receipt = _run(tmp_path, registry, [
        ToolCall(id="verified", name="SetValue", arguments={"snapshot_id": snapshot, "index": 1, "value": "first"}),
        ToolCall(id="unverified", name="Type", arguments={"snapshot_id": snapshot, "text": "second"}),
    ])
    assert json.loads(events[-1].terminal.results[0].value)["verification"]["matched"] is True
    assert driver.calls == [("type", "second")]
    assert sum(isinstance(event, VerificationNudged) for event in events) == 1
    assert receipt.status is ReceiptStatus.UNVERIFIED
    assert receipt.wrote and not receipt.verified


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("name,alias,arguments", [
    ("Click", "click", {"index": 1}),
    ("Key", "press_key", {"keys": "ctrl+s"}),
    ("Scroll", "scroll", {"index": 1, "dy": -120}),
    ("Drag", "drag", {"index": 1, "to_x": 300, "to_y": 250}),
    ("Select", "select_text", {"index": 1}),
    ("Select", "select_text", {"x": 100, "y": 100}),
    ("Act", "perform_secondary_action", {"index": 1, "action": "invoke"}),
])
def test_input_success_is_not_result_verification(tmp_path, name, alias, arguments, legacy):
    registry, driver, snapshot = _desktop_registry()
    tool_name = alias if legacy else name
    assert registry.get(tool_name).effect is Effect.REVERSIBLE_WRITE

    events, receipt = _run(tmp_path, registry, [
        ToolCall(id="input", name=tool_name, arguments={"snapshot_id": snapshot, **arguments}),
    ])

    result = events[-1].terminal.results[0]
    assert not result.is_error
    assert driver.calls or driver.uia_calls
    assert json.loads(result.value)["verification"] == {"matched": False, "status": "unavailable"}
    assert sum(isinstance(event, VerificationNudged) for event in events) == 1
    assert receipt.status is ReceiptStatus.UNVERIFIED
    assert receipt.wrote and not receipt.verified


@pytest.mark.parametrize("name", ["SetValue", "act_ui"])
def test_actual_postcondition_still_produces_verified_receipt(tmp_path, name):
    registry, driver, snapshot = _desktop_registry()
    arguments = (
        {"snapshot_id": snapshot, "index": 1, "value": "saved"}
        if name == "SetValue" else {
            "state_id": snapshot,
            "actions": [{"action": "setText", "ref": "@e1", "text": "saved"}],
            "expect": {"value": "saved"},
        }
    )
    events, receipt = _run(tmp_path, registry, [
        ToolCall(id="verified", name=name, arguments=arguments),
    ])

    result = events[-1].terminal.results[0]
    assert not result.is_error
    assert driver.values[1] == "saved"
    verification = json.loads(result.value)["verification"]
    assert verification["matched"] is True
    if name == "act_ui":
        assert verification["found"] is True
        assert verification["timed_out"] is False
        assert verification["state_id"]
    assert not any(isinstance(event, VerificationNudged) for event in events)
    assert receipt.status is ReceiptStatus.SUCCEEDED
    assert receipt.wrote and receipt.verified


@pytest.mark.parametrize("expect", [None, {"value": "missing", "timeout_ms": 100}])
def test_act_ui_without_a_matched_postcondition_remains_unverified(tmp_path, expect):
    registry, driver, snapshot = _desktop_registry()
    arguments = {
        "state_id": snapshot,
        "actions": [{"action": "keypress", "keys": ["ctrl", "s"]}],
    }
    if expect is not None:
        arguments["expect"] = expect
    events, receipt = _run(tmp_path, registry, [
        ToolCall(id="action", name="act_ui", arguments=arguments),
    ])

    result = events[-1].terminal.results[0]
    assert not result.is_error
    assert driver.calls
    verification = json.loads(result.value)["verification"]
    assert verification["matched"] is False
    if expect is not None:
        assert verification["found"] is False
        assert verification["timed_out"] is True
        assert verification["state_id"]
    assert receipt.status is ReceiptStatus.UNVERIFIED
    assert not receipt.verified


@pytest.mark.parametrize("expect", [{"timeout_ms": 10}, {"text": ""}])
def test_act_ui_options_without_a_condition_cannot_verify_a_write(tmp_path, expect):
    registry, driver, snapshot = _desktop_registry()
    events, receipt = _run(tmp_path, registry, [ToolCall(
        id="action", name="act_ui", arguments={
            "state_id": snapshot,
            "actions": [{"action": "keypress", "keys": ["ctrl", "s"]}],
            "expect": expect,
        },
    )])
    result = events[-1].terminal.results[0]
    assert not result.is_error
    assert driver.calls
    assert json.loads(result.value)["verification"]["matched"] is False
    assert receipt.status is ReceiptStatus.UNVERIFIED
