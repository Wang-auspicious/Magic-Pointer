"""Compile and run the read-only UIA tree dump against a live window.

    python scripts/uia_tree_dump.py --title-contains 微信 --all

Reuses the same csc discovery and assembly references as the production probe, so
what this tool can see is exactly what the probe could see if it chose to.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.adapters.uia_text_adapter import (  # noqa: E402
    UIA_REFERENCE_NAMES,
    _find_csc,
    _find_uia_reference,
)
from app.system_context import list_visible_windows  # noqa: E402

SOURCE = ROOT / "scripts" / "uia_tree_dump.cs"
EXE = ROOT / "data" / "runtime" / "uia_tree_dump.exe"


def build() -> None:
    if EXE.exists() and EXE.stat().st_mtime_ns >= SOURCE.stat().st_mtime_ns:
        return
    csc = _find_csc()
    if csc is None:
        raise SystemExit("no C# compiler found")
    references = []
    for name in UIA_REFERENCE_NAMES:
        reference = _find_uia_reference(name)
        if reference is None:
            raise SystemExit(f"missing UIA reference: {name}")
        references.append(reference)
    EXE.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(csc), "/nologo", "/target:exe", "/optimize+", f"/out:{EXE}",
        *(f"/reference:{reference}" for reference in references),
        str(SOURCE),
    ]
    proc = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if proc.returncode != 0:
        raise SystemExit(f"compile failed:\n{proc.stdout}\n{proc.stderr}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title-contains", required=True)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--all", action="store_true", help="include nodes with no text")
    parser.add_argument("--max-nodes", type=int, default=4000)
    parser.add_argument("--region", nargs=4, type=int, default=None, metavar=("X", "Y", "W", "H"))
    args = parser.parse_args()

    build()
    needle = args.title_contains.casefold()
    matches = [w for w in list_visible_windows() if needle in str(w.get("title") or "").casefold()]
    if len(matches) <= args.index:
        print(f"only {len(matches)} window(s) matched {args.title_contains!r}")
        for w in list_visible_windows()[:20]:
            print("   ", repr(w.get("title"))[:60], w.get("bbox"))
        return 2
    target = matches[args.index]
    print(f"window: {target.get('title')!r} hwnd={target.get('hwnd')} bbox={target.get('bbox')} class={target.get('class_name')}")

    argv = [str(EXE), str(int(target.get("hwnd") or 0)), "--max-nodes", str(args.max_nodes)]
    if args.all:
        argv.append("--all")
    if args.region:
        argv.extend(["--region", *[str(v) for v in args.region]])
    proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    print(proc.stdout)
    if proc.stderr.strip():
        print("stderr:", proc.stderr[:2000], file=sys.stderr)
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
