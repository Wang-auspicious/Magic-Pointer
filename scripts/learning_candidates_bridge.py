"""Local review/apply boundary for Hermes-style learning candidates.

The background reviewer can only propose. This bridge is deliberately not an
Agent tool: mutations require an explicit UI/CLI request carrying
``userApproved: true`` and are revalidated by ``LearningCandidateStore``.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.self_evolution.candidates import LearningCandidateStore  # noqa: E402

_STATUSES = {"pending", "applied", "rejected", "rolled_back"}


def _summary(candidate) -> dict[str, Any]:
    value = asdict(candidate)
    value.pop("original_content", None)
    value.pop("proposed_content", None)
    value["originalChars"] = len(candidate.original_content)
    value["proposedChars"] = len(candidate.proposed_content)
    return value


def _require_approval(payload: dict[str, Any]) -> None:
    if payload.get("userApproved") is not True:
        raise PermissionError("explicit user approval is required")


def handle_request(
    payload: dict[str, Any], *, user_root: Path | str
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("request must be an object")
    action = str(payload.get("action") or "list").strip().casefold()
    store = LearningCandidateStore(user_root)

    if action == "list":
        raw_status = payload.get("status")
        status = str(raw_status).strip().casefold() if raw_status else None
        if status is not None and status not in _STATUSES:
            raise ValueError("invalid candidate status")
        candidates = store.list(status=status)
        return {"ok": True, "candidates": [_summary(item) for item in candidates]}

    candidate_id = str(payload.get("candidateId") or "").strip().casefold()
    if not candidate_id:
        raise ValueError("candidateId is required")
    if action == "get":
        candidate = store.get(candidate_id)
        return {
            "ok": True,
            "candidate": asdict(candidate),
            "diff": store.diff(candidate_id),
        }
    if action == "apply":
        _require_approval(payload)
        candidate = store.apply(candidate_id, approved_by="user")
    elif action == "reject":
        _require_approval(payload)
        candidate = store.reject(
            candidate_id,
            approved_by="user",
            reason=str(payload.get("reason") or ""),
        )
    elif action == "rollback":
        _require_approval(payload)
        candidate = store.rollback(candidate_id, approved_by="user")
    else:
        raise ValueError(f"unknown candidate action {action!r}")
    return {"ok": True, "candidate": _summary(candidate)}


def main() -> int:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8-sig")
        payload = json.loads(raw or "{}")
        user_root = Path(
            os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
            or ROOT / "data" / "runtime"
        )
        result = handle_request(payload, user_root=user_root)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # local bridge boundary
        print(json.dumps({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
