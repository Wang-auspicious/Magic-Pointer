"""Explicit read-only Look acceptance on material B of the user's frozen frame.

This deliberately invokes Look to verify real model vision. It does not claim
that the OCR-covered end-to-end replay automatically required a vision call.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.ai_client import get_ai_config, get_ai_api_mode, request_ai_config  # noqa: E402
from app.agent_runtime.look_tool import LookTool  # noqa: E402
from app.agent_runtime.vision_backend import FileVisionBackend  # noqa: E402
from scripts.selection_bridge import _initial_task_context, _frozen_reference_resolver, _crop_frozen_frame_bytes  # noqa: E402


def main():
    out = ROOT / "data/runtime/selection-multisource-20260919"
    payload = json.loads((out / "request.json").read_text(encoding="utf8"))
    snapshot = payload["selectionSnapshot"]
    frame = Path(snapshot["capture_path"])
    _, updates, _, _ = _initial_task_context(
        "vision-acceptance", payload["command"], payload["selectionSessionId"],
        snapshot["source_window"], None, snapshot,
    )

    def crop(box):
        return _crop_frozen_frame_bytes(str(frame), box, snapshot["frame_lease"]["surfaceBoundsPx"])

    tool = LookTool(
        backend=FileVisionBackend().for_frozen_frame(frame, snapshot["captured_at"]),
        capture=crop, captured_at=snapshot["captured_at"],
        resolver=_frozen_reference_resolver(updates, snapshot),
    )
    credential, base_url, current_model = get_ai_config()
    model = current_model
    if "--replay-model" in sys.argv:
        model = json.loads((out / "runtime-result.json").read_text(encoding="utf8"))["model"]["model"]
    # A test-only request override preserves the user's currently selected model.
    with request_ai_config({"credential": credential, "baseUrl": base_url, "model": model,
                            "apiMode": get_ai_api_mode()}):
        evidence = tool.look(updates[1].binding.reference_id,
            prompt="识别这处圈选里的对象、文件名和所属应用。只描述冻结画面能看到的内容，不推测文件正文。")
    witness = {"model": model, "currentSelection": current_model,
               "status": evidence.status.value, "value": evidence.value,
               "note": evidence.note, "latencyMs": evidence.latency_ms}
    (out / f"vision-{model}-result.json").write_text(json.dumps(witness, ensure_ascii=False, indent=2), encoding="utf8")
    print(json.dumps(witness, ensure_ascii=False))


if __name__ == "__main__":
    main()
