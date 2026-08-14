"""Per-window change subscriptions: whitelist, throttle, storm breaker (L9).

A :class:`WindowSubscription` is the single admission point for change
events coming from an :class:`EventSource`. Events are only accepted for
windows that were explicitly subscribed (whitelist semantics, never a
global subscription), and only for the kinds subscribed on that window.
Accepted events are throttled per (window, kind): while a throttle window
is open the intermediate events are superseded and only the latest is
delivered when the window closes (trailing-edge merge). Each window is
also storm-protected: more than ``STORM_LIMIT`` events within one second
trip a cooldown during which everything is dropped.

All public methods are thread-safe. ``deliver`` is called from the event
source's threads; ``subscribe``/``unsubscribe``/``flush``/``breaker_status``
may be called from consumer threads. With ``auto_flush_interval_s`` set, a
background flusher closes open throttle windows on a timer so isolated
events are never stranded (otherwise consumers must call :meth:`flush`
themselves, e.g. on a tick loop).

This module is pure Python (stdlib only).
"""

from __future__ import annotations

import threading
import time
from collections import deque

from .change_events import ChangeKind, EventSource, SurfaceChangeEvent

STORM_LIMIT = 50
"""Default max events per window per second before the breaker trips."""

STORM_COOLDOWN_S = 5.0
"""Default breaker cooldown in seconds; everything is dropped while open."""

_STORM_WINDOW_S = 1.0


