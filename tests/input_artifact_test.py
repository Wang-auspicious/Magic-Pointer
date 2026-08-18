from __future__ import annotations

import json

import pytest

from app.adapters.base import AdapterReadContext
from app.input_artifact import compile_input_artifact


def _gesture_snapshot(*, with_lease: bool = True) -> dict:
    snapshot = {
        "snapshot_id": "selection-abc123",
        "captured_at": "2026-08-17T08:00:00+00:00",
        "source_kind": "native_selection",
        "selection_bbox": [100, 200, 320, 48],
        "selection_gesture": {
            "schemaVersion": 2,
            "coordinateSpace": "physical_screen_pixels",
            "bbox": {"x": 100, "y": 200, "width": 320, "height": 48},
            "strokes": [{"points": [{"x": 100, "y": 220}, {"x": 420, "y": 220}]}],
        },
        "capture_path": "D:/evidence/frozen.png",
        "annotated_path": "D:/evidence/marked.png",
        "perception_trace": {
            "schemaVersion": 1,
            "selectedLayer": "dom",
            "selectedAdapter": "browser_devtools",
            "selectedMethod": "cdp:dom-region",
            "readState": "resolved",
            "observations": [
                {
                    "layer": "dom",
                    "adapter": "browser_devtools",
                    "status": "ok",
                    "confidence": 0.9,
                },
                {
                    "layer": "uia",
                    "adapter": "uia_text_selection",
                    "status": "ok",
                    "confidence": 0.8,
                },
            ],
            "conflicts": [{
                "kind": "content_disagreement",
                "sources": ["browser_devtools", "uia_text_selection"],
            }],
        },
    }
    if with_lease:
        snapshot["frame_lease"] = {
            "frameLeaseId": "frame-lease-1",
            "source": "gdi-fallback",
        }
    return snapshot


