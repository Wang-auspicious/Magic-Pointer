from __future__ import annotations

from datetime import datetime
from typing import Any

from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus

JsonDict = dict[str, Any]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class SafeActionExecutor:
    """Tiny execution layer with hard confirmation checks.

    This is deliberately conservative: only clipboard copy is implemented now.
    UIA/DOM/nut.js commands should be added here as typed commands, never by
    executing raw model text.
    """

    def preview(self, proposal: ActionProposal) -> JsonDict:
        return {
            "proposal_id": proposal.id,
            "action_type": proposal.action_type,
            "needs_confirmation": proposal.needs_confirmation(),
            "target": None if proposal.target is None else proposal.target.to_dict(),
            "parameters": dict(proposal.parameters),
            "rationale": proposal.rationale,
        }

    def execute(self, proposal: ActionProposal, *, confirmed: bool = False) -> ExecutionResult:
        started = now_iso()
        if proposal.needs_confirmation() and not confirmed:
            return ExecutionResult(
                proposal_id=proposal.id,
                action_type=proposal.action_type,
                status=ExecutionStatus.SKIPPED,
                error="confirmation required",
                started_at=started,
                finished_at=now_iso(),
                confirmed_by_user=False,
            )
        if proposal.action_type != "copy_text_to_clipboard":
            return ExecutionResult(
                proposal_id=proposal.id,
                action_type=proposal.action_type,
                status=ExecutionStatus.FAILED,
                error=f"unsupported action_type: {proposal.action_type}",
                started_at=started,
                finished_at=now_iso(),
                confirmed_by_user=confirmed,
            )
        text = str(proposal.parameters.get("text") or "")
        try:
            import pyperclip

            pyperclip.copy(text)
            return ExecutionResult(
                proposal_id=proposal.id,
                action_type=proposal.action_type,
                status=ExecutionStatus.SUCCEEDED,
                output={"copied_chars": len(text)},
                started_at=started,
                finished_at=now_iso(),
                confirmed_by_user=confirmed,
            )
        except Exception as exc:
            return ExecutionResult(
                proposal_id=proposal.id,
                action_type=proposal.action_type,
                status=ExecutionStatus.FAILED,
                error=f"clipboard copy failed: {type(exc).__name__}: {exc}",
                started_at=started,
                finished_at=now_iso(),
                confirmed_by_user=confirmed,
            )
