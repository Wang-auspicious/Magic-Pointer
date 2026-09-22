from __future__ import annotations

import sys

from _bridge_common import ensure_root_on_path

ensure_root_on_path()

from app.adapters.uia_text_adapter import (  # noqa: E402
    UIA_WINDOW_CLASSES,
    UiaTextSelectionAdapter,
    clipboard_fallback_forbidden,
    uia_app_from_window,
)


def main(argv: list[str]) -> int:
    adapter = UiaTextSelectionAdapter()
    for spec in argv:
        label, _, rest = spec.partition(":")
        class_name, _, raw_hwnd = rest.rpartition(":")
        window = {
            "hwnd": int(raw_hwnd),
            "pid": 0,
            "class_name": class_name,
            "title": label,
        }
        admitted = adapter.match_window(window)
        was_admitted = class_name in UIA_WINDOW_CLASSES
        no_ctrl_c, reason = clipboard_fallback_forbidden(window)
        change = (
            "NEWLY ADMITTED" if admitted and not was_admitted
            else "excluded" if not admitted
            else "unchanged"
        )
        print(
            f"{label:16s} class={class_name:34s} admitted={str(admitted):5s} "
            f"({change:14s}) app={uia_app_from_window(window):11s} "
            f"no_ctrl_c={str(no_ctrl_c):5s} {reason}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
