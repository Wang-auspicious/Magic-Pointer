"""CDP eval helper: run JS in a live Electron page.

Usage: python scripts/cdp_eval.py <title-substring> <js-expression>
"""
from __future__ import annotations

import json
import sys
from urllib.request import urlopen

import websocket

BASE = "http://127.0.0.1:9222"


def main() -> int:
    target = sys.argv[1]
    expression = sys.argv[2]
    pages = json.load(urlopen(f"{BASE}/json", timeout=5))
    page = next((p for p in pages if target in p.get("title", "")), None)
    if page is None:
        print("page not found:", [p["title"] for p in pages])
        return 1
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20)
    ws.send(json.dumps({
        "id": 1, "method": "Runtime.evaluate",
        "params": {"expression": expression, "returnByValue": True},
    }))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            result = msg.get("result", {})
            if "exceptionDetails" in result:
                print("EXC:", result["exceptionDetails"])
                return 1
            value = result.get("result", {}).get("value")
            if value is not None:
                print(value)
            return 0
        if "error" in msg:
            print("cdp error:", msg["error"])
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