class WindowSubscription:
    """Thread-safe per-window change event admission, throttle and breaker."""

    def __init__(
        self,
        *,
        clock=None,
        storm_limit: int = STORM_LIMIT,
        storm_cooldown_s: float = STORM_COOLDOWN_S,
        auto_flush_interval_s: float | None = None,
    ) -> None:
        self._clock = clock if clock is not None else time.monotonic
        self._storm_limit = storm_limit
        self._storm_cooldown_s = storm_cooldown_s
        self._auto_flush_interval_s = auto_flush_interval_s

        self._lock = threading.RLock()
        self._kinds: dict[str, set[ChangeKind]] = {}
        self._throttle_ms: dict[str, int] = {}
        self._pending: dict[tuple[str, ChangeKind], SurfaceChangeEvent] = {}
        self._window_open_t: dict[tuple[str, ChangeKind], float] = {}
        self._storm: dict[str, deque[float]] = {}
        self._broken_until: dict[str, float] = {}
        self._breaker_triggered: dict[str, int] = {}
        self._breaker_dropped: dict[str, int] = {}
        self._handled = 0
        self._dropped = 0
        self._handler = None
        self._flush_stop = threading.Event()
        self._flush_thread: threading.Thread | None = None
        if auto_flush_interval_s is not None and auto_flush_interval_s > 0:
            # Without a flush driver a single isolated event (no follow-up of
            # the same key) stays pending forever: the trailing-edge throttle
            # only delivers on the next same-key event or an explicit flush.
            # The optional background flusher closes throttle windows on a
            # timer (review P2.9). Tests keep it off for determinism.
            self._flush_thread = threading.Thread(
                target=self._auto_flush_loop,
                name="mp-event-flush",
                daemon=True,
            )
            self._flush_thread.start()

    def _auto_flush_loop(self) -> None:
        while not self._flush_stop.wait(self._auto_flush_interval_s):
            self.flush()

    def close(self) -> None:
        """Stop the background flusher (if any); the whitelist stays intact."""
        self._flush_stop.set()

    def set_handler(self, handler) -> None:
        """Install the consumer that receives delivered events (or None)."""
        with self._lock:
            self._handler = handler

    def subscribe(self, window_ref: str, kinds: set[ChangeKind], *, throttle_ms: int = 100) -> None:
        """Whitelist ``window_ref`` for ``kinds`` with per-window throttling.

        Re-subscribing an existing window replaces its kind set and throttle
        setting. ``throttle_ms=0`` disables throttling (every event is
        delivered).
        """
        with self._lock:
            self._kinds[window_ref] = set(kinds)
            self._throttle_ms[window_ref] = throttle_ms

    def unsubscribe(self, window_ref: str) -> None:
        """Remove the window from the whitelist and drop its state."""
        with self._lock:
            self._kinds.pop(window_ref, None)
            self._throttle_ms.pop(window_ref, None)
            for key in [key for key in self._pending if key[0] == window_ref]:
                self._pending.pop(key)
                self._window_open_t.pop(key, None)
            self._storm.pop(window_ref, None)
            self._broken_until.pop(window_ref, None)
            self._breaker_triggered.pop(window_ref, None)
            self._breaker_dropped.pop(window_ref, None)

    def deliver(self, event: SurfaceChangeEvent) -> bool:
        """Admit one event from the source; True when accepted.

        Rejected (False) cases: window not subscribed, kind not subscribed,
        or the window's storm breaker is open. Accepted events are throttled
        per (window, kind): the latest wins inside the throttle window and is
        delivered when the window closes (at the next same-key event or via
        :meth:`flush`). Superseded intermediates count as dropped.
        """
        with self._lock:
            t = self._clock()
            window = event.window_ref
            key = (window, event.kind)

            broken_until = self._broken_until.get(window)
            if broken_until is not None:
                if t < broken_until:
                    self._dropped += 1
                    self._breaker_dropped[window] = self._breaker_dropped.get(window, 0) + 1
                    return False
                self._broken_until.pop(window)
                self._storm.pop(window, None)

            kinds = self._kinds.get(window)
            if kinds is None or event.kind not in kinds:
                self._dropped += 1
                return False

            stamps = self._storm.setdefault(window, deque())
            stamps.append(t)
            while stamps and t - stamps[0] > _STORM_WINDOW_S:
                stamps.popleft()
            if len(stamps) > self._storm_limit:
                self._broken_until[window] = t + self._storm_cooldown_s
                self._breaker_triggered[window] = self._breaker_triggered.get(window, 0) + 1
                for pending_key in [pending_key for pending_key in self._pending if pending_key[0] == window]:
                    self._pending.pop(pending_key)
                    self._window_open_t.pop(pending_key, None)
                    self._dropped += 1
                self._dropped += 1
                self._breaker_dropped[window] = self._breaker_dropped.get(window, 0) + 1
                return False

            throttle_s = self._throttle_ms[window] / 1000.0
            open_t = self._window_open_t.get(key)
            if open_t is None:
                self._window_open_t[key] = t
                self._pending[key] = event
            elif t - open_t >= throttle_s:
                self._deliver_locked(self._pending[key])
                self._window_open_t[key] = t
                self._pending[key] = event
            else:
                self._pending[key] = event
                self._dropped += 1
            return True

    def flush(self, window_ref: str | None = None) -> int:
        """Deliver all currently pending merged events; returns count.

        With ``window_ref`` given, only that window's pending events are
        flushed. This is the explicit "window boundary closed" signal used
        by consumers and tests when no further same-key event arrives.
        """
        with self._lock:
            delivered = 0
            for key in [key for key in self._pending if window_ref is None or key[0] == window_ref]:
                self._deliver_locked(self._pending.pop(key))
                self._window_open_t.pop(key, None)
                delivered += 1
            return delivered

    def breaker_status(self, window_ref: str) -> dict:
        """Audit view of the storm breaker state for one window."""
        with self._lock:
            t = self._clock()
            broken_until = self._broken_until.get(window_ref)
            stamps = self._storm.get(window_ref, deque())
            while stamps and t - stamps[0] > _STORM_WINDOW_S:
                stamps.popleft()
            return {
                "window_ref": window_ref,
                "broken": broken_until is not None and t < broken_until,
                "broken_until": broken_until,
                "event_count_1s": len(stamps),
                "limit": self._storm_limit,
                "cooldown_s": self._storm_cooldown_s,
                "triggered_count": self._breaker_triggered.get(window_ref, 0),
                "dropped_while_broken": self._breaker_dropped.get(window_ref, 0),
            }

    def handled_count(self) -> int:
        """Total events delivered to the consumer handler."""
        with self._lock:
            return self._handled

    def dropped_count(self) -> int:
        """Total events rejected or superseded (whitelist/breaker/throttle)."""
        with self._lock:
            return self._dropped

    def _deliver_locked(self, event: SurfaceChangeEvent) -> None:
        self._handled += 1
        if self._handler is not None:
            self._handler(event)


class SubscriptionHandle:
    """The closable connection returned by :func:`create_subscription`."""

    def __init__(self, source: EventSource, subscription: WindowSubscription) -> None:
        self._source = source
        self._subscription = subscription
        self._closed = False

    def close(self) -> None:
        """Detach the source; further emissions are ignored. Idempotent."""
        if self._closed:
            return
        self._source.set_handler(None)
        self._closed = True

    @property
    def is_closed(self) -> bool:
        return self._closed


def create_subscription(
    source: EventSource, subscription: WindowSubscription
) -> SubscriptionHandle:
    """Connect ``source`` so its events flow into ``subscription.deliver``.

    Returns a closable handle; ``close()`` detaches the handler (the source
    itself is not stopped).
    """
    source.set_handler(subscription.deliver)
    return SubscriptionHandle(source, subscription)
