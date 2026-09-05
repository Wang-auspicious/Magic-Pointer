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
from app.action_guard.undo_log import UndoEmptyError, UndoFailedError, UndoNotFoundError
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


def _task_id(payload: dict[str, Any], proposal: ActionProposal | None = None) -> str:
    metadata = proposal.metadata if proposal is not None else {}
    return str(
        payload.get("taskId")
        or payload.get("sessionId")
        or metadata.get("task_id")
        or metadata.get("taskId")
        or "action-bridge"
    )


def process_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Execute one action or one durable compensation request."""
    if payload.get("operation") == "undo":
        action_id = str(payload.get("actionId") or payload.get("action_id") or "").strip() or None
        broker = ActionBroker(task_id=_task_id(payload))
        try:
            compensation = broker.undo(action_id)
        except (UndoEmptyError, UndoNotFoundError, UndoFailedError) as exc:
            return {"ok": False, "prompt": "Undo result", "error": str(exc)}, 1
        return {
            "ok": True,
            "prompt": "Undo result",
            "answer": f"已撤销 {compensation.tool_name}。",
            "undoneActionId": compensation.action_id,
        }, 0

    proposal_data = payload.get("proposal")
    if not isinstance(proposal_data, dict):
        return {"ok": False, "error": "missing proposal"}, 2
    try:
        proposal = ActionProposal.from_dict(proposal_data)
    except Exception as exc:
        return {"ok": False, "error": f"invalid proposal: {type(exc).__name__}: {exc}"}, 2
    result = ActionBroker(task_id=_task_id(payload, proposal)).execute(
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
        answers = {
            "copy_text_to_clipboard": "Copied to clipboard.",
            "office_replace_selection": "文档选区已替换。之后即使继续编辑，也可以通过下方动作尝试精确恢复这一次修改。",
            "office_undo_last_action": "已精确恢复这一次 Magic Pointer 文档修改。",
            "shopping_list_add": "已加入购物清单。",
            "shopping_list_set_checked": "购物清单状态已更新。",
            "shopping_list_undo_add": "已撤销这次购物清单添加。",
            "calendar_event_create": "本地日历事件已创建并验证。",
            "calendar_event_undo_create": "已撤销这次本地日历创建。",
            "paste_text_to_foreground": "草稿已完整填入目标输入框，未发送；请检查后由你点击发送。",
        }
        answer = answers.get(proposal.action_type, "Action completed.")
        if proposal.action_type == "fabric_recipe_execute":
            receipt = result.output.get("fabric_receipt") if isinstance(result.output, dict) else {}
            recipe_id = str((receipt or {}).get("recipeId") or proposal.metadata.get("recipe_id") or "")
            answer = f"Recipe 已完成并验证：{recipe_id}"
    else:
        answer = result.error or "Action was not executed."
    output = result.to_dict()
    undo_raw = result.output.get("undo_proposal") if isinstance(result.output, dict) else None
    return {
        "ok": ok,
        "prompt": "Action result",
        "answer": answer,
        "executionResult": output,
        "taskId": _task_id(payload, proposal),
        "actions": ([{
            "id": str(result.proposal_id),
            "kind": "undo",
            "label": "撤销这一步",
            "actionId": str(result.proposal_id),
            "taskId": _task_id(payload, proposal),
        }] if completed and isinstance(undo_raw, dict) else []),
        "contextSessionFinished": context_session_finished,
        "actionProposals": _followup_proposals(result.output) if ok else [],
    }, 0 if ok else 1


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
    output, exit_code = process_payload(payload)
    print(json.dumps(output, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
