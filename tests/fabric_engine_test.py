from __future__ import annotations

import json
import threading
from pathlib import Path

from app.fabric.agents import AgentInvocation, AgentRequest
from app.fabric.artifacts import ArtifactRegistry
from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.engine import FabricEngine
from app.fabric.settings import FabricSettings
from app.fabric.task_store import AgentTaskStore
from app.fabric.workflow_task_store import WorkflowTaskError, WorkflowTaskStore
from app.models.profiles import ModelProfile, ModelProfileStore


def _object(object_id: str = "obj-1", content: str = "Hello  123  456") -> dict:
    return {
        "id": object_id,
        "kind": "text",
        "label": "selected text",
        "content": content,
        "source": {"app": "test", "title": "Fixture"},
    }


def test_every_catalog_recipe_can_be_planned_or_reports_precise_object_requirement(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    for recipe in RECIPE_CATALOG:
        objects = [_object(f"obj-{index}") for index in range(max(recipe.min_objects, 1))]
        if recipe.min_objects == 0:
            objects = []
        result = engine.plan(
            f"recipe: {recipe.id}",
            objects=objects,
            parameters={"cwd": str(tmp_path)},
        )
        assert result["ok"] is True, (recipe.id, result)
        assert result["plan"]["recipeId"] == recipe.id
        assert result["plan"]["provider"]
        assert result["plan"]["idempotencyKey"]


def test_idempotency_key_binds_the_effective_execution_parameters(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    first = engine.plan(
        "recipe: text.ocr_copy",
        objects=[_object()],
        parameters={"replacementText": "first"},
    )["plan"]
    second = engine.plan(
        "recipe: text.ocr_copy",
        objects=[_object()],
        parameters={"replacementText": "second"},
    )["plan"]

    assert first["idempotencyKey"] != second["idempotencyKey"]


def test_workflow_rejects_a_receipt_from_a_different_plan(tmp_path: Path) -> None:
    store = WorkflowTaskStore(tmp_path / "workflows")
    task = store.create(
        {
            "id": "plan-a",
            "recipeId": "text.ocr_copy",
            "idempotencyKey": "key-a",
            "integrityToken": "signed",
            "requiresConfirmation": False,
        },
        surface="gui",
    )
    claim = store.claim_execution(task["taskId"], surface="gui")

    try:
        store.complete_execution(
            task["taskId"],
            claim_id=claim["claimId"],
            receipt={
                "id": "receipt-b",
                "planId": "plan-b",
                "recipeId": "other.recipe",
                "status": "succeeded",
            },
            surface="gui",
        )
    except WorkflowTaskError as exc:
        assert "identity" in str(exc)
    else:
        raise AssertionError("foreign receipt was accepted")


def test_concurrent_engine_boots_share_one_atomic_signing_key(
    tmp_path: Path,
    monkeypatch,
) -> None:
    real_exists = Path.exists
    rendezvous = threading.Barrier(2)

    def synchronized_exists(path: Path) -> bool:
        exists = real_exists(path)
        if path.name == "plan-signing.key" and not exists:
            rendezvous.wait(timeout=2)
        return exists

    monkeypatch.setattr(Path, "exists", synchronized_exists)
    engines: list[FabricEngine] = []
    errors: list[BaseException] = []

    def boot_engine() -> None:
        try:
            engines.append(FabricEngine(root=tmp_path))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=boot_engine) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)

    assert errors == []
    assert len(engines) == 2
    assert engines[0]._signing_key == engines[1]._signing_key  # noqa: SLF001


def test_local_ocr_clean_requires_confirmation_then_verifies_clipboard(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    engine = FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )
    planned = engine.plan("把号码空格去掉再复制", objects=[_object()])
    plan = planned["plan"]
    assert plan["requiresConfirmation"] is True

    skipped = engine.execute(plan, confirmed=False)
    assert skipped["status"] == "confirmation_required"
    assert clipboard["value"] == ""

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert clipboard["value"] == "Hello123456"


def test_screen_region_ocr_uses_local_reader_and_copies_verified_text(tmp_path: Path) -> None:
    image = tmp_path / "pointer-region.png"
    image.write_bytes(b"fixture")
    clipboard = {"value": ""}
    reads: list[Path] = []
    engine = FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
        ocr_reader=lambda path: reads.append(path) or "订单号  138 0013 8000",
    )
    obj = {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "content": "",
        "bbox": [20, 30, 400, 260],
        "source": {
            "app": "screen",
            "path": str(image),
            "captureAttestation": {"status": "verified", "phase": "complete"},
        },
    }
    plan = engine.plan("识别这个屏幕对象中的文字并复制", objects=[obj])["plan"]
    assert plan["provider"] == "native.ocr"

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert clipboard["value"] == "订单号  138 0013 8000"
    assert reads == [image.resolve()]


