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
from app.actions.schema import ExecutionStatus


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
    return json.loads(raw) if raw else {}


def _followup_proposals(result_output: dict[str, Any]) -> list[dict[str, Any]]:
    undo = result_output.get("undo_proposal")
    if isinstance(undo, dict):
        return [undo]
    return []


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
    ok = result.status == ExecutionStatus.SUCCEEDED
    if ok:
        if proposal.action_type == "copy_text_to_clipboard":
            answer = "Copied to clipboard."
        elif proposal.action_type == "office_replace_selection":
            answer = "文档选区已替换。之后即使继续编辑，也可以通过下方动作尝试精确恢复这一次修改。"
        elif proposal.action_type == "office_undo_last_action":
            answer = "已精确恢复这一次 Magic Pointer 文档修改。"
        else:
            answer = "Action completed."
    else:
        answer = result.error or "Action was not executed."
    output = result.to_dict()
    print(json.dumps({
        "ok": ok,
        "prompt": "Action result",
        "answer": answer,
        "executionResult": output,
        "actionProposals": _followup_proposals(result.output) if ok else [],
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
