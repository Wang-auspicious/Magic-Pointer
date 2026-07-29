from __future__ import annotations

import json
import os
import sys
import uuid
import webbrowser
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.catalog import public_recipe_catalog
from app.fabric.capabilities import CapabilityRegistry
from app.fabric.artifacts import ArtifactRegistry
from app.fabric.agent_gateway import AgentGateway
from app.fabric.agent_context_handoff import AgentContextHandoffStore
from app.fabric.engine import FabricEngine
from app.fabric.mcp import CurrentObjectStore
from app.fabric.router import RecipeRouter
from app.fabric.settings import FabricSettings, SettingsStore
from app.fabric.task_store import AgentTaskStore
from app.fabric.workflow_task_store import WorkflowTaskStore
from app.fabric.provenance import ProvenanceIndex
from app.fabric.skill_candidates import SkillCandidateStore
from app.fabric.capture_policy import CapturePolicyEngine
from app.fabric.runtime_snapshot import build_runtime_snapshot
from app.adapters.browser_devtools_adapter import ChromeDevToolsProbe
from app.models.capability_resolver import ModelCapabilityResolver
from app.models.profiles import ModelProfile, ModelProfileStore
from app.models.runtime_client import ModelRuntimeClient
from app.models.visual_relay import VisualRelayPlanner
from app.system_context import list_visible_windows


if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _read() -> dict[str, Any]:
    value = json.loads(sys.stdin.read().lstrip("\ufeff") or "{}")
    if not isinstance(value, dict):
        raise ValueError("payload must be an object")
    return value


def _clipboard_writer(value: str) -> None:
    import pyperclip

    pyperclip.copy(value)


def _clipboard_reader() -> str:
    import pyperclip

    return str(pyperclip.paste() or "")


def map_execute_result(planned: dict[str, Any], receipt: dict[str, Any]) -> dict[str, Any]:
    """Map an execution receipt onto an honest bridge result.

    - verified local synchronous action -> ok:true, state "completed"
    - queued/running agent task -> ok:true, state "accepted" (explicitly not finished)
    - anything else -> ok:false with the receipt status preserved
    """
    status = str(receipt.get("status") or "")
    base = {"match": planned.get("match"), "plan": planned.get("plan"), "receipt": receipt}
    if status == "succeeded":
        return {"ok": True, "state": "completed", **base}
    if status == "accepted":
        task = receipt.get("output") if isinstance(receipt.get("output"), dict) else {}
        task_id = str(task.get("taskId") or "")
        plan = planned.get("plan") if isinstance(planned.get("plan"), dict) else {}
        parameters = plan.get("parameters") if isinstance(plan.get("parameters"), dict) else {}
        provider = str(task.get("provider") or parameters.get("agent") or "Agent")
        return {
            "ok": True,
            "state": "accepted",
            "provider": provider,
            "taskId": task_id,
            "message": f"已交给 {provider}，任务 {task_id} 正在运行，尚未完成。",
            **base,
        }
    result: dict[str, Any] = {"ok": False, "state": status or "failed", **base}
    if receipt.get("error"):
        result["error"] = str(receipt["error"])
    return result


def _workflow_execute(
    *,
    workflow_store: WorkflowTaskStore,
    engine: FabricEngine,
    task_id: str,
    surface: str,
) -> dict[str, Any]:
    claim = workflow_store.claim_execution(task_id, surface=surface)
    task = dict(claim.get("task") or {})
    if claim.get("reused") is True:
        receipt = dict(claim.get("receipt") or {})
        mapped = map_execute_result({"match": None, "plan": None}, receipt)
        return {
            **mapped,
            "workflowTask": task,
            "reused": True,
            "workflowReused": True,
        }
    if claim.get("claimed") is not True:
        reason = str(claim.get("reason") or "execution_not_claimed")
        return {
            "ok": True,
            "state": "confirmation_required" if reason == "approval_required" else "accepted",
            "workflowTask": task,
            "reason": reason,
            "reused": False,
            "workflowReused": False,
        }
    claim_id = str(claim["claimId"])
    plan = workflow_store.plan_for_claim(task_id, claim_id=claim_id)
    try:
        receipt = engine.execute(plan, confirmed=True)
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
    completed = workflow_store.complete_execution(
        task_id,
        claim_id=claim_id,
        receipt=receipt,
        surface=surface,
    )
    mapped = map_execute_result({"match": None, "plan": plan}, receipt)
    return {
        **mapped,
        "workflowTask": completed,
        "reused": False,
        "workflowReused": False,
    }


