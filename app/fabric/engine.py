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

from app.fabric.agents import AgentConnectorRegistry, AgentRequest
from app.fabric.audit import AuditStore
from app.fabric.catalog import get_recipe
from app.fabric.executors import FabricExecutors
from app.fabric.providers import AgentProviderDiscovery
from app.fabric.router import RecipeRouter
from app.fabric.schema import OperationPlan, RiskLevel
from app.fabric.settings import FabricSettings, SettingsStore
from app.fabric.task_store import AgentTaskStore
from app.fabric.workflow import operation_graph


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
    ) -> None:
        self.root = Path(root) if root is not None else SettingsStore().path.parent
        self._signing_key = self._load_signing_key()
        self.settings = settings or SettingsStore(self.root / "fabric-settings.json").load()
        self.router = RecipeRouter()
        self.audit = AuditStore(self.root / "fabric-audit.jsonl")
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
        provider = str(payload.get("provider") or self.settings.agents.preferred)
        command = "cursor-agent" if provider == "cursor" else provider
        executable = shutil.which(command)
        if not executable:
            raise RuntimeError(f"agent executable not found: {provider}")
        request = AgentRequest(
            provider=provider,
            prompt=str(payload.get("prompt") or ""),
            cwd=str(payload.get("cwd") or Path.cwd()),
            attachments=tuple(str(item) for item in payload.get("attachments") or []),
            permission=str(payload.get("permission") or "write"),
            session_id=str(payload.get("sessionId") or "") or None,
            metadata=dict(payload.get("privacy") or {}),
        )
        connector = AgentConnectorRegistry()
        invocation = (
            connector.build_rpc_command(request, executable=executable)
            if provider == "pi" and payload.get("background") is True
            else connector.build(request, executable=executable)
        )
        return AgentTaskStore(self.root / "agent-tasks").start(request, invocation)

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
        params["objects"] = clean_objects
        object_ids = tuple(self._object_id(obj, index) for index, obj in enumerate(clean_objects, 1))
        params.setdefault("referenceMode", match.reference_mode)
        permission = self.settings.permission_for(recipe.id, recipe.risk.value)
        provider = "denied" if permission == "deny" else self._provider(recipe.id, params)
        visual_attachment_count = sum(
            1
            for item in params.get("attachments") or []
            if Path(str(item or "")).suffix.casefold()
            in {".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".heic", ".avif"}
        )
        screenshot_upload = bool(
            provider == "agent.task"
            and self.settings.privacy.upload_screenshots
            and visual_attachment_count
        )
        if provider == "agent.task":
            params["privacyPolicy"] = {
                "screenshotUploadAllowed": self.settings.privacy.upload_screenshots is True,
                "visualAttachmentCount": visual_attachment_count,
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
            "recipeId": recipe.id,
            "provider": provider,
            "risk": recipe.risk.value,
            "objectCount": len(clean_objects),
            "requiresConfirmation": plan.requires_confirmation,
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
        receipt = self.executors.execute(plan)
        self.audit.append("recipe.executed", {
            "recipeId": plan.recipe_id,
            "provider": plan.provider,
            "status": receipt.status,
            "verified": receipt.verified,
            "error": receipt.error,
        })
        return receipt.to_dict()