def test_raw_screen_visual_prompt_routes_image_to_available_agent(tmp_path: Path) -> None:
    image = tmp_path / "pointer-region.png"
    image.write_bytes(b"fixture")
    starts: list[dict] = []
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "vision-task",
            "status": "queued",
        },
    )
    obj = {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "content": "",
        "bbox": [20, 30, 400, 260],
        "source": {"app": "screen", "path": str(image)},
    }
    plan = engine.plan(
        "为这个屏幕对象生成给非多模态模型使用的详细视觉提示",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )["plan"]
    assert plan["recipeId"] == "vision.prompt_bridge"
    assert plan["provider"] == "agent.task"
    assert plan["parameters"]["capabilityFallback"] == "raw_screen_requires_vision_provider"

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert receipt["verified"] is False
    assert starts[0]["attachments"] == []
    assert str(image) not in starts[0]["prompt"]
    assert starts[0]["privacy"] == {
        "screenshotUploadAllowed": False,
        "withheldVisualAttachmentCount": 1,
    }
    assert receipt["verification"]["terminalOutcomeVerified"] is False


def test_visual_agent_attachment_requires_enabled_privacy_setting_and_confirmation(tmp_path: Path) -> None:
    image = tmp_path / "pointer-region.png"
    image.write_bytes(b"fixture")
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.permissions.recipe_overrides["vision.prompt_bridge"] = "allow"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "vision-task",
            "status": "queued",
        },
    )
    obj = {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "source": {
            "app": "screen",
            "path": str(image),
            "captureAttestation": {"status": "verified", "phase": "complete"},
        },
    }
    plan = engine.plan(
        "为这个屏幕对象生成给非多模态模型使用的详细视觉提示",
        objects=[obj],
        parameters={"cwd": str(tmp_path), "attachments": [str(image)]},
    )["plan"]
    assert plan["requiresConfirmation"] is True
    assert plan["preview"]["privacy"]["requiresExplicitConfirmation"] is True
    assert engine.execute(plan, confirmed=False)["status"] == "confirmation_required"

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert starts[0]["attachments"] == [str(image)]
    assert starts[0]["privacy"]["screenshotUploadAllowed"] is True


def test_text_only_default_model_gets_visual_relay_and_zero_image_attachments(tmp_path: Path) -> None:
    image = tmp_path / "pointer-region.png"
    image.write_bytes(b"fixture")
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.permissions.recipe_overrides["vision.prompt_bridge"] = "allow"
    settings.permissions.recipe_overrides["agent.handoff"] = "allow"
    profile = ModelProfile.from_dict({
        "schemaVersion": 1,
        "id": "text-only",
        "displayName": "Local text model",
        "provider": "local",
        "baseUrl": "http://127.0.0.1:11434/v1",
        "model": "text-model",
        "apiMode": "local",
        "credentialRef": "",
        "enabled": True,
        "overrides": {"visionInput": "no", "audioInput": "auto", "toolCalls": "auto"},
    })
    settings.models = ModelProfileStore(profiles=(profile,), default_profile_id="text-only")
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {"taskId": "relay-task", "status": "queued"},
    )
    obj = {
        "id": "save-button",
        "kind": "screen_region",
        "label": "Save",
        "content": "Save",
        "bbox": [812, 124, 884, 158],
        "elements": [{"role": "button", "name": "Save"}],
        "hierarchy": ["Settings", "Actions"],
        "appearance": {"foreground": "#1266D4", "background": "#FFFFFF", "shape": "rounded-rectangle"},
        "neighbors": ["Cancel is 12px left"],
        "source": {
            "app": "code.exe",
            "title": "Settings",
            "path": str(image),
            "captureAttestation": {"status": "verified", "phase": "complete"},
        },
    }

    plan = engine.plan(
        "recipe: agent.handoff",
        objects=[obj],
        parameters={"cwd": str(tmp_path), "attachments": [str(image)], "agent": "pi"},
    )["plan"]

    assert plan["parameters"]["visualRelays"][0]["mode"] == "structured_text"
    assert plan["parameters"]["capturePolicy"]["uploadAllowedPaths"] == []
    assert str(image) not in json.dumps(plan["parameters"]["contextPacket"])
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert starts[0]["attachments"] == []
    assert "Visual relay for text-only models" in starts[0]["prompt"]
    assert "rounded-rectangle" in starts[0]["prompt"]


