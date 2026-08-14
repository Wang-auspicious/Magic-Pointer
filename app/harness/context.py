"""Harness kernel context: the DSH-Cordis five ideas rewritten in Python.

Gold-standard reference: ``docs/2026-08-14-plugin-architecture-review.md``
(derived from deepseek-harness ``docs/architecture.md`` /
``docs/cordis-primer.md``). This module owns the context semantics only:

- A context is a repository of services. A service claims a stable key
  (``ctx.get("tools")``); consumers find services by key instead of
  importing concrete implementations.
- Dependencies are declared through :meth:`inject`: the callback activates
  when every named service exists, inside a fork whose registrations unwind
  when a required service is revoked or the context unloads. Load order is
  expressed by service requirements, not by call order.
- Registrations are reversible effects (:meth:`effect`, :meth:`on`): every
  registration returns a :class:`Disposable` and teardown unwinds them in
  LIFO order.
- Events carry a declared dispatch mode: ``emit`` / ``waterfall`` /
  ``parallel`` / ``serial``. Dispatching with the wrong method raises; the
  mode is part of the event's public contract.
- :meth:`scope` derives a child context that reads parent services but
  confines its own registrations and events (per-agent scopes).

Scale adaptations versus Cordis:

- ``service/<key>`` events are implicitly declared as ``emit`` (no
  :meth:`declare` needed).
- Registration is single-thread owned; parallel dispatch uses a lazily created
  bounded thread pool that shuts down on unload.

The lifecycle semantics are not simplified: dependency revocation deactivates
the plugin fork, re-provision reactivates it, and parent scopes own the lifetime
of their children. These are the guarantees that make plugin unload exact.
"""

from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

__all__ = [
    "Context",
    "Disposable",
    "InjectionHandle",
    "EventDispatchError",
    "UndeclaredEventError",
    "EMIT",
    "WATERFALL",
    "PARALLEL",
    "SERIAL",
    "EVENT_MODES",
]

EMIT = "emit"
WATERFALL = "waterfall"
PARALLEL = "parallel"
SERIAL = "serial"
EVENT_MODES = (EMIT, WATERFALL, PARALLEL, SERIAL)

_PARALLEL_WORKERS = 8
"""Threads in the lazily created pool used by parallel dispatch."""

_SERVICE_EVENT_PREFIX = "service/"
"""Event kinds under this prefix are implicitly declared as ``emit``."""

_logger = logging.getLogger(__name__)


class EventDispatchError(Exception):
    """A dispatch method was used against an event of a different mode."""


class UndeclaredEventError(Exception):
    """An event was dispatched or subscribed before being declared."""


class Disposable:
    """Handle that unwinds one registration exactly once."""

    __slots__ = ("_dispose", "_disposed")

    def __init__(self, dispose: Callable[[], None]) -> None:
        self._dispose = dispose
        self._disposed = False

    def dispose(self) -> None:
        if not self._disposed:
            self._disposed = True
            self._dispose()

    @property
    def disposed(self) -> bool:
        return self._disposed


@dataclass
class _ListenerEntry:
    fn: Callable[..., Any]
    disposable: Disposable


@dataclass
class _InjectWaiter:
    deps: set[str]
    callback: Callable[[Context], None]
    state: str = "pending"  # pending | active | error | disposed
    fork: Context | None = None
    handle: Disposable | None = None
    error: BaseException | None = None


class InjectionHandle(Disposable):
    """Lifetime and live state of one reactive dependency injection."""

    __slots__ = ("_context", "_waiter")

    def __init__(
        self,
        dispose: Callable[[], None],
        context: Context,
        waiter: _InjectWaiter,
    ) -> None:
        super().__init__(dispose)
        self._context = context
        self._waiter = waiter

    @property
    def state(self) -> str:
        return self._waiter.state

    @property
    def missing_deps(self) -> tuple[str, ...]:
        if self.state != "pending":
            return ()
        return tuple(sorted(dep for dep in self._waiter.deps if not self._context.has(dep)))

    @property
    def error(self) -> BaseException | None:
        return self._waiter.error


