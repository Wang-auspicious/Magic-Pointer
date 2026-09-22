
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

_SERVICE_EVENT_PREFIX = "service/"

_logger = logging.getLogger(__name__)


class EventDispatchError(Exception):
    pass


class UndeclaredEventError(Exception):
    pass


class Disposable:

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
    state: str = "pending"
    fork: Context | None = None
    handle: Disposable | None = None
    error: BaseException | None = None


class InjectionHandle(Disposable):

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
        self._scope_handle_in_parent: Disposable | None = None


    def provide(self, key: str, service: Any) -> None:
        self._ensure_alive()
        if key in self._services:
            raise ValueError(f"service {key!r} is already provided")
        self._services[key] = service
        self._emit_internal(
            f"{_SERVICE_EVENT_PREFIX}{key}", {"key": key, "service": service}
        )
        self._refresh_injects_recursive()

    def get(self, key: str) -> Any:
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
        self._ensure_alive()
        if key not in self._services:
            return False
        del self._services[key]
        self._clear_service_view_recursive(key)
        self._refresh_injects_recursive()
        return True

    def provide_up(self, key: str, service: Any) -> Disposable:
        self._ensure_alive()
        target = self
        while target._parent is not None and not target._service_boundary:
            target = target._parent
        target.provide(key, service)

        def undo() -> None:
            if not target._unloaded:  # noqa: SLF001
                target.revoke(key)

        return self._register(undo)


    def inject(
        self, dependencies: list[str] | tuple[str, ...], callback: Callable[[Context], None]
    ) -> Disposable:
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
                _logger.exception(
                    "nested inject activation failed for deps=%s",
                    sorted(waiter.deps),
                )

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


    def effect(self, disposer: Callable[[], None]) -> Disposable:
        return self._register(disposer)

    @contextlib.contextmanager
    def work(self):
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

        def self_removing_dispose() -> None:
            with contextlib.suppress(ValueError):
                self._effects.remove(handle)
            disposer()

        handle._dispose = self_removing_dispose  # noqa: SLF001
        return handle

    def _run_reserved_work(self, callback: Callable[..., Any], *args: Any) -> Any:
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


    def declare(self, kind: str, mode: str) -> None:
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
        with self.work():
            self._require_mode(kind, EMIT)
            for entry in list(self._listeners.get(kind, ())):
                entry.fn(payload)

    def waterfall(self, kind: str, payload: Any) -> Any:
        with self.work():
            self._require_mode(kind, WATERFALL)
            entries = list(self._listeners.get(kind, ()))

            def run(index: int) -> Any:
                if index >= len(entries):
                    return payload
                return entries[index].fn(payload, lambda: run(index + 1))

            return run(0)

    def parallel(self, kind: str, payload: Any) -> list[Any]:
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
            results: list[Any] = []
            for future in futures:
                try:
                    results.append(future.result())
                except Exception:  # noqa: BLE001 - one listener's crash is
                    _logger.exception("parallel event listener failed for %s", kind)
                    results.append(None)
            return results

    def serial(self, kind: str, payload: Any) -> Any:
        with self.work():
            self._require_mode(kind, SERIAL)
            result = payload
            for entry in list(self._listeners.get(kind, ())):
                result = entry.fn(payload)
            return result


    def scope(self, *, service_boundary: bool = False) -> Context:
        self._ensure_alive()
        child = Context(parent=self, service_boundary=service_boundary)
        self._children.append(child)
        child._scope_handle_in_parent = self.effect(child.unload)  # noqa: SLF001
        return child


    def unload(self) -> None:
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
                    handle.dispose()
            self._inject_waiters.clear()
            for child in list(self._children):
                child.unload()
            self._children.clear()
            self._listeners.clear()
            self._service_views.clear()
            self._services.clear()
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
        if self._scope_handle_in_parent is not None:
            handle = self._scope_handle_in_parent
            self._scope_handle_in_parent = None
            with contextlib.suppress(Exception):
                handle.dispose()


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
