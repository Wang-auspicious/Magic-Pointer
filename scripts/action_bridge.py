from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions import ActionProposal
from app.actions.executor import SafeActionExecutor


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    return json.loads(raw) if raw else {}


def main() -> int:
    payload = read_payload()
    proposal_data = payload.get("proposal")
    if not isinstance(proposal_data, dict):
        print(json.dumps({"ok": False, "error": "missing proposal"}, ensure_ascii=False))
        return 2
    try:
        proposal = ActionProposal.from_dict(proposal_data)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"invalid proposal: {type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 2
    result = SafeActionExecutor().execute(proposal, confirmed=bool(payload.get("confirmed")))
    ok = result.status.value == "succeeded"
    if ok:
        if proposal.action_type == "copy_text_to_clipboard":
            answer = "Copied to clipboard."
        else:
            answer = "Action completed."
    else:
        answer = result.error or "Action was not executed."
    print(json.dumps({
        "ok": ok,
        "prompt": "Action result",
        "answer": answer,
        "executionResult": result.to_dict(),
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
