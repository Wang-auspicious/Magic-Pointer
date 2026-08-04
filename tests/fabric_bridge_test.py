from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

from app.fabric.agent_context_handoff import AgentContextHandoffStore
from app.fabric.schema import OperationPlan, RiskLevel
from app.fabric.skill_candidates import SkillCandidateStore


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "fabric_bridge.py"


def _load_bridge_module():
    spec = importlib.util.spec_from_file_location("fabric_bridge_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _call(tmp_path: Path, payload: dict) -> tuple[int, dict]:
    env = dict(os.environ)
    env["MAGIC_POINTER_USER_DATA_DIR"] = str(tmp_path)
    completed = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
        env=env,
        timeout=15,
        check=False,
    )
    return completed.returncode, json.loads(completed.stdout.strip().splitlines()[-1])


def test_bridge_lists_catalog_and_real_provider_state(tmp_path: Path) -> None:
    code, catalog = _call(tmp_path, {"operation": "catalog"})
    assert code == 0
    assert catalog["ok"] is True
    assert len(catalog["recipes"]) >= 30

    code, providers = _call(tmp_path, {"operation": "providers"})
    assert code == 0
    assert providers["ok"] is True
    assert {item["id"] for item in providers["providers"]} >= {"codex", "pi", "claude", "gemini"}
    assert all("sessionSupport" in item and "backgroundSteerable" in item for item in providers["providers"])


def test_bridge_forwards_active_only_to_agent_session_gateway(tmp_path: Path, monkeypatch) -> None:
    bridge = _load_bridge_module()
    calls: list[dict] = []
    output: list[dict] = []

    class _Gateway:
        def __init__(self, **_kwargs) -> None:
            pass

        def sessions(self, **kwargs):
            calls.append(kwargs)
            return []

    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(bridge, "AgentGateway", _Gateway)
    monkeypatch.setattr(bridge, "read_json_line", lambda: {
        "operation": "agent.sessions",
        "cwd": str(tmp_path),
        "activeOnly": True,
        "limit": 5,
    })
    monkeypatch.setattr(bridge, "write_json", output.append)

    assert bridge.main() == 0
    assert calls[0]["active_only"] is True
    assert calls[0]["limit"] == 5
    assert output[0]["sessions"] == []


def test_bridge_routes_plans_and_executes_safe_recipe(tmp_path: Path) -> None:
    obj = {"id": "one", "kind": "text", "content": "0800 22 44 88"}
    code, routed = _call(tmp_path, {"operation": "route", "command": "号码去掉空格再复制", "objects": [obj]})
    assert code == 0
    assert routed["match"]["recipeId"] == "text.ocr_clean"

    code, executed = _call(
        tmp_path,
        {
            "operation": "execute",
            "command": "recipe: research.evidence_card",
            "objects": [obj],
            "confirmed": True,
        },
    )
    assert code == 0
    assert executed["receipt"]["status"] == "succeeded"
    assert Path(executed["receipt"]["output"]["artifact"]).exists()
    assert len(executed["receipt"]["output"]["artifactIds"]) == 1

    code, indexed = _call(tmp_path, {"operation": "artifacts.list"})
    assert code == 0
    assert indexed["artifacts"][0]["planId"] == executed["plan"]["id"]
    assert indexed["artifacts"][0]["receiptId"] == executed["receipt"]["id"]

    code, objects = _call(tmp_path, {"operation": "provenance.objects"})
    assert code == 0
    assert [item["objectId"] for item in objects["objects"]] == ["one"]

    code, trace = _call(tmp_path, {
        "operation": "provenance.trace",
        "objectId": "one",
    })
    assert code == 0
    assert trace["trace"]["plans"][0]["planId"] == executed["plan"]["id"]
    assert trace["trace"]["artifacts"][0]["artifactId"] == indexed["artifacts"][0]["artifactId"]
    assert trace["trace"]["artifacts"][0]["sourceObjectIds"] == ["one"]

    code, cleanup = _call(tmp_path, {
        "operation": "artifacts.cleanup",
        "confirmed": False,
    })
    assert code == 0
    assert cleanup["cleanup"]["status"] == "confirmation_required"


