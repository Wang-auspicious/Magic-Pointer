
from __future__ import annotations

import threading


class CancelledError(RuntimeError):
    pass


class CancellationToken:

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
    return _registry


def cancel_all_in_flight() -> None:
    get_registry().cancel_all()


class CancellationScope:

    __slots__ = ("_children", "_parent", "_registry", "token")

    _local = threading.local()

    def __init__(self, registry: CancellationRegistry | None = None) -> None:
        self._registry = registry if registry is not None else get_registry()
        self._children: list[CancellationScope] = []
        self._parent: CancellationScope | None = None
        self.token: CancellationToken | None = None

    def __enter__(self) -> CancellationScope:
        stack = getattr(self._local, "stack", None)
        if stack is None:
            stack = self._local.stack = []
        parent = stack[-1] if stack else None
        token = CancellationToken()
        self._registry.register(token)
        self.token = token
        self._parent = parent
        stack.append(self)
        if parent is not None:
            parent._children.append(self)
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        stack = getattr(self._local, "stack", None)
        if stack and stack[-1] is self:
            stack.pop()
        parent = self._parent
        self._parent = None
        if parent is not None:
            try:
                parent._children.remove(self)
            except ValueError:
                pass
        token = self.token
        if token is not None:
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