def _model_profile(settings: FabricSettings, profile_id: object) -> ModelProfile | None:
    return settings.models.profile(str(profile_id or "") or None)


def _save_model_profile(
    *,
    store: SettingsStore,
    settings: FabricSettings,
    profile: ModelProfile,
    resolver: ModelCapabilityResolver,
) -> ModelProfile:
    resolved = resolver.resolve(profile)
    persisted = replace(profile, resolved=resolved)
    profiles = [item for item in settings.models.profiles if item.id != persisted.id]
    profiles.append(persisted)
    profiles.sort(key=lambda item: item.id)
    settings.models = ModelProfileStore(
        profiles=tuple(profiles),
        default_profile_id=settings.models.default_profile_id,
    )
    store.save(settings)
    return persisted


def _set_default_model(
    *,
    store: SettingsStore,
    settings: FabricSettings,
    profile_id: str,
) -> None:
    if settings.models.profile(profile_id) is None:
        raise ValueError("model_profile_not_found")
    settings.models = ModelProfileStore(
        profiles=settings.models.profiles,
        default_profile_id=profile_id,
    )
    store.save(settings)


def _test_model_profile(
    *,
    store: SettingsStore,
    settings: FabricSettings,
    profile: ModelProfile,
    credential: str,
    client: ModelRuntimeClient,
    resolver: ModelCapabilityResolver,
) -> dict[str, Any]:
    text_probe = client.complete_text(
        profile,
        credential=credential,
        user_text="Reply with exactly OK.",
    )
    if text_probe.get("ok") is not True:
        return {
            "ok": False,
            "state": "failed",
            "error": str(text_probe.get("error") or "model_test_failed"),
            "evidence": {"profileId": profile.id, "apiMode": profile.api_mode},
        }
    vision_probe = client.probe_vision(profile, credential=credential)
    checked_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    vision_input = str(vision_probe.get("visionInput") or "unknown")
    persisted = profile
    if vision_probe.get("ok") is True and vision_input in {"yes", "no"}:
        resolved = resolver.resolve(profile, explicit_probe={
            "visionInput": vision_input,
            "evidence": "user-requested 1x1 image capability probe",
            "checkedAt": checked_at,
        })
        persisted = replace(profile, resolved=resolved)
        settings.models = ModelProfileStore(
            profiles=tuple(
                persisted if item.id == persisted.id else item
                for item in settings.models.profiles
            ),
            default_profile_id=settings.models.default_profile_id,
        )
        store.save(settings)
    return {
        "ok": True,
        "state": "completed",
        "text": text_probe["text"],
        "visionInput": vision_input,
        "profile": persisted.to_dict(),
        "evidence": {
            "profileId": profile.id,
            "apiMode": profile.api_mode,
            "probe": "text_connection_and_user_requested_1x1_image",
            "visionProbeState": str(vision_probe.get("state") or "failed"),
            "visionProbeError": str(vision_probe.get("error") or ""),
            "checkedAt": checked_at,
        },
    }