def test_map_execute_result_reports_queued_agent_task_as_accepted_not_failure() -> None:
    bridge = _load_bridge_module()
    planned = {
        "match": {"recipeId": "agent.handoff"},
        "plan": {"recipeId": "agent.handoff", "parameters": {"agent": "pi"}},
    }
    receipt = {
        "status": "accepted",
        "verified": False,
        "output": {"taskId": "task-9", "provider": "pi", "status": "queued"},
    }
    result = bridge.map_execute_result(planned, receipt)
    assert result["ok"] is True
    assert result["state"] == "accepted"
    assert result["provider"] == "pi"
    assert result["taskId"] == "task-9"
    assert "尚未完成" in result["message"]
    assert result["receipt"] is receipt

    completed = bridge.map_execute_result(planned, {"status": "succeeded", "verified": True, "output": {}})
    assert completed["ok"] is True
    assert completed["state"] == "completed"

    failed = bridge.map_execute_result(planned, {"status": "verification_failed", "error": "clipboard_readback_mismatch"})
    assert failed["ok"] is False
    assert failed["state"] == "verification_failed"
    assert failed["error"] == "clipboard_readback_mismatch"


def test_bridge_unknown_operation_fails_closed(tmp_path: Path) -> None:
    code, result = _call(tmp_path, {"operation": "destroy_everything"})
    assert code == 1
    assert result["ok"] is False
    assert "unknown operation" in result["error"]


def test_bridge_searches_only_a_bounded_relevant_capability_set(tmp_path: Path) -> None:
    code, result = _call(tmp_path, {
        "operation": "capabilities.search",
        "command": "让 Codex 修这个界面",
        "selectedRecipeId": "agent.handoff",
        "objects": [{"id": "screen-1", "kind": "screen_region"}],
        "limit": 6,
    })
    assert code == 0
    assert result["ok"] is True
    assert 3 <= len(result["capabilities"]) <= 6
    assert result["capabilities"][0]["id"] == "agent.handoff"


def test_bridge_task_list_and_recover_are_real_empty_states(tmp_path: Path) -> None:
    code, listed = _call(tmp_path, {"operation": "task.list", "limit": 20})
    assert code == 0
    assert listed == {"ok": True, "tasks": []}
    code, recovered = _call(tmp_path, {"operation": "task.recover"})
    assert code == 0
    assert recovered == {"ok": True, "tasks": []}


def test_browser_status_honors_disabled_setting_without_fake_connection(tmp_path: Path) -> None:
    code, defaults = _call(tmp_path, {"operation": "settings.get"})
    assert code == 0
    settings = defaults["settings"]
    settings["connections"] = {
        "browser_devtools_enabled": False,
        "browser_devtools_endpoints": ["http://127.0.0.1:65431"],
    }
    code, saved = _call(tmp_path, {"operation": "settings.save", "settings": settings})
    assert code == 0
    assert saved["settings"]["connections"]["browser_devtools_enabled"] is False

    code, status = _call(tmp_path, {"operation": "browser.status"})

    assert code == 0
    assert status == {
        "ok": True,
        "state": "disabled",
        "configuredEndpointCount": 1,
        "reachableEndpointCount": 0,
        "pageCount": 0,
        "endpoints": ["http://127.0.0.1:65431"],
        "reason": "disabled_by_user",
    }


def test_cli_plan_can_resume_in_gui_with_same_workflow_and_approval(tmp_path: Path) -> None:
    payload = {
        "operation": "plan",
        "surface": "cli",
        "command": "recipe: research.evidence_card",
        "objects": [{"id": "claim-1", "kind": "text", "content": "bounded claim"}],
        "parameters": {"cwd": str(tmp_path)},
    }
    code, planned = _call(tmp_path, payload)
    assert code == 0
    workflow_id = planned["workflowTask"]["taskId"]
    assert planned["workflowTask"]["approvalState"] == "pending"

    code, listed = _call(tmp_path, {"operation": "workflow.list", "surface": "gui"})
    assert code == 0
    resumed = next(item for item in listed["workflows"] if item["taskId"] == workflow_id)
    assert resumed["approvalState"] == "pending"
    assert resumed["surfaceHistory"] == ["cli", "gui"]

    code, approved = _call(tmp_path, {
        "operation": "workflow.approve",
        "surface": "gui",
        "taskId": workflow_id,
        "confirmed": True,
    })
    assert code == 0
    assert approved["workflowTask"]["taskId"] == workflow_id
    assert approved["workflowTask"]["approvalState"] == "approved"

    code, executed = _call(tmp_path, {
        "operation": "workflow.execute",
        "surface": "cli",
        "taskId": workflow_id,
    })
    assert code == 0
    assert executed["workflowTask"]["taskId"] == workflow_id
    assert executed["receipt"]["status"] == "succeeded"

    code, duplicate = _call(tmp_path, {
        "operation": "workflow.execute",
        "surface": "gui",
        "taskId": workflow_id,
    })
    assert code == 0
    assert duplicate["reused"] is True
    assert duplicate["receipt"]["id"] == executed["receipt"]["id"]


