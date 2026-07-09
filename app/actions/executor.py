from __future__ import annotations

import base64
from datetime import datetime
from typing import Any

from app.actions.history import ActionHistoryRecord, ActionHistoryStore, make_word_undo_proposal, new_history_id, excerpt
from app.actions.office import text_sha256
from app.actions.policy import LocalPermissionPolicy
from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus
from app.adapters.office_adapter import _run_powershell_json

JsonDict = dict[str, Any]

SUPPORTED_ACTION_TYPES = {
    "copy_text_to_clipboard",
    "office_replace_selection",
    "office_undo_last_action",
}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _b64_utf16le(value: str | None) -> str:
    return base64.b64encode((value or "").encode("utf-16le", errors="surrogatepass")).decode("ascii")


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


def _ps_literal_string(value: str | None) -> str:
    # Single-quoted PowerShell literal. Only used for hashes/ids, not model text.
    return "'" + str(value or "").replace("'", "''") + "'"


class SafeActionExecutor:
    '''Typed execution layer with policy, precondition, and history checks.

    The model can propose actions, but it cannot execute arbitrary text. Every
    write action is a named verb, requires explicit confirmation, and is verified
    against live application state before mutation.
    '''

    def __init__(self, *, policy: LocalPermissionPolicy | None = None, history_store: ActionHistoryStore | None = None) -> None:
        self.policy = policy or LocalPermissionPolicy()
        self.history_store = history_store or ActionHistoryStore()

    def preview(self, proposal: ActionProposal) -> JsonDict:
        decision = self.policy.decide(proposal)
        return {
            "proposal_id": proposal.id,
            "action_type": proposal.action_type,
            "needs_confirmation": decision.requires_confirmation,
            "target": None if proposal.target is None else proposal.target.to_dict(),
            "parameters": dict(proposal.parameters),
            "rationale": proposal.rationale,
            "policy_decision": decision.to_dict(),
        }

    def _result(
        self,
        proposal: ActionProposal,
        started: str,
        status: ExecutionStatus,
        *,
        confirmed: bool,
        output: JsonDict | None = None,
        error: str | None = None,
        metadata: JsonDict | None = None,
    ) -> ExecutionResult:
        return ExecutionResult(
            proposal_id=proposal.id,
            action_type=proposal.action_type,
            status=status,
            output=output or {},
            error=error,
            started_at=started,
            finished_at=now_iso(),
            confirmed_by_user=confirmed,
            metadata=metadata or {},
        )

    def execute(self, proposal: ActionProposal, *, confirmed: bool = False) -> ExecutionResult:
        started = now_iso()
        decision = self.policy.decide(proposal)
        metadata = {"policy_decision": decision.to_dict()}
        if proposal.action_type not in SUPPORTED_ACTION_TYPES:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=f"unsupported action_type: {proposal.action_type}",
                metadata=metadata,
            )
        if not decision.allowed:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=decision.reason,
                metadata=metadata,
            )
        if decision.requires_confirmation and not confirmed:
            return self._result(
                proposal,
                started,
                ExecutionStatus.SKIPPED,
                confirmed=False,
                error="confirmation required",
                metadata=metadata,
            )

        if proposal.action_type == "copy_text_to_clipboard":
            return self._copy_text_to_clipboard(proposal, started, confirmed=confirmed, metadata=metadata)
        if proposal.action_type == "office_replace_selection":
            return self._office_replace_selection(proposal, started, confirmed=confirmed, metadata=metadata)
        if proposal.action_type == "office_undo_last_action":
            return self._office_undo_last_action(proposal, started, confirmed=confirmed, metadata=metadata)
        return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="unreachable action dispatch", metadata=metadata)

    def _copy_text_to_clipboard(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        text = str(proposal.parameters.get("text") or "")
        try:
            import pyperclip

            pyperclip.copy(text)
            return self._result(
                proposal,
                started,
                ExecutionStatus.SUCCEEDED,
                confirmed=confirmed,
                output={"copied_chars": len(text)},
                metadata=metadata,
            )
        except Exception as exc:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=f"clipboard copy failed: {type(exc).__name__}: {exc}",
                metadata=metadata,
            )

    def _office_replace_selection(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        replacement = str(params.get("replacement_text") or "")
        if not replacement:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="replacement_text is empty", metadata=metadata)

        expected_hash = str(params.get("expected_text_sha256") or "")
        expected_doc = str(params.get("document") or "")
        expected_start = _optional_int(params.get("selection_start"))
        expected_end = _optional_int(params.get("selection_end"))
        replacement_hash = text_sha256(replacement)
        if params.get("replacement_text_sha256") and str(params.get("replacement_text_sha256")) != replacement_hash:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="replacement_text hash mismatch", metadata=metadata)

        script = f'''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function FromB64Utf16([string]$Value) {{ if ([string]::IsNullOrEmpty($Value)) {{ return "" }}; return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Value)) }}
function Sha256Text([string]$Value) {{ $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value); $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes); return (($hash | ForEach-Object {{ $_.ToString("x2") }}) -join "") }}
$replacement = FromB64Utf16 "{_b64_utf16le(replacement)}"
$expectedDoc = FromB64Utf16 "{_b64_utf16le(expected_doc)}"
$expectedHash = {_ps_literal_string(expected_hash)}
$expectedStart = {('$null' if expected_start is None else str(expected_start))}
$expectedEnd = {('$null' if expected_end is None else str(expected_end))}
$result = [ordered]@{{ ok=$false; app="word"; method="com:word.selection.replace"; document=$null; hwnd=$null; selection_start=$null; selection_end=$null; before_text=$null; before_sha256=$null; after_sha256=$null; replacement_chars=$replacement.Length; error=$null }}
try {{
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
  try {{ if ($word.ActiveWindow) {{ $result.hwnd = [int64]$word.ActiveWindow.Hwnd }} }} catch {{}}
  if (-not $word.ActiveDocument) {{ throw "No active Word document" }}
  $result.document = [string]$word.ActiveDocument.FullName
  if ($expectedDoc -and $result.document -ne $expectedDoc) {{ throw "Active Word document changed before execution" }}
  $sel = $word.Selection
  if ($null -eq $sel) {{ throw "No Word selection" }}
  $result.selection_start = [int]$sel.Start
  $result.selection_end = [int]$sel.End
  $before = [string]$sel.Text
  $result.before_text = $before
  $result.before_sha256 = Sha256Text $before
  if ($expectedHash -and $result.before_sha256 -ne $expectedHash) {{ throw "Word selection text changed before execution" }}
  if ($null -ne $expectedStart -and [int]$sel.Start -ne [int]$expectedStart) {{ throw "Word selection start changed before execution" }}
  if ($null -ne $expectedEnd -and [int]$sel.End -ne [int]$expectedEnd) {{ throw "Word selection end changed before execution" }}
  $undoRecord = $null
  $undoStarted = $false
  try {{ $undoRecord = $word.Application.UndoRecord; if ($null -ne $undoRecord) {{ $undoRecord.StartCustomRecord("Magic Pointer Replace Selection"); $undoStarted = $true }} }} catch {{}}
  try {{
    $sel.Text = $replacement
  }} finally {{
    if ($undoStarted -and $null -ne $undoRecord) {{ try {{ $undoRecord.EndCustomRecord() }} catch {{}} }}
  }}
  $result.after_sha256 = Sha256Text $replacement
  $result.ok = $true
}} catch {{
  $result.error = $_.Exception.Message
}}
$result | ConvertTo-Json -Depth 8 -Compress
'''
        probe = _run_powershell_json(script, timeout=10)
        if not probe.ok:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=probe.error, metadata=metadata)
        data = probe.data
        if not data.get("ok"):
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=str(data.get("error") or "Word replace failed"),
                output={k: data.get(k) for k in ("document", "selection_start", "selection_end", "before_sha256")},
                metadata=metadata,
            )

        before_text = str(data.get("before_text") or "")
        record = ActionHistoryRecord(
            id=new_history_id(),
            action_type=proposal.action_type,
            app="word",
            proposal_id=proposal.id,
            document=str(data.get("document") or expected_doc or "") or None,
            target_label=(proposal.target.description if proposal.target else None),
            before_sha256=str(data.get("before_sha256") or expected_hash or "") or None,
            after_sha256=str(data.get("after_sha256") or replacement_hash),
            before_excerpt=excerpt(before_text),
            after_excerpt=excerpt(replacement),
            selection_start=_optional_int(data.get("selection_start")),
            selection_end=_optional_int(data.get("selection_end")),
            metadata={"method": data.get("method"), "hwnd": data.get("hwnd"), "command": params.get("command")},
        )
        self.history_store.append(record)
        undo_proposal = make_word_undo_proposal(record)
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED,
            confirmed=confirmed,
            output={
                "history_id": record.id,
                "document": record.document,
                "before_sha256": record.before_sha256,
                "after_sha256": record.after_sha256,
                "replacement_chars": len(replacement),
                "undo_proposal": undo_proposal.to_dict(),
            },
            metadata=metadata,
        )

    def _office_undo_last_action(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        history_id = str(params.get("history_id") or "")
        record = self.history_store.get(history_id) if history_id else self.history_store.recent_undoable(app="word")
        if record is None:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="No undoable Magic Pointer Word action was found", metadata=metadata)
        if not record.is_undoable:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="That Magic Pointer action is not undoable", metadata=metadata)

        expected_doc = record.document or str(params.get("document") or "")
        script = f'''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function FromB64Utf16([string]$Value) {{ if ([string]::IsNullOrEmpty($Value)) {{ return "" }}; return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Value)) }}
$expectedDoc = FromB64Utf16 "{_b64_utf16le(expected_doc)}"
$result = [ordered]@{{ ok=$false; app="word"; method="com:word.application.undo"; document=$null; error=$null }}
try {{
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
  if (-not $word.ActiveDocument) {{ throw "No active Word document" }}
  $result.document = [string]$word.ActiveDocument.FullName
  if ($expectedDoc -and $result.document -ne $expectedDoc) {{ throw "Active Word document changed before undo" }}
  try {{ [void]$word.Undo(1) }} catch {{ [void]$word.Undo() }}
  $result.ok = $true
}} catch {{
  $result.error = $_.Exception.Message
}}
$result | ConvertTo-Json -Depth 6 -Compress
'''
        probe = _run_powershell_json(script, timeout=10)
        if not probe.ok:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=probe.error, metadata=metadata)
        data = probe.data
        if not data.get("ok"):
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(data.get("error") or "Word undo failed"), metadata=metadata)
        updated = self.history_store.mark_undone(record.id)
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED,
            confirmed=confirmed,
            output={"history_id": record.id, "document": record.document, "undone_at": None if updated is None else updated.undone_at},
            metadata=metadata,
        )
