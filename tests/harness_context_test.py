"""Harness kernel context tests (plugin-kernel batch, plan T1).

Pins the DSH-Cordis-style semantics re-written in Python
(docs/2026-08-14-plugin-architecture-review.md):

- ``provide``/``get``/``has``/``keys`` service repository with duplicate
  rejection and ``service/<key>`` activation events.
- ``inject`` dependency-driven activation: runs immediately when all deps
  are present, otherwise waits for the last dep; activations cascade and
  register into the same LIFO teardown stack as effects.
- ``effect`` reversible registrations unwound LIFO on ``unload``; a raising
  disposer never prevents the rest from unwinding.
- Events must be declared with a dispatch mode; emitting with the wrong
  method raises. emit / waterfall (short-circuitable) / parallel /
  serial(last-result) semantics.
- ``on`` listeners are reversible; prepend=True runs before others.
- ``scope()`` child contexts read services from the parent, confine their
  own registrations, and unload independently.
- ``revoke`` disposes the inject scope that depended on the removed
  service.
"""

from __future__ import annotations

import threading

import pytest

from app.harness.context import (
    Context,
    EventDispatchError,
    UndeclaredEventError,
)


def test_provide_get_has_keys():
    ctx = Context()
    service = object()
    ctx.provide("tools", service)
    assert ctx.get("tools") is service
    assert ctx.has("tools") is True
    assert ctx.has("missing") is False
    assert "tools" in ctx


def test_duplicate_provide_raises():
    ctx = Context()
    ctx.provide("tools", object())
    with pytest.raises(ValueError):
        ctx.provide("tools", object())


def test_inject_activates_immediately_when_deps_present():
    ctx = Context()
    ctx.provide("tools", object())
    calls: list[str] = []
    ctx.inject(["tools"], lambda c: calls.append("tools"))
    assert calls == ["tools"]


def test_inject_waits_for_last_dep_and_activates_in_registration_order():
    ctx = Context()
    ctx.provide("a", object())
    order: list[str] = []
    ctx.inject(["a", "b"], lambda c: order.append("first"))
    ctx.inject(["a", "b"], lambda c: order.append("second"))
    assert order == []
    ctx.provide("b", object())
    assert order == ["first", "second"]


def test_inject_cascades_within_its_fork():
    """An inject callback runs inside a fork: services it provides stay in
    the fork, but the fork is a full context, so nested injects cascade."""
    ctx = Context()
    order: list[str] = []

    def outer(fork):
        fork.provide("b", object())
        fork.inject(["b"], lambda c: order.append("b-ready"))

    ctx.inject(["a"], outer)
    ctx.provide("a", object())
    assert order == ["b-ready"]
    assert ctx.has("b") is False  # fork provides never leak to the parent


def test_service_activation_event_fires_on_provide():
    ctx = Context()
    seen: list[str] = []
    ctx.on("service/tools", lambda payload: seen.append(payload["key"]))
    ctx.provide("tools", object())
    assert seen == ["tools"]


def test_raising_service_listener_does_not_leave_provide_half_applied(caplog):
    ctx = Context()
    activated: list[str] = []
    ctx.inject(["tools"], lambda _scope: activated.append("ready"))

    def broken_listener(_payload):
        raise RuntimeError("broken service observer")

    ctx.on("service/tools", broken_listener)
    ctx.provide("tools", object())

    assert ctx.has("tools") is True
    assert activated == ["ready"]
    assert "broken service observer" in caplog.text


def test_effect_unwinds_lifo_on_unload():
    ctx = Context()
    disposed: list[str] = []
    ctx.effect(lambda: disposed.append("first"))
    ctx.effect(lambda: disposed.append("second"))
    ctx.unload()
    assert disposed == ["second", "first"]


def test_raising_disposer_does_not_block_the_rest():
    ctx = Context()
    disposed: list[str] = []

    def broken() -> None:
        raise RuntimeError("broken disposer")

    ctx.effect(broken)
    ctx.effect(lambda: disposed.append("ok"))
    ctx.unload()  # must not raise
    assert disposed == ["ok"]


def test_inject_child_scope_unwinds_with_context():
    ctx = Context()
    ctx.provide("tools", object())
    disposed: list[str] = []
    ctx.inject(["tools"], lambda c: c.effect(lambda: disposed.append("child")))
    ctx.unload()
    assert disposed == ["child"]


def test_unload_is_idempotent_and_registration_after_unload_raises():
    ctx = Context()
    ctx.unload()
    ctx.unload()
    with pytest.raises(RuntimeError):
        ctx.provide("x", object())
    with pytest.raises(RuntimeError):
        ctx.effect(lambda: None)
    with pytest.raises(RuntimeError):
        ctx.on("k", lambda p: None)
    with pytest.raises(RuntimeError):
        ctx.inject(["x"], lambda c: None)