def test_repeated_direct_execute_reuses_workflow_and_does_not_execute_twice(tmp_path: Path) -> None:
    payload = {
        "operation": "execute",
        "surface": "cli",
        "command": "recipe: research.evidence_card",
        "objects": [{"id": "claim-1", "kind": "text", "content": "one claim"}],
        "parameters": {"cwd": str(tmp_path)},
        "confirmed": True,
    }

    code, first = _call(tmp_path, payload)
    assert code == 0
    code, second = _call(tmp_path, payload)

    assert code == 0
    assert second["workflowTask"]["taskId"] == first["workflowTask"]["taskId"]
    assert second["receipt"]["id"] == first["receipt"]["id"]
    assert second["workflowReused"] is True


def test_agent_context_switch_requires_confirmation_without_repeating_scene(tmp_path: Path) -> None:
    packet = {
        "schemaVersion": 2,
        "packetId": "packet-n14-bridge",
        "intent": {"command": "fix", "recipeId": "agent.handoff"},
        "objects": [{"id": "one", "kind": "button", "label": "Save", "source": {}}],
        "workspace": {"cwd": str(tmp_path)},
        "privacy": {},
    }
    sealed = AgentContextHandoffStore(tmp_path / "agent-contexts").seal(
        packet,
        prompt="provider-neutral",
        attachments=[],
        permission="write",
        privacy={},
    )

    code, listed = _call(tmp_path, {"operation": "agent.contexts.list"})
    assert code == 0
    assert listed["contexts"][0]["contextId"] == sealed["contextId"]
    assert listed["contexts"][0]["contextPacketDigest"] == sealed["contextPacketDigest"]

    code, preview = _call(tmp_path, {
        "operation": "agent.context.dispatch",
        "contextId": sealed["contextId"],
        "provider": "pi",
        "confirmed": False,
    })
    assert code == 0
    assert preview["state"] == "confirmation_required"
    assert preview["context"]["contextId"] == sealed["contextId"]


def test_bridge_lists_drafts_and_installs_disabled_skill_candidates(tmp_path: Path) -> None:
    store = SkillCandidateStore(tmp_path)
    for index in range(3):
        plan = OperationPlan(
            id=f"plan-bridge-n16-{index}",
            recipe_id="agent.handoff",
            command=f"verified handoff {index}",
            risk=RiskLevel.EXTERNAL_SEND,
            provider="agent.task",
            object_ids=(f"object-bridge-{index}",),
            parameters={"objects": [{"id": f"object-bridge-{index}", "kind": "screen_region"}]},
            preview={"title": "Agent handoff"},
            requires_confirmation=True,
            idempotency_key=f"bridge-n16-{index}",
            integrity_token="signed",
        )
        observed = store.observe_execution(plan, {
            "id": f"receipt-bridge-n16-{index}",
            "status": "succeeded",
            "verified": True,
            "output": {},
        })
    candidate = observed["candidate"]
    assert candidate and candidate["state"] == "candidate_disabled"

    code, listed = _call(tmp_path, {"operation": "skills.candidates.list", "limit": 10})
    assert code == 0
    assert listed["ok"] is True
    assert listed["state"] == "completed"
    assert listed["candidates"][0]["candidateId"] == candidate["candidateId"]

    code, draft = _call(tmp_path, {
        "operation": "skills.candidates.draft",
        "candidateId": candidate["candidateId"],
    })
    assert code == 0
    assert draft["ok"] is True
    assert draft["state"] == "completed"
    assert draft["draft"]["candidate"]["candidateId"] == candidate["candidateId"]
    assert draft["draft"]["content"].startswith("---\nname:")
    review_token = draft["draft"]["reviewToken"]

    code, preview = _call(tmp_path, {
        "operation": "skills.candidates.install",
        "candidateId": candidate["candidateId"],
        "reviewToken": review_token,
        "confirmed": False,
    })
    assert code == 0
    assert preview["ok"] is True
    assert preview["state"] == "confirmation_required"
    assert not (tmp_path / "managed-skills").exists()

    code, installed = _call(tmp_path, {
        "operation": "skills.candidates.install",
        "candidateId": candidate["candidateId"],
        "reviewToken": review_token,
        "confirmed": True,
    })
    assert code == 0
    assert installed["ok"] is True
    assert installed["state"] == "installed_disabled"
    assert installed["install"]["candidate"]["enabled"] is False
    assert Path(installed["install"]["installedPath"]).exists()
