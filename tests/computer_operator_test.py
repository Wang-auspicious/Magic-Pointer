"""Computer operators stay behind Magic Pointer's lease and receipt boundary."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from app.agent_runtime.tool_registry import Effect
from app.computer_operator import (
    ComputerAction,
    ComputerActionKind,
    ComputerOperatorRegistry,
    GuardedComputerOperator,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
    compile_ui_tars_intent,
    parse_ui_tars_response,
)
from app.harness.context import Context


def _future(seconds: int = 60) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat()


def _grant(**changes) -> SurfaceGrant:
    value = SurfaceGrant(
        grant_id="grant-1",
        surface_id="surface-1",
        source_frame_id="frame-lease-1",
        source_frame_sha256="a" * 64,
        bounds_ltrb=(100, 200, 900, 800),
        target_lease={"schemaVersion": 1, "leaseId": "lease-1"},
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
        expires_at=_future(),
    )
    return replace(value, **changes)


def test_surface_grant_is_compiled_from_matching_frame_and_target_leases() -> None:
    frame = {
        "schemaVersion": 1,
        "frameLeaseId": "frame-1",
        "contentHash": "sha256:" + "a" * 64,
        "surfaceBoundsPx": [100, 200, 900, 800],
        "targetWindow": {"hwnd": 42, "processId": 314},
    }
    target = {
        "schemaVersion": 1,
        "leaseId": "target-1",
        "expiresAt": _future(),
        "window": {"hwnd": 42, "processId": 314},
        "windows": [{"hwnd": 42, "processId": 314}],
    }

    grant = SurfaceGrant.from_leases(
        frame,
        target,
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
    )

    assert grant.source_frame_id == "frame-1"
    assert grant.source_frame_sha256 == "a" * 64
    assert grant.bounds_ltrb == (100, 200, 900, 800)
    assert grant.surface_id == "window:42:314"


def test_surface_grant_rejects_frame_target_identity_mismatch() -> None:
    frame = {
        "schemaVersion": 1,
        "frameLeaseId": "frame-1",
        "contentHash": "a" * 64,
        "surfaceBoundsPx": [0, 0, 800, 600],
        "targetWindow": {"hwnd": 42, "processId": 314},
    }
    target = {
        "schemaVersion": 1,
        "leaseId": "target-1",
        "expiresAt": _future(),
        "window": {"hwnd": 99, "processId": 314},
    }

    with pytest.raises(ValueError, match="identity"):
        SurfaceGrant.from_leases(
            frame,
            target,
            allowed_effects=(Effect.READ,),
        )


def _observation(name: str) -> OperatorObservation:
    return OperatorObservation(
        observation_id=name,
        surface_id="surface-1",
        image_ref=f"artifact://{name}.png",
        image_sha256=("b" if name == "before" else "c") * 64,
        width=800,
        height=600,
        captured_at=datetime.now(UTC).isoformat(),
        used_backend="fake-operator",
    )


class _FakeBackend:
    backend_name = "fake-operator"

    def __init__(self) -> None:
        self.calls: list[str] = []

    def observe(self, grant, *, scope=None):
        self.calls.append("observe")
        return _observation("before" if self.calls.count("observe") == 1 else "after")

    def execute(self, action, grant, *, scope=None):
        self.calls.append("execute")
        return OperatorBackendResult(executed=True, data={"native": "receipt-1"})

    def abort(self, operation_id: str) -> bool:
        self.calls.append(f"abort:{operation_id}")
        return True


def test_guarded_operator_revalidates_then_captures_post_action_receipt() -> None:
    backend = _FakeBackend()
    lease_checks: list[dict] = []
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda lease: lease_checks.append(lease) or {"valid": True},
        authorize_effect=lambda effect: effect is Effect.REVERSIBLE_WRITE,
        verify_action=lambda action, before, after, raw: (
            action.kind is ComputerActionKind.TYPE_TEXT
            and before.image_sha256 != after.image_sha256
            and raw.executed
        ),
    )
    action = ComputerAction(
        action_id="action-1",
        kind=ComputerActionKind.TYPE_TEXT,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="before",
        source_image_sha256="b" * 64,
        text="hello",
    )

    receipt = operator.execute(action, _grant())

    assert backend.calls == ["observe", "execute", "observe"]
    assert lease_checks == [{"schemaVersion": 1, "leaseId": "lease-1"}]
    assert receipt.executed is True
    assert receipt.verified is True
    assert receipt.before.image_sha256 == "b" * 64
    assert receipt.after is not None and receipt.after.image_sha256 == "c" * 64
    assert receipt.backend_data == {"native": "receipt-1"}


def test_guarded_operator_rejects_expired_grant_without_touching_backend() -> None:
    backend = _FakeBackend()
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": True},
        authorize_effect=lambda _effect: True,
        verify_action=lambda *_args: True,
    )
    action = ComputerAction(
        action_id="action-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="before",
        source_image_sha256="b" * 64,
        start=(0.5, 0.5),
    )

    receipt = operator.execute(action, _grant(expires_at=_future(-1)))

    assert receipt.executed is False
    assert receipt.verified is False
    assert receipt.error == "surface_grant_expired"
    assert backend.calls == []


def test_guarded_operator_fails_closed_on_target_or_effect_mismatch() -> None:
    backend = _FakeBackend()
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": False, "reason": "window_changed"},
        authorize_effect=lambda _effect: True,
        verify_action=lambda *_args: True,
    )
    action = ComputerAction(
        action_id="action-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.DESTRUCTIVE,
        source_observation_id="before",
        source_image_sha256="b" * 64,
        start=(0.5, 0.5),
    )

    receipt = operator.execute(action, _grant())

    assert receipt.error == "effect_not_granted:destructive"
    assert backend.calls == []


def test_guarded_operator_validates_lease_before_capturing_pixels() -> None:
    backend = _FakeBackend()
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": False, "reason": "window_changed"},
        authorize_effect=lambda _effect: True,
        verify_action=lambda *_args: True,
    )
    action = ComputerAction(
        action_id="action-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="before",
        source_image_sha256="b" * 64,
        start=(0.5, 0.5),
    )

    receipt = operator.execute(action, _grant())

    assert receipt.error == "target_lease_invalid:window_changed"
    assert backend.calls == []


def test_guarded_operator_rechecks_delayed_visual_change_without_repeating_action() -> None:
    class DelayedBackend(_FakeBackend):
        def observe(self, grant, *, scope=None):
            self.calls.append("observe")
            count = self.calls.count("observe")
            return _observation("before" if count <= 2 else "after")

    backend = DelayedBackend()
    sleeps: list[float] = []
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": True},
        authorize_effect=lambda _effect: True,
        verify_action=lambda _action, before, after, raw: (
            raw.executed and before.image_sha256 != after.image_sha256
        ),
        verification_delays_s=(0.05,),
        sleeper=sleeps.append,
    )
    action = ComputerAction(
        action_id="action-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="before",
        source_image_sha256="b" * 64,
        start=(0.5, 0.5),
    )

    receipt = operator.execute(action, _grant())

    assert receipt.executed is True
    assert receipt.verified is True
    assert backend.calls == ["observe", "execute", "observe", "observe"]
    assert sleeps == [0.05]


def test_guarded_operator_refuses_action_compiled_from_changed_pixels() -> None:
    backend = _FakeBackend()
    operator = GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": True},
        authorize_effect=lambda _effect: True,
        verify_action=lambda *_args: True,
    )
    action = ComputerAction(
        action_id="stale-action",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="model-observation",
        source_image_sha256="d" * 64,
        start=(0.5, 0.5),
    )

    receipt = operator.execute(action, _grant())

    assert receipt.error == "source_observation_changed"
    assert receipt.executed is False
    assert backend.calls == ["observe"]


def test_ui_tars_parser_is_data_only_and_keeps_coordinates_normalized() -> None:
    intents = parse_ui_tars_response(
        "Thought: fill the field\nAction: click(start_box='[0.1, 0.2, 0.3, 0.4]')"
        "\n\ntype(content='hello world')"
    )

    assert [intent.kind for intent in intents] == [
        ComputerActionKind.CLICK,
        ComputerActionKind.TYPE_TEXT,
    ]
    assert intents[0].start == pytest.approx((0.2, 0.3))
    assert intents[1].text == "hello world"
    action = compile_ui_tars_intent(
        intents[0],
        action_id="approved-1",
        effect=Effect.REVERSIBLE_WRITE,
        source_observation=_observation("before"),
    )
    assert action.effect is Effect.REVERSIBLE_WRITE


def test_ui_tars_parser_rejects_executable_or_out_of_surface_payloads() -> None:
    with pytest.raises(ValueError, match="literal"):
        parse_ui_tars_response(
            "Action: click(start_box=__import__('os').system('whoami'))"
        )
    with pytest.raises(ValueError, match="normalized"):
        parse_ui_tars_response("Action: click(start_box='[1.2, 0.2]')")


def test_ui_tars_parser_rejects_unknown_or_duplicate_action_arguments() -> None:
    with pytest.raises(ValueError, match="unsupported argument"):
        parse_ui_tars_response(
            "Action: click(start_box='[0.2, 0.2]', surprise=True)"
        )
    with pytest.raises(ValueError, match="duplicate"):
        parse_ui_tars_response(
            "Action: click(start_box='[0.2, 0.2]', start_box='[0.4, 0.4]')"
        )


def test_ui_tars_parser_normalizes_absolute_model_image_coordinates() -> None:
    intents = parse_ui_tars_response(
        "Action: click(start_box='(200, 100, 400, 300)')",
        model_image_size=(1000, 500),
    )

    assert intents[0].start == pytest.approx((0.3, 0.4))


def test_ui_tars_parser_accepts_plus_or_space_separated_hotkeys() -> None:
    plus = parse_ui_tars_response("Action: hotkey(key='CTRL+A')")[0]
    spaced = parse_ui_tars_response("Action: hotkey(key='CTRL A')")[0]

    assert plus.keys == ("ctrl", "a")
    assert spaced.keys == ("ctrl", "a")


def test_ui_tars_press_is_a_complete_key_press_not_a_stuck_key_down() -> None:
    intent = parse_ui_tars_response("Action: press(key='enter')")[0]

    assert intent.kind is ComputerActionKind.HOTKEY
    assert intent.keys == ("enter",)


def test_ui_tars_control_intents_cannot_be_compiled_as_backend_actions() -> None:
    intent = parse_ui_tars_response("Action: finished()")

    with pytest.raises(ValueError, match="control intent"):
        compile_ui_tars_intent(
            intent[0],
            action_id="must-not-execute",
            effect=Effect.READ,
            source_observation=_observation("before"),
        )


def test_action_schema_rejects_missing_kind_specific_fields() -> None:
    with pytest.raises(ValueError, match="start coordinate"):
        ComputerAction(
            action_id="bad-click",
            kind=ComputerActionKind.CLICK,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="before",
            source_image_sha256="b" * 64,
        )
    with pytest.raises(ValueError, match="text is required"):
        ComputerAction(
            action_id="bad-type",
            kind=ComputerActionKind.TYPE_TEXT,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="before",
            source_image_sha256="b" * 64,
        )
    with pytest.raises(ValueError, match="scroll requires a start coordinate"):
        ComputerAction(
            action_id="bad-scroll",
            kind=ComputerActionKind.SCROLL,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="before",
            source_image_sha256="b" * 64,
            scroll_delta=-5,
        )
    with pytest.raises(ValueError, match="cannot be classified as read"):
        ComputerAction(
            action_id="bad-effect",
            kind=ComputerActionKind.CLICK,
            effect=Effect.READ,
            source_observation_id="before",
            source_image_sha256="b" * 64,
            start=(0.5, 0.5),
        )


def test_action_schema_bounds_text_keys_scroll_and_duration() -> None:
    common = {
        "action_id": "bounded-action",
        "source_observation_id": "observation-1",
        "source_image_sha256": "a" * 64,
        "effect": Effect.REVERSIBLE_WRITE,
    }
    with pytest.raises(ValueError, match="text exceeds"):
        ComputerAction(
            **common,
            kind=ComputerActionKind.TYPE_TEXT,
            text="x" * 20_001,
        )
    with pytest.raises(ValueError, match="at most 8"):
        ComputerAction(
            **common,
            kind=ComputerActionKind.HOTKEY,
            keys=tuple(str(index) for index in range(9)),
        )
    with pytest.raises(ValueError, match="scroll_delta"):
        ComputerAction(
            **common,
            kind=ComputerActionKind.SCROLL,
            start=(0.5, 0.5),
            scroll_delta=101,
        )
    with pytest.raises(ValueError, match="duration_ms"):
        ComputerAction(
            **common,
            kind=ComputerActionKind.DRAG,
            start=(0.1, 0.1),
            end=(0.2, 0.2),
            duration_ms=30_001,
        )


def test_operator_provider_registration_is_scoped_and_unloads_exactly() -> None:
    root = Context()
    registry = ComputerOperatorRegistry()
    root.provide("computer_operators", registry)
    plugin_scope = root.scope()

    registered = plugin_scope.get("computer_operators").register(_FakeBackend())

    assert registry.get("fake-operator") is registered
    plugin_scope.unload()
    assert registry.list_names() == ()