def test_visual_default_model_gets_allowed_crop_and_concise_locator(tmp_path: Path) -> None:
    image = tmp_path / "save.png"
    image.write_bytes(b"fixture")
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.permissions.recipe_overrides["agent.handoff"] = "allow"
    profile = ModelProfile.from_dict({
        "schemaVersion": 1,
        "id": "visual",
        "displayName": "Visual model",
        "provider": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
        "apiMode": "responses",
        "credentialRef": "credential:model:visual",
        "enabled": True,
        "overrides": {"visionInput": "yes", "audioInput": "auto", "toolCalls": "auto"},
    })
    settings.models = ModelProfileStore(profiles=(profile,), default_profile_id="visual")
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {"taskId": "visual-task", "status": "queued"},
    )
    obj = {
        "id": "save-button",
        "kind": "screen_region",
        "label": "Save",
        "content": "Save",
        "bbox": [812, 124, 884, 158],
        "elements": [{"role": "button", "name": "Save"}],
        "source": {
            "app": "code.exe",
            "title": "Settings",
            "path": str(image),
            "captureAttestation": {"status": "verified", "phase": "complete"},
        },
    }

    plan = engine.plan(
        "recipe: agent.handoff",
        objects=[obj],
        parameters={"cwd": str(tmp_path), "attachments": [str(image)], "agent": "pi"},
    )["plan"]
    relay = plan["parameters"]["visualRelays"][0]

    assert relay["mode"] == "direct_visual"
    assert relay["attachments"] == [str(image)]
    assert len(relay["locatorText"].splitlines()) == 4
    assert "local summary=" not in relay["locatorText"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert starts[0]["attachments"] == [str(image)]


def test_target_mismatch_visual_path_never_reaches_agent_payload(tmp_path: Path) -> None:
    image = tmp_path / "stale-target.png"
    image.write_bytes(b"fixture")
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    settings.permissions.recipe_overrides["vision.prompt_bridge"] = "allow"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "vision-task",
            "status": "queued",
        },
    )
    obj = {
        "id": "screen-stale",
        "kind": "screen_region",
        "label": "THIS",
        "source": {
            "app": "screen",
            "path": str(image),
            "captureAttestation": {
                "status": "target_mismatch",
                "phase": "after_capture",
            },
        },
    }

    plan = engine.plan(
        "为这个屏幕对象生成详细视觉提示",
        objects=[obj],
        parameters={"cwd": str(tmp_path), "attachments": [str(image)]},
    )["plan"]
    assert plan["parameters"]["capturePolicy"]["uploadAllowedPaths"] == []
    assert plan["parameters"]["capturePolicy"]["withheldVisualPaths"] == [str(image)]
    assert plan["parameters"]["capturePolicy"]["decisions"][0]["reason"] == "target_mismatch"

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert starts[0]["attachments"] == []
    assert str(image) not in starts[0]["prompt"]
    assert starts[0]["privacy"] == {
        "screenshotUploadAllowed": False,
        "withheldVisualAttachmentCount": 1,
    }


def test_background_agent_task_persists_target_lease_guard(tmp_path: Path) -> None:
    task_store = AgentTaskStore(
        tmp_path / "agent-tasks",
        spawn_worker=lambda _path: 991,
        process_alive=lambda pid: pid == 991,
    )

    def start_agent(payload: dict) -> dict:
        request = AgentRequest(
            provider="pi",
            prompt=str(payload["prompt"]),
            cwd=str(payload["cwd"]),
        )
        invocation = AgentInvocation(
            argv=("pi", "--mode", "rpc"),
            stdin=None,
            cwd=str(payload["cwd"]),
            protocol="jsonl-rpc",
        )
        return task_store.start(request, invocation)

    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=start_agent,
        target_probe=lambda _lease: [{
            "hwnd": 42,
            "pid": 314,
            "title": "Design review",
        }],
    )
    planned = engine.plan(
        "让 Pi 在后台处理这个，完成后提醒",
        objects=[{
            "id": "screen-1",
            "kind": "screen_region",
            "label": "THIS",
            "source": {
                "app": "design.exe",
                "title": "Design review",
                "hwnd": 42,
                "processId": 314,
            },
        }],
        parameters={"cwd": str(tmp_path), "agent": "pi"},
    )["plan"]

    receipt = engine.execute(planned, confirmed=True)
    raw = task_store._read(receipt["output"]["taskId"])
    assert receipt["status"] == "accepted"
    assert raw["targetLease"]["state"] == "active"
    assert raw["targetLease"]["lease"]["leaseId"] == planned["parameters"]["targetLease"]["leaseId"]
    assert raw["targetLease"]["lease"]["objectIds"] == ["screen-1"]


