"""Tests for thread-safe cancellation tokens, scopes and registry (review L8).

Covers: idempotent cancel, state transitions, raise_if_cancelled, scope
lifetime semantics (enter/exit/cancel_all, nesting, sibling isolation),
generation invalidation, registry accounting, the module singleton, and
concurrent multi-threaded cancellation.
"""

import threading

import pytest

from app.governance import (
    CancellationRegistry,
    CancellationScope,
    CancellationToken,
    CancelledError,
    cancel_all_in_flight,
    get_registry,
)


@pytest.fixture(autouse=True)
def _isolated_global_registry() -> None:
    get_registry().clear()
    yield
    get_registry().clear()


class TestCancellationToken:
    def test_fresh_token_is_not_cancelled(self) -> None:
        token = CancellationToken()
        assert token.is_cancelled() is False

    def test_cancel_marks_cancelled(self) -> None:
        token = CancellationToken()
        token.cancel()
        assert token.is_cancelled() is True

    def test_cancel_is_idempotent(self) -> None:
        token = CancellationToken()
        token.cancel()
        token.cancel()
        token.cancel()
        assert token.is_cancelled() is True

    def test_raise_if_cancelled_noop_before_cancel(self) -> None:
        token = CancellationToken()
        token.raise_if_cancelled()

    def test_raise_if_cancelled_raises_after_cancel(self) -> None:
        token = CancellationToken()
        token.cancel()
        with pytest.raises(CancelledError):
            token.raise_if_cancelled()

    def test_cancelled_error_is_exception_and_exported(self) -> None:
        assert issubclass(CancelledError, Exception)
        assert CancelledError.__module__ == "app.governance.cancellation"

    def test_cancel_from_another_thread_is_visible(self) -> None:
        token = CancellationToken()
        assert not token.is_cancelled()
        threading.Thread(target=token.cancel).start()
        threading.Thread(target=token.cancel).start()
        assert token.is_cancelled()


class TestCancellationScope:
    def test_enter_creates_and_registers_token(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as scope:
            assert isinstance(scope.token, CancellationToken)
            assert not scope.token.is_cancelled()
            assert scope.is_cancelled is False
            assert registry.active_count() == 1

    def test_token_attribute_none_before_enter(self) -> None:
        scope = CancellationScope(registry=CancellationRegistry())
        assert scope.token is None
        assert scope.is_cancelled is False

    def test_scope_cancel_all_cancels_its_token(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as scope:
            scope.cancel_all()
            assert scope.token.is_cancelled()
            assert scope.is_cancelled is True
            assert registry.active_count() == 1

    def test_exit_removes_uncancelled_token(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry):
            pass
        assert registry.active_count() == 0

    def test_cancelled_token_stays_registered_after_exit(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as scope:
            scope.cancel_all()
        assert registry.active_count() == 1

    def test_exit_removes_token_even_on_exception(self) -> None:
        registry = CancellationRegistry()
        with pytest.raises(ValueError), CancellationScope(registry=registry):
            raise ValueError("boom")
        assert registry.active_count() == 0

    def test_outer_cancel_all_cancels_nested_scopes(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as outer, CancellationScope(
            registry=registry
        ) as inner:
            assert registry.active_count() == 2
            outer.cancel_all()
            assert outer.token.is_cancelled()
            assert inner.token.is_cancelled()
            assert outer.is_cancelled is True
            assert inner.is_cancelled is True

    def test_inner_cancel_all_leaves_outer_uncancelled(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as outer, CancellationScope(
            registry=registry
        ) as inner:
            inner.cancel_all()
            assert inner.is_cancelled is True
            assert outer.is_cancelled is False
            assert not outer.token.is_cancelled()

    def test_new_scope_after_cancelled_scope_is_unaffected(self) -> None:
        registry = CancellationRegistry()
        with CancellationScope(registry=registry) as first:
            first.cancel_all()
        assert first.is_cancelled is True
        with CancellationScope(registry=registry) as second:
            assert second.is_cancelled is False
            assert not second.token.is_cancelled()


class TestCancellationRegistry:
    def test_register_then_active_count(self) -> None:
        registry = CancellationRegistry()
        token = CancellationToken()
        registry.register(token)
        assert registry.active_count() == 1

    def test_duplicate_register_is_idempotent(self) -> None:
        registry = CancellationRegistry()
        token = CancellationToken()
        registry.register(token)
        registry.register(token)
        registry.register(token)
        assert registry.active_count() == 1

    def test_unregister_removes_without_cancelling(self) -> None:
        registry = CancellationRegistry()
        token = CancellationToken()
        registry.register(token)
        registry.unregister(token)
        assert registry.active_count() == 0
        assert token.is_cancelled() is False

    def test_cancel_all_cancels_everything_but_keeps_registry(self) -> None:
        registry = CancellationRegistry()
        tokens = [CancellationToken() for _ in range(3)]
        for token in tokens:
            registry.register(token)
        registry.cancel_all()
        assert all(token.is_cancelled() for token in tokens)
        assert registry.active_count() == 3

    def test_cancel_all_on_empty_registry_is_noop(self) -> None:
        registry = CancellationRegistry()
        registry.cancel_all()
        assert registry.active_count() == 0

    def test_generation_invalidation_old_cancelled_new_untouched(self) -> None:
        registry = CancellationRegistry()
        old = [CancellationToken() for _ in range(3)]
        for token in old:
            registry.register(token)
        registry.cancel_all()
        assert all(token.is_cancelled() for token in old)
        fresh = CancellationToken()
        registry.register(fresh)
        assert fresh.is_cancelled() is False
        assert registry.active_count() == 4
        registry.cancel_all()
        assert fresh.is_cancelled() is True

    def test_clear_empties_registry_without_cancelling(self) -> None:
        registry = CancellationRegistry()
        token = CancellationToken()
        registry.register(token)
        registry.clear()
        assert registry.active_count() == 0
        assert token.is_cancelled() is False


class TestGlobalRegistry:
    def test_get_registry_returns_singleton(self) -> None:
        assert get_registry() is get_registry()

    def test_cancel_all_in_flight_cancels_registered_tokens(self) -> None:
        token = CancellationToken()
        get_registry().register(token)
        assert token.is_cancelled() is False
        cancel_all_in_flight()
        assert token.is_cancelled() is True


class TestConcurrency:
    def test_eight_threads_cancel_own_tokens_safely(self) -> None:
        failures: list[BaseException] = []
        tokens = [CancellationToken() for _ in range(8)]

        def worker(token: CancellationToken) -> None:
            try:
                for _ in range(300):
                    token.cancel()
                    token.cancel()
                    assert token.is_cancelled()
            except BaseException as exc:  # pragma: no cover - failure path
                failures.append(exc)

        threads = [threading.Thread(target=worker, args=(token,)) for token in tokens]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert not failures
        assert all(token.is_cancelled() for token in tokens)

    def test_concurrent_register_cancel_all_unregister(self) -> None:
        registry = CancellationRegistry()
        failures: list[BaseException] = []
        stop = threading.Event()

        def worker() -> None:
            try:
                while not stop.is_set():
                    token = CancellationToken()
                    registry.register(token)
                    token.cancel()
                    registry.unregister(token)
            except BaseException as exc:  # pragma: no cover - failure path
                failures.append(exc)

        workers = [threading.Thread(target=worker) for _ in range(4)]
        for thread in workers:
            thread.start()
        for _ in range(50):
            registry.cancel_all()
        stop.set()
        for thread in workers:
            thread.join()
        assert not failures
        registry.cancel_all()
        assert registry.active_count() == 0
