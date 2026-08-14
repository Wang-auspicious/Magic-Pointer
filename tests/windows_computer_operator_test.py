from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from PIL import Image

from app.agent_runtime.tool_registry import Effect
from app.computer_operator import ComputerAction, ComputerActionKind, SurfaceGrant
from app.computer_operator.windows import Win32InputDriver, WindowsComputerOperatorBackend
from app.governance.cancellation import CancellationToken, CancelledError


class _Capture:
    source = "test-capture"

    def __init__(self) -> None:
        self.bounds: list[tuple[int, int, int, int]] = []

    def available(self) -> bool:
        return True

    @property
    def unavailable_reason(self) -> str:
        return ""

    def capture(self, bounds):
        self.bounds.append(bounds)
        return Image.new("RGB", (bounds[2] - bounds[0], bounds[3] - bounds[1]), "navy")


class _Driver:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.surface_hwnd = 42
        self.foreground_hwnd = 42

    def window_at(self, point):
        return self.surface_hwnd

    def foreground_window(self):
        return self.foreground_hwnd

    def click(self, point, *, button, count):
        self.calls.append(("click", point, button, count))

    def move(self, point, *, duration_ms):
        self.calls.append(("move", point, duration_ms))

    def drag(self, start, end, *, duration_ms):
        self.calls.append(("drag", start, end, duration_ms))

    def scroll(self, point, *, delta):
        self.calls.append(("scroll", point, delta))

    def type_text(self, value):
        self.calls.append(("type", value))

    def key_down(self, key):
        self.calls.append(("down", key))

    def key_up(self, key):
        self.calls.append(("up", key))


def _grant() -> SurfaceGrant:
    return SurfaceGrant(
        grant_id="grant-1",
        surface_id="surface-1",
        source_frame_id="frame-1",
        source_frame_sha256="a" * 64,
        bounds_ltrb=(100, 200, 900, 800),
        target_lease={
            "schemaVersion": 1,
            "leaseId": "lease-1",
            "window": {"hwnd": 42, "processId": 314},
        },
        allowed_effects=(Effect.READ, Effect.REVERSIBLE_WRITE),
        expires_at=(datetime.now(UTC) + timedelta(minutes=1)).isoformat(),
    )


def test_windows_operator_observation_is_a_persisted_surface_only_capture(tmp_path: Path) -> None:
    capture = _Capture()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=capture,
        driver=_Driver(),
    )

    observation = backend.observe(_grant())

    image_path = Path(observation.image_ref)
    assert capture.bounds == [(100, 200, 900, 800)]
    assert image_path.is_file()
    assert observation.image_sha256 == hashlib.sha256(image_path.read_bytes()).hexdigest()
    assert (observation.width, observation.height) == (800, 600)
    assert observation.used_backend == "windows-native:test-capture"


def test_windows_operator_maps_normalized_click_inside_the_granted_window(tmp_path: Path) -> None:
    driver = _Driver()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    action = ComputerAction(
        action_id="click-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        start=(0.25, 0.5),
    )

    result = backend.execute(action, _grant())

    assert result.executed is True
    assert driver.calls == [("click", (300, 500), "left", 1)]
    assert result.data["screenPoint"] == [300, 500]


def test_windows_operator_refuses_pointer_or_keyboard_outside_granted_window(tmp_path: Path) -> None:
    driver = _Driver()
    driver.surface_hwnd = 99
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    click = ComputerAction(
        action_id="click-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        start=(0.5, 0.5),
    )

    pointer_result = backend.execute(click, _grant())
    driver.foreground_hwnd = 99
    typing_result = backend.execute(
        ComputerAction(
            action_id="type-1",
            kind=ComputerActionKind.TYPE_TEXT,
            effect=Effect.REVERSIBLE_WRITE,
            source_observation_id="source-1",
            source_image_sha256="a" * 64,
            text="hello",
        ),
        _grant(),
    )

    assert pointer_result.error == "pointer_target_outside_surface"
    assert typing_result.error == "foreground_target_outside_surface"
    assert driver.calls == []


def test_windows_operator_abort_releases_keys_held_by_an_operation(tmp_path: Path) -> None:
    driver = _Driver()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    action = ComputerAction(
        action_id="hold-1",
        kind=ComputerActionKind.KEY_DOWN,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        keys=("ctrl",),
    )

    assert backend.execute(action, _grant()).executed is True
    assert backend.abort("hold-1") is True
    assert driver.calls == [("down", "ctrl"), ("up", "ctrl")]


def test_windows_operator_propagates_cancellation_without_input(tmp_path: Path) -> None:
    driver = _Driver()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    token = CancellationToken()
    token.cancel()
    action = ComputerAction(
        action_id="cancelled-1",
        kind=ComputerActionKind.CLICK,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        start=(0.5, 0.5),
    )

    with pytest.raises(CancelledError):
        backend.execute(action, _grant(), scope=token)

    assert driver.calls == []


def test_windows_unicode_typing_maps_newline_and_tab_to_real_keys() -> None:
    driver = object.__new__(Win32InputDriver)
    batches = []
    driver._send = batches.append  # type: ignore[method-assign]

    driver.type_text("A\r\n\tB")

    entries = batches[0]
    assert [(entry.type, entry.ki.wVk, entry.ki.wScan, entry.ki.dwFlags) for entry in entries] == [
        (1, 0, ord("A"), 0x0004),
        (1, 0, ord("A"), 0x0006),
        (1, 0x0D, 0, 0),
        (1, 0x0D, 0, 0x0002),
        (1, 0x09, 0, 0),
        (1, 0x09, 0, 0x0002),
        (1, 0, ord("B"), 0x0004),
        (1, 0, ord("B"), 0x0006),
    ]


def test_windows_hotkey_attempts_to_release_every_key_after_release_error(
    tmp_path: Path,
) -> None:
    class FailingDriver(_Driver):
        def key_up(self, key):
            self.calls.append(("up", key))
            if key == "a":
                raise RuntimeError("release failed")

    driver = FailingDriver()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    action = ComputerAction(
        action_id="hotkey-1",
        kind=ComputerActionKind.HOTKEY,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        keys=("ctrl", "a"),
    )

    result = backend.execute(action, _grant())

    assert result.executed is False
    assert driver.calls == [
        ("down", "ctrl"),
        ("down", "a"),
        ("up", "a"),
        ("up", "ctrl"),
    ]


def test_windows_partial_key_down_failure_releases_pressed_keys(tmp_path: Path) -> None:
    class FailingDriver(_Driver):
        def key_down(self, key):
            self.calls.append(("down", key))
            if key == "a":
                raise RuntimeError("press failed")

    driver = FailingDriver()
    backend = WindowsComputerOperatorBackend(
        output_root=tmp_path,
        capture_provider=_Capture(),
        driver=driver,
    )
    action = ComputerAction(
        action_id="hold-1",
        kind=ComputerActionKind.KEY_DOWN,
        effect=Effect.REVERSIBLE_WRITE,
        source_observation_id="source-1",
        source_image_sha256="a" * 64,
        keys=("ctrl", "a"),
    )

    result = backend.execute(action, _grant())

    assert result.executed is False
    assert driver.calls == [("down", "ctrl"), ("down", "a"), ("up", "ctrl")]
    assert backend.abort("hold-1") is False