class Context:
    """Service repository + typed events + reversible registrations.

    :param parent: when set, :meth:`get`/:meth:`has`/:meth:`keys` read
        through to the parent for keys not provided locally. Registrations
        and events stay local to this context.
    """

    def __init__(
        self,
        parent: Context | None = None,
        *,
        service_boundary: bool = False,
    ) -> None:
        self._parent = parent
        self._service_boundary = service_boundary
        self._services: dict[str, Any] = {}
        self._service_views: dict[str, tuple[Any, Any]] = {}
        self._effects: list[Disposable] = []
        self._event_modes: dict[str, str] = {}
        self._listeners: dict[str, list[_ListenerEntry]] = {}
        self._inject_waiters: list[_InjectWaiter] = []
        self._children: list[Context] = []
        self._work_condition = threading.Condition()
        self._active_work = 0
        self._work_owners: dict[int, int] = {}
        self._closing = False
        self._unloaded = False
        self._pool: ThreadPoolExecutor | None = None
        self._pool_shutdown = False

    # ------------------------------------------------------------- services

    def provide(self, key: str, service: Any) -> None:
        """Claim ``key`` for ``service``; duplicates and unloaded raise."""
        self._ensure_alive()
        if key in self._services:
            raise ValueError(f"service {key!r} is already provided")
        self._services[key] = service
        self._emit_internal(
            f"{_SERVICE_EVENT_PREFIX}{key}", {"key": key, "service": service}
        )
        self._refresh_injects_recursive()

    def get(self, key: str) -> Any:
        """Return the service at ``key``; KeyError when unknown."""
        self._ensure_alive()
        owner, service = self._find_service(key)
        if owner is self:
            return service
        scope_factory = getattr(service, "scope_for", None)
        if not callable(scope_factory):
            return service
        cached = self._service_views.get(key)
        if cached is not None and cached[0] is service:
            return cached[1]
        view = scope_factory(self)
        self._service_views[key] = (service, view)
        return view

    def has(self, key: str) -> bool:
        if key in self._services:
            return True
        return self._parent is not None and self._parent.has(key)

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and self.has(key)

    def keys(self) -> set[str]:
        keys = set(self._services)
        if self._parent is not None:
            keys |= self._parent.keys()
        return keys

    def revoke(self, key: str) -> bool:
        """Remove a local service and deactivate every dependent scope.

        Inject registrations remain pending, so providing the dependency
        again creates a fresh fork and re-runs the plugin callback.
        """
        self._ensure_alive()
        if key not in self._services:
            return False
        del self._services[key]
        self._clear_service_view_recursive(key)
        self._refresh_injects_recursive()
        return True

    def provide_up(self, key: str, service: Any) -> Disposable:
        """Provide ``service`` on the root context; revoke on dispose/unload.

        The plugin-facing counterpart of :meth:`provide`: plugin ``apply``
        callbacks run inside an inject fork, whose local services are not
        visible to the root — ``provide_up`` is the explicit escape hatch
        for services a plugin contributes to the tree. The returned handle
        (and this context's unload) revokes the root service again, which
        cascades to any forks that depended on it.
        """
        self._ensure_alive()
        target = self
        while target._parent is not None and not target._service_boundary:
            target = target._parent
        target.provide(key, service)

        def undo() -> None:
            # The root may already be mid-unload when this fork unwinds
            # (LIFO teardown pops the fork before the root services are
            # touched); skipping the revoke then is correct — the tree is
            # dying and nothing can activate against the key anymore.
            if not target._unloaded:  # noqa: SLF001
                target.revoke(key)

        return self._register(undo)

    # ------------------------------------------------------------ injection

    def inject(
        self, dependencies: list[str] | tuple[str, ...], callback: Callable[[Context], None]
    ) -> Disposable:
        """Keep ``callback`` active while every named service exists.

        The callback runs inside a fork of this context: it reads services
        from here, but everything it registers unwinds with the fork (on
        revoke of a dependency, context unload, or explicit dispose). If a
        missing dependency returns later, a fresh fork reactivates. Returns
        the lifetime handle for the entire reactive registration.
        """
        self._ensure_alive()
        waiter = _InjectWaiter(deps=set(dependencies), callback=callback)
        self._inject_waiters.append(waiter)

        def dispose_registration() -> None:
            if waiter.state == "disposed":
                return
            self._deactivate_waiter(waiter)
            waiter.state = "disposed"
            with contextlib.suppress(ValueError):
                self._inject_waiters.remove(waiter)

        handle = InjectionHandle(dispose_registration, self, waiter)
        self._effects.append(handle)
        waiter.handle = handle
        try:
            self._refresh_injects(raise_errors=True)
        except Exception:
            handle.dispose()
            raise
        return handle

    def _refresh_injects_recursive(self) -> None:
        self._refresh_injects(raise_errors=False)
        for child in list(self._children):
            if not child._unloaded:  # noqa: SLF001
                child._refresh_injects_recursive()  # noqa: SLF001

    def _refresh_injects(self, *, raise_errors: bool) -> None:
        for waiter in list(self._inject_waiters):
            if waiter.state in {"disposed", "error"}:
                continue
            ready = waiter.deps <= self.keys()
            if waiter.state == "active" and not ready:
                self._deactivate_waiter(waiter)
                waiter.state = "pending"
                continue
            if waiter.state != "pending" or not ready:
                continue
            try:
                self._activate_waiter(waiter)
            except Exception as exc:
                waiter.error = exc
                waiter.state = "error"
                if raise_errors:
                    raise

    def _activate_waiter(self, waiter: _InjectWaiter) -> None:
        fork = Context(parent=self)
        self._children.append(fork)
        waiter.state = "active"
        waiter.fork = fork
        try:
            waiter.callback(fork)
        except Exception:
            fork.unload()
            waiter.fork = None
            raise

    def _deactivate_waiter(self, waiter: _InjectWaiter) -> None:
        fork = waiter.fork
        waiter.fork = None
        if fork is not None:
            fork.unload()

    # -------------------------------------------------------------- effects

    def effect(self, disposer: Callable[[], None]) -> Disposable:
        """Register a reversible side effect; unwinds LIFO on unload."""
        return self._register(disposer)

    @contextlib.contextmanager
    def work(self):
        """Own one in-flight operation and keep teardown quiescent.

        New work is rejected once unload starts. A started operation must
        settle before plugin effects are disposed, so unload can never tear
        a service out from underneath one of its calls.
        """
        with self._work_condition:
            if self._closing or self._unloaded:
                raise RuntimeError("context is unloading")
            self._active_work += 1
            owner = threading.get_ident()
            self._work_owners[owner] = self._work_owners.get(owner, 0) + 1
        try:
            yield
        finally:
            with self._work_condition:
                self._active_work -= 1
                remaining = self._work_owners.get(owner, 0) - 1
                if remaining > 0:
                    self._work_owners[owner] = remaining
                else:
                    self._work_owners.pop(owner, None)
                if self._active_work == 0:
                    self._work_condition.notify_all()

    def _register(self, disposer: Callable[[], None]) -> Disposable:
        self._ensure_alive()
        handle = Disposable(disposer)
        self._effects.append(handle)
        return handle

    def _run_reserved_work(self, callback: Callable[..., Any], *args: Any) -> Any:
        """Run a callback already covered by an outer work reservation.

        Parallel event listeners execute on pool threads. Registering those
        threads as owners makes re-entrant unload fail immediately while the
        outer dispatch's active-work count remains the single teardown lease.
        """
        owner = threading.get_ident()
        with self._work_condition:
            self._work_owners[owner] = self._work_owners.get(owner, 0) + 1
        try:
            return callback(*args)
        finally:
            with self._work_condition:
                remaining = self._work_owners.get(owner, 0) - 1
                if remaining > 0:
                    self._work_owners[owner] = remaining
                else:
                    self._work_owners.pop(owner, None)

    # --------------------------------------------------------------- events

    def declare(self, kind: str, mode: str) -> None:
        """Declare an event kind and its dispatch mode (public contract)."""
        self._ensure_alive()
        if mode not in EVENT_MODES:
            raise ValueError(f"unknown event mode {mode!r}")
        existing = self._event_mode(kind)
        if existing is not None:
            if existing != mode:
                raise ValueError(
                    f"event {kind!r} is already declared as {existing!r}, "
                    f"cannot redeclare as {mode!r}"
                )
            return
        self._event_modes[kind] = mode

    def on(
        self, kind: str, listener: Callable[..., Any], *, prepend: bool = False
    ) -> Disposable:
        """Subscribe ``listener`` to ``kind``; returns a reversible handle."""
        self._ensure_alive()
        self._require_declared(kind)
        entry = _ListenerEntry(fn=listener, disposable=None)  # type: ignore[arg-type]
        bucket = self._listeners.setdefault(kind, [])

        def dispose_listener() -> None:
            with contextlib.suppress(ValueError):
                bucket.remove(entry)

        entry.disposable = self._register(dispose_listener)
        if prepend:
            bucket.insert(0, entry)
        else:
            bucket.append(entry)
        return entry.disposable

    def emit(self, kind: str, payload: Any) -> None:
        """Observe-only dispatch; listeners run in registration order."""
        with self.work():
            self._require_mode(kind, EMIT)
            for entry in list(self._listeners.get(kind, ())):
                entry.fn(payload)

    def waterfall(self, kind: str, payload: Any) -> Any:
        """Around-middleware dispatch; ``next()`` delegates to later ones.

        A listener receives ``(payload, next)``. Returning without calling
        ``next()`` short-circuits; the chain result is the final return.
        """
        with self.work():
            self._require_mode(kind, WATERFALL)
            entries = list(self._listeners.get(kind, ()))

            def run(index: int) -> Any:
                if index >= len(entries):
                    return payload
                return entries[index].fn(payload, lambda: run(index + 1))

            return run(0)

    def parallel(self, kind: str, payload: Any) -> list[Any]:
        """Concurrent fan-out: all listeners run on the pool, all awaited."""
        with self.work():
            self._require_mode(kind, PARALLEL)
            entries = list(self._listeners.get(kind, ()))
            if not entries:
                return []
            pool = self._get_pool()
            futures = [
                pool.submit(self._run_reserved_work, entry.fn, payload)
                for entry in entries
            ]
            return [future.result() for future in futures]

    def serial(self, kind: str, payload: Any) -> Any:
        """Ordered dispatch returning the last listener's result."""
        with self.work():
            self._require_mode(kind, SERIAL)
            result = payload
            for entry in list(self._listeners.get(kind, ())):
                result = entry.fn(payload)
            return result

    # ---------------------------------------------------------------- scope

    def scope(self, *, service_boundary: bool = False) -> Context:
        """An owned child scope: inherited reads, isolated registrations.

        Unloading the child leaves the parent alive; unloading the parent
        always unloads the child.
        """
        self._ensure_alive()
        child = Context(parent=self, service_boundary=service_boundary)
        self._children.append(child)
        self.effect(child.unload)
        return child

    # -------------------------------------------------------------- teardown

    def unload(self) -> None:
        """Unwind every registration in LIFO order; idempotent."""
        with self._work_condition:
            if self._work_owners.get(threading.get_ident(), 0):
                raise RuntimeError(
                    "cannot unload a context from its own active work"
                )
            if self._unloaded:
                return
            if self._closing:
                while not self._unloaded:
                    self._work_condition.wait()
                return
            self._closing = True
            while self._active_work:
                self._work_condition.wait()
        try:
            while self._effects:
                handle = self._effects.pop()
                with contextlib.suppress(Exception):  # noqa: BLE001 - one broken
                    handle.dispose()  # disposer must not block the rest (plan T1)
            self._inject_waiters.clear()
            for child in list(self._children):
                child.unload()
            self._children.clear()
            self._listeners.clear()
            self._service_views.clear()
            if self._pool is not None:
                self._pool.shutdown(wait=True, cancel_futures=True)
                self._pool_shutdown = True
            if self._parent is not None:
                with contextlib.suppress(ValueError):
                    self._parent._children.remove(self)  # noqa: SLF001
        finally:
            with self._work_condition:
                self._unloaded = True
                self._closing = False
                self._work_condition.notify_all()

    # -------------------------------------------------------------- internal

    def _ensure_alive(self) -> None:
        if self._closing or self._unloaded:
            raise RuntimeError("context is unloaded")

    def _find_service(self, key: str) -> tuple[Context, Any]:
        if key in self._services:
            return self, self._services[key]
        if self._parent is not None:
            return self._parent._find_service(key)  # noqa: SLF001
        raise KeyError(key)

    def _clear_service_view_recursive(self, key: str) -> None:
        self._service_views.pop(key, None)
        for child in list(self._children):
            child._clear_service_view_recursive(key)  # noqa: SLF001

    def _event_mode(self, kind: str) -> str | None:
        if kind.startswith(_SERVICE_EVENT_PREFIX):
            return EMIT
        mode = self._event_modes.get(kind)
        if mode is not None:
            return mode
        if self._parent is not None:
            return self._parent._event_mode(kind)  # noqa: SLF001
        return None

    def _require_declared(self, kind: str) -> None:
        if self._event_mode(kind) is None:
            raise UndeclaredEventError(
                f"event {kind!r} was not declared (call declare(kind, mode) first)"
            )

    def _require_mode(self, kind: str, expected: str) -> None:
        mode = self._event_mode(kind)
        if mode is None:
            raise UndeclaredEventError(
                f"event {kind!r} was not declared (call declare(kind, mode) first)"
            )
        if mode != expected:
            raise EventDispatchError(
                f"event {kind!r} is declared as {mode!r}; "
                f"{expected!r} dispatch is not allowed"
            )

    def _emit_internal(self, kind: str, payload: Any) -> None:
        """Notify service observers without letting one corrupt provisioning.

        These events report committed repository state.  They are not a
        transaction hook: rolling a service back after earlier observers ran
        would be equally inconsistent, while propagating here used to skip
        dependency activation entirely.  Ordinary public ``emit`` keeps its
        fail-fast semantics.
        """
        for entry in list(self._listeners.get(kind, ())):
            try:
                entry.fn(payload)
            except Exception:  # noqa: BLE001 - isolate third-party observers
                _logger.exception("service event listener failed for %s", kind)

    def _get_pool(self) -> ThreadPoolExecutor:
        if self._pool is None:
            self._pool = ThreadPoolExecutor(
                max_workers=_PARALLEL_WORKERS, thread_name_prefix="mp-harness"
            )
        return self._pool
