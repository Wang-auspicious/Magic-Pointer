"""Phase timings are the only thing that turns "it was slow" into a root cause.

The 2026-08-03 real-machine session produced a 30s `bridge_timeout` and a 4.9s
wait before the capsule appeared, and not one unit test could say which step
owned either number. This covers the wire format both bridges emit, because the
Electron side parses it and a silent format drift would take the diagnostics
down without failing anything.
"""

from __future__ import annotations

import io
import re

from scripts.bridge_progress import PhaseClock, null_clock

LINE = re.compile(r"^@@mp phase=(\S+) ms=(\d+) d=(\d+) scope=(\S+)(.*)$")


def _emit(**kwargs) -> list[str]:
    stream = io.StringIO()
    clock = PhaseClock("selection_snapshot", stream=stream, **kwargs)
    clock.mark("payload_read")
    clock.mark("pixels_frozen", w=2950, h=1908)
    clock.total(status="ready")
    return [line for line in stream.getvalue().splitlines() if line]


def test_every_mark_matches_the_wire_format_electron_parses() -> None:
    lines = _emit()
    assert len(lines) == 3
    for line in lines:
        assert LINE.match(line), line


def test_marks_carry_their_phase_and_extra_fields() -> None:
    phases = [LINE.match(line).group(1) for line in _emit()]
    assert phases == ["payload_read", "pixels_frozen", "total"]
    assert "w=2950" in _emit()[1]
    assert "h=1908" in _emit()[1]


def test_total_reports_the_per_phase_breakdown() -> None:
    total = _emit()[-1]
    assert "status=ready" in total
    assert "breakdown=" in total
    breakdown = total.split("breakdown=", 1)[1].split()[0]
    assert breakdown.startswith("payload_read:")
    assert "pixels_frozen:" in breakdown


def test_values_containing_whitespace_cannot_break_the_line_parser() -> None:
    stream = io.StringIO()
    clock = PhaseClock("scope with spaces", stream=stream)
    clock.mark("structured_read", app="Windows Explorer", err="two words")
    line = stream.getvalue().strip()
    assert LINE.match(line), line
    assert " " not in line.split("app=", 1)[1].split()[0]


def test_a_broken_stream_disables_emission_instead_of_failing_the_capture() -> None:
    class Exploding(io.StringIO):
        def write(self, _text: str) -> int:
            raise OSError("stderr went away")

    clock = PhaseClock("selection_bridge", stream=Exploding())
    clock.mark("payload_read")
    clock.mark("still_alive")
    assert clock.enabled is False


def test_null_clock_measures_without_writing() -> None:
    clock = null_clock("tests")
    assert isinstance(clock.mark("a"), float)
    assert clock.enabled is False
