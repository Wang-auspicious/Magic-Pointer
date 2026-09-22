
from app.agent_runtime.loop import (
    _FRUITLESS_COMPACTION_RETRY_RATIO,
    _history_moved_since,
)


class FakeParams:

    def __init__(self, estimate) -> None:
        self.token_estimator = estimate


def _fixed(value):
    return FakeParams(lambda messages: value)


class TestNoBaseline:
    def test_no_failed_attempt_yet_means_nothing_to_compare(self) -> None:
        assert _history_moved_since(_fixed(500), [], None) is False

    def test_a_missing_estimator_cannot_answer(self) -> None:
        params = FakeParams(None)
        assert _history_moved_since(params, [], 1000) is False


class TestHistoryShrank:
    def test_a_materially_lighter_history_reopens_compaction(self) -> None:
        assert _history_moved_since(_fixed(800), [], 1000) is True

    def test_an_identical_history_does_not(self) -> None:
        assert _history_moved_since(_fixed(1000), [], 1000) is False

    def test_a_growing_history_does_not(self) -> None:
        assert _history_moved_since(_fixed(5000), [], 1000) is False

    def test_the_boundary_is_exclusive(self) -> None:
        baseline = 1000
        at_boundary = int(baseline * _FRUITLESS_COMPACTION_RETRY_RATIO)
        assert _history_moved_since(_fixed(at_boundary), [], baseline) is False
        assert _history_moved_since(_fixed(at_boundary - 1), [], baseline) is True

    def test_ordinary_churn_does_not_reopen_it(self) -> None:
        assert _history_moved_since(_fixed(950), [], 1000) is False

    def test_a_large_drop_reopens_it(self) -> None:
        assert _history_moved_since(_fixed(300), [], 1000) is True

    def test_a_zero_baseline_never_reopens_it(self) -> None:
        assert _history_moved_since(_fixed(0), [], 0) is False


class TestTheLatchIsActuallyEscapable:

    def test_sequence_thrash_then_drop_then_compact_again(self) -> None:
        baseline = None
        baseline = 1000
        assert _history_moved_since(_fixed(1000), [], baseline) is False, (
            'the same history must not be re-summarized'
        )
        assert _history_moved_since(_fixed(400), [], baseline) is True, (
            'a genuinely lighter history must be allowed to compact again — '
            'this is the case the counter latch made unreachable'
        )

    def test_repeatedly_thrashing_is_still_refused(self) -> None:
        baseline = 1000
        for _ in range(5):
            assert _history_moved_since(_fixed(1050), [], baseline) is False
