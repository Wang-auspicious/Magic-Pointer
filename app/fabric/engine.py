from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import shutil
import uuid
from pathlib import Path
from typing import Any, Callable

from app.fabric.agent_gateway import AgentGateway
from app.fabric.artifacts import ArtifactRegistry
from app.fabric.audit import AuditStore
from app.fabric.capabilities import CapabilityRegistry
from app.fabric.capture_policy import CapturePolicyEngine, build_capture_policy
from app.fabric.catalog import get_recipe
from app.fabric.context_packet import ContextPacketBuilder
from app.fabric.executors import FabricExecutors
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.router import RecipeRouter
from app.fabric.runtime_workspace import RuntimeWorkspaceResolver
from app.fabric.provenance import ProvenanceIndex, ProvenanceError
from app.fabric.skill_candidates import SkillCandidateError, SkillCandidateStore
from app.fabric.schema import ExecutionReceipt, OperationPlan, RiskLevel
from app.fabric.settings import FabricSettings, SettingsStore
from app.fabric.task_store import AgentTaskError, AgentTaskStore
from app.fabric.target_lease import TargetLease, validate_target_lease
from app.fabric.workflow import operation_graph
from app.models.capability_resolver import ModelCapabilityResolver
from app.models.visual_relay import VisualRelayPlanner


_PROVIDER_BY_RECIPE = {
    "activate.wiggle": "internal",
    "ground.this": "internal",
    "ground.references": "internal",
    "text.ocr_copy": "clipboard",
    "text.ocr_clean": "clipboard",
    "text.rewrite_in_place": "model.text",
    "text.translate_in_place": "model.text",
    "text.summarize_route": "model.text",
    "entity.quick_action": "unavailable:entity_destination_not_configured",
    "table.to_spreadsheet": "artifact.table",
    "table.merge": "artifact.table",
    "chart.extract_data": "unavailable:chart_digitizer_not_configured",
    "formula.to_latex": "unavailable:math_vision_provider_not_configured",
    "image.edit_object": "unavailable:image_provider_not_configured",
    "image.compose": "unavailable:image_provider_not_configured",
    "image.style_transfer": "unavailable:image_provider_not_configured",
    "canvas.transform": "unavailable:canvas_adapter_not_configured",
    "calendar.create_from_screen": "unavailable:calendar_adapter_not_configured",
    "map.route": "maps.deep_link",
    "video.place_action": "unavailable:place_provider_not_configured",
    "recipe.scale_and_route": "artifact.list",
    "task.route": "local.task",
    "research.evidence_card": "artifact.evidence",
    "agent.handoff": "agent.task",
    "vision.prompt_bridge": "artifact.visual_context",
    "objects.compare": "artifact.compare",
    "voice.short_command": "unavailable:speech_provider_not_configured",
    "agent.background_task": "agent.task",
    "integration.mcp": "internal",
    "governance.dashboard": "internal",
}


