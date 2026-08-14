"""Semantic guardrails for an agent that is using tools without progress.

Adapted from HermesAgent's MIT-licensed ``agent/tool_guardrails.py``.  Magic
Pointer classifies idempotence from the registered :class:`ToolSpec` effect
instead of maintaining tool-name lists, and also detects the same evidence
being fetched through different read tools.

This is deliberately not a small turn cap.  A run can continue while each read
produces new evidence or a permitted write succeeds.  It is stalled only after
repeated observations demonstrate that retrying is not changing the state
available to the model.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.agent_runtime.tool_registry import Effect

__all__ = [
    "ToolCallGuardrailConfig",
    "ToolCallGuardrailController",
    "ToolGuardrailDecision",
    "append_toolguard_guidance",
    "canonical_tool_args",
]


@dataclass(frozen=True, slots=True)
class ToolCallGuardrailConfig:
    """Thresholds for evidence-based loop detection.

    Counts include the first observation.  Defaults give the model one direct
    warning on the second identical outcome and stop only on the fourth.
    Cross-tool duplicate reads warn immediately because changing the tool name
    while returning byte-equivalent evidence is already one failed recovery.
    """

    warnings_enabled: bool = True
    hard_stop_enabled: bool = True
    exact_failure_warn_after: int = 2
    exact_failure_halt_after: int = 4
    same_tool_failure_warn_after: int = 3
    same_tool_failure_halt_after: int = 6
    read_no_progress_warn_after: int = 2
    read_no_progress_halt_after: int = 4
    duplicate_read_warn_after: int = 1
    duplicate_read_halt_after: int = 3
    repeated_action_warn_after: int = 2
    repeated_action_halt_after: int = 4


@dataclass(frozen=True, slots=True)
class ToolCallSignature:
    """Stable non-reversible identity of a tool name and canonical arguments."""

    tool_name: str
    args_hash: str

    @classmethod
    def create(
        cls, tool_name: str, args: Mapping[str, Any] | None
    ) -> "ToolCallSignature":
        return cls(tool_name=tool_name, args_hash=_sha256(canonical_tool_args(args or {})))


@dataclass(frozen=True, slots=True)
class ToolGuardrailDecision:
    """One observation verdict returned to the loop interpreter."""

    action: str = "allow"  # allow | warn | halt
    code: str = "allow"
    message: str = ""
    count: int = 0
    made_progress: bool = False
    signature: ToolCallSignature | None = None

    @property
    def should_halt(self) -> bool:
        return self.action == "halt"


def canonical_tool_args(args: Mapping[str, Any]) -> str:
    """Return deterministic compact JSON for a parsed tool argument mapping."""

    if not isinstance(args, Mapping):
        raise TypeError(f"tool args must be a mapping, got {type(args).__name__}")
    return json.dumps(
        args,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


class ToolCallGuardrailController:
    """Track failure and evidence novelty for one user-initiated agent run."""

    def __init__(self, config: ToolCallGuardrailConfig | None = None) -> None:
        self.config = config or ToolCallGuardrailConfig()
        self._exact_failure_counts: dict[ToolCallSignature, int] = {}
        self._same_tool_failure_counts: dict[str, int] = {}
        self._read_results: dict[ToolCallSignature, tuple[str, int]] = {}
        self._seen_read_result_hashes: set[str] = set()
        self._consecutive_duplicate_reads = 0
        self._successful_action_counts: dict[ToolCallSignature, int] = {}

    def observe(
        self,
        tool_name: str,
        args: Mapping[str, Any] | None,
        result: str | None,
        *,
        failed: bool,
        effect: Effect,
    ) -> ToolGuardrailDecision:
        """Observe a completed tool call and classify whether it made progress."""

        signature = ToolCallSignature.create(tool_name, args)
        if failed:
            return self._observe_failure(signature)

        self._exact_failure_counts.pop(signature, None)
        self._same_tool_failure_counts.pop(tool_name, None)
        if effect is not Effect.READ:
            action_count = self._successful_action_counts.get(signature, 0) + 1
            self._successful_action_counts[signature] = action_count
            if (
                self.config.hard_stop_enabled
                and action_count >= self.config.repeated_action_halt_after
            ):
                return self._decision(
                    "halt",
                    "repeated_successful_action_halt",
                    (
                        f"Stopped {tool_name}: the identical state-changing call "
                        f"was executed {action_count} times. Do not repeat an action "
                        "that already succeeded; verify the result or answer."
                    ),
                    action_count,
                    signature,
                )
            if (
                self.config.warnings_enabled
                and action_count >= self.config.repeated_action_warn_after
            ):
                return self._decision(
                    "warn",
                    "repeated_successful_action_warning",
                    (
                        f"{tool_name} already succeeded with these exact arguments "
                        f"{action_count} times. Verify the outcome instead of "
                        "repeating the same state change."
                    ),
                    action_count,
                    signature,
                )
            return ToolGuardrailDecision(
                count=action_count,
                made_progress=True,
                signature=signature,
            )

        result_hash = _result_hash(result)
        previous = self._read_results.get(signature)
        same_call_count = 1
        if previous is not None and previous[0] == result_hash:
            same_call_count = previous[1] + 1
        self._read_results[signature] = (result_hash, same_call_count)

        was_seen = result_hash in self._seen_read_result_hashes
        self._seen_read_result_hashes.add(result_hash)
        if was_seen:
            self._consecutive_duplicate_reads += 1
        else:
            self._consecutive_duplicate_reads = 0

        if (
            self.config.hard_stop_enabled
            and same_call_count >= self.config.read_no_progress_halt_after
        ):
            return self._decision(
                "halt",
                "read_no_progress_halt",
                (
                    f"Stopped {tool_name}: the same read call returned the same "
                    f"evidence {same_call_count} times. Use the evidence already "
                    "available, change the query, or report the blocker."
                ),
                same_call_count,
                signature,
            )
        if (
            self.config.hard_stop_enabled
            and self._consecutive_duplicate_reads
            >= self.config.duplicate_read_halt_after
        ):
            return self._decision(
                "halt",
                "duplicate_read_evidence_halt",
                (
                    "Stopped the read trajectory: switching tools has returned "
                    f"already-seen evidence {self._consecutive_duplicate_reads} "
                    "times in a row. Answer from existing evidence or explain what "
                    "specific evidence is unavailable."
                ),
                self._consecutive_duplicate_reads,
                signature,
            )
        if (
            self.config.warnings_enabled
            and same_call_count >= self.config.read_no_progress_warn_after
        ):
            return self._decision(
                "warn",
                "read_no_progress_warning",
                (
                    f"{tool_name} returned the same evidence {same_call_count} "
                    "times. Do not repeat this call unchanged; use the result or "
                    "change the query."
                ),
                same_call_count,
                signature,
            )
        if (
            self.config.warnings_enabled
            and self._consecutive_duplicate_reads
            >= self.config.duplicate_read_warn_after
        ):
            return self._decision(
                "warn",
                "duplicate_read_evidence_warning",
                (
                    "This read returned evidence already available from an earlier "
                    "tool. Answer from it or request genuinely different evidence."
                ),
                self._consecutive_duplicate_reads,
                signature,
            )
        return ToolGuardrailDecision(
            count=same_call_count,
            made_progress=not was_seen,
            signature=signature,
        )

    def _observe_failure(
        self, signature: ToolCallSignature
    ) -> ToolGuardrailDecision:
        exact_count = self._exact_failure_counts.get(signature, 0) + 1
        self._exact_failure_counts[signature] = exact_count
        tool_count = self._same_tool_failure_counts.get(signature.tool_name, 0) + 1
        self._same_tool_failure_counts[signature.tool_name] = tool_count
        self._read_results.pop(signature, None)
        self._successful_action_counts.pop(signature, None)
        self._consecutive_duplicate_reads = 0

        if (
            self.config.hard_stop_enabled
            and exact_count >= self.config.exact_failure_halt_after
        ):
            return self._decision(
                "halt",
                "repeated_exact_failure_halt",
                (
                    f"Stopped {signature.tool_name}: the identical call failed "
                    f"{exact_count} times. Retrying unchanged cannot make progress."
                ),
                exact_count,
                signature,
            )
        if (
            self.config.hard_stop_enabled
            and tool_count >= self.config.same_tool_failure_halt_after
        ):
            return self._decision(
                "halt",
                "same_tool_failure_halt",
                (
                    f"Stopped {signature.tool_name}: it failed {tool_count} times "
                    "across argument changes. Choose another capability or report "
                    "the external blocker."
                ),
                tool_count,
                signature,
            )
        if (
            self.config.warnings_enabled
            and exact_count >= self.config.exact_failure_warn_after
        ):
            return self._decision(
                "warn",
                "repeated_exact_failure_warning",
                (
                    f"{signature.tool_name} failed {exact_count} times with identical "
                    "arguments. Inspect the error and change strategy before retrying."
                ),
                exact_count,
                signature,
            )
        if (
            self.config.warnings_enabled
            and tool_count >= self.config.same_tool_failure_warn_after
        ):
            return self._decision(
                "warn",
                "same_tool_failure_warning",
                (
                    f"{signature.tool_name} failed {tool_count} times. Diagnose the "
                    "latest error, change capability, or report the blocker."
                ),
                tool_count,
                signature,
            )
        return ToolGuardrailDecision(count=exact_count, signature=signature)

    @staticmethod
    def _decision(
        action: str,
        code: str,
        message: str,
        count: int,
        signature: ToolCallSignature,
    ) -> ToolGuardrailDecision:
        return ToolGuardrailDecision(
            action=action,
            code=code,
            message=message,
            count=count,
            made_progress=False,
            signature=signature,
        )


def append_toolguard_guidance(result: str, decision: ToolGuardrailDecision) -> str:
    """Append a warning/halt as model-visible data to the tool result."""

    if decision.action not in {"warn", "halt"} or not decision.message:
        return result
    label = "Tool loop hard stop" if decision.should_halt else "Tool loop warning"
    return (
        (result or "")
        + f"\n\n[{label}: {decision.code}; count={decision.count}; "
        + decision.message
        + "]"
    )


def _result_hash(result: str | None) -> str:
    raw = result or ""
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        canonical = raw
    else:
        canonical = json.dumps(
            parsed,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
    return _sha256(canonical)


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