def test_emit_dispatch():
    ctx = Context()
    ctx.declare("tick", "emit")
    seen: list[int] = []
    ctx.on("tick", seen.append)
    ctx.on("tick", lambda payload: seen.append(payload * 10))
    ctx.emit("tick", 3)
    assert seen == [3, 30]


def test_unload_waits_for_inflight_event_dispatch() -> None:
    ctx = Context()
    ctx.declare("slow", "emit")
    entered = threading.Event()
    release = threading.Event()
    unloaded = threading.Event()

    def listener(_payload):
        entered.set()
        assert release.wait(timeout=2)

    ctx.on("slow", listener)
    dispatching = threading.Thread(target=lambda: ctx.emit("slow", None), daemon=True)
    dispatching.start()
    assert entered.wait(timeout=1)
    unloading = threading.Thread(
        target=lambda: (ctx.unload(), unloaded.set()),
        daemon=True,
    )
    unloading.start()

    assert not unloaded.wait(timeout=0.05)
    release.set()
    dispatching.join(timeout=1)
    unloading.join(timeout=1)

    assert unloaded.is_set()


def test_waterfall_delegates_and_can_short_circuit():
    ctx = Context()
    ctx.declare("decision", "waterfall")
    calls: list[str] = []

    def wrap(payload, next):
        calls.append("wrap")
        return next() + 1

    def short(payload, next):
        calls.append("short")
        return 100  # no next() call: short-circuit

    ctx.on("decision", wrap)
    ctx.on("decision", short)
    result = ctx.waterfall("decision", 1)
    assert result == 101
    assert calls == ["wrap", "short"]


def test_serial_runs_in_order_and_returns_last_result():
    ctx = Context()
    ctx.declare("fold", "serial")
    results: list[int] = []

    def first(payload):
        results.append(payload)
        return payload + 1

    def second(payload):
        results.append(payload * 2)
        return payload * 2

    ctx.on("fold", first)
    ctx.on("fold", second)
    assert ctx.serial("fold", 4) == 8
    assert results == [4, 8]


def test_parallel_runs_all_listeners_concurrently():
    ctx = Context()
    ctx.declare("fan", "parallel")
    barrier = threading.Barrier(2)

    def listener(payload):
        barrier.wait(timeout=5)
        return payload + 1

    ctx.on("fan", listener)
    ctx.on("fan", listener)
    results = ctx.parallel("fan", 1)
    assert results == [2, 2]


def test_parallel_listener_cannot_unload_its_dispatch_context() -> None:
    ctx = Context()
    ctx.declare("fan", "parallel")
    errors: list[str] = []

    def listener(_payload):
        try:
            ctx.unload()
        except RuntimeError as exc:
            errors.append(str(exc))

    ctx.on("fan", listener)

    ctx.parallel("fan", None)

    assert errors == ["cannot unload a context from its own active work"]
    ctx.unload()


def test_dispatch_mode_mismatch_raises():
    ctx = Context()
    ctx.declare("tick", "emit")
    with pytest.raises(EventDispatchError):
        ctx.waterfall("tick", 1)


def test_undeclared_event_raises_on_dispatch_and_on():
    ctx = Context()
    with pytest.raises(UndeclaredEventError):
        ctx.emit("ghost", 1)
    with pytest.raises(UndeclaredEventError):
        ctx.on("ghost", lambda p: None)


def test_conflicting_mode_redeclare_raises():
    ctx = Context()
    ctx.declare("tick", "emit")
    with pytest.raises(ValueError):
        ctx.declare("tick", "waterfall")


def test_on_prepend_runs_first_and_listener_is_reversible():
    ctx = Context()
    ctx.declare("tick", "emit")
    seen: list[str] = []
    ctx.on("tick", lambda p: seen.append("normal"))
    removable = ctx.on("tick", lambda p: seen.append("prepended"), prepend=True)
    ctx.emit("tick", None)
    assert seen == ["prepended", "normal"]
    removable.dispose()
    seen.clear()
    ctx.emit("tick", None)
    assert seen == ["normal"]


def test_scope_reads_parent_services_and_confines_own_registrations():
    parent = Context()
    parent.provide("tools", object())
    child = parent.scope()
    assert child.get("tools") is parent.get("tools")
    child.provide("own", object())
    assert child.has("own") is True
    assert parent.has("own") is False
    # child listeners are isolated from parent emissions
    parent.declare("tick", "emit")
    seen: list[int] = []
    child.on("tick", seen.append)
    parent.emit("tick", 1)
    assert seen == []


