"""CDP screenshot of a live page via Electron's remote-debugging port.

Usage: python scripts/cdp_shot.py <title-substring> <out.png>
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from urllib.request import urlopen

import websocket

BASE = "http://127.0.0.1:9222"


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else "Magic Pointer |"
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "data/runtime/cdp-shot.png")
    pages = json.load(urlopen(f"{BASE}/json", timeout=5))
    page = next((p for p in pages if target in p.get("title", "")), None)
    if page is None:
        print("page not found; available:", [p["title"] for p in pages])
        return 1
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
    ws.send(json.dumps({"id": 1, "method": "Page.enable"}))
    ws.recv()
    ws.send(json.dumps({
        "id": 2, "method": "Page.captureScreenshot",
        "params": {"format": "png", "captureBeyondViewport": False},
    }))
    deadline = 30
    while deadline > 0:
        try:
            msg = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:
            deadline -= 5
            continue
        if msg.get("id") == 2:
            data = msg.get("result", {}).get("data", "")
            if data:
                out.write_bytes(base64.b64decode(data))
                print(f"saved {out} ({len(data)} b64)")
                return 0
            print("empty screenshot; retrying")
            ws.send(json.dumps({
                "id": 3, "method": "Page.captureScreenshot",
                "params": {"format": "png"},
            }))
            deadline -= 5
            continue
        if "error" in msg:
            print("cdp error:", msg["error"])
            return 1
    print("timed out waiting for screenshot")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
