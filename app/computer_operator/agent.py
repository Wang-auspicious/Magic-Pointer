"""A bounded-by-progress visual action loop behind Magic Pointer authority."""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from app.agent_runtime.tool_registry import Effect
from app.governance.cancellation import CancelledError

from .protocol import GuardedComputerOperator
from .schema import (
    ComputerActionKind,
    OperatorActionReceipt,
    OperatorObservation,
    SurfaceGrant,
)
from .ui_tars import UiTarsActionIntent, compile_ui_tars_intent, parse_ui_tars_response


class UiTarsActionModel(Protocol):
    """One screenshot in, one data-only UI-TARS response out."""

    used_backend: str

    def predict(
        self,
        task: str,
        observation: OperatorObservation,
        history: Sequence[dict[str, Any]],
        *,
        scope: Any = None,
    ) -> str | UiTarsPrediction: ...


EffectClassifier = Callable[[UiTarsActionIntent], Effect | None]


@dataclass(frozen=True, slots=True)
class UiTarsPrediction:
    text: str
    model_image_size: tuple[int, int] | None = None

    def __post_init__(self) -> None:
        if not str(self.text or "").strip():
            raise ValueError("prediction text is required")
        if self.model_image_size is not None and (
            len(self.model_image_size) != 2
            or int(self.model_image_size[0]) <= 0
            or int(self.model_image_size[1]) <= 0
        ):
            raise ValueError("model_image_size must contain positive width and height")


@dataclass(frozen=True, slots=True)
class UiTarsRunResult:
    status: str
    rounds: int
    used_backend: str
    receipts: tuple[OperatorActionReceipt, ...] = ()
    final_text: str = ""
    question: str = ""
    last_observation: OperatorObservation | None = None
    error: str | None = None


def _check_cancel(scope: Any) -> None:
    checker = getattr(scope, "raise_if_cancelled", None)
    if callable(checker):
        checker()


def _action_signature(
    intent: UiTarsActionIntent,
    observation: OperatorObservation,
) -> tuple[object, ...]:
    return (
        observation.image_sha256,
        intent.kind.value,
        intent.start,
        intent.end,
        intent.text,
        intent.keys,
        intent.scroll_delta,
        intent.duration_ms,
    )