def main() -> int:
    try:
        payload = _read()
        operation = str(payload.get("operation") or "catalog")
        user_root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or ROOT / "data" / "runtime")
        store = SettingsStore(user_root / "fabric-settings.json")
        if operation == "runtime.snapshot":
            settings = store.load()
            result = {
                "ok": True,
                "snapshot": build_runtime_snapshot(
                    settings=settings,
                    runtime_evidence=dict(payload.get("runtimeEvidence") or {}),
                ),
            }
        elif operation == "catalog":
            result = {"ok": True, "recipes": public_recipe_catalog()}
        elif operation == "providers":
            result = {"ok": True, "providers": AgentGateway(root=user_root).providers()}
        elif operation == "agent.sessions":
            settings = store.load()
            result = {
                "ok": True,
                "state": "completed",
                "sessions": AgentGateway(root=user_root).sessions(
                    provider=str(payload.get("provider") or "") or None,
                    cwd=str(payload.get("cwd") or ROOT),
                    cwd_match=str(payload.get("cwdMatch") or settings.agents.cwd_match),
                    include_mismatch=payload.get("includeMismatch") is True,
                    limit=int(payload.get("limit") or 200),
                ),
                "cwd": str(Path(payload.get("cwd") or ROOT).resolve()),
            }
        elif operation == "agent.contexts.list":
            context_store = AgentContextHandoffStore(user_root / "agent-contexts")
            agent_tasks = AgentTaskStore(user_root / "agent-tasks")
            result = {
                "ok": True,
                "state": "completed",
                "contexts": context_store.reconcile(
                    agent_tasks.status,
                    limit=int(payload.get("limit") or 100),
                ),
            }
        elif operation == "agent.context.dispatch":
            contexts = AgentContextHandoffStore(user_root / "agent-contexts")
            context_id = str(payload.get("contextId") or "")
            provider = str(payload.get("provider") or "").strip().casefold()
            if payload.get("confirmed") is not True:
                result = {
                    "ok": True,
                    "state": "confirmation_required",
                    "context": contexts.get(context_id),
                    "provider": provider,
                }
            else:
                settings = store.load()
                gateway = AgentGateway(
                    root=user_root,
                    default_provider=settings.agents.preferred,
                )

                def start_context(request: dict[str, Any]) -> dict[str, Any]:
                    selected = str(request.get("provider") or "")
                    return gateway.start({
                        **request,
                        "deliveryMode": settings.agents.delivery_mode,
                        "cwdMatch": settings.agents.cwd_match,
                        "autoAttach": settings.agents.auto_attach,
                        "sessionId": str(
                            request.get("sessionId")
                            or settings.agents.session_bindings.get(selected, "")
                        ),
                    })

                dispatched = contexts.dispatch(
                    context_id,
                    provider=provider,
                    starter=start_context,
                    session_id=str(settings.agents.session_bindings.get(provider, "")),
                )
                result = {
                    "ok": dispatched.get("accepted") is True,
                    "state": "accepted" if dispatched.get("accepted") is True else "verification_failed",
                    "dispatch": dispatched,
                }
        elif operation == "settings.get":
            result = {"ok": True, "settings": store.load().to_dict()}
        elif operation == "settings.save":
            settings = FabricSettings.from_dict(dict(payload.get("settings") or {}))
            store.save(settings)
            result = {"ok": True, "settings": settings.to_dict()}
        elif operation == "browser.status":
            settings = store.load()
            connections = settings.connections
            if not connections.browser_devtools_enabled:
                result = {
                    "ok": True,
                    "state": "disabled",
                    "configuredEndpointCount": len(connections.browser_devtools_endpoints),
                    "reachableEndpointCount": 0,
                    "pageCount": 0,
                    "endpoints": list(connections.browser_devtools_endpoints),
                    "reason": "disabled_by_user",
                }
            else:
                result = {
                    "ok": True,
                    **ChromeDevToolsProbe(
                        endpoints=connections.browser_devtools_endpoints,
                    ).status(),
                }
        elif operation.startswith("models."):
            settings = store.load()
            resolver = ModelCapabilityResolver()
            profile_id = str(payload.get("profileId") or payload.get("id") or "").strip()
            if operation == "models.list":
                result = {
                    "ok": True,
                    "state": "completed",
                    "models": [
                        replace(profile, resolved=resolver.resolve(profile)).to_dict()
                        for profile in settings.models.profiles
                    ],
                    "defaultProfileId": settings.models.default_profile_id,
                    "evidence": {"count": len(settings.models.profiles)},
                }
            elif operation == "models.inspect":
                profile = _model_profile(settings, profile_id)
                if profile is None:
                    result = {
                        "ok": False,
                        "state": "failed",
                        "error": "model_profile_not_found",
                        "evidence": {"profileId": profile_id},
                    }
                else:
                    resolved = resolver.resolve(profile)
                    result = {
                        "ok": True,
                        "state": "completed",
                        "profile": replace(profile, resolved=resolved).to_dict(),
                        "evidence": {"profileId": profile.id, "capabilitySource": resolved["source"]},
                    }
            elif operation == "models.save":
                profile = ModelProfile.from_dict(dict(payload.get("profile") or {}))
                persisted = _save_model_profile(
                    store=store,
                    settings=settings,
                    profile=profile,
                    resolver=resolver,
                )
                result = {
                    "ok": True,
                    "state": "saved",
                    "profile": persisted.to_dict(),
                    "evidence": {"profileId": persisted.id, "capabilitySource": persisted.resolved["source"]},
                }
            elif operation == "models.delete":
                if not profile_id or settings.models.profile(profile_id) is None:
                    result = {
                        "ok": False,
                        "state": "failed",
                        "error": "model_profile_not_found",
                        "evidence": {"profileId": profile_id},
                    }
                else:
                    profiles = tuple(item for item in settings.models.profiles if item.id != profile_id)
                    settings.models = ModelProfileStore(
                        profiles=profiles,
                        default_profile_id=(
                            None if settings.models.default_profile_id == profile_id
                            else settings.models.default_profile_id
                        ),
                    )
                    store.save(settings)
                    result = {
                        "ok": True,
                        "state": "deleted",
                        "profileId": profile_id,
                        "evidence": {"remaining": len(profiles)},
                    }
            elif operation == "models.set_default":
                _set_default_model(store=store, settings=settings, profile_id=profile_id)
                result = {
                    "ok": True,
                    "state": "saved",
                    "defaultProfileId": profile_id,
                    "evidence": {"profileId": profile_id},
                }
            elif operation == "models.test":
                profile = _model_profile(settings, profile_id)
                credential = str(payload.pop("credential", "") or "")
                if profile is None:
                    result = {
                        "ok": False,
                        "state": "failed",
                        "error": "model_profile_not_found",
                        "evidence": {"profileId": profile_id},
                    }
                else:
                    result = _test_model_profile(
                        store=store,
                        settings=settings,
                        profile=profile,
                        credential=credential,
                        client=ModelRuntimeClient(),
                        resolver=resolver,
                    )
            else:
                raise ValueError(f"unknown operation: {operation}")
        elif operation == "visual_relay.plan":
            settings = store.load()
            profile = _model_profile(settings, payload.get("profileId") or payload.get("id"))
            if profile is None:
                result = {
                    "ok": False,
                    "state": "failed",
                    "error": "model_profile_not_found",
                    "evidence": {"profileId": str(payload.get("profileId") or payload.get("id") or "")},
                }
            else:
                target = dict(payload.get("target") or {})
                policy = CapturePolicyEngine(
                    settings.privacy.upload_screenshots,
                    settings.privacy.default_capture_mode,
                    settings.privacy.sensitive_apps,
                    settings.privacy.app_capture_modes,
                ).decide(target)
                resolved = ModelCapabilityResolver().resolve(profile)
                planned = VisualRelayPlanner().plan(
                    profile=profile,
                    resolved_capabilities=resolved,
                    target=target,
                    capture=policy,
                    intent=str(payload.get("intent") or payload.get("command") or ""),
                )
                result = {
                    **planned,
                    "evidence": {
                        "profileId": profile.id,
                        "capabilitySource": resolved["source"],
                        "captureMode": policy.mode,
                    },
                }
        elif operation == "audit.tail":
            engine = FabricEngine(root=user_root, settings=store.load())
            result = {"ok": True, "events": engine.audit.tail(int(payload.get("limit") or 100))}
        elif operation == "current_object":
            episode = CurrentObjectStore(user_root / "current-object.json").read()
            result = (
                {"ok": False, "error": "no_frozen_object"}
                if episode is None
                else {"ok": True, "episode": episode}
            )
        elif operation == "capabilities.search":
            capabilities = CapabilityRegistry().search(
                str(payload.get("command") or ""),
                objects=[
                    dict(item)
                    for item in payload.get("objects") or []
                    if isinstance(item, dict)
                ],
                selected_recipe_id=str(payload.get("selectedRecipeId") or "") or None,
                platform=str(payload.get("platform") or "") or None,
                provider_availability=(
                    dict(payload.get("providerAvailability") or {})
                    if payload.get("providerAvailability") is not None
                    else None
                ),
                limit=int(payload.get("limit") or 6),
            )
            result = {"ok": True, "capabilities": capabilities}
        elif operation == "artifacts.list":
            result = {
                "ok": True,
                "artifacts": ArtifactRegistry(user_root).list(
                    limit=int(payload.get("limit") or 100)
                ),
            }
        elif operation == "skills.candidates.list":
            result = {
                "ok": True,
                "state": "completed",
                "candidates": SkillCandidateStore(user_root).list(
                    limit=int(payload.get("limit") or 100)
                ),
            }
        elif operation == "skills.candidates.draft":
            result = {
                "ok": True,
                "state": "completed",
                "draft": SkillCandidateStore(user_root).draft(
                    str(payload.get("candidateId") or "")
                ),
            }
        elif operation == "skills.candidates.install":
            installed = SkillCandidateStore(user_root).install(
                str(payload.get("candidateId") or ""),
                confirmed=payload.get("confirmed") is True,
                review_token=str(payload.get("reviewToken") or ""),
            )
            result = {
                "ok": True,
                "state": str(installed.get("status") or "completed"),
                "install": installed,
            }
        elif operation == "provenance.objects":
            result = {
                "ok": True,
                "state": "completed",
                "objects": ProvenanceIndex(user_root).objects(
                    limit=int(payload.get("limit") or 200),
                ),
            }
        elif operation == "provenance.trace":
            result = {
                "ok": True,
                "state": "completed",
                "trace": ProvenanceIndex(user_root).trace(
                    str(payload.get("objectId") or ""),
                ),
            }
        elif operation == "artifacts.cleanup":
            cleanup = ArtifactRegistry(user_root).cleanup_expired(
                confirmed=payload.get("confirmed") is True,
            )
            result = {"ok": True, "cleanup": cleanup}
        elif operation == "artifacts.restore":
            if payload.get("confirmed") is not True:
                result = {
                    "ok": True,
                    "restore": {
                        "status": "confirmation_required",
                        "artifactId": str(payload.get("artifactId") or ""),
                    },
                }
            else:
                result = {
                    "ok": True,
                    "restore": ArtifactRegistry(user_root).restore(
                        str(payload.get("artifactId") or "")
                    ),
                }
        elif operation.startswith("task."):
            tasks = AgentTaskStore(user_root / "agent-tasks")
            gateway = AgentGateway(
                root=user_root,
                task_store=tasks,
                target_probe=lambda _lease: list_visible_windows(),
            )
            task_id = str(payload.get("taskId") or "")
            if operation == "task.status":
                task = gateway.status(task_id)
            elif operation == "task.cancel":
                task = tasks.cancel(task_id)
            elif operation == "task.steer":
                task = tasks.steer(task_id, str(payload.get("message") or ""))
            elif operation == "task.resume":
                task = tasks.resume(task_id)
            elif operation == "task.reconfirm_target":
                if payload.get("confirmed") is not True:
                    task = {
                        "taskId": task_id,
                        "status": "confirmation_required",
                        "reconfirmationRequired": True,
                    }
                else:
                    task = gateway.reconfirm_target(
                        task_id,
                        confirmed_windows=list_visible_windows(),
                    )
            elif operation == "task.list":
                result = {
                    "ok": True,
                    "tasks": gateway.list(limit=int(payload.get("limit") or 100)),
                }
                print(json.dumps(result, ensure_ascii=False))
                return 0
            elif operation == "task.recover":
                result = {"ok": True, "tasks": gateway.list(limit=500)}
                print(json.dumps(result, ensure_ascii=False))
                return 0
            else:
                raise ValueError(f"unknown operation: {operation}")
            result = {"ok": True, "task": task}
        elif operation.startswith("workflow."):
            surface = str(payload.get("surface") or "gui")
            workflows = WorkflowTaskStore(user_root / "workflow-tasks")
            if operation == "workflow.list":
                result = {
                    "ok": True,
                    "state": "completed",
                    "workflows": workflows.list(
                        surface=surface,
                        limit=int(payload.get("limit") or 100),
                    ),
                }
            elif operation == "workflow.get":
                result = {
                    "ok": True,
                    "state": "completed",
                    "workflowTask": workflows.get(
                        str(payload.get("taskId") or ""),
                        surface=surface,
                    ),
                }
            elif operation == "workflow.approve":
                if payload.get("confirmed") is not True:
                    result = {
                        "ok": True,
                        "state": "confirmation_required",
                        "workflowTask": workflows.get(
                            str(payload.get("taskId") or ""),
                            surface=surface,
                        ),
                    }
                else:
                    result = {
                        "ok": True,
                        "state": "ready",
                        "workflowTask": workflows.approve(
                            str(payload.get("taskId") or ""),
                            surface=surface,
                        ),
                    }
            elif operation == "workflow.execute":
                engine = FabricEngine(
                    root=user_root,
                    settings=store.load(),
                    clipboard_writer=_clipboard_writer,
                    clipboard_reader=_clipboard_reader,
                    url_opener=webbrowser.open,
                    target_probe=lambda _lease: list_visible_windows(),
                )
                result = _workflow_execute(
                    workflow_store=workflows,
                    engine=engine,
                    task_id=str(payload.get("taskId") or ""),
                    surface=surface,
                )
            else:
                raise ValueError(f"unknown operation: {operation}")
        else:
            objects = [dict(item) for item in payload.get("objects") or [] if isinstance(item, dict)]
            command = str(payload.get("command") or "")
            if operation == "route":
                result = {"ok": True, "match": RecipeRouter().route(command, object_count=len(objects)).to_dict()}
            elif operation in {"plan", "execute"}:
                engine = FabricEngine(
                    root=user_root,
                    settings=store.load(),
                    clipboard_writer=_clipboard_writer,
                    clipboard_reader=_clipboard_reader,
                    url_opener=webbrowser.open,
                    target_probe=lambda _lease: list_visible_windows(),
                )
                planned = engine.plan(command, objects=objects, parameters=dict(payload.get("parameters") or {}))
                if planned.get("ok") is not True:
                    result = planned
                else:
                    surface = str(payload.get("surface") or "cli")
                    workflows = WorkflowTaskStore(user_root / "workflow-tasks")
                    workflow_task = workflows.create(dict(planned["plan"]), surface=surface)
                    if operation == "plan":
                        result = {**planned, "workflowTask": workflow_task}
                    else:
                        if payload.get("confirmed") is True and workflow_task["approvalState"] == "pending":
                            workflow_task = workflows.approve(workflow_task["taskId"], surface=surface)
                        result = _workflow_execute(
                            workflow_store=workflows,
                            engine=engine,
                            task_id=workflow_task["taskId"],
                            surface=surface,
                        )
                        result["match"] = planned.get("match")
                        result["workflowReused"] = workflow_task.get("reused") is True or result.get("workflowReused") is True
            else:
                raise ValueError(f"unknown operation: {operation}")
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") is not False else 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
