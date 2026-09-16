"""The twin cursor's message channel.

The gap this closes: the driver knew where it was about to click and how long
the flight would take, the Electron side knew how to draw and animate a cursor,
and nothing carried the news between them. The cursor followed the pointer and
was never pointed at anything.
"""

from app.computer_operator.agent_cursor_channel import (
    ACTION_APPROACH,
    ACTION_CLICK,
    ACTION_IDLE,
    AGENT_CURSOR_PHASE,
    DEFAULT_CURSOR_ID,
    AgentCursorEmitter,
)


class Recorder:
    def __init__(self) -> None:
        self.marks: list[tuple[str, dict]] = []

    def mark(self, phase: str, **fields):
        self.marks.append((phase, fields))
        return 0.0


class Exploding:
    def mark(self, phase: str, **fields):
        raise RuntimeError("stderr closed")


class TestProtocol:
    def test_it_satisfies_the_driver_observer_protocol(self) -> None:
        from app.computer_operator.windows import ApproachObserver

        # structural check: every method the driver calls must exist
        for name in ("cursor_approach", "cursor_clicked"):
            assert callable(getattr(AgentCursorEmitter(None), name)), name
        assert hasattr(ApproachObserver, "cursor_approach")

    def test_disabled_without_a_sink(self) -> None:
        emitter = AgentCursorEmitter(None)
        assert emitter.enabled is False
        emitter.cursor_approach((1, 2), lead_ms=600)  # must not raise
        emitter.cursor_clicked((1, 2), button="left", count=1)
        emitter.idle()


class TestApproach:
    def test_approach_emits_the_phase_the_main_process_expects(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_approach((300, 400), lead_ms=600)
        phase, fields = sink.marks[0]
        assert phase == AGENT_CURSOR_PHASE
        assert fields["action"] == ACTION_APPROACH
        assert (fields["x"], fields["y"]) == (300, 400)
        assert fields["leadMs"] == 600
        assert fields["id"] == DEFAULT_CURSOR_ID

    def test_negative_lead_is_clamped(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_approach((0, 0), lead_ms=-5)
        assert sink.marks[0][1]["leadMs"] == 0

    def test_coordinates_are_ints(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_approach((1.7, 2.2), lead_ms=0)
        assert sink.marks[0][1]["x"] == 1
        assert sink.marks[0][1]["y"] == 2


class TestClick:
    def test_click_carries_button_and_count(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_clicked((10, 20), button="right", count=2)
        fields = sink.marks[0][1]
        assert fields["action"] == ACTION_CLICK
        assert fields["button"] == "right"
        assert fields["count"] == 2

    def test_count_is_at_least_one(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_clicked((0, 0), button="left", count=0)
        assert sink.marks[0][1]["count"] == 1

    def test_missing_button_defaults_to_left(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink).cursor_clicked((0, 0), button="", count=1)
        assert sink.marks[0][1]["button"] == "left"


class TestIdle:
    def test_idle_before_any_motion_says_nothing(self) -> None:
        # There is no cursor to release yet; an idle row would create one.
        sink = Recorder()
        AgentCursorEmitter(sink).idle()
        assert sink.marks == []

    def test_idle_after_a_motion_releases_the_cursor(self) -> None:
        sink = Recorder()
        emitter = AgentCursorEmitter(sink)
        emitter.cursor_approach((5, 6), lead_ms=0)
        emitter.idle()
        assert [m[1]["action"] for m in sink.marks] == [ACTION_APPROACH, ACTION_IDLE]
        assert (sink.marks[1][1]["x"], sink.marks[1][1]["y"]) == (5, 6)


class TestNeverFailsTheAction:
    def test_a_raising_sink_is_swallowed(self) -> None:
        emitter = AgentCursorEmitter(Exploding())
        emitter.cursor_approach((1, 1), lead_ms=100)  # must not raise
        emitter.cursor_clicked((1, 1), button="left", count=1)
        emitter.idle()

    def test_enabled_reflects_the_sink_not_its_health(self) -> None:
        assert AgentCursorEmitter(Exploding()).enabled is True

    def test_a_custom_cursor_id_is_carried(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink, cursor_id="worker-2").cursor_approach((0, 0), lead_ms=0)
        assert sink.marks[0][1]["id"] == "worker-2"

    def test_an_empty_cursor_id_falls_back(self) -> None:
        sink = Recorder()
        AgentCursorEmitter(sink, cursor_id="").cursor_approach((0, 0), lead_ms=0)
        assert sink.marks[0][1]["id"] == DEFAULT_CURSOR_ID


class TestSessionAttachment:
    """The driver is built lazily by the session factory, so the emitter has to
    be attached there rather than passed down. These pin that wiring."""

    def test_the_driver_is_built_with_an_observer_when_a_sink_is_set(self) -> None:
        import app.desktop_actions.session as session_module

        seen: dict = {}

        class FakeDriver:
            def __init__(self, *, approach_observer=None):
                seen["observer"] = approach_observer

        import app.computer_operator.windows as windows_module

        real = windows_module.Win32InputDriver
        windows_module.Win32InputDriver = FakeDriver  # type: ignore[assignment]
        try:
            sink = Recorder()
            session_module.set_agent_cursor_sink(sink)
            session_module._live_driver()
            assert seen["observer"] is not None, (
                'a sink must produce an observer, or the twin cursor never moves'
            )
            seen["observer"].cursor_clicked((3, 4), button="left", count=1)
            assert sink.marks[0][1]["action"] == ACTION_CLICK
        finally:
            windows_module.Win32InputDriver = real  # type: ignore[assignment]
            session_module.set_agent_cursor_sink(None)

    def test_no_sink_means_no_observer(self) -> None:
        import app.desktop_actions.session as session_module

        seen: dict = {}

        class FakeDriver:
            def __init__(self, *, approach_observer=None):
                seen["observer"] = approach_observer

        import app.computer_operator.windows as windows_module

        real = windows_module.Win32InputDriver
        windows_module.Win32InputDriver = FakeDriver  # type: ignore[assignment]
        try:
            session_module.set_agent_cursor_sink(None)
            session_module._live_driver()
            assert seen["observer"] is None
        finally:
            windows_module.Win32InputDriver = real  # type: ignore[assignment]

    def test_detaching_does_not_leave_a_stale_emitter(self) -> None:
        import app.desktop_actions.session as session_module

        session_module.set_agent_cursor_sink(Recorder())
        session_module.set_agent_cursor_sink(None)
        assert session_module._agent_cursor_sink is None
