from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_episode_locations_to_allowlisted_google_maps_url(tmp_path: Path) -> None:
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat()
    payload = {
        "command": "规划路线",
        "selectionSessionId": "session-route-e2e",
        "selectionSnapshot": {
            "snapshot_id": "snapshot-route-e2e",
            "expires_at": expires_at,
            "source_window": {"title": "地点 B.pdf", "hwnd": 123},
            "context": {
                "adapter": "uia_text_selection",
                "app": "pdf",
                "window": {"title": "地点 B.pdf", "hwnd": 123},
                "content": "上海虹桥站",
                "label": "地点 B.pdf",
                "method": "uia:text-pattern.selection",
                "capabilities": [],
                "artifacts": {},
                "error": None,
            },
        },
        "interactionEpisode": {
            "episodeId": "episode-route-e2e",
            "slots": {
                "that": {"objectId": "selection:a", "content": "上海博物馆", "app": "browser"},
                "this": {"objectId": "selection:b", "content": "上海虹桥站", "app": "pdf"},
                "these": [],
            },
        },
    }
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    selected = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "selection_bridge.py")],
        cwd=ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        encoding="utf-8",
        capture_output=True,
        env=env,
        check=False,
    )
    assert selected.returncode == 0
    response = json.loads(selected.stdout.strip())
    assert response["intentKind"] == "route_draft"
    assert response["actionProposals"] == []
    draft = response["routeDraft"]

    node_script = (
        "const p=require('./electron/route_policy');"
        "const x=JSON.parse(process.argv[1]);"
        "const u=p.buildGoogleMapsDirectionsUrl(x);"
        "process.stdout.write(JSON.stringify({url:u,allowed:p.isAllowedGoogleMapsDirectionsUrl(u)}));"
    )
    built = subprocess.run(
        ["node", "-e", node_script, json.dumps({
            "origin": draft["origin"],
            "destination": draft["destination"],
            "travelMode": "transit",
        }, ensure_ascii=False)],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    assert built.returncode == 0
    result = json.loads(built.stdout)
    assert result["allowed"] is True
    assert "api=1" in result["url"]
    assert "%E4%B8%8A%E6%B5%B7" in result["url"]
