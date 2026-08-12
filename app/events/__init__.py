"""Event-driven perception subscriptions (harness gap review L9).

Per-window/kind change event admission with throttle, whitelist and storm
breaker. Pure Python: no UIA, no I/O, no Electron coupling.
"""

from .change_events import ChangeKind, EventSource, SurfaceChangeEvent
from .subscription import (
    STORM_COOLDOWN_S,
    STORM_LIMIT,
    SubscriptionHandle,
    WindowSubscription,
    create_subscription,
)

__all__ = [
    "ChangeKind",
    "EventSource",
    "STORM_COOLDOWN_S",
    "STORM_LIMIT",
    "SubscriptionHandle",
    "SurfaceChangeEvent",
    "WindowSubscription",
    "create_subscription",
]
