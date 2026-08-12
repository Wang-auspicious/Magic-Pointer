"""DesktopTrace: record real desktop interactions into replayable fixtures.

The package is pure Python except for ``recorder.capture_frame`` which accepts an
injected capture backend; it never grabs the real screen by itself.
"""

from app.replay.trace_schema import (
    CdpSnapshot,
    DesktopTrace,
    FocusEvent,
    PointerSample,
    SCHEMA_VERSION,
    TraceFrame,
    UiaSnapshot,
)

__all__ = [
    "SCHEMA_VERSION",
    "CdpSnapshot",
    "DesktopTrace",
    "FocusEvent",
    "PointerSample",
    "TraceFrame",
    "UiaSnapshot",
]