def test_table_to_csv_writes_source_mapped_artifact(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    table = _object(content="name\tvalue\nalpha\t1\nbeta\t2")
    table["kind"] = "table"
    plan = engine.plan("把这张表放进 Excel", objects=[table])["plan"]
    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    path = Path(receipt["output"]["artifact"])
    assert path.exists()
    assert path.read_text(encoding="utf-8").splitlines() == ["name,value", "alpha,1", "beta,2"]
    assert receipt["verification"]["rows"] == 3
    assert receipt["verification"]["columns"] == 2


def test_route_opens_only_allowlisted_url_after_confirmation(tmp_path: Path) -> None:
    opened: list[str] = []
    engine = FabricEngine(root=tmp_path, url_opener=lambda url: opened.append(url) or True)
    origin = _object("origin", "上海虹桥站")
    destination = _object("destination", "人民广场")
    plan = engine.plan("从这里到那个地方怎么走", objects=[origin, destination])["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert opened and opened[0].startswith("https://www.google.com/maps/dir/?api=1&")
    assert "origin=" in opened[0] and "destination=" in opened[0]


def test_research_evidence_card_is_traceable_and_local(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    obj = _object(content="A bounded scientific claim.")
    obj["source"] = {
        "app": "pdf",
        "path": str(tmp_path / "paper.pdf"),
        "page": 7,
        "bbox": [10, 20, 200, 80],
        "fileSha256": "abc123",
    }
    plan = engine.plan("把这段和图保存到项目笔记", objects=[obj])["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    markdown = Path(receipt["output"]["artifact"])
    assert markdown.exists()
    text = markdown.read_text(encoding="utf-8")
    assert "A bounded scientific claim." in text
    assert "page: 7" in text
    assert "abc123" in text


def test_provider_backed_recipe_never_claims_success_when_unconfigured(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path, agent_availability={"pi": False})
    plan = engine.plan(
        "把这张沙发放进这个房间",
        objects=[_object("sofa"), _object("room")],
    )["plan"]
    assert plan["provider"].startswith("unavailable:")
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "capability_unavailable"
    assert receipt["verified"] is False
    assert receipt["error"] == "image_provider_not_configured"


def test_model_text_recipe_uses_local_model_when_transform_wired(tmp_path: Path) -> None:
    """Review R3: a model.text recipe (text.summarize_route) must run through
    the local model transform when one is wired — the Notepad incident showed
    the production bridge left it unwired, so the plan fell back to
    agent.task and the user got AgentGatewayError instead of a summary."""
    calls: list[tuple] = []

    def fake_transform(command: str, context_text: str, recipe_id: str) -> str:
        calls.append((command, context_text, recipe_id))
        return "要点摘要：这是长文本的内容。"

    engine = FabricEngine(root=tmp_path, model_transform=fake_transform)
    plan = engine.plan(
        "总结成三点放到邮件",
        objects=[_object(content="长文本")],
        recipe_id="text.summarize_route",
    )["plan"]
    assert plan["provider"] == "model.text"
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert len(calls) == 1
    assert calls[0][0] == "总结成三点放到邮件"
    assert "长文本" in calls[0][1]
    assert calls[0][2] == "text.summarize_route"


def test_model_text_recipe_without_transform_is_honest(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path, agent_availability={})
    plan = engine.plan(
        "总结成三点放到邮件",
        objects=[_object(content="长文本")],
        recipe_id="text.summarize_route",
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "capability_unavailable"
    assert receipt["error"] == "text_model_not_configured"


def test_agent_handoff_starts_real_task_adapter_and_keeps_submit_false(tmp_path: Path) -> None:
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.agents.preferred = "pi"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "task-1",
            "status": "queued",
        },
        agent_availability={"pi": True},
    )
    plan = engine.plan(
        "让 Pi 修这个",
        objects=[_object(content="Save button overlaps the card")],
        parameters={"cwd": str(tmp_path)},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert receipt["verified"] is False
    assert starts[0]["provider"] == "pi"
    assert starts[0]["submit"] is False
    assert "Save button overlaps the card" in starts[0]["prompt"]
    assert receipt["output"]["taskId"] == "task-1"


def test_agent_handoff_seals_provider_neutral_context_for_later_switch(tmp_path: Path) -> None:
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.permissions.recipe_overrides["agent.handoff"] = "allow"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"codex": True},
        agent_starter=lambda payload: starts.append(payload) or {"taskId": "task-codex", "status": "queued"},
    )
    plan = engine.plan(
        "recipe: agent.handoff",
        objects=[{"id": "button-1", "kind": "button", "label": "Save", "content": "Save"}],
        parameters={"cwd": str(tmp_path), "agent": "codex"},
    )["plan"]

    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "accepted"
    assert receipt["output"]["contextHandoffId"]
    assert receipt["output"]["contextPacketDigest"] == starts[0]["contextPacketDigest"]
    assert starts[0]["contextPacket"] == plan["parameters"]["contextPacket"]
    assert starts[0]["provider"] == "codex"


def test_safe_local_task_route_is_idempotent(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.permissions.recipe_overrides["task.route"] = "allow"
    engine = FabricEngine(root=tmp_path, settings=settings)
    plan = engine.plan("把这个错误建成任务", objects=[_object(content="E42 failed")])["plan"]
    first = engine.execute(plan, confirmed=False)
    second = engine.execute(plan, confirmed=False)
    assert first["status"] == "succeeded"
    assert second["status"] == "succeeded"
    assert first["output"]["taskId"] == second["output"]["taskId"]
    tasks = json.loads((tmp_path / "tasks" / "tasks.json").read_text(encoding="utf-8"))
    assert len(tasks["tasks"]) == 1


def test_concurrent_task_adds_do_not_lose_updates(tmp_path: Path) -> None:
    """Red-team T5: lockless read-modify-write lost ~47% of concurrent adds
    and crashed one process with PermissionError on the shared .tmp handle."""
    settings = FabricSettings.defaults()
    settings.permissions.recipe_overrides["task.route"] = "allow"

    def add(engine: FabricEngine, index: int) -> str:
        plan = engine.plan(
            "把这个错误建成任务",
            objects=[_object(content=f"content {index}")],
        )["plan"]
        receipt = engine.execute(plan, confirmed=False)
        assert receipt["status"] == "succeeded", receipt
        return receipt["output"]["taskId"]

    engines = [FabricEngine(root=tmp_path, settings=settings) for _ in range(3)]
    results: list[list[str]] = [[], [], []]

    def worker(worker_index: int) -> None:
        for task_index in range(20):
            results[worker_index].append(add(engines[worker_index], worker_index * 100 + task_index))

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    all_ids = [task_id for batch in results for task_id in batch]
    assert len(all_ids) == 60
    assert len(set(all_ids)) == 60
    tasks = json.loads((tmp_path / "tasks" / "tasks.json").read_text(encoding="utf-8"))
    assert len(tasks["tasks"]) == 60


def test_plan_provider_and_parameters_are_integrity_bound(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    plan = engine.plan(
        "把这张沙发放进这个房间",
        objects=[_object("sofa"), _object("room")],
    )["plan"]
    assert plan["integrityToken"]
    plan["provider"] = "internal"
    forged = engine.execute(plan, confirmed=True)
    assert forged["status"] == "failed"
    assert forged["error"] == "invalid_plan_signature"


def test_malformed_operation_plan_returns_failure_instead_of_raising(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)

    receipt = engine.execute({"risk": "not-a-risk", "parameters": []})

    assert receipt == {
        "status": "failed",
        "verified": False,
        "error": "invalid_plan",
    }


def test_unconfigured_specialists_fall_back_to_installed_agent_with_receipt(tmp_path: Path) -> None:
    starts: list[dict] = []
    settings = FabricSettings.defaults()
    settings.agents.preferred = "pi"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "fallback-task",
            "status": "queued",
        },
    )
    objects = [_object("formula", r"\int_0^1 x^2 dx")]
    planned = engine.plan("把这个公式转成 LaTeX", objects=objects, parameters={"cwd": str(tmp_path)})
    assert planned["plan"]["provider"] == "agent.task"
    assert planned["plan"]["parameters"]["capabilityFallback"] == "math_vision_provider_not_configured"
    receipt = engine.execute(planned["plan"], confirmed=True)
    assert receipt["status"] == "accepted"
    assert receipt["verified"] is False
    assert starts[0]["provider"] == "pi"
    assert "formula.to_latex" in starts[0]["prompt"]


def test_pi_background_recipe_requests_rpc_capable_worker(tmp_path: Path) -> None:
    starts: list[dict] = []
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "background-task",
            "status": "running",
        },
    )
    plan = engine.plan(
        "交给 Pi 在后台处理",
        objects=[_object(content="Audit this report")],
        parameters={"cwd": str(tmp_path), "agent": "pi"},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "accepted"
    assert receipt["verified"] is False
    assert starts[0]["background"] is True
    assert starts[0]["sessionId"] == ""
    assert starts[0]["sessionId"] != plan["id"]


def test_agent_name_is_inferred_from_command_and_default_falls_back_to_available_provider(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.agents.preferred = "pi"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": False, "codex": True, "claude": True},
        agent_starter=lambda payload: {"taskId": payload["provider"], "status": "queued"},
    )
    explicit = engine.plan("让 Claude 处理这个", objects=[_object()], parameters={"cwd": str(tmp_path)})
    assert explicit["plan"]["parameters"]["agent"] == "claude"
    assert explicit["plan"]["provider"] == "agent.task"

    fallback = engine.plan(
        "把这个公式转成 LaTeX",
        objects=[_object()],
        parameters={"cwd": str(tmp_path)},
    )
    assert fallback["plan"]["parameters"]["agent"] == "codex"
    assert fallback["plan"]["provider"] == "agent.task"


def test_disabled_recipe_fails_closed_before_plan_creation(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.recipe_enabled["research.evidence_card"] = False
    engine = FabricEngine(root=tmp_path, settings=settings)
    result = engine.plan("把这段和来源保存成证据卡", objects=[_object()])
    assert result["ok"] is False
    assert result["error"] == "recipe_disabled"
    assert result["match"]["recipeId"] == "research.evidence_card"


def test_plan_composes_target_lease_capture_policy_packet_and_bounded_capabilities(tmp_path: Path) -> None:
    image = tmp_path / "screen.png"
    image.write_bytes(b"pixels")
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: {"taskId": "task-1", "status": "queued"},
    )
    obj = {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "content": "Save button overlaps the card",
        "bbox": [10, 20, 300, 240],
        "source": {
            "app": "code.exe",
            "title": "app.py - Visual Studio Code",
            "hwnd": 42,
            "processId": 314,
            "screenshotPath": str(image),
            "path": str(image),
        },
    }
    plan = engine.plan(
        "让 Pi 修这个",
        objects=[obj],
        parameters={
            "cwd": str(tmp_path),
            "selectionSessionId": "selection-1",
            "attachments": [str(image)],
        },
    )["plan"]

    params = plan["parameters"]
    assert params["targetLease"]["selectionSessionId"] == "selection-1"
    assert params["targetLease"]["requiresLiveValidation"] is True
    assert params["targetLease"]["window"]["hwnd"] == 42
    assert params["capturePolicy"]["uploadAllowedPaths"] == []
    assert params["capturePolicy"]["withheldVisualCount"] == 1
    assert 3 <= len(params["capabilitySelection"]) <= 8
    assert params["capabilitySelection"][0]["id"] == "agent.handoff"
    assert params["contextPacket"]["schemaVersion"] == 2
    assert params["contextPacket"]["workspace"]["cwd"] == str(tmp_path.resolve())
    assert "screen.png" not in json.dumps(params["contextPacket"], ensure_ascii=False)


def test_stale_target_window_blocks_signed_external_action_before_agent_start(tmp_path: Path) -> None:
    starts: list[dict] = []
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "task-1",
            "status": "queued",
        },
        target_probe=lambda _lease: [],
    )
    obj = _object(content="Fix this")
    obj["source"].update({"hwnd": 42, "processId": 314})
    plan = engine.plan(
        "让 Pi 修这个",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "failed"
    assert receipt["verified"] is False
    assert receipt["error"] == "stale_target_window"
    assert receipt["verification"]["targetLease"]["valid"] is False
    assert starts == []


def test_live_target_lease_without_probe_fails_closed_before_agent_start(tmp_path: Path) -> None:
    starts: list[dict] = []
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "task-1",
            "status": "queued",
        },
    )
    obj = _object(content="Fix this")
    obj["source"].update({"hwnd": 42, "processId": 314})
    plan = engine.plan(
        "Let Pi fix this",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )["plan"]

    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "failed"
    assert receipt["verified"] is False
    assert receipt["error"] == "target_lease_probe_unavailable"
    assert receipt["verification"]["targetLease"] == {
        "valid": False,
        "reason": "target_lease_probe_unavailable",
    }
    assert starts == []


