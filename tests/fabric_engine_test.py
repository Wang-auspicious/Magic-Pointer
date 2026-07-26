from __future__ import annotations

import json
from pathlib import Path

from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.engine import FabricEngine
from app.fabric.settings import FabricSettings


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
    assert receipt["status"] == "accepted"
    assert receipt["verified"] is False
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
        "source": {"app": "screen", "path": str(image)},
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
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
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
        "source": {"app": "screen", "path": str(image)},
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
    assert starts[0]["sessionId"] == plan["id"]


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