class UiTarsComputerAgent:
    """Run visual grounding without giving the model desktop authority.

    The loop has no product-level turn limit. Completion is the model's
    explicit ``finished`` control intent. A high invariant fuse only catches
    broken code/providers, while repeated identical actions on identical
    pixels terminate as semantic ``stalled``.

    Exactly one executable action is accepted per screenshot. After that
    action the guarded operator captures and verifies a new observation before
    the model can act again.
    """

    def __init__(
        self,
        *,
        operator: GuardedComputerOperator,
        model: UiTarsActionModel,
        classify_effect: EffectClassifier,
        invariant_fuse: int = 100,
    ) -> None:
        if not callable(classify_effect):
            raise TypeError("classify_effect must be callable")
        if not 1 <= int(invariant_fuse) <= 1_000:
            raise ValueError("invariant_fuse must be between 1 and 1000")
        self.operator = operator
        self.model = model
        self.classify_effect = classify_effect
        self.invariant_fuse = int(invariant_fuse)

    @property
    def used_backend(self) -> str:
        declared = str(getattr(self.model, "used_backend", "") or "").strip()
        return declared or f"{type(self.model).__module__}.{type(self.model).__qualname__}"

    def _result(
        self,
        status: str,
        rounds: int,
        receipts: list[OperatorActionReceipt],
        observation: OperatorObservation | None,
        **values: Any,
    ) -> UiTarsRunResult:
        for receipt in receipts:
            with contextlib.suppress(Exception):
                self.operator.abort(receipt.action_id)
        return UiTarsRunResult(
            status=status,
            rounds=rounds,
            used_backend=self.used_backend,
            receipts=tuple(receipts),
            last_observation=observation,
            **values,
        )

    def run(
        self,
        task: str,
        grant: SurfaceGrant,
        *,
        scope: Any = None,
    ) -> UiTarsRunResult:
        instruction = str(task or "").strip()
        if not instruction:
            raise ValueError("task is required")
        receipts: list[OperatorActionReceipt] = []
        history: list[dict[str, Any]] = []
        repeats: dict[tuple[object, ...], int] = {}
        try:
            _check_cancel(scope)
            observation = self.operator.observe(grant, scope=scope)
        except CancelledError:
            raise
        except Exception as exc:
            return self._result(
                "failed",
                0,
                receipts,
                None,
                error=f"initial_observation_failed:{type(exc).__name__}:{exc}",
            )

        for round_index in range(1, self.invariant_fuse + 1):
            try:
                _check_cancel(scope)
                raw_prediction = self.model.predict(
                    instruction,
                    observation,
                    tuple(history),
                    scope=scope,
                )
                _check_cancel(scope)
                if isinstance(raw_prediction, UiTarsPrediction):
                    response = raw_prediction.text
                    model_image_size = raw_prediction.model_image_size
                elif isinstance(raw_prediction, str):
                    response = raw_prediction
                    model_image_size = (observation.width, observation.height)
                else:
                    raise TypeError("UI-TARS model must return str or UiTarsPrediction")
                intents = parse_ui_tars_response(
                    response,
                    model_image_size=model_image_size,
                )
            except CancelledError:
                raise
            except Exception as exc:
                return self._result(
                    "failed",
                    round_index,
                    receipts,
                    observation,
                    error=f"model_prediction_failed:{type(exc).__name__}:{exc}",
                )
            if len(intents) != 1:
                return self._result(
                    "failed",
                    round_index,
                    receipts,
                    observation,
                    error="multiple_actions_require_fresh_observation",
                )
            intent = intents[0]
            if intent.kind is ComputerActionKind.FINISH:
                return self._result(
                    "completed",
                    round_index,
                    receipts,
                    observation,
                    final_text=str(intent.text or intent.thought or "completed"),
                )
            if intent.kind is ComputerActionKind.REQUEST_USER:
                return self._result(
                    "needs_user",
                    round_index,
                    receipts,
                    observation,
                    question=str(intent.text or intent.thought or "User input required"),
                )

            signature = _action_signature(intent, observation)
            repeats[signature] = repeats.get(signature, 0) + 1
            if repeats[signature] > 2:
                return self._result(
                    "stalled",
                    round_index,
                    receipts,
                    observation,
                    error="repeated_action_without_visual_change",
                )
            try:
                effect = self.classify_effect(intent)
            except CancelledError:
                raise
            except Exception as exc:
                return self._result(
                    "failed",
                    round_index,
                    receipts,
                    observation,
                    error=f"effect_classification_failed:{type(exc).__name__}:{exc}",
                )
            if not isinstance(effect, Effect):
                return self._result(
                    "denied",
                    round_index,
                    receipts,
                    observation,
                    error="action_effect_not_authorized",
                )
            try:
                action = compile_ui_tars_intent(
                    intent,
                    action_id=(
                        f"{grant.grant_id}:{observation.observation_id}:{round_index}"
                    ),
                    effect=effect,
                    source_observation=observation,
                )
                receipt = self.operator.execute(action, grant, scope=scope)
            except CancelledError:
                raise
            except Exception as exc:
                return self._result(
                    "failed",
                    round_index,
                    receipts,
                    observation,
                    error=f"operator_failed:{type(exc).__name__}:{exc}",
                )
            receipts.append(receipt)
            history.append({
                "round": round_index,
                "modelResponse": str(response)[:8_000],
                "actionId": receipt.action_id,
                "executed": receipt.executed,
                "verified": receipt.verified,
                "error": receipt.error,
                "beforeSha256": (
                    receipt.before.image_sha256 if receipt.before is not None else None
                ),
                "afterSha256": (
                    receipt.after.image_sha256 if receipt.after is not None else None
                ),
            })
            if not receipt.executed or not receipt.verified or receipt.after is None:
                return self._result(
                    "failed",
                    round_index,
                    receipts,
                    receipt.after or observation,
                    error=receipt.error or "operator_outcome_unverified",
                )
            observation = receipt.after

        return self._result(
            "invariant_failed",
            self.invariant_fuse,
            receipts,
            observation,
            error="computer_agent_invariant_fuse_exhausted",
        )
