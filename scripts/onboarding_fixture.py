from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def write_ready_onboarding_marker(runtime: Path) -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    manifest_path = ROOT / "data" / "preflight_manifest.v1.json"
    marker = {
        "schemaVersion": 2,
        "status": "ready",
        "bootstrapVersion": 1,
        "productVersion": str(package["version"]),
        "manifestDigest": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }
    (runtime / "onboarding.json").write_text(
        json.dumps(marker, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
