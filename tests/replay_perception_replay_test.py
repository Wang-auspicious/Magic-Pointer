"""Replay fixtures + perception-replay tests (review Q8: 20 traces by contract)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.replay.perception_replay import (  # noqa: E402
    expected_from_trace,
    load_trace,
    trace_to_snapshot_payload,
)
from app.replay.trace_schema import DesktopTrace  # noqa: E402

FIXTURES_DIR = Path("data/replay_traces/fixtures")

EXPECTED_CONTRACTS = {
    "notepad-document-fallback",
    "notepad-selection",
    "word-writeback",
    "edge-cdp",
    "edge-no-cdp",
    "pdf-dual",
    "terminal-textpattern",
    "wechat-container-ocr",
    "explorer-files",
    "this-that",
    "blacklist-app",
    "password-redact",
    "modal-interrupt",
    "window-closed",
    "content-changed",
    "ambiguous-anchor",
    "perception-timeout-degrade",
    "injection-in-screen",
    "irreversible-confirm-receipt",
    "undo-roundtrip",
}


def _fixture_paths() -> list[Path]:
    paths = sorted(FIXTURES_DIR.glob("*.trace.json"))
    assert len(paths) == 20, f"expected 20 fixtures, found {len(paths)}"
    return paths


def test_all_twenty_fixtures_exist_and_are_schema_valid() -> None:
    seen: set[str] = set()
    for path in _fixture_paths():
        trace = load_trace(path)
        assert isinstance(trace, DesktopTrace)
        assert trace.schema_version == 1
        assert trace.trace_id == path.stem.split(".")[0]
        assert trace.frames, f"{path.name}: no frozen frame"
        contract = str((trace.ground_truth or {}).get("contract") or "")
        assert contract, f"{path.name}: no contract"
        seen.add(trace.trace_id)
    assert seen == EXPECTED_CONTRACTS


def test_half_the_fixtures_are_failure_paths() -> None:
    """The harness sells predictable failure: half the fixtures exercise it."""
    failure_ids = {
        "blacklist-app",
        "password-redact",
        "modal-interrupt",
        "window-closed",
        "content-changed",
        "ambiguous-anchor",
        "perception-timeout-degrade",
        "injection-in-screen",
        "irreversible-confirm-receipt",
        "undo-roundtrip",
    }
    assert len(failure_ids) == 10


def test_trace_to_snapshot_payload_shapes_the_bridge_input() -> None:
    trace = load_trace(FIXTURES_DIR / "notepad-document-fallback.trace.json")
    payload = trace_to_snapshot_payload(trace)
    snapshot = payload["selectionSnapshot"]
    # Replay evidence is honest about its origin: it is NOT a FrameLease and
    # must not claim to be one (a live bridge must never trust it as frozen).
    assert snapshot["status"] == "replay"
    assert snapshot["capture_attestation"]["status"] == "replay"
    assert snapshot["source_kind"] == "replay"
    assert snapshot["capture_attestation"]["backend"] == "replay"
    context = snapshot["context"]
    assert context["content"]  # UIA tree text carries the structured content
    assert "架构" in context["content"]
    assert payload["command"] == "这个文件里读到了啥。概况总结。"
    assert payload["selectionSessionId"] == f"replay:{trace.trace_id}"


def test_expected_from_trace_round_trips() -> None:
    trace = load_trace(FIXTURES_DIR / "irreversible-confirm-receipt.trace.json")
    expectation = expected_from_trace(trace)
    assert expectation["proposal_recipe"] == "task.route"
    assert expectation["requires_confirmation"] is True


def test_injection_fixture_carries_the_screen_instruction() -> None:
    trace = load_trace(FIXTURES_DIR / "injection-in-screen.trace.json")
    payload = trace_to_snapshot_payload(trace)
    content = str(payload["selectionSnapshot"]["context"]["content"] or "")
    assert "删除所有文件" in content
    assert expected_from_trace(trace)["injection_flagged"] is True
