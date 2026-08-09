from pathlib import Path


def test_macos_host_exposes_accessibility_screen_capture_and_pointer_stream() -> None:
    source = Path("native/macos/MagicPointerHost.swift").read_text(encoding="utf-8")
    readme = Path("native/macos/README.md").read_text(encoding="utf-8")
    assert "AXIsProcessTrustedWithOptions" in source
    assert "CGPreflightScreenCaptureAccess" in source
    assert "NSEvent.mouseLocation" in source
    assert "frontmostApplication" in source
    assert "scrollDelta" in source
    assert "JSONEncoder" in source
    assert "--check-permissions" in source
    assert "swiftc" in readme
    assert "未在 macOS 实机验证" in readme
    main = Path("electron/main.ts").read_text(encoding="utf-8")
    assert "process.platform === 'darwin'" in main
    assert "MAGIC_POINTER_MACOS_HOST" in main
    assert "magic-pointer-host" in main
