"""Guarded provider seam for UI-TARS, Codex Computer Use and remote operators."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any, Protocol

from app.agent_runtime.tool_registry import Effect
from app.governance.cancellation import CancelledError

from .schema import (
    ComputerAction,
    OperatorActionReceipt,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
)


class ComputerOperatorBackend(Protocol):
    backend_name: str

    def observe(self, grant: SurfaceGrant, *, scope: Any = None) -> OperatorObservation: ...

    def execute(
        self,
        action: ComputerAction,
        grant: SurfaceGrant,
        *,
        scope: Any = None,
    ) -> OperatorBackendResult: ...

    def abort(self, operation_id: str) -> bool: ...


LeaseValidator = Callable[[dict[str, Any]], bool | dict[str, Any]]
EffectAuthorizer = Callable[[Effect], bool]
ActionVerifier = Callable[
    [ComputerAction, OperatorObservation, OperatorObservation, OperatorBackendResult],
    bool,
]


class GuardedComputerOperator:
    """Core-owned checks around an otherwise untrusted operator provider."""

    def __init__(
        self,
        backend: ComputerOperatorBackend,
        *,
        validate_target_lease: LeaseValidator,
        authorize_effect: EffectAuthorizer,
        verify_action: ActionVerifier,
        verification_delays_s: tuple[float, ...] = (0.08, 0.2),
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        delays = tuple(float(value) for value in verification_delays_s)
        if len(delays) > 5 or any(value < 0.0 or value > 2.0 for value in delays):
            raise ValueError("verification delays must contain at most five values in [0, 2]")
        if not callable(sleeper):
            raise TypeError("sleeper must be callable")
        self.backend = backend
        self.validate_target_lease = validate_target_lease
        self.authorize_effect = authorize_effect
        self.verify_action = verify_action
        self.verification_delays_s = delays
        self.sleeper = sleeper

    def _receipt(
        self,
        action: ComputerAction,
        grant: SurfaceGrant,
        started: float,
        *,
        executed: bool = False,
        verified: bool = False,
        before: OperatorObservation | None = None,
        after: OperatorObservation | None = None,
        backend_data: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> OperatorActionReceipt:
        return OperatorActionReceipt(
            action_id=action.action_id,
            grant_id=grant.grant_id,
            executed=executed,
            verified=verified,
            used_backend=str(self.backend.backend_name),
            latency_ms=round((time.perf_counter() - started) * 1000.0, 3),
            before=before,
            after=after,
            backend_data=dict(backend_data or {}),
            error=error,
        )

    @staticmethod
    def _lease_error(value: bool | dict[str, Any]) -> str | None:
        if value is True:
            return None
        if value is False:
            return "target_lease_invalid"
        if not isinstance(value, dict) or value.get("valid") is not True:
            reason = str(value.get("reason") or "target_lease_invalid") if isinstance(value, dict) else "target_lease_invalid"
            return f"target_lease_invalid:{reason}"
        return None

    @staticmethod
    def _observation_error(value: OperatorObservation, grant: SurfaceGrant) -> str | None:
        if not isinstance(value, OperatorObservation):
            return "operator_observation_invalid"
        if value.surface_id != grant.surface_id:
            return "operator_surface_mismatch"
        return None

    def _validate_lease(self, grant: SurfaceGrant) -> str | None:
        try:
            return self._lease_error(
                self.validate_target_lease(dict(grant.target_lease))
            )
        except Exception as exc:
            return f"target_lease_probe_failed:{type(exc).__name__}:{exc}"

    def observe(
        self,
        grant: SurfaceGrant,
        *,
        scope: Any = None,
    ) -> OperatorObservation:
        """Capture one current surface only after authority is revalidated."""
        if grant.expired():
            raise PermissionError("surface_grant_expired")
        if Effect.READ not in grant.allowed_effects:
            raise PermissionError("effect_not_granted:read")
        try:
            authorized = self.authorize_effect(Effect.READ)
        except Exception as exc:
            raise PermissionError(
                f"effect_authorization_failed:{type(exc).__name__}:{exc}"
            ) from exc
        if not authorized:
            raise PermissionError("effect_not_authorized:read")
        lease_error = self._validate_lease(grant)
        if lease_error:
            raise PermissionError(lease_error)
        observation = self.backend.observe(grant, scope=scope)
        observation_error = self._observation_error(observation, grant)
        if observation_error:
            raise RuntimeError(observation_error)
        return observation

    def execute(
        self,
        action: ComputerAction,
        grant: SurfaceGrant,
        *,
        scope: Any = None,
    ) -> OperatorActionReceipt:
        started = time.perf_counter()
        if grant.expired():
            return self._receipt(action, grant, started, error="surface_grant_expired")
        if action.effect not in grant.allowed_effects:
            return self._receipt(
                action,
                grant,
                started,
                error=f"effect_not_granted:{action.effect.value}",
            )
        try:
            authorized = self.authorize_effect(action.effect)
        except Exception as exc:
            return self._receipt(
                action,
                grant,
                started,
                error=f"effect_authorization_failed:{type(exc).__name__}:{exc}",
            )
        if not authorized:
            return self._receipt(
                action,
                grant,
                started,
                error=f"effect_not_authorized:{action.effect.value}",
            )
        lease_error = self._validate_lease(grant)
        if lease_error:
            return self._receipt(action, grant, started, error=lease_error)
        try:
            before = self.backend.observe(grant, scope=scope)
        except CancelledError:
            raise
        except Exception as exc:
            return self._receipt(
                action,
                grant,
                started,
                error=f"pre_action_observation_failed:{type(exc).__name__}:{exc}",
            )
        observation_error = self._observation_error(before, grant)
        if observation_error:
            return self._receipt(action, grant, started, before=before, error=observation_error)
        if before.image_sha256 != action.source_image_sha256:
            return self._receipt(
                action,
                grant,
                started,
                before=before,
                error="source_observation_changed",
            )
        try:
            raw = self.backend.execute(action, grant, scope=scope)
        except CancelledError:
            raise
        except Exception as exc:
            return self._receipt(
                action,
                grant,
                started,
                before=before,
                error=f"operator_execute_failed:{type(exc).__name__}:{exc}",
            )
        if not isinstance(raw, OperatorBackendResult):
            return self._receipt(
                action,
                grant,
                started,
                before=before,
                error="operator_backend_result_invalid",
            )
        try:
            after = self.backend.observe(grant, scope=scope)
        except CancelledError:
            raise
        except Exception as exc:
            return self._receipt(
                action,
                grant,
                started,
                executed=raw.executed,
                before=before,
                backend_data=raw.data,
                error=f"post_action_observation_failed:{type(exc).__name__}:{exc}",
            )
        observation_error = self._observation_error(after, grant)
        if observation_error:
            return self._receipt(
                action,
                grant,
                started,
                executed=raw.executed,
                before=before,
                after=after,
                backend_data=raw.data,
                error=observation_error,
            )
        if not raw.executed:
            return self._receipt(
                action,
                grant,
                started,
                before=before,
                after=after,
                backend_data=raw.data,
                error=str(raw.error or "operator_did_not_execute"),
            )
        try:
            verified = self.verify_action(action, before, after, raw) is True
        except Exception as exc:
            return self._receipt(
                action,
                grant,
                started,
                executed=True,
                before=before,
                after=after,
                backend_data=raw.data,
                error=f"operator_verification_failed:{type(exc).__name__}:{exc}",
            )
        for delay in self.verification_delays_s if not verified else ():
            self.sleeper(delay)
            lease_error = self._validate_lease(grant)
            if lease_error:
                return self._receipt(
                    action,
                    grant,
                    started,
                    executed=True,
                    before=before,
                    after=after,
                    backend_data=raw.data,
                    error=lease_error,
                )
            try:
                after = self.backend.observe(grant, scope=scope)
            except CancelledError:
                raise
            except Exception as exc:
                return self._receipt(
                    action,
                    grant,
                    started,
                    executed=True,
                    before=before,
                    after=after,
                    backend_data=raw.data,
                    error=f"post_action_observation_failed:{type(exc).__name__}:{exc}",
                )
            observation_error = self._observation_error(after, grant)
            if observation_error:
                return self._receipt(
                    action,
                    grant,
                    started,
                    executed=True,
                    before=before,
                    after=after,
                    backend_data=raw.data,
                    error=observation_error,
                )
            try:
                verified = self.verify_action(action, before, after, raw) is True
            except Exception as exc:
                return self._receipt(
                    action,
                    grant,
                    started,
                    executed=True,
                    before=before,
                    after=after,
                    backend_data=raw.data,
                    error=f"operator_verification_failed:{type(exc).__name__}:{exc}",
                )
            if verified:
                break
        return self._receipt(
            action,
            grant,
            started,
            executed=True,
            verified=verified,
            before=before,
            after=after,
            backend_data=raw.data,
            error=None if verified else "operator_outcome_unverified",
        )

    def abort(self, operation_id: str) -> bool:
        return self.backend.abort(str(operation_id)) is True
