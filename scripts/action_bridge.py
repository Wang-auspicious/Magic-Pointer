from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.actions import ActionProposal
from app.action_guard.action_broker import ActionBroker
from app.actions.schema import ExecutionStatus
from app.context_pack.session import ContextSessionError, ContextSessionStore
from scripts._bridge_common import PayloadTooLargeError, read_bounded_json_payload


def _configure_stdio() -> None:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def read_payload() -> dict[str, Any]:
    return read_bounded_json_payload()


def _followup_proposals(result_output: dict[str, Any]) -> list[dict[str, Any]]:
    undo = result_output.get("undo_proposal")
    if isinstance(undo, dict):
        return [undo]
    return []


def _finish_runtime_context_after_success(
    proposal: ActionProposal,
    *,
    succeeded: bool,
    store: ContextSessionStore | None = None,
) -> bool:
    if not succeeded or proposal.action_type != "paste_text_to_foreground":
        return False
    workflow_kind = str(
        proposal.parameters.get("workflow_kind")
        or proposal.metadata.get("workflow_kind")
        or ""
    )
    session_id = str(proposal.parameters.get("context_session_id") or "")
    if workflow_kind != "runtime_issue" or not session_id:
        return False
    try:
        (store or ContextSessionStore()).finish(expected_session_id=session_id)
        return True
    except ContextSessionError:
        return False


def main() -> int:
    _configure_stdio()
    try:
        payload = read_payload()
    except PayloadTooLargeError as exc:
        print(json.dumps({
            "ok": False,
            "error": "payload_too_large",
            "maxPayloadBytes": exc.max_bytes,
        }, ensure_ascii=False))
        return 2
    proposal_data = payload.get("proposal")
    if not isinstance(proposal_data, dict):
        print(json.dumps({"ok": False, "error": "missing proposal"}, ensure_ascii=False))
        return 2
    try:
        proposal = ActionProposal.from_dict(proposal_data)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"invalid proposal: {type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 2
    task_id = str(
        payload.get("taskId")
        or payload.get("sessionId")
        or proposal.metadata.get("task_id")
        or proposal.metadata.get("taskId")
        or "action-bridge"
    )
    result = ActionBroker(task_id=task_id).execute(
        proposal,
        confirmed=payload.get("confirmed") is True,
    )
    completed = result.status == ExecutionStatus.SUCCEEDED
    accepted = result.status == ExecutionStatus.PENDING
    ok = completed or accepted
    context_session_finished = _finish_runtime_context_after_success(proposal, succeeded=completed)
    if accepted and proposal.action_type == "fabric_recipe_execute":
        receipt = result.output.get("fabric_receipt") if isinstance(result.output, dict) else {}
        task = (receipt or {}).get("output") if isinstance(receipt, dict) else {}
        task = task if isinstance(task, dict) else {}
        task_id = str(task.get("taskId") or "")
        provider = str(task.get("provider") or (receipt or {}).get("provider") or "Agent")
        answer = f"已交给 {provider}，任务 {task_id} 正在运行，尚未完成。"
    elif completed:
        if proposal.action_type == "copy_text_to_clipboard":
            answer = "Copied to clipboard."
        elif proposal.action_type == "office_replace_selection":
            answer = "文档选区已替换。之后即使继续编辑，也可以通过下方动作尝试精确恢复这一次修改。"
        elif proposal.action_type == "office_undo_last_action":
            answer = "已精确恢复这一次 Magic Pointer 文档修改。"
        elif proposal.action_type == "shopping_list_add":
            answer = "已加入购物清单。"
        elif proposal.action_type == "shopping_list_set_checked":
            answer = "购物清单状态已更新。"
        elif proposal.action_type == "shopping_list_undo_add":
            answer = "已撤销这次购物清单添加。"
        elif proposal.action_type == "calendar_event_create":
            answer = "本地日历事件已创建并验证。"
        elif proposal.action_type == "calendar_event_undo_create":
            answer = "已撤销这次本地日历创建。"
        elif proposal.action_type == "paste_text_to_foreground":
            answer = "草稿已完整填入目标输入框，未发送；请检查后由你点击发送。"
        elif proposal.action_type == "fabric_recipe_execute":
            receipt = result.output.get("fabric_receipt") if isinstance(result.output, dict) else {}
            recipe_id = str((receipt or {}).get("recipeId") or proposal.metadata.get("recipe_id") or "")
            answer = f"Recipe 已完成并验证：{recipe_id}"
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
        "contextSessionFinished": context_session_finished,
        "actionProposals": _followup_proposals(result.output) if ok else [],
    }, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
