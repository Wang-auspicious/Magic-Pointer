from __future__ import annotations

import base64
import hashlib
import uuid
from dataclasses import replace
from datetime import datetime
from typing import Any

from app.actions.history import ActionHistoryRecord, ActionHistoryStore, make_word_undo_proposal, new_history_id, excerpt
from app.actions.office import text_sha256
from app.actions.shopping_list import make_shopping_list_undo_proposal
from app.actions.calendar import make_calendar_undo_proposal
from app.actions.draft_writer import write_draft_to_target
from app.actions.policy import LocalPermissionPolicy
from app.actions.schema import ActionProposal, ExecutionResult, ExecutionStatus, SafetyLevel
from app.action_guard.approval import ActionApproval, ApprovalError
from app.action_guard.undo_log import Compensation, UndoLog
from app.agent_runtime.tool_registry import Effect
from app.adapters.office_adapter import ALLOWED_WORD_COM_PROG_IDS, WORD_COM_PROG_ID, _run_powershell_json
from app.dashboard.shopping_list import ShoppingListError, ShoppingListStore
from app.dashboard.calendar import CalendarConflict, CalendarError, CalendarEventStore

JsonDict = dict[str, Any]

_ACTION_DISPATCH = {}


def _register(action_type: str):
    """Decorator: register a private handler method for an action type."""
    def decorate(fn):
        _ACTION_DISPATCH[action_type] = fn
        return fn
    return decorate


SUPPORTED_ACTION_TYPES = frozenset({
    "copy_text_to_clipboard",
    "office_replace_selection",
    "office_undo_last_action",
    "shopping_list_add",
    "shopping_list_add_many",
    "shopping_list_set_checked",
    "shopping_list_undo_add",
    "calendar_event_create",
    "calendar_event_undo_create",
    "paste_text_to_foreground",
    "fabric_recipe_execute",
    "document_patch_operation",
})


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


def _word_com_prog_id(value: Any) -> str:
    prog_id = str(value or WORD_COM_PROG_ID)
    return prog_id if prog_id in ALLOWED_WORD_COM_PROG_IDS else WORD_COM_PROG_ID


