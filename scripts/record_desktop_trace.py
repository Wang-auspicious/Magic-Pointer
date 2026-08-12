"""Record a DesktopTrace fixture from a real desktop interaction.

By default nothing is captured from the screen; ``--capture`` grabs the full
virtual desktop with Pillow ImageGrab. Ctrl+C finishes the trace with whatever
was recorded so far.

    python scripts/record_desktop_trace.py --out-dir data/runtime/trace-demo --capture
"""

from __future__ import annotations

import argparse
import ctypes
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.replay.recorder import DesktopTraceRecorder  # noqa: E402
from app.replay.replayer import ReplayHarness  # noqa: E402

_SM_XVIRTUALSCREEN = 76
_SM_YVIRTUALSCREEN = 77
_SM_CXVIRTUALSCREEN = 78
_SM_CYVIRTUALSCREEN = 79


def virtual_screen_origin() -> tuple[int, int]:
    user32 = ctypes.windll.user32
    return (
        int(user32.GetSystemMetrics(_SM_XVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(_SM_YVIRTUALSCREEN)),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", required=True, type=Path, help="directory to write the trace into")
    parser.add_argument(
        "--capture",
        action="store_true",
        help="grab the full virtual desktop with Pillow ImageGrab (off by default)",
    )
    parser.add_argument("--interval", type=float, default=1.0, help="seconds between captures with --capture")
    args = parser.parse_args(argv)

    out_dir = args.out_dir
    recorder = DesktopTraceRecorder()
    recorder.begin(out_dir)
    print(f"trace started: {recorder.started_at_utc}")
    print(f"out-dir:       {out_dir}")
    print(f"capture:       {'on (full virtual desktop)' if args.capture else 'off (no frames)'}")
    print("Ctrl+C to stop and write trace.json")

    frame_count = 0
    try:
        if args.capture:
            from PIL import ImageGrab

            origin_x, origin_y = virtual_screen_origin()
            while True:
                image = ImageGrab.grab(all_screens=True)
                region = (origin_x, origin_y, origin_x + image.width, origin_y + image.height)
                recorder.capture_frame(backend=lambda bbox: image, region=region)
                frame_count += 1
                print(f"  captured frame {frame_count}", flush=True)
                time.sleep(args.interval)
        else:
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass

    trace = recorder.finish()
    harness = ReplayHarness.load(out_dir)
    print(f"trace finished: {recorder.clock()}")
    print(f"trace.json:     {out_dir / 'trace.json'}")
    print(f"summary:        {harness.stats()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
