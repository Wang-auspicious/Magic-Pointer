"""Guards the probe timeout budget against being tightened back.

Measured 2026-08-03 against live windows with the probe's cap lifted to 3000ms:
RunProbeCore needs 199-975ms depending on the size of the target's automation
tree (Edge ~205ms, Clash ~310ms, CC Switch ~320ms, QQ ~730ms — QQ is CEF-based,
so FindDocumentSelection's FindAll(TreeScope.Descendants) walks a huge tree).

At the previous 200ms cap all four windows returned "uia_probe_timeout_200ms",
which reports a *read failure* for what is really "nothing is selected here".
That distinction matters: a read failure sends the caller down the OCR fallback,
while an empty selection should stay silent. These tests pin both halves of the
budget so the regression cannot come back quietly.
"""

import inspect
import re
from pathlib import Path

from app.adapters import uia_text_adapter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "scripts" / "uia_selection_probe.cs").read_text(encoding="utf-8")

# Slowest window measured, plus headroom for a tree larger than anything we saw.
SLOWEST_MEASURED_PROBE_MS = 975


def _native_hard_timeout_ms() -> int:
    match = re.search(r"UiaProbeHardTimeoutMs\s*=\s*(\d+)\s*;", SOURCE)
    assert match is not None, "UiaProbeHardTimeoutMs is no longer a literal constant"
    return int(match.group(1))


def test_native_hard_timeout_clears_the_slowest_measured_window() -> None:
    assert _native_hard_timeout_ms() >= SLOWEST_MEASURED_PROBE_MS


def test_timeout_error_string_reports_the_actual_budget() -> None:
    # A hardcoded "uia_probe_timeout_200ms" outlived the 200ms constant once
    # already, which made logs claim a budget the binary no longer used. Check
    # only executable lines: the comment above the constant quotes the old
    # string deliberately, as the record of what went wrong.
    assert 'result.Error = "uia_probe_timeout_" + UiaProbeHardTimeoutMs + "ms"' in SOURCE
    code_lines = [
        line
        for line in SOURCE.splitlines()
        if not line.lstrip().startswith("//")
    ]
    literal_timeout_errors = [
        line
        for line in code_lines
        if re.search(r'"uia_probe_timeout_\d+ms"', line)
    ]
    assert not literal_timeout_errors, literal_timeout_errors


def test_python_timeout_stays_above_the_native_ceiling() -> None:
    # The Python timeout only bounds a wedged process. If it drops below the
    # probe's own ceiling it kills the probe while it is answering correctly,
    # and the caller records that as a read failure.
    default = inspect.signature(
        uia_text_adapter._run_uia_selection_probe
    ).parameters["timeout"].default
    native_seconds = _native_hard_timeout_ms() / 1000
    assert default > native_seconds, (
        f"python default timeout {default}s must exceed the probe's own "
        f"{native_seconds}s ceiling plus startup and serialization"
    )
