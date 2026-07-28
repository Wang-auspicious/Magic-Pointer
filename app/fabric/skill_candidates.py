from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from app.fabric.audit import AuditStore
from app.fabric.catalog import get_recipe
from app.fabric.schema import OperationPlan
from app.fabric.task_store import AgentTaskError, AgentTaskStore


class SkillCandidateError(RuntimeError):
    pass


_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_ELIGIBLE_RECIPES = {"agent.handoff", "agent.background_task"}
_TERMINAL_TASK_STATES = {"succeeded", "failed", "cancelled", "interrupted"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _digest(value: Any) -> str:
    raw = value if isinstance(value, str) else _canonical(value)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _token(value: Any, *, limit: int = 120) -> str:
    return re.sub(r"[^a-zA-Z0-9_.:-]+", "-", str(value or "").strip())[:limit].strip("-")


class SkillCandidateStore:
    """Learn privacy-bounded Skill drafts from repeated verified Agent workflows.

    The store records only semantic enums and execution identifiers. Screen text,
    commands, prompts, paths, window titles and object labels never enter it.
    """

    def __init__(self, root: Path | str, *, threshold: int = 3) -> None:
        self.root = Path(root).expanduser().resolve()
        self.path = self.root / "skill-candidates.json"
        self.draft_root = self.root / "skill-candidates"
        self.managed_root = self.root / "managed-skills"
        self.threshold = max(3, int(threshold))
        self.tasks = AgentTaskStore(self.root / "agent-tasks")
        self.audit = AuditStore(self.root / "fabric-audit.jsonl")

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / ".skill-candidates.lock"
        key = str(lock_path.resolve()).casefold()
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(key, threading.RLock())
        with process_lock, lock_path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"schemaVersion": 1, "observations": {}, "candidates": {}}

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._empty()
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise SkillCandidateError("invalid Skill candidate state") from exc
        if (
            not isinstance(value, dict)
            or value.get("schemaVersion") != 1
            or not isinstance(value.get("observations"), dict)
            or not isinstance(value.get("candidates"), dict)
        ):
            raise SkillCandidateError("invalid Skill candidate state")
        return value

    def _write(self, value: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(f".json.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as exc:
            raise SkillCandidateError(f"could not persist Skill candidate state:{type(exc).__name__}") from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    @staticmethod
    def _nested(parameters: dict[str, Any], direct: str, runtime: str = "") -> dict[str, Any]:
        value = parameters.get(direct)
        if isinstance(value, dict):
            return dict(value)
        packet = parameters.get("contextPacket")
        packet = packet if isinstance(packet, dict) else {}
        runtime_value = packet.get("runtime")
        runtime_value = runtime_value if isinstance(runtime_value, dict) else {}
        value = runtime_value.get(runtime or direct)
        return dict(value) if isinstance(value, dict) else {}

    @classmethod
    def _semantic(cls, plan: OperationPlan) -> dict[str, Any] | None:
        if plan.recipe_id not in _ELIGIBLE_RECIPES:
            return None
        parameters = dict(plan.parameters or {})
        objects = [dict(item) for item in parameters.get("objects") or [] if isinstance(item, dict)]
        object_kinds = sorted(set(_token(item.get("kind") or "grounded_object") for item in objects))
        object_kinds = [item for item in object_kinds if item][:12] or ["grounded_object"]
        terminal = cls._nested(parameters, "terminalEvidence")
        browser = cls._nested(parameters, "browserContext")
        component = cls._nested(parameters, "componentLink")
        workspace = parameters.get("runtimeWorkspace")
        if not isinstance(workspace, dict):
            packet = parameters.get("contextPacket")
            packet = packet if isinstance(packet, dict) else {}
            workspace = packet.get("workspace") if isinstance(packet.get("workspace"), dict) else {}
        terminal_method = _token(terminal.get("method"))
        browser_method = _token(browser.get("method"))
        component_method = _token(component.get("method"))
        workspace_relation = _token(workspace.get("bindingRelation") or workspace.get("bindingState"))
        steps = ["freeze_grounded_objects"]
        if workspace_relation:
            steps.append("bind_runtime_workspace")
        if terminal_method:
            steps.append("collect_terminal_evidence")
        if browser_method:
            steps.append("collect_browser_evidence")
        if component_method:
            steps.append("resolve_component_source")
        steps.extend(["dispatch_context_packet", "verify_agent_terminal_status"])
        return {
            "recipeId": plan.recipe_id,
            "risk": plan.risk.value,
            "objectKinds": object_kinds,
            "terminalMethod": terminal_method,
            "browserMethod": browser_method,
            "componentMethod": component_method,
            "workspaceRelation": workspace_relation,
            "steps": steps,
        }

    @staticmethod
    def _direct_outcome(receipt: dict[str, Any]) -> str:
        status = str(receipt.get("status") or "")
        if status == "succeeded" and receipt.get("verified") is True:
            return "succeeded"
        if status == "accepted" and str((receipt.get("output") or {}).get("taskId") or ""):
            return "pending_agent"
        return "failed"

    @staticmethod
    def _public(candidate: dict[str, Any]) -> dict[str, Any]:
        return {
            "candidateId": candidate["candidateId"],
            "name": candidate["name"],
            "recipeId": candidate["recipeId"],
            "state": candidate["state"],
            "enabled": False,
            "occurrenceCount": candidate["occurrenceCount"],
            "threshold": candidate["threshold"],
            "objectKinds": list(candidate["objectKinds"]),
            "steps": list(candidate["steps"]),
            "providers": list(candidate["providers"]),
            "sourcePlanIds": list(candidate["sourcePlanIds"]),
            "sourceReceiptIds": list(candidate["sourceReceiptIds"]),
            "sourceTaskIds": list(candidate["sourceTaskIds"]),
            "draftSha256": candidate["draftSha256"],
            "createdAt": candidate["createdAt"],
            "installedAt": candidate.get("installedAt"),
            "installedPath": candidate.get("installedPath"),
        }

    @staticmethod
    def _draft_content(candidate: dict[str, Any], semantic: dict[str, Any]) -> str:
        kinds = ", ".join(candidate["objectKinds"])
        providers = ", ".join(candidate["providers"]) or "provider-neutral Agent"
        steps = {
            "freeze_grounded_objects": "Freeze the pointed objects and retain their stable identifiers.",
            "bind_runtime_workspace": "Bind the active workspace from verified runtime process evidence.",
            "collect_terminal_evidence": "Collect the bounded terminal error window and observed exit state.",
            "collect_browser_evidence": "Collect the pointed DOM reference and bounded browser failure evidence.",
            "resolve_component_source": "Resolve component-source candidates; inspect low-confidence matches before editing.",
            "dispatch_context_packet": "Dispatch one sealed Context Packet without asking the user to repeat the scene.",
            "verify_agent_terminal_status": "Read the durable Agent task terminal status and retain its receipt.",
        }
        workflow = "\n".join(
            f"{index}. {steps.get(step, step)}"
            for index, step in enumerate(candidate["steps"], start=1)
        )
        receipts = "\n".join(f"- receipt `{item}`" for item in candidate["sourceReceiptIds"])
        description = (
            f"Replay a reviewed Magic Pointer debugging workflow for {kinds}. "
            "Use only after a human reviews this generated draft; installation does not enable it."
        )
        return (
            "---\n"
            f"name: {candidate['name']}\n"
            "description: >\n"
            f"  {description}\n"
            "compatibility: Magic Pointer managed Skill; human review required\n"
            "metadata:\n"
            "  magic_pointer_state: candidate_disabled\n"
            f"  source_execution_count: {candidate['occurrenceCount']}\n"
            "---\n\n"
            f"# {candidate['name']}\n\n"
            "## When to use\n\n"
            f"Use for the same reviewed `{semantic['recipeId']}` workflow over `{kinds}` objects.\n\n"
            "## Inputs\n\n"
            "- A current Magic Pointer Context Packet with grounded object identifiers.\n"
            "- Verified runtime evidence appropriate to the recorded workflow.\n"
            f"- An available execution provider; observed providers: {providers}.\n\n"
            "Never request or reconstruct screen text from the learning record. Read current context through normal permissions.\n\n"
            "## Workflow\n\n"
            f"{workflow}\n\n"
            "## Safety\n\n"
            "Keep target-lease, capture, permission and confirmation gates active. Treat candidate component paths as hints until verified. Do not install or enable another Skill.\n\n"
            "## Verification\n\n"
            "Require a durable terminal Agent task status. `accepted` or `queued` is not completion. Confirm artifacts and source-object provenance when outputs exist.\n\n"
            "## Failure handling\n\n"
            "Fail closed on stale targets, missing runtime evidence, unavailable providers, digest mismatch or unverified output. Preserve the failed receipt without inventing progress.\n\n"
            "## Source executions\n\n"
            f"{receipts}\n"
        )

    def _draft_path(self, candidate_id: str) -> Path:
        if not re.fullmatch(r"skill-[0-9a-f]{16}", str(candidate_id or "")):
            raise SkillCandidateError("invalid Skill candidate id")
        return self.draft_root / candidate_id / "SKILL.md"

    @staticmethod
    def _atomic_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".md.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def _reconcile(self, state: dict[str, Any]) -> bool:
        changed = False
        for observation in state["observations"].values():
            if observation.get("outcome") != "pending_agent":
                continue
            task_id = str(observation.get("taskId") or "")
            try:
                task = self.tasks.status(task_id)
            except AgentTaskError:
                continue
            status = str(task.get("status") or "")
            if status == "succeeded":
                observation["outcome"] = "succeeded"
                observation["completedAt"] = str(task.get("updatedAt") or _now())
                changed = True
            elif status in _TERMINAL_TASK_STATES:
                observation["outcome"] = "failed"
                observation["completedAt"] = str(task.get("updatedAt") or _now())
                changed = True
        return changed

    def _rebuild(self, state: dict[str, Any]) -> list[dict[str, Any]]:
        created: list[dict[str, Any]] = []
        groups: dict[str, list[dict[str, Any]]] = {}
        for observation in state["observations"].values():
            if observation.get("outcome") != "succeeded":
                continue
            groups.setdefault(str(observation["signature"]), []).append(observation)
        for signature, observations in groups.items():
            observations.sort(key=lambda item: (str(item.get("completedAt") or item["observedAt"]), item["receiptId"]))
            if len(observations) < self.threshold:
                continue
            candidate_id = f"skill-{signature[:16]}"
            if candidate_id in state["candidates"]:
                continue
            sources = observations[:self.threshold]
            semantic = dict(sources[0]["semantic"])
            recipe = get_recipe(str(semantic["recipeId"]))
            name = f"mp-{_token(recipe.id.replace('.', '-'), limit=48).casefold()}-{signature[:8]}"
            stamp = _now()
            candidate = {
                "candidateId": candidate_id,
                "name": name,
                "recipeId": semantic["recipeId"],
                "state": "candidate_disabled",
                "enabled": False,
                "occurrenceCount": self.threshold,
                "threshold": self.threshold,
                "objectKinds": list(semantic["objectKinds"]),
                "steps": list(semantic["steps"]),
                "providers": list(dict.fromkeys(str(item["provider"]) for item in sources if item.get("provider"))),
                "sourcePlanIds": [str(item["planId"]) for item in sources],
                "sourceReceiptIds": [str(item["receiptId"]) for item in sources],
                "sourceTaskIds": [str(item["taskId"]) for item in sources if item.get("taskId")],
                "createdAt": stamp,
                "installedAt": None,
                "installedPath": None,
            }
            content = self._draft_content(candidate, semantic)
            candidate["draftSha256"] = _digest(content)
            self._atomic_text(self._draft_path(candidate_id), content)
            state["candidates"][candidate_id] = candidate
            created.append(candidate)
        return created

    def observe_execution(self, plan: OperationPlan, receipt: dict[str, Any]) -> dict[str, Any]:
        semantic = self._semantic(plan)
        if semantic is None:
            return {"eligible": False, "progress": 0, "candidate": None}
        if not isinstance(receipt, dict) or not str(receipt.get("id") or ""):
            raise SkillCandidateError("execution receipt id is required")
        receipt_id = str(receipt["id"])
        task_id = str((receipt.get("output") or {}).get("taskId") or "")
        signature = _digest(semantic)
        created: list[dict[str, Any]] = []
        with self._lock():
            state = self._read()
            existing = state["observations"].get(receipt_id)
            if existing is None:
                state["observations"][receipt_id] = {
                    "observationId": str(uuid.uuid4()),
                    "signature": signature,
                    "semantic": semantic,
                    "planId": plan.id,
                    "receiptId": receipt_id,
                    "taskId": task_id,
                    "recipeId": plan.recipe_id,
                    "provider": _token(plan.provider),
                    "outcome": self._direct_outcome(receipt),
                    "observedAt": _now(),
                }
            elif (
                existing.get("planId") != plan.id
                or existing.get("signature") != signature
                or str(existing.get("taskId") or "") != task_id
            ):
                raise SkillCandidateError("Skill observation receipt id collision")
            self._reconcile(state)
            created = self._rebuild(state)
            self._write(state)
            candidate = next((item for item in state["candidates"].values() if item["candidateId"] == f"skill-{signature[:16]}"), None)
            progress = sum(
                1 for item in state["observations"].values()
                if item.get("signature") == signature and item.get("outcome") == "succeeded"
            )
            public = self._public(candidate) if candidate is not None else None
        for item in created:
            self.audit.append("skill.candidate_created", {
                "candidateId": item["candidateId"],
                "recipeId": item["recipeId"],
                "occurrenceCount": item["occurrenceCount"],
                "state": item["state"],
            })
        return {"eligible": True, "progress": min(progress, self.threshold), "threshold": self.threshold, "candidate": public}

    def list(self, *, limit: int = 100) -> list[dict[str, Any]]:
        created: list[dict[str, Any]] = []
        with self._lock():
            state = self._read()
            changed = self._reconcile(state)
            created = self._rebuild(state)
            if changed or created:
                self._write(state)
            values = sorted(
                state["candidates"].values(),
                key=lambda item: str(item.get("createdAt") or ""),
                reverse=True,
            )[:max(0, min(int(limit), 500))]
            result = [self._public(item) for item in values]
        for item in created:
            self.audit.append("skill.candidate_created", {
                "candidateId": item["candidateId"],
                "recipeId": item["recipeId"],
                "occurrenceCount": item["occurrenceCount"],
                "state": item["state"],
            })
        return result

    def draft(self, candidate_id: str) -> dict[str, Any]:
        with self._lock():
            state = self._read()
            candidate = state["candidates"].get(str(candidate_id or ""))
            if not isinstance(candidate, dict):
                raise SkillCandidateError("unknown Skill candidate id")
            path = self._draft_path(candidate["candidateId"]).resolve()
            if not path.is_relative_to(self.draft_root.resolve()):
                raise SkillCandidateError("invalid Skill candidate path")
            try:
                content = path.read_text(encoding="utf-8")
            except OSError as exc:
                raise SkillCandidateError("Skill candidate draft is unavailable") from exc
            if _digest(content) != candidate["draftSha256"]:
                raise SkillCandidateError("Skill candidate draft digest mismatch")
            review_token = secrets.token_urlsafe(32)
            candidate["reviewTokenDigest"] = _digest(review_token)
            candidate["reviewedDraftSha256"] = candidate["draftSha256"]
            candidate["reviewIssuedAt"] = _now()
            candidate.pop("installConfirmationDigest", None)
            candidate.pop("confirmationIssuedAt", None)
            self._write(state)
            return {
                "candidate": self._public(candidate),
                "content": content,
                "draftPath": str(path),
                "sha256": candidate["draftSha256"],
                "reviewToken": review_token,
            }

    def install(self, candidate_id: str, *, confirmed: bool, review_token: str = "") -> dict[str, Any]:
        with self._lock():
            state = self._read()
            candidate = state["candidates"].get(str(candidate_id or ""))
            if not isinstance(candidate, dict):
                raise SkillCandidateError("unknown Skill candidate id")
            draft_path = self._draft_path(candidate["candidateId"]).resolve()
            if not draft_path.is_relative_to(self.draft_root.resolve()):
                raise SkillCandidateError("invalid Skill candidate path")
            try:
                content = draft_path.read_text(encoding="utf-8")
            except OSError as exc:
                raise SkillCandidateError("Skill candidate draft is unavailable") from exc
            if _digest(content) != candidate["draftSha256"]:
                raise SkillCandidateError("Skill candidate draft digest mismatch")
            expected_review = str(candidate.get("reviewTokenDigest") or "")
            if (
                not expected_review
                or candidate.get("reviewedDraftSha256") != candidate["draftSha256"]
                or not hmac.compare_digest(expected_review, _digest(str(review_token or "")))
            ):
                raise SkillCandidateError("Skill draft review is required")
            review_digest = _digest(str(review_token or ""))
            if not confirmed:
                candidate["installConfirmationDigest"] = review_digest
                candidate["confirmationIssuedAt"] = _now()
                self._write(state)
                return {
                    "status": "confirmation_required",
                    "candidate": self._public(candidate),
                    "draftSha256": candidate["draftSha256"],
                }
            if not hmac.compare_digest(
                str(candidate.get("installConfirmationDigest") or ""),
                review_digest,
            ):
                raise SkillCandidateError("Skill installation confirmation is required")
            target = (self.managed_root / candidate["name"] / "SKILL.md").resolve()
            if not target.is_relative_to(self.managed_root.resolve()):
                raise SkillCandidateError("invalid managed Skill path")
            reused = False
            if target.exists():
                if _digest(target.read_text(encoding="utf-8")) != candidate["draftSha256"]:
                    raise SkillCandidateError("managed Skill collision")
                reused = True
            else:
                self._atomic_text(target, content)
            candidate["state"] = "installed_disabled"
            candidate["enabled"] = False
            candidate["installedAt"] = candidate.get("installedAt") or _now()
            candidate["installedPath"] = str(target)
            candidate.pop("reviewTokenDigest", None)
            candidate.pop("reviewedDraftSha256", None)
            candidate.pop("reviewIssuedAt", None)
            candidate.pop("installConfirmationDigest", None)
            candidate.pop("confirmationIssuedAt", None)
            self._write(state)
            public = self._public(candidate)
        self.audit.append("skill.candidate_installed", {
            "candidateId": public["candidateId"],
            "recipeId": public["recipeId"],
            "state": "installed_disabled",
            "enabled": False,
            "reused": reused,
        })
        return {
            "status": "installed_disabled",
            "candidate": public,
            "installedPath": str(target),
            "reused": reused,
        }