def test_matching_target_handoff_persists_context_packet_artifact(tmp_path: Path) -> None:
    starts: list[dict] = []
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {
            "taskId": "task-1",
            "status": "queued",
        },
        target_probe=lambda _lease: [{"hwnd": 42, "pid": 314}],
    )
    obj = _object(content="Fix the overlapping Save button")
    obj["source"].update({"hwnd": 42, "processId": 314})
    plan = engine.plan(
        "让 Pi 修这个",
        objects=[obj],
        parameters={"cwd": str(tmp_path), "sessionId": "existing-pi-session"},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "accepted"
    packet_artifact = Path(starts[0]["contextPacketArtifact"])
    assert packet_artifact.exists()
    assert json.loads(packet_artifact.read_text(encoding="utf-8"))["schemaVersion"] == 2
    assert str(packet_artifact) in starts[0]["prompt"]
    assert "Fix the overlapping Save button" in starts[0]["prompt"]
    assert starts[0]["sessionId"] == "existing-pi-session"
    assert receipt["verification"]["targetLease"]["valid"] is True


def test_capture_policy_deny_refuses_plan_before_provider_selection(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.privacy.app_capture_modes = {"password": "deny"}
    engine = FabricEngine(root=tmp_path, settings=settings)
    result = engine.plan(
        "让 Pi 修这个",
        objects=[{
            "id": "secret",
            "kind": "screen_region",
            "content": "secret",
            "source": {"app": "Password Manager"},
        }],
        parameters={"cwd": str(tmp_path)},
    )
    assert result["ok"] is False
    assert result["error"] == "capture_policy_denied"
    assert result["deniedObjectIds"] == ["secret"]


def test_project_and_app_scoped_permission_is_visible_in_signed_plan(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.permissions.scoped_grants = [{
        "decision": "allow",
        "recipe": "agent.handoff",
        "app": "code.exe",
        "project": str(tmp_path),
        "risk": "external_send",
    }]
    settings.permissions.validate()
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: {"taskId": "task-1", "status": "queued"},
    )
    obj = _object(content="Fix the selected issue")
    obj["source"]["app"] = "code.exe"
    plan = engine.plan(
        "让 Pi 修这个",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )["plan"]

    assert plan["requiresConfirmation"] is False
    assert plan["parameters"]["permissionDecision"]["decision"] == "allow"
    assert plan["parameters"]["permissionDecision"]["source"] == "scoped_grant"
    assert plan["preview"]["permissionScope"]["project"] == str(tmp_path)


def test_audit_correlates_plan_receipt_task_lease_and_target_without_user_content(tmp_path: Path) -> None:
    private_content = "Customer 4815162342 contract clause"
    private_title = "Customer contract.pdf"
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: {"taskId": "task-42", "status": "queued"},
        target_probe=lambda _lease: [{"hwnd": 42, "pid": 314}],
    )
    obj = _object(content=private_content)
    obj["source"].update({
        "app": "code.exe",
        "title": private_title,
        "hwnd": 42,
        "processId": 314,
    })
    plan = engine.plan(
        "recipe: agent.handoff",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)

    planned = next(event for event in engine.audit.tail() if event["type"] == "recipe.planned")
    executed = next(event for event in engine.audit.tail() if event["type"] == "recipe.executed")
    assert planned["data"]["planId"] == plan["id"]
    assert planned["data"]["leaseId"] == plan["parameters"]["targetLease"]["leaseId"]
    assert planned["data"]["targetApps"] == ["code.exe"]
    assert planned["data"]["projectId"]
    assert planned["data"]["permissionSource"] == "risk_default"
    assert executed["data"]["planId"] == plan["id"]
    assert executed["data"]["receiptId"] == receipt["id"]
    assert executed["data"]["taskId"] == "task-42"
    assert executed["data"]["leaseId"] == plan["parameters"]["targetLease"]["leaseId"]
    assert executed["data"]["targetLeaseValid"] is True
    encoded = json.dumps(engine.audit.tail(), ensure_ascii=False)
    assert private_content not in encoded
    assert private_title not in encoded
    assert str(tmp_path) not in encoded


def test_terminal_audit_keeps_only_state_exit_presence_and_bounded_line_count(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path, agent_availability={"pi": True})
    obj = _object(content="Error: private-customer-log")
    obj["source"].update({
        "app": "terminal",
        "terminalEvidence": {
            "schemaVersion": 1,
            "state": "resolved",
            "method": "uia:terminal-text-pattern",
            "command": "python private-command.py",
            "exitCode": 7,
            "anchor": {"line": 2, "text": "Error: private-customer-log"},
            "window": {
                "startLine": 1,
                "endLine": 3,
                "lineCount": 3,
                "text": "Error: private-customer-log\nProcess exited with code 7",
            },
            "pixelFallbackUsed": False,
        },
    })
    engine.plan(
        "recipe: agent.handoff",
        objects=[obj],
        parameters={"cwd": str(tmp_path)},
    )

    planned = next(event for event in engine.audit.tail() if event["type"] == "recipe.planned")
    assert planned["data"]["terminalEvidenceState"] == "resolved"
    assert planned["data"]["terminalEvidenceMethod"] == "uia:terminal-text-pattern"
    assert planned["data"]["terminalExitCodeObserved"] is True
    assert planned["data"]["terminalExitCode"] == 7
    assert planned["data"]["terminalWindowLineCount"] == 3
    encoded = json.dumps(engine.audit.tail(), ensure_ascii=False)
    assert "private-customer-log" not in encoded
    assert "private-command.py" not in encoded


def test_browser_audit_keeps_only_devtools_presence_summary(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path, agent_availability={"pi": True})
    obj = _object(content="Retry private checkout")
    obj["source"].update({
        "app": "browser",
        "browserContext": {
            "schemaVersion": 1,
            "state": "resolved",
            "method": "cdp:dom-point",
            "page": {"title": "Private checkout", "url": "https://example.test/private"},
            "node": {"tag": "button", "accessibleName": "Private retry", "text": "Retry"},
            "selector": "#private-retry",
            "coordinates": {"pointerScreenPhysical": {"x": 640, "y": 520}},
            "networkFailures": [{"url": "https://api.example.test/private", "errorText": "net::ERR_FAILED", "source": "devtools_log"}],
            "provenance": {"structural": True},
        },
    })
    engine.plan("recipe: agent.handoff", objects=[obj], parameters={"cwd": str(tmp_path)})

    planned = next(event for event in engine.audit.tail() if event["type"] == "recipe.planned")
    assert planned["data"]["browserEvidenceState"] == "resolved"
    assert planned["data"]["browserEvidenceMethod"] == "cdp:dom-point"
    assert planned["data"]["browserSelectorObserved"] is True
    assert planned["data"]["browserAccessibleNameObserved"] is True
    assert planned["data"]["browserNetworkFailureCount"] == 1
    assert planned["data"]["browserCoordinatesObserved"] is True
    encoded = json.dumps(engine.audit.tail(), ensure_ascii=False)
    assert "Private checkout" not in encoded
    assert "#private-retry" not in encoded
    assert "api.example.test/private" not in encoded


def test_component_source_audit_keeps_confidence_gate_but_not_private_paths(tmp_path: Path) -> None:
    component = tmp_path / "src" / "PrivateRetry.tsx"
    component.parent.mkdir()
    component.write_text("export function PrivateRetry() { return <button>Retry</button>; }\n", encoding="utf-8")
    engine = FabricEngine(root=tmp_path, agent_availability={"pi": True})
    obj = _object(content="Retry")
    obj["source"].update({
        "app": "browser",
        "browserContext": {
            "schemaVersion": 1,
            "state": "resolved",
            "method": "cdp:dom-point",
            "page": {"title": "Private", "url": "http://127.0.0.1:5173/private"},
            "node": {"tag": "button", "accessibleName": "Retry", "text": "Retry", "attributes": {}},
            "selector": "button",
            "componentHints": {"framework": "react", "owners": [{
                "name": "PrivateRetry",
                "source": {"file": component.as_uri(), "line": 1},
            }]},
        },
    })

    engine.plan("recipe: agent.handoff", objects=[obj], parameters={"cwd": str(tmp_path)})

    planned = next(event for event in engine.audit.tail() if event["type"] == "recipe.planned")
    assert planned["data"]["componentLinkState"] == "resolved"
    assert planned["data"]["componentCandidateCount"] == 1
    assert planned["data"]["componentTopConfidence"] >= 0.95
    assert planned["data"]["componentAutoModificationAllowed"] is True
    assert "PrivateRetry.tsx" not in json.dumps(engine.audit.tail())


def test_verified_artifact_receipt_is_registered_with_plan_and_source_provenance(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    plan = engine.plan(
        "recipe: research.evidence_card",
        objects=[_object(content="A bounded source claim.")],
        parameters={"cwd": str(tmp_path)},
    )["plan"]
    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert len(receipt["output"]["artifactIds"]) == 1
    indexed = ArtifactRegistry(tmp_path).get(receipt["output"]["artifactIds"][0])
    assert indexed["planId"] == plan["id"]
    assert indexed["receiptId"] == receipt["id"]
    assert indexed["recipeId"] == "research.evidence_card"
    assert indexed["sourceObjectIds"] == ["obj-1"]


def test_engine_observes_real_execution_for_skill_candidate_learning(tmp_path: Path) -> None:
    observed: list[tuple[str, str]] = []

    class Recorder:
        def observe_execution(self, plan, receipt):
            observed.append((plan.id, receipt["id"]))
            return {"eligible": False, "candidate": None}

    engine = FabricEngine(root=tmp_path)
    engine.skill_candidates = Recorder()
    plan = engine.plan(
        "recipe: research.evidence_card",
        objects=[_object(content="A bounded source claim.")],
        parameters={"cwd": str(tmp_path)},
    )["plan"]

    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "succeeded"
    assert observed == [(plan["id"], receipt["id"])]


def test_skill_candidate_learning_failure_never_breaks_primary_execution(tmp_path: Path) -> None:
    class BrokenRecorder:
        def observe_execution(self, _plan, _receipt):
            raise RuntimeError("learning store unavailable")

    engine = FabricEngine(root=tmp_path)
    engine.skill_candidates = BrokenRecorder()
    plan = engine.plan(
        "recipe: research.evidence_card",
        objects=[_object(content="A bounded source claim.")],
        parameters={"cwd": str(tmp_path)},
    )["plan"]

    receipt = engine.execute(plan, confirmed=True)

    assert receipt["status"] == "succeeded"
    assert any(item["type"] == "skill.candidate_observation_failed" for item in engine.audit.tail())
