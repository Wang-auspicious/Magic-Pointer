"""Concurrent perception broker: plan, collect, normalise, fuse, project.

The broker owns exactly two decisions: which providers this read is allowed to
start, and how long the interaction is willing to wait for them. It never picks
a winner — that is fusion's job — and it never reads pixels or creates a
FrameLease; its caller must freeze and bind the interaction first.

Tiers exist because concurrency is not "always launch everything" (blueprint
§7.3). Every provider in a tier starts together and none is cancelled because a
sibling returned first. The expensive tier is only planned when the cheap tier
failed to answer about the mark, so a clean Notepad read never spends OCR CPU
recognising text it already has exactly.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Iterable, Sequence

from app.adapters.base import AdapterReadContext
from app.evidence.contract import EvidenceStatus
from app.perception.fusion import FusedPerception, fuse_observations, pixel_tier_warranted
from app.perception.providers import (
    NOT_APPLICABLE,
    TIER_ORDER,
    AdapterProvider,
    PerceptionObservation,
    PerceptionProvider,
    PerceptionRequest,
    ProviderResult,
    context_has_usable_structure,
    observation_from_result,
    perception_layer,
    synthetic_observation,
)

# A UIA probe against an unresponsive window can block for as long as that
# window stays wedged. Two seconds clears every healthy structured provider
# measured on this machine (UIA cold start ~573ms, steady 200-250ms) while
# keeping a wedged one from owning the interaction.
DEFAULT_DEADLINE_MS = 2000.0

# Frozen-frame OCR on a warm resident worker is 1-3s; a cold one pays ~9s of
# model init. This tier only runs when the structured tier already failed to
# answer, so the budget buys the only remaining chance at the marked content.
DEFAULT_PIXEL_DEADLINE_MS = 12000.0

_TIER_DEADLINES = {
    "structured": DEFAULT_DEADLINE_MS,
    "pixel": DEFAULT_PIXEL_DEADLINE_MS,
}


@dataclass(frozen=True, slots=True)
class PerceptionResult:
    context: AdapterReadContext | None
    observations: tuple[PerceptionObservation, ...]
    trace: dict[str, Any]
    selected: PerceptionObservation | None
    conflicts: tuple[dict[str, Any], ...]
    fused: FusedPerception


class PerceptionBroker:
    """Run a perception plan against one bound interaction."""

    def __init__(self, *, max_workers: int = 4) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be positive")
        self.max_workers = max_workers

    def resolve(
        self,
        request: PerceptionRequest,
        providers: Iterable[PerceptionProvider],
        *,
        deadline_ms: float | None = None,
        pixel_deadline_ms: float | None = None,
        prior_observations: Sequence[PerceptionObservation] = (),
        policy_mode: str | None = None,
    ) -> PerceptionResult:
        planned = list(providers)
        started = perf_counter()
        observations: list[PerceptionObservation] = list(prior_observations)
        # A specialist declining a window it was never for is routing detail, not
        # evidence about the target. It is counted, not fused: otherwise every
        # Notepad read carries one dead line per surface specialist.
        declined: list[str] = []
        next_index = (
            max((item.index for item in observations), default=-1) + 1
        )
        for tier in TIER_ORDER:
            tier_providers = [
                provider for provider in planned
                if provider.descriptor.tier == tier
            ]
            if not tier_providers:
                continue
            if tier != TIER_ORDER[0]:
                warranted, _reason = pixel_tier_warranted(observations)
                if not warranted:
                    continue
            budget = (
                deadline_ms if tier == TIER_ORDER[0] else pixel_deadline_ms
            )
            collected = self._collect(
                tier_providers,
                request,
                first_index=next_index,
                tier=tier,
                deadline_ms=budget,
            )
            for item in collected:
                if item.reason == NOT_APPLICABLE:
                    declined.append(item.provider_id)
                else:
                    observations.append(item)
            next_index += len(collected)
        elapsed_ms = (perf_counter() - started) * 1000.0
        fused = fuse_observations(
            observations,
            elapsed_ms=elapsed_ms,
            policy_mode=policy_mode,
            declined=tuple(declined),
        )
        return PerceptionResult(
            context=fused.context,
            observations=fused.observations,
            trace=fused.trace,
            selected=fused.selected,
            conflicts=fused.conflicts,
            fused=fused,
        )

    def observe(
        self,
        provider: PerceptionProvider,
        request: PerceptionRequest,
        *,
        index: int = 0,
    ) -> PerceptionObservation:
        """Read one provider and normalise it. Same path the plan uses."""
        return self._read_one(provider, request, index)

    def _collect(
        self,
        providers: list[PerceptionProvider],
        request: PerceptionRequest,
        *,
        first_index: int,
        tier: str,
        deadline_ms: float | None,
    ) -> tuple[PerceptionObservation, ...]:
        """Read every provider in this tier, but let the deadline rule.

        A provider that misses the deadline becomes a TIMEOUT observation and
        the verdict is made from whatever did arrive. Its thread is left to
        finish on its own: this bounds the interaction, not the thread, so
        providers still owe their own internal timeouts.

        A provider may declare its own ceiling: the gesture strategy spends a
        documented 3.5s sampling budget, and holding it to the tier default
        would throw away reads that succeed today. The tier therefore ends when
        its most patient planned provider ends, and each provider is only ever
        cut off at its own deadline.
        """
        runnable: list[tuple[int, PerceptionProvider]] = []
        collected: dict[int, PerceptionObservation] = {}
        for offset, provider in enumerate(providers):
            index = first_index + offset
            descriptor = provider.descriptor
            if descriptor.requires_frozen_pixels and not request.has_frozen_pixels:
                # No lease means no pixels. Reading the live screen here would
                # certify a post-gesture frame as the moment of the gesture.
                collected[index] = synthetic_observation(
                    descriptor,
                    request,
                    index=index,
                    status=EvidenceStatus.UNSUPPORTED,
                    reason="frozen_pixels_unavailable",
                )
                continue
            runnable.append((index, provider))
        if runnable:
            tier_budget_ms = (
                _TIER_DEADLINES.get(tier, DEFAULT_DEADLINE_MS)
                if deadline_ms is None
                else float(deadline_ms)
            )
            by_index = dict(runnable)
            cutoff_ms = {
                index: float(provider.descriptor.deadline_ms or tier_budget_ms)
                for index, provider in runnable
            }
            pool = ThreadPoolExecutor(
                max_workers=min(self.max_workers, len(runnable)),
                thread_name_prefix="mp-perception",
            )
            try:
                tier_started = perf_counter()
                pending = {
                    pool.submit(self._read_one, provider, request, index): index
                    for index, provider in runnable
                }
                for cutoff in sorted(set(cutoff_ms.values())):
                    if not pending:
                        break
                    remaining_s = (
                        cutoff / 1000.0 - (perf_counter() - tier_started)
                    )
                    done, _still_running = wait(
                        list(pending), timeout=max(0.0, remaining_s)
                    )
                    for future in done:
                        collected[pending.pop(future)] = future.result()
                    tier_elapsed_ms = (perf_counter() - tier_started) * 1000.0
                    overdue = [
                        future
                        for future, index in pending.items()
                        if cutoff_ms[index] <= cutoff
                    ]
                    for future in overdue:
                        index = pending.pop(future)
                        collected[index] = synthetic_observation(
                            by_index[index].descriptor,
                            request,
                            index=index,
                            status=EvidenceStatus.TIMEOUT,
                            reason="deadline_exceeded",
                            latency_ms=tier_elapsed_ms,
                        )
            finally:
                pool.shutdown(wait=False)
        return tuple(collected[index] for index in sorted(collected))

    @staticmethod
    def _read_one(
        provider: PerceptionProvider,
        request: PerceptionRequest,
        index: int,
    ) -> PerceptionObservation:
        descriptor = provider.descriptor
        started = perf_counter()
        try:
            result = provider.read(request)
        except Exception as exc:  # one provider must not erase the others
            return synthetic_observation(
                descriptor,
                request,
                index=index,
                status=EvidenceStatus.ERROR,
                reason=f"provider_exception:{type(exc).__name__}",
                latency_ms=(perf_counter() - started) * 1000.0,
            )
        latency_ms = (perf_counter() - started) * 1000.0
        if not isinstance(result, ProviderResult):
            return synthetic_observation(
                descriptor,
                request,
                index=index,
                status=EvidenceStatus.ERROR,
                reason="invalid_provider_result",
                latency_ms=latency_ms,
            )
        return observation_from_result(
            descriptor,
            result,
            request,
            index=index,
            latency_ms=latency_ms,
        )


def providers_for_registry(
    registry: Any,
    window: dict[str, Any],
) -> list[AdapterProvider]:
    """Every adapter that claims this window becomes one structured provider."""
    matcher = getattr(registry, "matching_adapters", None)
    if callable(matcher):
        candidates = list(matcher(window) or [])
    else:
        adapter = registry.matching_adapter(window)
        candidates = [adapter] if adapter is not None else []
    providers = [AdapterProvider(adapter) for adapter in candidates]
    return sorted(
        providers,
        key=lambda provider: (provider.descriptor.priority, provider.descriptor.id),
    )


__all__ = [
    "DEFAULT_DEADLINE_MS",
    "DEFAULT_PIXEL_DEADLINE_MS",
    "PerceptionBroker",
    "PerceptionResult",
    "context_has_usable_structure",
    "perception_layer",
    "providers_for_registry",
]