class SafeActionExecutor:
    """Typed execution layer with policy, precondition, and history checks."""

    def __init__(
        self,
        *,
        policy: LocalPermissionPolicy | None = None,
        history_store: ActionHistoryStore | None = None,
        shopping_list_store: ShoppingListStore | None = None,
        calendar_event_store: CalendarEventStore | None = None,
        draft_writer: Any | None = None,
        artifact_revision_probe: Any | None = None,
        document_operation_executor: Any | None = None,
        fabric_engine: Any | None = None,
        approval_ledger: ActionApproval | None = None,
        undo_log: UndoLog | None = None,
    ) -> None:
        self.policy = policy or LocalPermissionPolicy()
        self.history_store = history_store or ActionHistoryStore()
        self.shopping_list_store = shopping_list_store or ShoppingListStore()
        self.calendar_event_store = calendar_event_store or CalendarEventStore()
        self.draft_writer = draft_writer or write_draft_to_target
        self.artifact_revision_probe = artifact_revision_probe
        self.document_operation_executor = document_operation_executor
        self.fabric_engine = fabric_engine
        # One ledger can be shared by the Runtime and GUI action bridges.  A
        # local default keeps old embedders compatible while still recording
        # every proposal that reaches this execution seam.
        self.approval_ledger = approval_ledger or ActionApproval()
        self.undo_log = undo_log or UndoLog()

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
        # Confirmation is a trust-boundary bit, not a truthy option. Strings
        # such as "false" must never authorize an action.
        confirmed = confirmed is True
        started = now_iso()
        decision = self.policy.decide(proposal)
        metadata = {"policy_decision": decision.to_dict()}
        approval_request = self._record_approval_request(proposal, confirmed)
        if approval_request is not None:
            metadata["approval_request_id"] = approval_request.request_id
        if proposal.action_type not in SUPPORTED_ACTION_TYPES:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=f"unsupported action_type: {proposal.action_type}", metadata=metadata)
        if not decision.allowed:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=decision.reason, metadata=metadata)
        if decision.requires_confirmation and not confirmed:
            return self._result(proposal, started, ExecutionStatus.SKIPPED, confirmed=False, error="confirmation required", metadata=metadata)

        if proposal.action_type == "copy_text_to_clipboard":
            return self._finalize_execution(self._copy_text_to_clipboard(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "office_replace_selection":
            return self._finalize_execution(self._office_replace_selection(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "office_undo_last_action":
            return self._finalize_execution(self._office_undo_last_action(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "shopping_list_add":
            return self._finalize_execution(self._shopping_list_add(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "shopping_list_add_many":
            return self._finalize_execution(self._shopping_list_add_many(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "shopping_list_set_checked":
            return self._finalize_execution(self._shopping_list_set_checked(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "shopping_list_undo_add":
            return self._finalize_execution(self._shopping_list_undo_add(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "calendar_event_create":
            return self._finalize_execution(self._calendar_event_create(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "calendar_event_undo_create":
            return self._finalize_execution(self._calendar_event_undo_create(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "paste_text_to_foreground":
            return self._finalize_execution(self._paste_text_to_foreground(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "fabric_recipe_execute":
            return self._finalize_execution(self._fabric_recipe_execute(proposal, started, confirmed=confirmed, metadata=metadata))
        if proposal.action_type == "document_patch_operation":
            return self._finalize_execution(self._document_patch_operation(
                proposal,
                started,
                confirmed=confirmed,
                metadata=metadata,
            ))
        return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="unreachable action dispatch", metadata=metadata)

    def _finalize_execution(self, result: ExecutionResult) -> ExecutionResult:
        """Register a generated compensation after a verified write succeeds.

        Handlers remain responsible for producing a precise, target-bound
        ``undo_proposal``.  The executor owns the common ledger so every
        action surface gets the same LIFO recovery semantics.
        """
        if result.status is not ExecutionStatus.SUCCEEDED:
            return result
        raw = result.output.get("undo_proposal")
        if not isinstance(raw, dict):
            return result
        try:
            undo_proposal = ActionProposal.from_dict(raw)
        except (KeyError, TypeError, ValueError) as exc:
            return replace(result, metadata={**result.metadata, "undo_registered": False, "undo_registration_error": str(exc)})

        def compensate(_: Compensation) -> None:
            undone = self.execute(undo_proposal, confirmed=True)
            if undone.status is not ExecutionStatus.SUCCEEDED:
                raise RuntimeError(undone.error or f"undo action returned {undone.status.value}")

        target_ref = None
        if undo_proposal.target is not None:
            target_ref = undo_proposal.target.selection_id or undo_proposal.target.object_id
        self.undo_log.record(
            Compensation(
                action_id=result.proposal_id,
                tool_name=result.action_type or "action",
                target_ref=target_ref,
                prior_content=result.output.get("before_text"),
                cursor_position=None,
                was_created=bool(result.output.get("created", False)),
                captured_at_utc=now_iso(),
                compensate=compensate,
            )
        )
        return replace(result, metadata={**result.metadata, "undo_registered": True})

    def _document_patch_operation(
        self,
        proposal: ActionProposal,
        started: str,
        *,
        confirmed: bool,
        metadata: JsonDict,
    ) -> ExecutionResult:
        """Execute one whitelisted DocumentPatch operation.

        The outer document-patch gate owns source authorization, base reads,
        revision/acceptance checks, and post-write verification.  This shared
        executor is still the only route to the physical handler so UI-started
        edits do not bypass the normal local permission policy.
        """
        from app.artifacts.document_patch import OperationWriteResult, PatchOperation

        if proposal.metadata.get("trusted_document_patch") is not True:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error="document patch proposal is not runtime-bound",
                metadata=metadata,
            )
        raw_operation = proposal.parameters.get("operation")
        if not isinstance(raw_operation, dict):
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error="document patch operation is missing",
                metadata=metadata,
            )
        callback = self.document_operation_executor
        if callback is None:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error="document operation executor is unavailable",
                metadata=metadata,
            )
        try:
            operation = PatchOperation.from_dict(raw_operation)
            write = callback(operation)
        except Exception as exc:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=f"document operation failed:{type(exc).__name__}:{exc}",
                metadata=metadata,
            )
        if not isinstance(write, OperationWriteResult):
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error="document operation returned an invalid result",
                metadata=metadata,
            )
        output = {
            "wrote": write.wrote,
            "used_backend": write.used_backend,
        }
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED if write.ok else ExecutionStatus.FAILED,
            confirmed=confirmed,
            output=output,
            error=write.error,
            metadata=metadata,
        )

    @staticmethod
    def _effect_for(proposal: ActionProposal) -> Effect:
        if proposal.safety_level is SafetyLevel.READ_ONLY:
            return Effect.READ
        if proposal.safety_level is SafetyLevel.DESTRUCTIVE:
            return Effect.DESTRUCTIVE
        if proposal.action_type in {"wechat_send_message", "send_message", "submit_form"}:
            return Effect.EXTERNAL_SEND
        if proposal.safety_level is SafetyLevel.HIGH:
            return Effect.LOCAL_IRREVERSIBLE
        return Effect.REVERSIBLE_WRITE

    def _record_approval_request(
        self,
        proposal: ActionProposal,
        confirmed: bool,
    ) -> Any | None:
        """Bind the legacy boolean confirmation to the approval ledger.

        Existing callers still receive the same policy result.  The ledger is
        now the durable semantic record: an unconfirmed irreversible proposal
        remains PENDING, while an explicitly confirmed one transitions through
        APPROVED using a non-model actor.  This keeps approval provenance out
        of individual action handlers.
        """
        effect = self._effect_for(proposal)
        target = proposal.target.object_id if proposal.target is not None else None
        request = self.approval_ledger.request(
            proposal.action_type,
            str(target or proposal.id),
            str(proposal.parameters.get("text_sha256") or "") or None,
            effect,
            origin=str(proposal.metadata.get("origin") or "data"),
        )
        if confirmed:
            actor = str(proposal.metadata.get("approval_actor") or "human")
            try:
                self.approval_ledger.approve(request.request_id, by=actor)
            except ApprovalError:
                # The policy result remains authoritative for compatibility;
                # expose the failed transition in metadata through the
                # request's PENDING state instead of executing as approved.
                return request
        return request

    def _fabric_recipe_execute(
        self,
        proposal: ActionProposal,
        started: str,
        *,
        confirmed: bool,
        metadata: JsonDict,
    ) -> ExecutionResult:
        plan = proposal.parameters.get("plan")
        if not isinstance(plan, dict):
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="fabric plan is missing", metadata=metadata)
        engine = self.fabric_engine
        if engine is None:
            import webbrowser

            import pyperclip

            from app.fabric.engine import FabricEngine
            from app.system_context import list_visible_windows

            engine = FabricEngine(
                clipboard_writer=pyperclip.copy,
                clipboard_reader=lambda: str(pyperclip.paste() or ""),
                url_opener=webbrowser.open,
                target_probe=lambda _lease: list_visible_windows(),
            )
        workflow_task_id = str(proposal.parameters.get("workflow_task_id") or "").strip()
        workflow_store = None
        workflow_claim = None
        if workflow_task_id:
            from app.fabric.workflow_task_store import WorkflowTaskError, WorkflowTaskStore

            workflow_store = WorkflowTaskStore(engine.root / "workflow-tasks")
            try:
                workflow_task = workflow_store.get(workflow_task_id, surface="gui")
                if confirmed and workflow_task.get("approvalState") == "pending":
                    workflow_store.approve(workflow_task_id, surface="gui")
                workflow_claim = workflow_store.claim_execution(workflow_task_id, surface="gui")
            except WorkflowTaskError as exc:
                # A stale or deleted workflow task must not escape execute() as
                # an exception; every other failure path returns a result.
                return self._result(
                    proposal,
                    started,
                    ExecutionStatus.FAILED,
                    confirmed=confirmed,
                    error=f"workflow_task_unavailable:{exc}",
                    metadata={**metadata, "workflow_task_id": workflow_task_id},
                )
            if workflow_claim.get("reused") is True:
                receipt = dict(workflow_claim.get("receipt") or {})
                metadata = {**metadata, "workflow_task_id": workflow_task_id, "workflow_reused": True}
                return self._fabric_receipt_result(
                    proposal,
                    started,
                    confirmed=confirmed,
                    receipt=receipt,
                    metadata=metadata,
                )
            if workflow_claim.get("claimed") is not True:
                reason = str(workflow_claim.get("reason") or "workflow_execution_not_claimed")
                status = ExecutionStatus.SKIPPED if reason == "approval_required" else ExecutionStatus.PENDING
                return self._result(
                    proposal,
                    started,
                    status,
                    confirmed=confirmed,
                    error="confirmation required" if reason == "approval_required" else None,
                    metadata={**metadata, "workflow_task_id": workflow_task_id, "workflow_reused": False, "workflow_reason": reason},
                )
            plan = workflow_store.plan_for_claim(
                workflow_task_id,
                claim_id=str(workflow_claim["claimId"]),
            )
        try:
            receipt = engine.execute(dict(plan), confirmed=confirmed)
        except Exception as exc:
            receipt = {
                "id": str(uuid.uuid4()),
                "planId": str(plan.get("id") or ""),
                "recipeId": str(plan.get("recipeId") or ""),
                "status": "failed",
                "provider": str(plan.get("provider") or ""),
                "output": {},
                "verified": False,
                "verification": {},
                "undo": None,
                "error": f"execution_exception:{type(exc).__name__}",
            }
        if workflow_store is not None and workflow_claim is not None:
            workflow_store.complete_execution(
                workflow_task_id,
                claim_id=str(workflow_claim["claimId"]),
                receipt=receipt,
                surface="gui",
            )
            metadata = {**metadata, "workflow_task_id": workflow_task_id, "workflow_reused": False}
        return self._fabric_receipt_result(
            proposal,
            started,
            confirmed=confirmed,
            receipt=receipt,
            metadata=metadata,
        )

    def _fabric_receipt_result(
        self,
        proposal: ActionProposal,
        started: str,
        *,
        confirmed: bool,
        receipt: JsonDict,
        metadata: JsonDict,
    ) -> ExecutionResult:
        status = str(receipt.get("status") or "failed")
        if status == "succeeded" and receipt.get("verified") is True:
            return self._result(
                proposal,
                started,
                ExecutionStatus.SUCCEEDED,
                confirmed=confirmed,
                output={"fabric_receipt": receipt},
                metadata=metadata,
            )
        if (
            status == "accepted"
            and isinstance(receipt.get("output"), dict)
            and receipt["output"].get("taskId")
            and receipt["output"].get("status") in {"queued", "running"}
        ):
            return self._result(
                proposal,
                started,
                ExecutionStatus.PENDING,
                confirmed=confirmed,
                output={"fabric_receipt": receipt},
                metadata=metadata,
            )
        if status == "confirmation_required":
            return self._result(
                proposal,
                started,
                ExecutionStatus.SKIPPED,
                confirmed=confirmed,
                error="confirmation required",
                output={"fabric_receipt": receipt},
                metadata=metadata,
            )
        return self._result(
            proposal,
            started,
            ExecutionStatus.FAILED,
            confirmed=confirmed,
            error=str(receipt.get("error") or status),
            output={"fabric_receipt": receipt},
            metadata=metadata,
        )

    def _paste_text_to_foreground(
        self,
        proposal: ActionProposal,
        started: str,
        *,
        confirmed: bool,
        metadata: JsonDict,
    ) -> ExecutionResult:
        params = dict(proposal.parameters)
        text = str(params.get("text") or "")
        expected_hash = str(params.get("text_sha256") or "")
        expected_hwnd = _optional_int(params.get("target_hwnd"))
        expected_process_id = _optional_int(params.get("target_process_id"))
        expected_title = str(params.get("target_title") or "")
        if not text:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft text is empty", metadata=metadata)
        if params.get("submit") is not False:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft delivery submit must be false", metadata=metadata)
        if expected_hwnd is None:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft target hwnd is missing", metadata=metadata)
        if expected_process_id is None:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft target process identity is missing", metadata=metadata)
        if not expected_title:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft target window title is missing", metadata=metadata)
        if params.get("target_point_space") != "physical_screen_pixels":
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft target coordinate space is not physical screen pixels", metadata=metadata)
        actual_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if not expected_hash or expected_hash != actual_hash:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft text hash mismatch", metadata=metadata)
        artifact_id = str(params.get("artifact_id") or "").strip()
        if artifact_id:
            artifact_revision = _optional_int(params.get("artifact_revision"))
            source_id = str(params.get("source_id") or "").strip()
            locator = params.get("locator")
            action_lease = params.get("action_lease")
            lease_valid = (
                artifact_revision is not None
                and source_id
                and isinstance(locator, dict)
                and isinstance(action_lease, dict)
                and action_lease.get("artifactId") == artifact_id
                and action_lease.get("artifactRevision") == artifact_revision
                and action_lease.get("sourceId") == source_id
                and action_lease.get("locator") == locator
                and _optional_int(action_lease.get("targetHwnd")) == expected_hwnd
                and _optional_int(action_lease.get("targetProcessId")) == expected_process_id
            )
            if not lease_valid:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft action lease is invalid", metadata=metadata)
            if self.artifact_revision_probe is None:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft artifact verifier is unavailable", metadata=metadata)
            try:
                artifact_state = self.artifact_revision_probe(artifact_id)
            except Exception as exc:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=f"draft artifact verification failed: {type(exc).__name__}: {exc}", metadata=metadata)
            if (
                not isinstance(artifact_state, dict)
                or _optional_int(artifact_state.get("revision")) != artifact_revision
            ):
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft artifact revision changed before execution", metadata=metadata)
            if _optional_int(artifact_state.get("acceptedRevision")) != artifact_revision:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft artifact revision is not accepted", metadata=metadata)
            if str(artifact_state.get("contentHash") or "") != actual_hash:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft artifact content changed before execution", metadata=metadata)
        try:
            receipt = self.draft_writer(params)
        except Exception as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=f"draft writer failed: {type(exc).__name__}: {exc}", metadata=metadata)
        if not isinstance(receipt, dict) or receipt.get("ok") is not True:
            error = receipt.get("error") if isinstance(receipt, dict) else "invalid writer receipt"
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(error or "draft writer failed"), metadata=metadata)
        if receipt.get("submit_sent") is not False:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft writer violated no-submit contract", metadata=metadata)
        actual_hwnd = _optional_int(receipt.get("target_hwnd"))
        actual_title = str(receipt.get("target_title") or "")
        target_changed = actual_hwnd != expected_hwnd or actual_title != expected_title
        if target_changed:
            adaptive_resolutions = {
                "focused_editable",
                "cursor_window",
                "stable_foreground",
                "foreground_window",
                "original_target",
            }
            adaptive_receipt = (
                params.get("target_resolution") == "adaptive"
                and receipt.get("resolved_from_trusted_native_evidence") is True
                and str(receipt.get("target_resolution") or "") in adaptive_resolutions
                and actual_hwnd is not None
                and bool(actual_title)
            )
            if not adaptive_receipt:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft writer target mismatch", metadata=metadata)
        delivery_mode = str(receipt.get("delivery_mode") or "full_prompt")
        # The receipt is JSON from a child process; parse defensively instead of
        # letting a malformed field raise out of execute().
        source_chars = _optional_int(receipt.get("source_chars"))
        written_chars = _optional_int(receipt.get("written_chars"))
        if delivery_mode == "artifact_reference":
            artifact_contract_valid = (
                bool(str(params.get("prompt_artifact") or "").strip())
                and source_chars == len(text)
                and (written_chars or 0) > 0
                and str(receipt.get("method") or "").startswith("keyboard:terminal-")
            )
            if not artifact_contract_valid:
                return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="terminal artifact-reference verification failed", metadata=metadata)
        elif written_chars != len(text):
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft writer character-count verification failed", metadata=metadata)
        if receipt.get("verified") is not True:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="draft writer did not verify the write", metadata=metadata)
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED,
            confirmed=confirmed,
            output=dict(receipt),
            metadata=metadata,
        )

    def _shopping_list_add(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        try:
            stored = self.shopping_list_store.add_item(
                str(params.get("item_text") or ""),
                idempotency_key=str(params.get("idempotency_key") or ""),
                source=params.get("source") or {},
            )
            undo = make_shopping_list_undo_proposal(receipt_id=stored["receipt_id"], item=stored["item"])
            return self._result(
                proposal,
                started,
                ExecutionStatus.SUCCEEDED,
                confirmed=confirmed,
                output={
                    "verified": stored["verified"],
                    "receipt_id": stored["receipt_id"],
                    "item": stored["item"],
                    "list_id": "default-shopping-list",
                    "created": stored["created"],
                    "revision": stored["revision"],
                    "undo_proposal": undo.to_dict(),
                },
                metadata=metadata,
            )
        except ShoppingListError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)

    def _shopping_list_add_many(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        raw_items = proposal.parameters.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="batch items are required", metadata=metadata)
        stored_items: list[JsonDict] = []
        try:
            for raw in raw_items[:24]:
                if not isinstance(raw, dict):
                    raise ShoppingListError("invalid batch item")
                stored_items.append(self.shopping_list_store.add_item(
                    str(raw.get("item_text") or ""),
                    idempotency_key=str(raw.get("idempotency_key") or ""),
                    source=raw.get("source") or {},
                ))
        except ShoppingListError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)
        verified = all(item.get("verified") is True for item in stored_items)
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED if verified else ExecutionStatus.FAILED,
            confirmed=confirmed,
            output={
                "verified": verified,
                "items": [dict(item.get("item") or {}) for item in stored_items],
                "created_count": sum(1 for item in stored_items if item.get("created") is True),
                "list_id": "default-shopping-list",
                "receipts": [item.get("receipt_id") for item in stored_items],
            },
            error=None if verified else "shopping list batch verification failed",
            metadata=metadata,
        )

    def _shopping_list_set_checked(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        try:
            stored = self.shopping_list_store.set_checked(
                str(params.get("item_id") or ""),
                params.get("checked"),
                str(params.get("expected_updated_at") or ""),
            )
            return self._result(proposal, started, ExecutionStatus.SUCCEEDED, confirmed=confirmed, output=stored, metadata=metadata)
        except ShoppingListError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)

    def _shopping_list_undo_add(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        try:
            stored = self.shopping_list_store.undo_add(
                str(params.get("item_id") or ""),
                str(params.get("receipt_id") or ""),
                str(params.get("expected_updated_at") or ""),
            )
            return self._result(proposal, started, ExecutionStatus.SUCCEEDED, confirmed=confirmed, output=stored, metadata=metadata)
        except ShoppingListError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)

    def _calendar_event_create(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        try:
            stored = self.calendar_event_store.create_event(
                params.get("event") or {},
                idempotency_key=str(params.get("idempotency_key") or ""),
                source=params.get("source") or {},
                allow_conflict=params.get("allow_conflict", False),
            )
            undo = make_calendar_undo_proposal(receipt_id=stored["receipt_id"], event=stored["event"])
            return self._result(
                proposal,
                started,
                ExecutionStatus.SUCCEEDED,
                confirmed=confirmed,
                output={**stored, "calendar_id": "local-calendar", "undo_proposal": undo.to_dict()},
                metadata=metadata,
            )
        except CalendarConflict as exc:
            return self._result(
                proposal,
                started,
                ExecutionStatus.FAILED,
                confirmed=confirmed,
                error=str(exc),
                output={"conflicts": exc.conflicts},
                metadata=metadata,
            )
        except CalendarError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)

    def _calendar_event_undo_create(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        try:
            stored = self.calendar_event_store.undo_create(
                str(params.get("event_id") or ""),
                str(params.get("receipt_id") or ""),
                str(params.get("expected_updated_at") or ""),
            )
            return self._result(proposal, started, ExecutionStatus.SUCCEEDED, confirmed=confirmed, output=stored, metadata=metadata)
        except CalendarError as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(exc), metadata=metadata)

    def _copy_text_to_clipboard(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        text = str(proposal.parameters.get("text") or "")
        try:
            import pyperclip

            pyperclip.copy(text)
            return self._result(proposal, started, ExecutionStatus.SUCCEEDED, confirmed=confirmed, output={"copied_chars": len(text)}, metadata=metadata)
        except Exception as exc:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=f"clipboard copy failed: {type(exc).__name__}: {exc}", metadata=metadata)

    def _office_replace_selection(self, proposal: ActionProposal, started: str, *, confirmed: bool, metadata: JsonDict) -> ExecutionResult:
        params = dict(proposal.parameters)
        replacement = str(params.get("replacement_text") or "")
        if not replacement:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="replacement_text is empty", metadata=metadata)

        expected_hash = str(params.get("expected_text_sha256") or "")
        expected_doc = str(params.get("document") or "")
        expected_doc_name = str(params.get("document_name") or "")
        expected_hwnd = _optional_int(params.get("hwnd"))
        expected_start = _optional_int(params.get("selection_start"))
        expected_end = _optional_int(params.get("selection_end"))
        com_prog_id = _word_com_prog_id(params.get("com_prog_id"))
        replacement_hash = text_sha256(replacement)
        if params.get("replacement_text_sha256") and str(params.get("replacement_text_sha256")) != replacement_hash:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="replacement_text hash mismatch", metadata=metadata)

        script = f"""
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function FromB64Utf16([string]$Value) {{ if ([string]::IsNullOrEmpty($Value)) {{ return "" }}; return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Value)) }}
function Sha256Text([string]$Value) {{ $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value); $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes); return (($hash | ForEach-Object {{ $_.ToString("x2") }}) -join "") }}
$replacement = FromB64Utf16 "{_b64_utf16le(replacement)}"
$expectedDoc = FromB64Utf16 "{_b64_utf16le(expected_doc)}"
$expectedDocName = FromB64Utf16 "{_b64_utf16le(expected_doc_name)}"
$expectedHash = {_ps_literal_string(expected_hash)}
$comProgId = {_ps_literal_string(com_prog_id)}
$expectedHwnd = {('$null' if expected_hwnd is None else str(expected_hwnd))}
$expectedStart = {('$null' if expected_start is None else str(expected_start))}
$expectedEnd = {('$null' if expected_end is None else str(expected_end))}
$result = [ordered]@{{ ok=$false; app="word"; method="com:word.selection.replace"; com_prog_id=$comProgId; document=$null; document_name=$null; hwnd=$null; selection_start=$null; selection_end=$null; after_selection_end=$null; before_text=$null; before_sha256=$null; after_text=$null; after_sha256=$null; left_anchor_sha256=$null; left_anchor_chars=0; right_anchor_sha256=$null; right_anchor_chars=0; replacement_chars=$replacement.Length; error=$null }}
try {{
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject($comProgId)
  try {{ if ($word.ActiveWindow) {{ $result.hwnd = [int64]$word.ActiveWindow.Hwnd }} }} catch {{}}
  if (-not $word.ActiveDocument) {{ throw "No active Word document" }}
  $doc = $word.ActiveDocument
  $result.document = [string]$doc.FullName
  $result.document_name = [string]$doc.Name
  if ($expectedDoc -and $result.document -ne $expectedDoc) {{ throw "Active Word document changed before execution" }}
  if ($expectedDocName -and $result.document_name -ne $expectedDocName) {{ throw "Active Word document name changed before execution" }}
  if ($null -ne $expectedHwnd -and [int64]$result.hwnd -ne [int64]$expectedHwnd) {{ throw "Active Word window changed before execution" }}
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
  $start = [int]$sel.Start
  $end = [int]$sel.End
  $anchorSize = 64
  $leftStart = [Math]::Max(0, $start - $anchorSize)
  $rightEnd = [Math]::Min([int]$doc.Content.End, $end + $anchorSize)
  $leftAnchor = [string]$doc.Range([int]$leftStart, [int]$start).Text
  $rightAnchor = [string]$doc.Range([int]$end, [int]$rightEnd).Text
  $result.left_anchor_chars = $leftAnchor.Length
  $result.right_anchor_chars = $rightAnchor.Length
  if ($leftAnchor.Length -gt 0) {{ $result.left_anchor_sha256 = Sha256Text $leftAnchor }}
  if ($rightAnchor.Length -gt 0) {{ $result.right_anchor_sha256 = Sha256Text $rightAnchor }}
  $undoRecord = $null
  $undoStarted = $false
  try {{ $undoRecord = $word.Application.UndoRecord; if ($null -ne $undoRecord) {{ $undoRecord.StartCustomRecord("Magic Pointer Replace Selection"); $undoStarted = $true }} }} catch {{}}
  try {{
    $sel.Text = $replacement
  }} finally {{
    if ($undoStarted -and $null -ne $undoRecord) {{ try {{ $undoRecord.EndCustomRecord() }} catch {{}} }}
  }}
  $result.after_selection_end = [int]($start + $replacement.Length)
  $writtenRange = $doc.Range([int]$start, [int]$result.after_selection_end)
  $result.after_text = [string]$writtenRange.Text
  $result.after_sha256 = Sha256Text $result.after_text
  if ($result.after_sha256 -ne (Sha256Text $replacement)) {{
    try {{ $writtenRange.Text = $before }} catch {{}}
    throw "Word write verification failed; the original text was restored."
  }}
  $result.ok = $true
}} catch {{
  $result.error = $_.Exception.Message
}}
$result | ConvertTo-Json -Depth 8 -Compress
"""
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
                output={k: data.get(k) for k in ("document", "document_name", "hwnd", "selection_start", "selection_end", "before_sha256")},
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
            before_text=before_text,
            after_text=replacement,
            selection_start=_optional_int(data.get("selection_start")),
            selection_end=_optional_int(data.get("selection_end")),
            after_selection_end=_optional_int(data.get("after_selection_end")),
            selection_session_id=str(params.get("selection_session_id") or "") or None,
            selection_snapshot_id=str(params.get("selection_snapshot_id") or "") or None,
            source_window_hwnd=_optional_int(params.get("hwnd")),
            source_window_title=str(params.get("source_window_title") or "") or None,
            left_anchor_sha256=str(data.get("left_anchor_sha256") or "") or None,
            left_anchor_chars=_optional_int(data.get("left_anchor_chars")),
            right_anchor_sha256=str(data.get("right_anchor_sha256") or "") or None,
            right_anchor_chars=_optional_int(data.get("right_anchor_chars")),
            metadata={
                "method": data.get("method"),
                "hwnd": data.get("hwnd"),
                "command": params.get("command"),
                "office_host": params.get("office_host"),
                "com_prog_id": data.get("com_prog_id") or com_prog_id,
                "selection_session_id": params.get("selection_session_id"),
                "selection_snapshot_id": params.get("selection_snapshot_id"),
            },
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
        if record.before_text is None or record.after_text is None:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error="That history record does not contain precise restore text", metadata=metadata)

        expected_doc = record.document or str(params.get("document") or "")
        start_pos = record.selection_start
        after_end = record.after_selection_end
        before_text = record.before_text
        after_text = record.after_text
        after_hash = record.after_sha256 or text_sha256(after_text)
        com_prog_id = _word_com_prog_id(record.metadata.get("com_prog_id"))
        left_anchor_hash = record.left_anchor_sha256 or ""
        left_anchor_chars = record.left_anchor_chars or 0
        right_anchor_hash = record.right_anchor_sha256 or ""
        right_anchor_chars = record.right_anchor_chars or 0
        script = f"""
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function FromB64Utf16([string]$Value) {{ if ([string]::IsNullOrEmpty($Value)) {{ return "" }}; return [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Value)) }}
function Sha256Text([string]$Value) {{ $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value); $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes); return (($hash | ForEach-Object {{ $_.ToString("x2") }}) -join "") }}
$expectedDoc = FromB64Utf16 "{_b64_utf16le(expected_doc)}"
$beforeText = FromB64Utf16 "{_b64_utf16le(before_text)}"
$afterText = FromB64Utf16 "{_b64_utf16le(after_text)}"
$afterHash = {_ps_literal_string(after_hash)}
$comProgId = {_ps_literal_string(com_prog_id)}
$leftAnchorHash = {_ps_literal_string(left_anchor_hash)}
$leftAnchorChars = {left_anchor_chars}
$rightAnchorHash = {_ps_literal_string(right_anchor_hash)}
$rightAnchorChars = {right_anchor_chars}
$startPos = {('$null' if start_pos is None else str(start_pos))}
$afterEnd = {('$null' if after_end is None else str(after_end))}
$result = [ordered]@{{ ok=$false; app="word"; method="com:word.range.precise_restore"; com_prog_id=$comProgId; document=$null; restored_by=$null; match_count=0; error=$null }}
try {{
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject($comProgId)
  if (-not $word.ActiveDocument) {{ throw "No active Word document" }}
  $doc = $word.ActiveDocument
  $result.document = [string]$doc.FullName
  if ($expectedDoc -and $result.document -ne $expectedDoc) {{ throw "Active Word document changed before undo" }}
  $restored = $false
  if ($null -ne $startPos -and $null -ne $afterEnd) {{
    $verifyFailed = $false
    try {{
      $range = $doc.Range([int]$startPos, [int]$afterEnd)
      $current = [string]$range.Text
      if ((Sha256Text $current) -eq $afterHash -or $current -eq $afterText) {{
        $range.Text = $beforeText
        # 读回校验：restore 是历史事实，不是"请求已发出"。修订模式、
        # 自动更正、受保护段落都可能静默改写或吞掉赋值——不验证等于
        # 谎报已恢复（invariant ⑥）。
        if ((Sha256Text ([string]$range.Text)) -ne (Sha256Text $beforeText)) {{
          $verifyFailed = $true
          throw "Word precise restore verification failed; the document did not take the recorded original text."
        }}
        $result.restored_by = "recorded_range"
        $restored = $true
      }}
    }} catch {{ if ($verifyFailed) {{ throw }} }}
  }}
  if (-not $restored -and ($leftAnchorHash -or $rightAnchorHash)) {{
    $matches = @()
    $searchStart = 0
    $documentEnd = [int]$doc.Content.End
    while ($searchStart -lt $documentEnd -and $matches.Count -lt 2) {{
      $range = $doc.Range([int]$searchStart, [int]$documentEnd)
      $find = $range.Find
      $find.ClearFormatting()
      $find.Text = $afterText
      $find.Forward = $true
      $find.Wrap = 0
      $find.MatchWildcards = $false
      if (-not $find.Execute()) {{ break }}
      $anchorOk = $true
      if ($leftAnchorHash) {{
        if ([int]$range.Start -lt [int]$leftAnchorChars) {{
          $anchorOk = $false
        }} else {{
          $left = [string]$doc.Range([int]$range.Start - [int]$leftAnchorChars, [int]$range.Start).Text
          if ((Sha256Text $left) -ne $leftAnchorHash) {{ $anchorOk = $false }}
        }}
      }}
      if ($anchorOk -and $rightAnchorHash) {{
        $rightEnd = [int]$range.End + [int]$rightAnchorChars
        if ($rightEnd -gt [int]$doc.Content.End) {{
          $anchorOk = $false
        }} else {{
          $right = [string]$doc.Range([int]$range.End, [int]$rightEnd).Text
          if ((Sha256Text $right) -ne $rightAnchorHash) {{ $anchorOk = $false }}
        }}
      }}
      if ($anchorOk) {{ $matches += ,([ordered]@{{ start=[int]$range.Start; end=[int]$range.End }}) }}
      $nextStart = [int]$range.End
      if ($nextStart -le $searchStart) {{ $nextStart = $searchStart + 1 }}
      $searchStart = $nextStart
    }}
    $result.match_count = $matches.Count
    if ($matches.Count -eq 1) {{
      $match = $matches[0]
      $range = $doc.Range([int]$match.start, [int]$match.end)
      if ((Sha256Text ([string]$range.Text)) -ne $afterHash) {{ throw "Unique restore match changed before replacement" }}
      $range.Text = $beforeText
      # 读回校验（同 recorded_range 路径）：不验证就谎报已恢复。
      if ((Sha256Text ([string]$range.Text)) -ne (Sha256Text $beforeText)) {{
        throw "Word anchored restore verification failed; the document did not take the recorded original text."
      }}
      $result.restored_by = "anchored_text_match"
      $restored = $true
    }} elseif ($matches.Count -gt 1) {{
      throw "Magic Pointer replacement text appears more than once; refusing an ambiguous restore."
    }}
  }}
  if (-not $restored) {{ throw "Could not find the Magic Pointer replacement text to restore; document may have been edited inside that span." }}
  $result.ok = $true
}} catch {{
  $result.error = $_.Exception.Message
}}
$result | ConvertTo-Json -Depth 6 -Compress
"""
        probe = _run_powershell_json(script, timeout=10)
        if not probe.ok:
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=probe.error, metadata=metadata)
        data = probe.data
        if not data.get("ok"):
            return self._result(proposal, started, ExecutionStatus.FAILED, confirmed=confirmed, error=str(data.get("error") or "Word precise undo failed"), metadata=metadata)
        updated = self.history_store.mark_undone(record.id)
        return self._result(
            proposal,
            started,
            ExecutionStatus.SUCCEEDED,
            confirmed=confirmed,
            output={"history_id": record.id, "document": record.document, "undone_at": None if updated is None else updated.undone_at, "restored_by": data.get("restored_by")},
            metadata=metadata,
        )
