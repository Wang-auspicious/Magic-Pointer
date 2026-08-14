from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image

from app.agent_runtime.tool_registry import Effect
from app.computer_operator import (
    ComputerActionKind,
    ConfiguredUiTarsModel,
    GuardedComputerOperator,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
    UiTarsComputerAgent,
    UiTarsPrediction,
)
from app.governance.cancellation import CancellationToken, CancelledError


def _grant() -> SurfaceGrant:
    return SurfaceGrant(
        grant_id="grant-1",
        surface_id="surface-1",
        source_frame_id="frame-1",
        source_frame_sha256="a" * 64,
        bounds_ltrb=(0, 0, 800, 600),
        target_lease={"schemaVersion": 1, "leaseId": "lease-1"},
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
        expires_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
    )


def _observation(index: int, *, unchanged: bool = False) -> OperatorObservation:
    digest = "b" * 64 if unchanged else f"{index % 10}" * 64
    return OperatorObservation(
        observation_id=f"observation-{index}",
        surface_id="surface-1",
        image_ref=f"artifact://observation-{index}.png",
        image_sha256=digest,
        width=800,
        height=600,
        captured_at=datetime.now(UTC).isoformat(),
        used_backend="fake-operator",
    )


class _Backend:
    backend_name = "fake-operator"

    def __init__(self, *, unchanged: bool = False) -> None:
        self.observations = 0
        self.actions = []
        self.unchanged = unchanged
        self.state = 1

    def observe(self, _grant, *, scope=None):
        self.observations += 1
        return _observation(self.state, unchanged=self.unchanged)

    def execute(self, action, _grant, *, scope=None):
        self.actions.append(action)
        if not self.unchanged:
            self.state += 1
        return OperatorBackendResult(executed=True, data={"native": len(self.actions)})

    def abort(self, _operation_id):
        return True


class _Model:
    used_backend = "fake-ui-tars"

    def __init__(self, responses: list[str]) -> None:
        self.responses = iter(responses)
        self.observations = []

    def predict(self, task, observation, history, *, scope=None):
        self.observations.append(observation)
        return next(self.responses)


def _operator(backend: _Backend) -> GuardedComputerOperator:
    return GuardedComputerOperator(
        backend,
        validate_target_lease=lambda _lease: {"valid": True},
        authorize_effect=lambda _effect: True,
        verify_action=lambda _action, _before, _after, raw: raw.executed,
    )


def _effect(intent):
    return Effect.READ if intent.kind is ComputerActionKind.WAIT else Effect.REVERSIBLE_WRITE


def test_ui_tars_agent_runs_one_verified_action_per_fresh_observation() -> None:
    backend = _Backend()
    model = _Model([
        "Thought: open it\nAction: click(start_box='[0.5, 0.5]')",
        "Thought: done\nAction: finished(content='completed')",
    ])

    result = UiTarsComputerAgent(
        operator=_operator(backend),
        model=model,
        classify_effect=_effect,
    ).run("open the selected item", _grant())

    assert result.status == "completed"
    assert result.final_text == "completed"
    assert result.rounds == 2
    assert len(result.receipts) == 1
    assert result.receipts[0].verified is True
    assert len(backend.actions) == 1
    assert model.observations[1] == result.receipts[0].after


def test_ui_tars_agent_returns_call_user_without_executing() -> None:
    backend = _Backend()
    model = _Model(["Action: call_user(content='Please log in')"])

    result = UiTarsComputerAgent(
        operator=_operator(backend),
        model=model,
        classify_effect=_effect,
    ).run("continue", _grant())

    assert result.status == "needs_user"
    assert result.question == "Please log in"
    assert backend.actions == []


def test_ui_tars_agent_refuses_multiple_blind_actions_from_one_screenshot() -> None:
    backend = _Backend()
    model = _Model(["Action: click(start_box='[0.2, 0.2]') type(content='secret')"])

    result = UiTarsComputerAgent(
        operator=_operator(backend),
        model=model,
        classify_effect=_effect,
    ).run("fill field", _grant())

    assert result.status == "failed"
    assert result.error == "multiple_actions_require_fresh_observation"
    assert backend.actions == []


def test_ui_tars_agent_stops_repeating_same_action_on_same_pixels() -> None:
    backend = _Backend(unchanged=True)
    repeated = "Action: click(start_box='[0.5, 0.5]')"
    model = _Model([repeated, repeated, repeated, repeated])

    result = UiTarsComputerAgent(
        operator=_operator(backend),
        model=model,
        classify_effect=_effect,
    ).run("open item", _grant())

    assert result.status == "stalled"
    assert result.error == "repeated_action_without_visual_change"
    assert len(backend.actions) == 2


def test_ui_tars_agent_uses_the_exact_model_image_coordinate_space() -> None:
    backend = _Backend()
    model = _Model([
        UiTarsPrediction(
            text="Action: click(start_box='[400, 300]')",
            model_image_size=(800, 600),
        ),
        UiTarsPrediction(
            text="Action: finished(content='done')",
            model_image_size=(800, 600),
        ),
    ])

    result = UiTarsComputerAgent(
        operator=_operator(backend),
        model=model,
        classify_effect=_effect,
    ).run("open", _grant())

    assert result.status == "completed"
    assert backend.actions[0].start == (0.5, 0.5)


def test_configured_ui_tars_model_reuses_vision_gateway_with_bounded_history(
    tmp_path,
) -> None:
    image_path = tmp_path / "screen.png"
    Image.new("RGB", (2000, 1000), "white").save(image_path)
    observation = replace_observation_image(_observation(1), image_path)
    captured = {}

    def predictor(path, prompt, context_text=None, **kwargs):
        captured.update(
            path=path,
            prompt=prompt,
            context_text=context_text,
            kwargs=kwargs,
        )
        return "Thought: click it\nAction: click(start_box='[800, 400]')"

    prediction = ConfiguredUiTarsModel(
        predictor=predictor,
        timeout_s=9.0,
    ).predict(
        "open item",
        observation,
        tuple({"round": index, "secret": "x" * 4000} for index in range(20)),
    )

    assert prediction.model_image_size == (1600, 800)
    assert prediction.text.startswith("Thought:")
    assert captured["path"] == image_path
    assert "exactly one" in captured["prompt"]
    assert len(captured["context_text"]) <= 12_000
    assert "secret" not in captured["context_text"]
    assert captured["kwargs"]["timeout_s"] == 9.0
    assert captured["kwargs"]["attempts"] == 1
    assert captured["kwargs"]["max_tokens"] == 600


def test_ui_tars_agent_propagates_user_cancellation() -> None:
    backend = _Backend()
    token = CancellationToken()
    token.cancel()

    with pytest.raises(CancelledError):
        UiTarsComputerAgent(
            operator=_operator(backend),
            model=_Model(["Action: finished(content='must not run')"]),
            classify_effect=_effect,
        ).run("stop", _grant(), scope=token)

    assert backend.actions == []


def replace_observation_image(
    observation: OperatorObservation,
    path,
) -> OperatorObservation:
    return OperatorObservation(
        observation_id=observation.observation_id,
        surface_id=observation.surface_id,
        image_ref=str(path),
        image_sha256=observation.image_sha256,
        width=2000,
        height=1000,
        captured_at=observation.captured_at,
        used_backend=observation.used_backend,
    )
