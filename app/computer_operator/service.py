"""Explicitly-authorized entry point for visual computer tasks."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from app.agent_runtime.tool_registry import Effect
from app.fabric.target_lease import validate_target_lease

from .agent import UiTarsActionModel, UiTarsComputerAgent, UiTarsRunResult
from .configured_model import ConfiguredUiTarsModel
from .protocol import GuardedComputerOperator
from .registry import ComputerOperatorRegistry
from .schema import (
    ComputerAction,
    ComputerActionKind,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
)

ModelFactory = Callable[[], UiTarsActionModel]
LiveWindowProbe = Callable[[], Iterable[dict[str, Any]]]


def _visual_change_verifier(
    action: ComputerAction,
    before: OperatorObservation,
    after: OperatorObservation,
    raw: OperatorBackendResult,
) -> bool:
    if not raw.executed:
        return False
    if action.kind in {ComputerActionKind.WAIT, ComputerActionKind.HOVER}:
        return True
    return before.image_sha256 != after.image_sha256


class ComputerTaskService:
    """Create a guarded visual loop only from an explicit effect grant.

    This is a Harness service, not a generic model-facing tool. The caller
    must already have classified and authorized the whole GUI task's maximum
    effect. That keeps an ambiguous visual click from silently downgrading
    itself to a read or reversible action.
    """

    def __init__(
        self,
        registry: ComputerOperatorRegistry,
        *,
        model_factory: ModelFactory = ConfiguredUiTarsModel,
        live_window_probe: LiveWindowProbe,
    ) -> None:
        if not callable(model_factory) or not callable(live_window_probe):
            raise TypeError("model_factory and live_window_probe must be callable")
        self.registry = registry
        self.model_factory = model_factory
        self.live_window_probe = live_window_probe

    def run(
        self,
        task: str,
        *,
        frame_lease: dict[str, Any],
        target_lease: dict[str, Any],
        action_effect: Effect,
        backend_name: str = "windows-native",
        scope: Any = None,
    ) -> UiTarsRunResult:
        if not isinstance(action_effect, Effect) or action_effect is Effect.READ:
            raise ValueError("computer input actions require an explicit non-read effect")
        grant = SurfaceGrant.from_leases(
            frame_lease,
            target_lease,
            allowed_effects=(Effect.READ, action_effect),
        )

        def lease_validator(value: dict[str, Any]) -> dict[str, Any]:
            live = list(self.live_window_probe())
            return validate_target_lease(value, live_windows=live).to_dict()

        operator = GuardedComputerOperator(
            self.registry.get(backend_name),
            validate_target_lease=lease_validator,
            authorize_effect=lambda effect: effect in grant.allowed_effects,
            verify_action=_visual_change_verifier,
        )
        model = self.model_factory()
        agent = UiTarsComputerAgent(
            operator=operator,
            model=model,
            classify_effect=lambda intent: (
                Effect.READ
                if intent.kind is ComputerActionKind.WAIT
                else action_effect
            ),
        )
        return agent.run(task, grant, scope=scope)
