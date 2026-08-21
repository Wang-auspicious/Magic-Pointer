"""Concurrent, typed perception collection for a single frozen interaction."""

from .broker import (
    PerceptionBroker,
    PerceptionResult,
    providers_for_registry,
)
from .fusion import FusedPerception, fuse_observations, pixel_tier_warranted, texts_agree
from .providers import (
    NOT_APPLICABLE,
    TIER_PIXEL,
    TIER_STRUCTURED,
    AdapterProvider,
    CallableProvider,
    PerceptionObservation,
    PerceptionProvider,
    PerceptionRequest,
    ProviderDescriptor,
    ProviderResult,
    context_has_usable_structure,
    context_rectangles,
    observations_from_trace,
    perception_layer,
)

__all__ = [
    "NOT_APPLICABLE",
    "AdapterProvider",
    "CallableProvider",
    "FusedPerception",
    "PerceptionBroker",
    "PerceptionObservation",
    "PerceptionProvider",
    "PerceptionRequest",
    "PerceptionResult",
    "ProviderDescriptor",
    "ProviderResult",
    "TIER_PIXEL",
    "TIER_STRUCTURED",
    "context_has_usable_structure",
    "context_rectangles",
    "fuse_observations",
    "observations_from_trace",
    "perception_layer",
    "pixel_tier_warranted",
    "providers_for_registry",
    "texts_agree",
]
