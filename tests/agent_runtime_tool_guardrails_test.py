"""Behavior tests for semantic tool-loop guardrails.

These tests distinguish a turn fuse from progress detection: useful new read
results and successful writes may continue, while repeated failures or repeated
evidence are diagnosed as a stalled agent trajectory.
"""

from __future__ import annotations

from app.agent_runtime.tool_guardrails import (
    ToolCallGuardrailController,
    canonical_tool_args,
)
from app.agent_runtime.tool_registry import Effect


def test_canonical_arguments_ignore_mapping_insertion_order() -> None:
    assert canonical_tool_args({"b": 2, "a": {"d": 4, "c": 3}}) == (
        canonical_tool_args({"a": {"c": 3, "d": 4}, "b": 2})
    )


def test_repeated_exact_failure_warns_then_halts() -> None:
    guard = ToolCallGuardrailController()

    decisions = [
        guard.observe(
            "read_around",
            {"anchor": "selection"},
            "timeout",
            failed=True,
            effect=Effect.READ,
        )
        for _ in range(4)
    ]

    assert [decision.action for decision in decisions] == [
        "allow",
        "warn",
        "warn",
        "halt",
    ]
    assert decisions[-1].code == "repeated_exact_failure_halt"
    assert decisions[-1].made_progress is False


def test_same_read_result_warns_then_halts_but_new_result_resets() -> None:
    guard = ToolCallGuardrailController()

    first = guard.observe(
        "read_around", {"offset": 0}, '{"value":"A"}', failed=False, effect=Effect.READ
    )
    repeat = guard.observe(
        "read_around", {"offset": 0}, '{"value":"A"}', failed=False, effect=Effect.READ
    )
    changed = guard.observe(
        "read_around", {"offset": 0}, '{"value":"B"}', failed=False, effect=Effect.READ
    )
    repeated_changed = [
        guard.observe(
            "read_around",
            {"offset": 0},
            '{"value":"B"}',
            failed=False,
            effect=Effect.READ,
        )
        for _ in range(3)
    ]

    assert first.made_progress is True
    assert repeat.action == "warn"
    assert repeat.made_progress is False
    assert changed.action == "allow"
    assert changed.made_progress is True
    assert [decision.action for decision in repeated_changed] == [
        "warn",
        "warn",
        "halt",
    ]
    assert repeated_changed[-1].code == "read_no_progress_halt"


def test_switching_read_tools_does_not_hide_duplicate_evidence() -> None:
    guard = ToolCallGuardrailController()

    decisions = [
        guard.observe(
            tool_name,
            {"query": tool_name},
            '{"status":"ok","value":"same evidence"}',
            failed=False,
            effect=Effect.READ,
        )
        for tool_name in ("read_around", "find_in_window", "dump_subtree", "look")
    ]

    assert decisions[0].made_progress is True
    assert [decision.action for decision in decisions[1:]] == ["warn", "warn", "halt"]
    assert decisions[-1].code == "duplicate_read_evidence_halt"


def test_live_observation_polling_does_not_halt_a_long_wait() -> None:
    guard = ToolCallGuardrailController()
    snapshot = '{"snapshot_id":"s1","elements":[]}'

    decisions = [
        guard.observe(
            "get_app_state",
            {"window_id": "w-42"},
            snapshot,
            failed=False,
            effect=Effect.READ,
        )
        for _ in range(8)
    ]

    assert all(decision.action != "halt" for decision in decisions)
    assert any(decision.action == "warn" for decision in decisions)
    assert decisions[-1].code != "read_no_progress_halt"


def test_successful_mutations_with_distinct_arguments_are_progress() -> None:
    guard = ToolCallGuardrailController()

    decisions = [
        guard.observe(
            "update_draft",
            {"text": f"version {index}"},
            "ok",
            failed=False,
            effect=Effect.REVERSIBLE_WRITE,
        )
        for index in range(8)
    ]

    assert all(decision.action == "allow" for decision in decisions)
    assert all(decision.made_progress is True for decision in decisions)


def test_repeating_identical_successful_mutation_warns_then_halts() -> None:
    guard = ToolCallGuardrailController()

    decisions = [
        guard.observe(
            "update_draft",
            {"text": "same"},
            "ok",
            failed=False,
            effect=Effect.REVERSIBLE_WRITE,
        )
        for _ in range(4)
    ]

    assert [decision.action for decision in decisions] == [
        "allow",
        "warn",
        "warn",
        "halt",
    ]
    assert decisions[-1].code == "repeated_successful_action_halt"
