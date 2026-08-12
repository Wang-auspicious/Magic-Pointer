"""Thread-safe cancellation infrastructure (harness gap review L8).

The user's pointer leaving or clicking elsewhere must abort every in-flight
bridge, OCR and model request immediately. :class:`CancellationToken` is the
unit of cancellation; :class:`CancellationScope` ties a token to a context
(``with`` block); :class:`CancellationRegistry` tracks all in-flight tokens
so ``cancel_all_in_flight()`` can tear them down from a single call.

Stdlib ``threading`` only; no third-party dependencies.
"""

from __future__ import annotations

import threading


class CancelledError(RuntimeError):
    """Raised when a cancelled operation is asked to continue."""


class CancellationToken:
    """Thread-safe cancellation flag.

    ``cancel()`` is idempotent; once cancelled the token stays cancelled.
    """

    __slots__ = ("_cancelled", "_lock")

    def __init__(self) -> None:
        self._cancelled = False
        self._lock = threading.Lock()

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True

    def is_cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def raise_if_cancelled(self) -> None:
        if self.is_cancelled():
            raise CancelledError("operation cancelled")


class CancellationRegistry:
    """Tracks in-flight cancellation tokens.

    ``cancel_all()`` cancels every currently registered token but keeps the
    registry intact so tokens can be re-registered. ``clear()`` empties the
    registry without cancelling anything. All operations are thread-safe.
    """

    __slots__ = ("_lock", "_tokens")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tokens: dict[int, CancellationToken] = {}

    def register(self, token: CancellationToken) -> None:
        with self._lock:
            self._tokens[id(token)] = token

    def unregister(self, token: CancellationToken) -> None:
        with self._lock:
            self._tokens.pop(id(token), None)

    def cancel_all(self) -> None:
        with self._lock:
            tokens = list(self._tokens.values())
        for token in tokens:
            token.cancel()

    def active_count(self) -> int:
        with self._lock:
            return len(self._tokens)

    def clear(self) -> None:
        with self._lock:
            self._tokens.clear()


_registry = CancellationRegistry()


def get_registry() -> CancellationRegistry:
    """Return the module-wide singleton registry."""
    return _registry


def cancel_all_in_flight() -> None:
    """Cancel every token currently registered; keep the registry intact."""
    get_registry().cancel_all()


class CancellationScope:
    """Context manager owning a cancellation token.

    ``__enter__`` creates and registers a fresh token; ``__exit__`` removes
    the token from the registry when it was not cancelled (cancelled tokens
    stay registered so the keep-registry design survives teardown).
    ``cancel_all()`` cancels this scope's token and the tokens of every scope
    nested inside it.
    """

    __slots__ = ("_children", "_registry", "token")

    _local = threading.local()

    def __init__(self, registry: CancellationRegistry | None = None) -> None:
        self._registry = registry if registry is not None else get_registry()
        self._children: list[CancellationScope] = []
        self.token: CancellationToken | None = None

    def __enter__(self) -> CancellationScope:
        stack = getattr(self._local, "stack", None)
        if stack is None:
            stack = self._local.stack = []
        parent = stack[-1] if stack else None
        token = CancellationToken()
        self._registry.register(token)
        self.token = token
        stack.append(self)
        if parent is not None:
            parent._children.append(self)
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        stack = getattr(self._local, "stack", None)
        if stack and stack[-1] is self:
            stack.pop()
        token = self.token
        if token is not None and not token.is_cancelled():
            self._registry.unregister(token)
        return False

    @property
    def is_cancelled(self) -> bool:
        token = self.token
        return token is not None and token.is_cancelled()

    def cancel_all(self) -> None:
        self._cancel_recursive()

    def _cancel_recursive(self) -> None:
        for child in list(self._children):
            child._cancel_recursive()
        token = self.token
        if token is not None:
            token.cancel()