def test_scope_unload_does_not_unload_parent():
    parent = Context()
    disposed: list[str] = []
    parent.effect(lambda: disposed.append("parent"))
    child = parent.scope()
    child.effect(lambda: disposed.append("child"))
    child.unload()
    assert disposed == ["child"]
    parent.unload()
    assert disposed == ["child", "parent"]


def test_revoke_disposes_dependent_inject_scope():
    ctx = Context()
    ctx.provide("a", object())
    ctx.provide("b", object())
    disposed: list[str] = []
    ctx.inject(["a", "b"], lambda c: c.effect(lambda: disposed.append("dep")))
    ctx.revoke("b")
    assert disposed == ["dep"]
    assert ctx.has("b") is False
    assert ctx.has("a") is True


def test_reprovided_dependency_reactivates_inject_scope() -> None:
    ctx = Context()
    activations: list[int] = []
    disposals: list[int] = []

    def activate(plugin_ctx: Context) -> None:
        generation = len(activations) + 1
        activations.append(generation)
        plugin_ctx.effect(lambda: disposals.append(generation))

    ctx.inject(["service"], activate)
    ctx.provide("service", object())
    ctx.revoke("service")
    ctx.provide("service", object())

    assert activations == [1, 2]
    assert disposals == [1]
    ctx.unload()
    assert disposals == [1, 2]


def test_parent_service_changes_drive_child_injection() -> None:
    parent = Context()
    child = parent.scope()
    seen: list[str] = []
    disposed: list[str] = []
    child.inject(
        ["late"],
        lambda plugin_ctx: (
            seen.append("active"),
            plugin_ctx.effect(lambda: disposed.append("inactive")),
        ),
    )

    parent.provide("late", object())
    assert seen == ["active"]
    parent.revoke("late")
    assert disposed == ["inactive"]


def test_parent_unload_cascades_to_owned_scopes() -> None:
    parent = Context()
    child = parent.scope()
    disposed: list[str] = []
    child.effect(lambda: disposed.append("child"))

    parent.unload()

    assert disposed == ["child"]
    with pytest.raises(RuntimeError):
        child.provide("too-late", object())


def test_disposing_inject_handle_prevents_future_reactivation() -> None:
    ctx = Context()
    activations: list[str] = []
    handle = ctx.inject(["service"], lambda _fork: activations.append("active"))
    ctx.provide("service", object())
    ctx.revoke("service")
    handle.dispose()
    ctx.provide("service", object())

    assert activations == ["active"]


def test_context_unload_disposes_parallel_executor():
    ctx = Context()
    ctx.declare("fan", "parallel")
    ctx.on("fan", lambda p: p)
    ctx.parallel("fan", 1)
    ctx.unload()
    assert ctx._pool_shutdown is True


def test_unload_from_its_own_active_work_fails_instead_of_deadlocking() -> None:
    ctx = Context()
    finished = threading.Event()
    errors: list[str] = []

    def reentrant_unload() -> None:
        try:
            with ctx.work():
                ctx.unload()
        except RuntimeError as exc:
            errors.append(str(exc))
        finally:
            finished.set()

    worker = threading.Thread(target=reentrant_unload, daemon=True)
    worker.start()

    assert finished.wait(timeout=0.25), "reentrant unload deadlocked"
    assert errors == ["cannot unload a context from its own active work"]
    ctx.unload()


def test_provide_up_exposes_fork_service_on_root_and_revokes_on_unload():
    root = Context()
    fork = root.scope()
    fork.provide_up("plugin_svc", object())
    assert root.has("plugin_svc")
    # `has` reads through to the parent, so the fork sees it too; the point
    # is that the service lives on the root, not on the fork.
    fork.unload()
    assert root.has("plugin_svc") is False


def test_provide_up_activates_root_dependents_and_revoke_disposes_them():
    root = Context()
    root.provide("tools", object())
    fork = root.scope()
    order: list[str] = []
    root.inject(["tools", "plugin_svc"], lambda c: order.append("ready"))
    fork.provide_up("plugin_svc", object())
    assert order == ["ready"]
    fork.unload()
    # revoke cascaded: the dependent fork's teardown already ran
    assert root.has("plugin_svc") is False


def test_service_boundary_keeps_run_exports_out_of_process_root() -> None:
    root = Context()
    run = root.scope(service_boundary=True)
    plugin_fork = Context(parent=run)

    plugin_fork.provide_up("run_only", "value")

    assert run.get("run_only") == "value"
    assert root.has("run_only") is False
    plugin_fork.unload()
    assert run.has("run_only") is False