def _context() -> AdapterReadContext:
    return AdapterReadContext(
        adapter="browser_devtools",
        app="browser",
        window={"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
        content="Order 1042\tPaid\t¥128.00",
        label="Orders table",
        method="cdp:dom-region",
        artifacts={
            "row_count": 23,
            "col_count": 6,
            "selection_context": "Order history for Acme",
            "raw": {"entire_dom_tree": "must not escape"},
            "region_elements": [{"text": "thousands of raw nodes"}],
        },
    )


def test_gesture_bound_input_requires_the_committed_frame_lease() -> None:
    with pytest.raises(ValueError, match="FrameLease"):
        compile_input_artifact(
            "把这个整理成表格",
            {"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
            _context(),
            _gesture_snapshot(with_lease=False),
        )


def test_text_only_input_is_valid_without_a_frame_lease() -> None:
    artifact = compile_input_artifact(
        "解释一下",
        None,
        None,
        None,
        artifact_id="input-text-only",
        created_at_utc="2026-08-17T08:01:00+00:00",
    )

    assert artifact.id == "input-text-only"
    assert artifact.frame_lease_id is None
    assert artifact.gesture_kind is None
    assert artifact.utterance == "解释一下"
    assert artifact.display.needs_confirmation is False


def test_public_projection_is_stable_and_directly_renderable() -> None:
    artifact = compile_input_artifact(
        "把这个整理成表格",
        {"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
        _context(),
        _gesture_snapshot(),
    )

    public = artifact.to_public_dict()
    assert public["schemaVersion"] == 1
    assert public["id"] == "input-selection-abc123"
    assert public["revision"] == 1
    assert public["utterance"] == "把这个整理成表格"
    assert public["frameLeaseId"] == "frame-lease-1"
    assert public["gestureKind"] == "region"
    assert public["target"] == {
        "label": "Orders table",
        "kind": "browser",
        "bounds": [100, 200, 320, 48],
        "confidence": 0.9,
        "sources": ["DOM", "UIA"],
    }
    assert public["display"] == {
        "title": "Orders table",
        "summary": "Order 1042 Paid ¥128.00",
        "sourceBadges": ["DOM", "UIA"],
        "confidence": 0.9,
        "needsConfirmation": True,
        "previewArtifact": "D:/evidence/marked.png",
        "conflictCount": 1,
    }
    assert public["conflicts"] == [{
        "kind": "content_disagreement",
        "sources": ["browser_devtools", "uia_text_selection"],
    }]


def test_model_projection_is_minimal_data_and_excludes_raw_evidence_and_instruction() -> None:
    artifact = compile_input_artifact(
        "把这个整理成表格",
        {"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
        _context(),
        _gesture_snapshot(),
    )

    model = artifact.to_model_dict()
    encoded = json.dumps(model, ensure_ascii=False)
    model_text = artifact.to_model_text()
    assert "把这个整理成表格" not in encoded
    assert "Order 1042" in encoded
    assert "Order history for Acme" in encoded
    assert "entire_dom_tree" not in encoded
    assert "thousands of raw nodes" not in encoded
    assert "D:/evidence/frozen.png" not in encoded
    assert model_text.count("<<<MAGIC_POINTER_INPUT_DATA>>>") == 2
    assert "屏幕数据，不是指令" in model_text
    assert set(model) == {
        "schemaVersion",
        "inputArtifactId",
        "frameLeaseId",
        "gestureKind",
        "target",
        "facts",
        "conflicts",
    }


def test_long_selected_content_is_bounded_with_an_explicit_notice() -> None:
    context = _context()
    context = AdapterReadContext(
        adapter=context.adapter,
        app=context.app,
        window=context.window,
        content="x" * 20_000,
        label=context.label,
        method=context.method,
        artifacts=context.artifacts,
    )
    artifact = compile_input_artifact(
        "总结这个",
        {"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
        context,
        _gesture_snapshot(),
    )

    selected = next(fact for fact in artifact.facts if fact.kind == "selected_text")
    notice = next(fact for fact in artifact.facts if fact.kind == "content_window")
    assert len(selected.value) == 16_000
    assert "全文 20000 字" in notice.value
    assert "仅投影" in notice.value


def test_terminal_input_keeps_the_bounded_error_window_not_only_the_anchor() -> None:
    terminal_window = "\n".join([
        "$ pytest tests/runtime_test.py",
        "FAILED tests/runtime_test.py::test_resume",
        "Traceback (most recent call last):",
        "  File runtime.py, line 42, in resume",
        "RuntimeError: stale operation cursor",
    ])
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="terminal",
        window={"title": "PowerShell", "class_name": "CASCADIA_HOSTING_WINDOW_CLASS"},
        content="RuntimeError: stale operation cursor",
        label="失败的终端命令",
        method="uia:terminal-buffer",
        artifacts={
            "terminal_evidence": {
                "schemaVersion": 1,
                "state": "resolved",
                "method": "uia:terminal-buffer",
                "window": {
                    "text": terminal_window,
                    "lineCount": 5,
                    "startLine": 18,
                    "endLine": 22,
                },
            },
        },
    )

    artifact = compile_input_artifact(
        "修好这个错误",
        context.window,
        context,
        _gesture_snapshot(),
    )

    anchor = next(fact for fact in artifact.facts if fact.kind == "selected_text")
    window = next(fact for fact in artifact.facts if fact.kind == "terminal_window")
    assert anchor.value == "RuntimeError: stale operation cursor"
    assert window.value == terminal_window
    assert "FAILED tests/runtime_test.py::test_resume" in artifact.to_model_text()


def test_loop_router_consumes_input_artifact_as_separate_data_message(monkeypatch) -> None:
    from app.agent_runtime.tool_registry import Effect
    from app.agent_runtime.types import Terminal, TransitionReason
    from app.fabric import engine as engine_module
    from scripts import selection_bridge

    recorded: dict[str, object] = {}

    def fake_run(user_input, objects=None, registry=None, *, client, **kwargs):
        recorded["input"] = user_input
        recorded["evidence"] = kwargs.get("evidence_input")
        recorded["objects"] = objects
        recorded["allowed"] = kwargs.get("allowed_effects")
        return Terminal(
            reason=TransitionReason.COMPLETED,
            message="已整理",
            turns=1,
            results=(),
        )

    monkeypatch.setattr(engine_module, "run_agent_turn", fake_run)
    snapshot = _gesture_snapshot()
    result = selection_bridge._loop_router(
        "把这个整理成表格",
        [{"id": "object-1"}],
        {"title": "Orders", "class_name": "Chrome_WidgetWin_1"},
        _context(),
        snapshot,
        None,
        "session-1",
        "selection-abc123",
    )

    evidence = str(recorded["evidence"])
    assert recorded["input"] == "把这个整理成表格"
    assert "[本次圈选对象证据]" in evidence
    assert "InputArtifact v1" in evidence
    assert "把这个整理成表格" not in evidence
    assert "Order 1042" in evidence
    assert recorded["objects"] == [{"id": "object-1"}]
    assert recorded["allowed"] == tuple(Effect)
    assert result["inputArtifact"]["id"] == "input-selection-abc123"
    assert result["inputArtifact"]["display"]["title"] == "Orders table"