class FabricEngine:
    def __init__(
        self,
        *,
        root: Path | str | None = None,
        settings: FabricSettings | None = None,
        clipboard_writer: Callable[[str], Any] | None = None,
        clipboard_reader: Callable[[], str] | None = None,
        url_opener: Callable[[str], Any] | None = None,
        model_transform: Callable[[str, str, str], str] | None = None,
        provider_handlers: dict[str, Callable[[OperationPlan], dict[str, Any]]] | None = None,
        agent_starter: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        agent_availability: dict[str, bool] | None = None,
        ocr_reader: Callable[[Path], str] | None = None,
        target_probe: Callable[[dict[str, Any]], list[dict[str, Any]] | None] | None = None,
    ) -> None:
        self.root = Path(root) if root is not None else SettingsStore().path.parent
        self._signing_key = self._load_signing_key()
        self.settings = settings or SettingsStore(self.root / "fabric-settings.json").load()
        self.router = RecipeRouter()
        self.capabilities = CapabilityRegistry()
        self.context_packets = ContextPacketBuilder(runtime_resolver=RuntimeWorkspaceResolver())
        self.capture_policy = CapturePolicyEngine(
            self.settings.privacy.upload_screenshots,
            self.settings.privacy.default_capture_mode,
            self.settings.privacy.sensitive_apps,
            self.settings.privacy.app_capture_modes,
        )
        self.target_probe = target_probe
        self.audit = AuditStore(self.root / "fabric-audit.jsonl")
        self.artifacts = ArtifactRegistry(self.root)
        self.provenance = ProvenanceIndex(self.root)
        self.skill_candidates = SkillCandidateStore(self.root)
        self.model_transform_available = model_transform is not None
        self.ocr_available = (
            ocr_reader is not None
            or importlib.util.find_spec("rapidocr") is not None
            or shutil.which("tesseract") is not None
        )
        self.agent_availability = agent_availability if agent_availability is not None else {
            provider: shutil.which("cursor-agent" if provider == "cursor" else provider) is not None
            for provider in ("codex", "pi", "claude", "gemini", "cursor", "opencode", "aider")
        }
        self.executors = FabricExecutors(
            root=self.root,
            clipboard_writer=clipboard_writer,
            clipboard_reader=clipboard_reader,
            url_opener=url_opener,
            model_transform=model_transform,
            provider_handlers=provider_handlers,
            agent_starter=agent_starter or self._default_agent_starter,
            ocr_reader=ocr_reader,
            allow_screenshot_upload=self.settings.privacy.upload_screenshots,
        )

    @staticmethod
    def _attachment_candidates(
        objects: list[dict[str, Any]],
        requested: list[Any],
    ) -> list[str]:
        values: list[str] = []
        for raw in requested:
            value = str(raw or "").strip()
            if value and value not in values:
                values.append(value)
        for obj in objects:
            source = obj.get("source")
            source = dict(source) if isinstance(source, dict) else {}
            for raw in (
                obj.get("path"),
                source.get("path"),
                source.get("documentPath"),
                source.get("document_path"),
                source.get("imagePath"),
                source.get("screenshotPath"),
                source.get("capturePath"),
                source.get("annotatedPath"),
            ):
                value = str(raw or "").strip()
                if value and value not in values:
                    values.append(value)
        return values

    @staticmethod
    def _audit_context(
        parameters: dict[str, Any],
        objects: list[dict[str, Any]],
    ) -> dict[str, Any]:
        target_apps = sorted({
            str(source.get("app") or "").strip()[:120]
            for obj in objects
            for source in [obj.get("source") if isinstance(obj.get("source"), dict) else {}]
            if str(source.get("app") or "").strip()
        })[:8]
        packet = parameters.get("contextPacket")
        packet = dict(packet) if isinstance(packet, dict) else {}
        workspace = packet.get("workspace")
        workspace = dict(workspace) if isinstance(workspace, dict) else {}
        runtime = packet.get("runtime")
        runtime = dict(runtime) if isinstance(runtime, dict) else {}
        binding = runtime.get("processBinding")
        binding = dict(binding) if isinstance(binding, dict) else {}
        terminal = runtime.get("terminalEvidence")
        terminal = dict(terminal) if isinstance(terminal, dict) else {}
        terminal_window = terminal.get("window")
        terminal_window = dict(terminal_window) if isinstance(terminal_window, dict) else {}
        browser = runtime.get("browserContext")
        browser = dict(browser) if isinstance(browser, dict) else {}
        browser_node = browser.get("node")
        browser_node = dict(browser_node) if isinstance(browser_node, dict) else {}
        component_link = runtime.get("componentLink")
        component_link = dict(component_link) if isinstance(component_link, dict) else {}
        component_candidates = [
            dict(item) for item in component_link.get("candidates") or [] if isinstance(item, dict)
        ]
        project = str(workspace.get("repoRoot") or workspace.get("cwd") or parameters.get("cwd") or "").strip()
        permission = parameters.get("permissionDecision")
        permission = dict(permission) if isinstance(permission, dict) else {}
        scope = permission.get("scope")
        scope = dict(scope) if isinstance(scope, dict) else {}
        scope_fingerprint = ""
        if scope:
            encoded_scope = json.dumps(scope, ensure_ascii=False, sort_keys=True, default=str)
            scope_fingerprint = hashlib.sha256(encoded_scope.encode("utf-8")).hexdigest()[:16]
        return {
            "leaseId": str(
                (parameters.get("targetLease") or {}).get("leaseId") or ""
            ) if isinstance(parameters.get("targetLease"), dict) else "",
            "targetApps": target_apps,
            "projectId": hashlib.sha256(project.casefold().encode("utf-8")).hexdigest()[:16]
            if project else "",
            "permissionSource": str(permission.get("source") or ""),
            "permissionScopeFingerprint": scope_fingerprint,
            "permissionScope": {
                "recipe": str(scope.get("recipe") or ""),
                "risk": str(scope.get("risk") or ""),
                "appBound": bool(scope.get("app")),
                "projectBound": bool(scope.get("project")),
                "expiresAt": str(scope.get("expires_at") or scope.get("expiresAt") or ""),
            },
            "workspaceBindingState": str(binding.get("state") or ""),
            "workspaceBindingRelation": str(binding.get("relation") or ""),
            "targetProcessBound": bool(binding.get("targetProcessId")),
            "workspaceProcessBound": bool(binding.get("workspaceProcessId")),
            "terminalEvidenceState": str(terminal.get("state") or ""),
            "terminalEvidenceMethod": str(terminal.get("method") or "")[:120],
            "terminalExitCodeObserved": terminal.get("exitCode") is not None,
            "terminalExitCode": terminal.get("exitCode"),
            "terminalWindowLineCount": int(terminal_window.get("lineCount") or 0),
            "browserEvidenceState": str(browser.get("state") or ""),
            "browserEvidenceMethod": str(browser.get("method") or "")[:120],
            "browserSelectorObserved": bool(browser.get("selector")),
            "browserAccessibleNameObserved": bool(browser_node.get("accessibleName")),
            "browserNetworkFailureCount": len(browser.get("networkFailures") or []),
            "browserCoordinatesObserved": bool((browser.get("coordinates") or {}).get("pointerScreenPhysical"))
            if isinstance(browser.get("coordinates"), dict) else False,
            "componentLinkState": str(component_link.get("state") or ""),
            "componentCandidateCount": len(component_candidates),
            "componentTopConfidence": float(component_candidates[0].get("confidence") or 0)
            if component_candidates else 0.0,
            "componentAutoModificationAllowed": component_link.get("autoModificationAllowed") is True,
        }

    def _append_execution_audit(
        self,
        plan: OperationPlan,
        receipt: dict[str, Any],
        lease_validation: dict[str, Any] | None,
    ) -> None:
        output = receipt.get("output")
        output = dict(output) if isinstance(output, dict) else {}
        artifact_ids = output.get("artifactIds")
        artifact_ids = artifact_ids if isinstance(artifact_ids, list) else []
        objects = plan.parameters.get("objects")
        objects = [dict(item) for item in objects or [] if isinstance(item, dict)]
        context = self._audit_context(plan.parameters, objects)
        target_lease_valid = None
        if isinstance(lease_validation, dict):
            target_lease_valid = lease_validation.get("valid")
        self.audit.append("recipe.executed", {
            "planId": plan.id,
            "receiptId": str(receipt.get("id") or ""),
            "taskId": str(output.get("taskId") or ""),
            "artifactIds": [
                str(item)
                for item in artifact_ids
                if str(item)
            ][:32],
            "artifactCount": len(artifact_ids),
            "recipeId": plan.recipe_id,
            "provider": plan.provider,
            "status": str(receipt.get("status") or ""),
            "verified": receipt.get("verified") is True,
            "error": receipt.get("error"),
            "undoAvailable": isinstance(receipt.get("undo"), dict),
            "targetLeaseValid": target_lease_valid,
            **context,
        })

    def _load_signing_key(self) -> bytes:
        path = self.root / "plan-signing.key"
        if path.exists():
            try:
                value = bytes.fromhex(path.read_text(encoding="ascii").strip())
            except (OSError, ValueError) as exc:
                raise RuntimeError(f"plan signing key is corrupt: {type(exc).__name__}") from exc
            if len(value) != 32:
                raise RuntimeError("plan signing key has invalid length")
            return value
        path.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_bytes(32)
        temp = path.with_suffix(".key.tmp")
        temp.write_text(value.hex() + "\n", encoding="ascii", newline="\n")
        os.replace(temp, path)
        return value

    def _plan_signature(self, plan: OperationPlan) -> str:
        payload = {
            "id": plan.id,
            "recipeId": plan.recipe_id,
            "command": plan.command,
            "risk": plan.risk.value,
            "provider": plan.provider,
            "objectIds": list(plan.object_ids),
            "parameters": plan.parameters,
            "preview": plan.preview,
            "requiresConfirmation": plan.requires_confirmation,
            "idempotencyKey": plan.idempotency_key,
        }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        return hmac.new(self._signing_key, raw, hashlib.sha256).hexdigest()

    def _default_agent_starter(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = dict(payload)
        request["provider"] = str(request.get("provider") or self.settings.agents.preferred)
        request["cwd"] = str(request.get("cwd") or Path.cwd())
        request["deliveryMode"] = self.settings.agents.delivery_mode
        request["cwdMatch"] = self.settings.agents.cwd_match
        request["autoAttach"] = self.settings.agents.auto_attach
        if not str(request.get("sessionId") or "").strip():
            request["sessionId"] = str(
                self.settings.agents.session_bindings.get(request["provider"], "")
            )
        return AgentGateway(
            root=self.root,
            default_provider=self.settings.agents.preferred,
        ).start(request)

    def _object_id(self, obj: dict[str, Any], index: int) -> str:
        explicit = str(obj.get("id") or obj.get("objectId") or "").strip()
        if explicit:
            return explicit
        digest = hashlib.sha256(
            json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()[:16]
        return f"object-{index}-{digest}"

    def _provider(self, recipe_id: str, parameters: dict[str, Any]) -> str:
        objects = [dict(item) for item in parameters.get("objects") or [] if isinstance(item, dict)]
        if recipe_id in {"text.ocr_copy", "text.ocr_clean"}:
            has_text = any(str(obj.get("content") or obj.get("text") or "").strip() for obj in objects)
            if has_text:
                return "clipboard"
            if self.ocr_available:
                return "native.ocr"
            parameters["capabilityFallback"] = "native_ocr_not_configured"
            requested = str(parameters.get("agent") or "")
            candidates = [requested] if requested else [
                self.settings.agents.preferred,
                "codex",
                "pi",
                "claude",
                "gemini",
                "cursor",
                "opencode",
                "aider",
            ]
            agent = next((item for item in candidates if self.agent_availability.get(item, False)), None)
            if agent is not None:
                parameters["agent"] = agent
                return "agent.task"
            return "unavailable:native_ocr_not_configured"
        if recipe_id == "vision.prompt_bridge":
            has_semantic_structure = any(
                str(obj.get("content") or obj.get("text") or "").strip()
                or bool(obj.get("elements"))
                for obj in objects
            )
            if not has_semantic_structure:
                parameters["capabilityFallback"] = "raw_screen_requires_vision_provider"
                requested = str(parameters.get("agent") or "")
                candidates = [requested] if requested else [
                    self.settings.agents.preferred,
                    "codex",
                    "pi",
                    "claude",
                    "gemini",
                    "cursor",
                    "opencode",
                    "aider",
                ]
                agent = next((item for item in candidates if self.agent_availability.get(item, False)), None)
                if agent is not None:
                    parameters["agent"] = agent
                    return "agent.task"
                return "unavailable:vision_provider_not_configured"
        if recipe_id in {"agent.handoff", "agent.background_task"}:
            requested = str(parameters.get("agent") or "")
            candidates = (
                [requested]
                if requested
                else [
                    self.settings.agents.preferred,
                    "codex",
                    "pi",
                    "claude",
                    "gemini",
                    "cursor",
                    "opencode",
                    "aider",
                ]
            )
            agent = next((item for item in candidates if self.agent_availability.get(item, False)), None)
            if agent is None:
                return f"unavailable:agent_not_available:{requested or self.settings.agents.preferred}"
            parameters["agent"] = agent
            return "agent.task"
        configured = dict(parameters.get("providerCapabilities") or {})
        override = str(parameters.get("provider") or "")
        if override and configured.get(override) is True:
            return override
        provider = _PROVIDER_BY_RECIPE[recipe_id]
        needs_agent_fallback = provider.startswith("unavailable:")
        if provider == "model.text" and not self.model_transform_available:
            needs_agent_fallback = True
            parameters["capabilityFallback"] = "direct_text_model_not_configured"
        elif provider.startswith("unavailable:"):
            parameters["capabilityFallback"] = provider.split(":", 1)[1]
        if needs_agent_fallback:
            requested = str(parameters.get("agent") or "")
            candidates = (
                [requested]
                if requested
                else [
                    self.settings.agents.preferred,
                    "codex",
                    "pi",
                    "claude",
                    "gemini",
                    "cursor",
                    "opencode",
                    "aider",
                ]
            )
            agent = next((item for item in candidates if self.agent_availability.get(item, False)), None)
            if agent is not None:
                parameters["agent"] = agent
                return "agent.task"
        return provider

    def plan(
        self,
        command: str,
        *,
        objects: list[dict[str, Any]] | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_objects = [dict(item) for item in objects or [] if isinstance(item, dict)]
        match = self.router.route(command, object_count=len(clean_objects))
        if match.recipe_id is None:
            return {"ok": False, "error": match.reason, "match": match.to_dict()}
        recipe = get_recipe(match.recipe_id)
        if self.settings.recipe_enabled.get(recipe.id, True) is False:
            return {"ok": False, "error": "recipe_disabled", "match": match.to_dict()}
        params = dict(parameters or {})
        if recipe.id in {"agent.handoff", "agent.background_task"} and not params.get("agent"):
            lowered_command = str(command or "").casefold()
            for agent_name in ("codex", "pi", "claude", "gemini", "cursor", "opencode", "aider"):
                if agent_name in lowered_command:
                    params["agent"] = agent_name
                    break
        attachment_candidates = self._attachment_candidates(
            clean_objects,
            list(params.get("attachments") or []),
        )
        capture_policy = build_capture_policy(
            self.capture_policy,
            clean_objects,
            attachments=attachment_candidates,
        )
        if capture_policy["deniedObjectIds"]:
            self.audit.append("capture.denied", {
                "recipeId": recipe.id,
                "objectCount": len(clean_objects),
                "deniedObjectIds": list(capture_policy["deniedObjectIds"]),
            })
            return {
                "ok": False,
                "error": "capture_policy_denied",
                "match": match.to_dict(),
                "deniedObjectIds": list(capture_policy["deniedObjectIds"]),
            }
        visual_relays: list[dict[str, Any]] = []
        effective_decisions = [dict(item) for item in capture_policy["decisions"]]
        selected_profile = self.settings.models.profile(str(params.get("modelProfileId") or "") or None)
        resolved_model_capabilities: dict[str, Any] | None = None
        if selected_profile is not None:
            resolved_model_capabilities = ModelCapabilityResolver().resolve(selected_profile)
            planner = VisualRelayPlanner()
            for index, obj in enumerate(clean_objects):
                source = dict(obj.get("source") or {}) if isinstance(obj.get("source"), dict) else {}
                visual_target = bool(
                    str(obj.get("kind") or "").casefold() in {
                        "screen_region", "ui-control", "image", "canvas", "video_frame",
                    }
                    or obj.get("elements")
                    or obj.get("appearance")
                    or any(source.get(key) for key in (
                        "path", "imagePath", "screenshotPath", "capturePath", "annotatedPath",
                    ))
                )
                if not visual_target:
                    continue
                decision = self.capture_policy.decide(obj)
                planned_relay = planner.plan(
                    profile=selected_profile,
                    resolved_capabilities=resolved_model_capabilities,
                    target=obj,
                    capture=decision,
                    intent=command,
                )
                if planned_relay.get("ok") is not True:
                    return {
                        "ok": False,
                        "error": str(planned_relay.get("error") or "visual_relay_failed"),
                        "match": match.to_dict(),
                    }
                relay = dict(planned_relay["relay"])
                visual_relays.append(relay)
                if relay.get("mode") != "direct_visual":
                    effective_decisions[index]["allowUpload"] = False
                    effective_decisions[index]["reason"] = str(relay.get("capabilityNotice") or "structured_visual_relay")
            direct_visual_paths = {
                str(item)
                for relay in visual_relays
                if relay.get("mode") == "direct_visual"
                for item in relay.get("attachments") or []
                if str(item)
            }
            formerly_allowed = list(capture_policy["uploadAllowedPaths"])
            capture_policy["uploadAllowedPaths"] = [
                item for item in formerly_allowed if str(item) in direct_visual_paths
            ]
            removed_by_model = [
                item for item in formerly_allowed if str(item) not in direct_visual_paths
            ]
            capture_policy["withheldVisualPaths"] = list(dict.fromkeys([
                *capture_policy["withheldVisualPaths"],
                *removed_by_model,
            ]))
            capture_policy["withheldVisualCount"] = len(capture_policy["withheldVisualPaths"])
            capture_policy["requiresExplicitConfirmation"] = bool(capture_policy["uploadAllowedPaths"])
            capture_policy["decisions"] = effective_decisions
        target_lease = TargetLease.create(
            clean_objects,
            selection_session_id=str(params.get("selectionSessionId") or ""),
            ttl_seconds=int(params.get("targetLeaseTtlSeconds") or 600),
        )
        capability_selection = self.capabilities.search(
            command,
            objects=clean_objects,
            selected_recipe_id=recipe.id,
            platform=str(params.get("platform") or "") or None,
            provider_availability=(
                dict(params.get("providerCapabilities") or {})
                if params.get("providerCapabilities") is not None
                else None
            ),
            limit=int(params.get("capabilityLimit") or 6),
        )
        context_packet = self.context_packets.build(
            command=command,
            recipe_id=recipe.id,
            objects=clean_objects,
            cwd=str(params.get("cwd") or Path.cwd()),
            target_lease=target_lease.to_dict(),
            capture_decisions=effective_decisions,
            capabilities=capability_selection,
            terminal_excerpt=str(params.get("terminalExcerpt") or ""),
            attachments=attachment_candidates,
            visual_relays=visual_relays,
        )
        params["targetLease"] = target_lease.to_dict()
        params["capturePolicy"] = capture_policy
        params["capabilitySelection"] = capability_selection
        params["contextPacket"] = context_packet
        params["visualRelays"] = visual_relays
        if selected_profile is not None and resolved_model_capabilities is not None:
            params["visualRelayProfile"] = {
                "profileId": selected_profile.id,
                "visionInput": resolved_model_capabilities.get("visionInput") or "unknown",
                "source": resolved_model_capabilities.get("source") or "unknown",
            }
        params["objects"] = clean_objects
        object_ids = tuple(self._object_id(obj, index) for index, obj in enumerate(clean_objects, 1))
        params.setdefault("referenceMode", match.reference_mode)
        app_scope = " ".join(
            str(value or "")
            for obj in clean_objects
            for value in (
                (obj.get("source") or {}).get("app") if isinstance(obj.get("source"), dict) else "",
                (obj.get("source") or {}).get("title") if isinstance(obj.get("source"), dict) else "",
            )
            if str(value or "").strip()
        )
        permission_decision = self.settings.permission_decision(
            recipe.id,
            recipe.risk.value,
            app=app_scope,
            project=str(params.get("cwd") or ""),
        )
        params["permissionDecision"] = permission_decision
        permission = str(permission_decision["decision"])
        provider = "denied" if permission == "deny" else self._provider(recipe.id, params)
        visual_attachment_count = sum(
            1
            for item in attachment_candidates
            if Path(str(item or "")).suffix.casefold()
            in {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".heic", ".avif"}
        )
        screenshot_upload = bool(
            provider == "agent.task"
            and capture_policy["uploadAllowedPaths"]
        )
        if provider == "agent.task":
            params["privacyPolicy"] = {
                "screenshotUploadAllowed": bool(capture_policy["uploadAllowedPaths"]),
                "visualAttachmentCount": visual_attachment_count,
                "uploadAllowedVisualCount": len(capture_policy["uploadAllowedPaths"]),
                "withheldVisualCount": int(capture_policy["withheldVisualCount"]),
                "requiresExplicitConfirmation": screenshot_upload,
            }
        requires_confirmation = permission == "confirm" or screenshot_upload
        canonical = json.dumps(
            {
                "recipe": recipe.id,
                "command": command,
                "objectIds": object_ids,
                "objects": clean_objects,
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        idempotency_key = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        unsigned_plan = OperationPlan(
            id=str(uuid.uuid4()),
            recipe_id=recipe.id,
            command=str(command or "").strip(),
            risk=recipe.risk,
            provider=provider,
            object_ids=object_ids,
            parameters=params,
            preview={
                "title": recipe.title_zh,
                "description": recipe.description_zh,
                "objectLabels": [str(item.get("label") or item.get("kind") or object_ids[index]) for index, item in enumerate(clean_objects)],
                "provider": provider,
                "permission": permission,
                "permissionSource": permission_decision["source"],
                "permissionScope": dict(permission_decision["scope"]),
                "privacy": dict(params.get("privacyPolicy") or {}),
                "workflowGraph": operation_graph(
                    recipe_id=recipe.id,
                    provider=provider,
                    permission=permission,
                    object_count=len(clean_objects),
                ),
            },
            requires_confirmation=requires_confirmation,
            idempotency_key=idempotency_key,
        )
        plan = OperationPlan(
            **{
                **unsigned_plan.__dict__,
                "integrity_token": self._plan_signature(unsigned_plan),
            },
        )
        self.audit.append("recipe.planned", {
            "planId": plan.id,
            "recipeId": recipe.id,
            "provider": provider,
            "risk": recipe.risk.value,
            "objectCount": len(clean_objects),
            "requiresConfirmation": plan.requires_confirmation,
            **self._audit_context(params, clean_objects),
        })
        return {"ok": True, "match": match.to_dict(), "plan": plan.to_dict()}

    def execute(self, plan_value: dict[str, Any], *, confirmed: bool = False) -> dict[str, Any]:
        plan = OperationPlan.from_dict(plan_value)
        if not plan.id or not plan.recipe_id or not plan.idempotency_key:
            return {"status": "failed", "verified": False, "error": "invalid_plan"}
        if not plan.integrity_token or not hmac.compare_digest(plan.integrity_token, self._plan_signature(plan)):
            return {"status": "failed", "verified": False, "error": "invalid_plan_signature"}
        if plan.requires_confirmation and not confirmed:
            return {
                "status": "confirmation_required",
                "verified": False,
                "error": "confirmation_required",
                "planId": plan.id,
                "recipeId": plan.recipe_id,
            }
        lease_validation: dict[str, Any] | None = None
        lease = plan.parameters.get("targetLease")
        if isinstance(lease, dict) and lease.get("requiresLiveValidation") is True and self.target_probe is not None:
            try:
                live_windows = self.target_probe(dict(lease))
                validation = validate_target_lease(lease, live_windows=live_windows)
            except Exception as exc:
                validation = None
                lease_validation = {
                    "valid": False,
                    "reason": f"target_lease_probe_failed:{type(exc).__name__}",
                }
            if validation is not None:
                lease_validation = validation.to_dict()
            if not lease_validation["valid"]:
                receipt = ExecutionReceipt(
                    id=str(uuid.uuid4()),
                    plan_id=plan.id,
                    recipe_id=plan.recipe_id,
                    status="failed",
                    provider=plan.provider,
                    verified=False,
                    verification={"targetLease": lease_validation},
                    error=str(lease_validation["reason"]),
                ).to_dict()
                self._append_execution_audit(plan, receipt, lease_validation)
                return receipt
        receipt_value = self.executors.execute(plan).to_dict()
        if lease_validation is not None:
            receipt_value["verification"]["targetLease"] = lease_validation
        receipt_output = receipt_value.get("output")
        receipt_output = dict(receipt_output) if isinstance(receipt_output, dict) else {}
        task_id = str(receipt_output.get("taskId") or "")
        if task_id:
            try:
                AgentTaskStore(self.root / "agent-tasks").link_provenance(
                    task_id,
                    plan_id=plan.id,
                    receipt_id=str(receipt_value.get("id") or ""),
                    recipe_id=plan.recipe_id,
                    source_object_ids=plan.object_ids,
                    retention_days=self.settings.privacy.retain_artifacts_days,
                    target_lease=(
                        dict(plan.parameters.get("targetLease") or {})
                        if isinstance(plan.parameters.get("targetLease"), dict)
                        else None
                    ),
                )
            except AgentTaskError as exc:
                # Custom/in-process agent starters may return a task id without
                # using Magic Pointer's durable task store.
                if str(exc) != "unknown task id":
                    self.audit.append("task.provenance_link_failed", {
                        "planId": plan.id,
                        "taskId": task_id,
                        "error": type(exc).__name__,
                    })
            except Exception as exc:
                self.audit.append("task.provenance_link_failed", {
                    "planId": plan.id,
                    "taskId": task_id,
                    "error": type(exc).__name__,
                })
        try:
            registered_artifacts = self.artifacts.register_receipt(
                plan,
                receipt_value,
                retention_days=self.settings.privacy.retain_artifacts_days,
            )
        except Exception as exc:
            registered_artifacts = []
            self.audit.append("artifact.index_failed", {
                "planId": plan.id,
                "receiptId": str(receipt_value.get("id") or ""),
                "error": f"{type(exc).__name__}",
            })
        if registered_artifacts:
            output = receipt_value.get("output")
            output = dict(output) if isinstance(output, dict) else {}
            output["artifactIds"] = [
                str(item["artifactId"])
                for item in registered_artifacts
            ]
            receipt_value["output"] = output
        try:
            self.provenance.record_execution(plan, receipt_value)
        except ProvenanceError as exc:
            self.audit.append("provenance.index_failed", {
                "planId": plan.id,
                "receiptId": str(receipt_value.get("id") or ""),
                "error": type(exc).__name__,
            })
        try:
            self.skill_candidates.observe_execution(plan, receipt_value)
        except SkillCandidateError as exc:
            self.audit.append("skill.candidate_observation_failed", {
                "planId": plan.id,
                "receiptId": str(receipt_value.get("id") or ""),
                "error": type(exc).__name__,
            })
        except Exception as exc:
            self.audit.append("skill.candidate_observation_failed", {
                "planId": plan.id,
                "receiptId": str(receipt_value.get("id") or ""),
                "error": type(exc).__name__,
            })
        self._append_execution_audit(plan, receipt_value, lease_validation)
        return receipt_value
