from __future__ import annotations

from pathlib import Path

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


def _lenient_engine(tmp_path: Path) -> FabricEngine:
    settings = FabricSettings()
    settings.permissions.default_write = "allow"
    return FabricEngine(root=tmp_path, settings=settings)


def _translate_plan(object_id: str = "obj-1") -> dict:
    return {
        "intent": "translate the selected text to English",
        "targetObjectIds": [object_id],
        "requestedResult": "translated text written back in place",
        "toolCalls": [{"tool": "translate_text", "arguments": {"language": "en"}}],
        "riskLevel": "local_write",
        "needsConfirmation": False,
        "expectedVerification": "read_back_and_compare",
        "model": "advisor-test",
    }


def test_model_plan_routes_to_recipe_without_keywords(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    result = engine.plan_from_model(_translate_plan(), objects=[_object()])
    assert result["ok"] is True, result
    plan = result["plan"]
    assert plan["recipeId"] == "text.translate_in_place"
    assert plan["command"] == "translate the selected text to English"
    # The model cannot bypass the local permission policy: default_write is
    # "confirm", so a local-write plan still requires confirmation even when
    # the model says needsConfirmation=false.
    assert plan["requiresConfirmation"] is True
    assert plan["parameters"]["modelPlan"]["toolCalls"][0]["tool"] == "translate_text"
    assert plan["parameters"]["modelToolCalls"][0]["arguments"] == {"language": "en"}
    assert result["match"]["referenceMode"] == "model_plan"


def test_model_plan_can_escalate_but_not_bypass_confirmation(tmp_path: Path) -> None:
    engine = _lenient_engine(tmp_path)

    relaxed = _translate_plan()
    relaxed["needsConfirmation"] = False
    result = engine.plan_from_model(relaxed, objects=[_object()])
    assert result["ok"] is True
    assert result["plan"]["requiresConfirmation"] is False

    escalated = _translate_plan()
    escalated["needsConfirmation"] = True
    result = engine.plan_from_model(escalated, objects=[_object()])
    assert result["ok"] is True
    assert result["plan"]["requiresConfirmation"] is True


def test_model_plan_targets_subset_of_objects(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    objects = [_object("obj-1"), _object("obj-2"), _object("obj-3")]
    value = _translate_plan("obj-2")
    result = engine.plan_from_model(value, objects=objects)
    assert result["ok"] is True, result
    assert len(result["plan"]["parameters"]["objects"]) == 1
    assert result["plan"]["parameters"]["objects"][0]["id"] == "obj-2"


def test_invalid_model_plan_fails_closed(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    result = engine.plan_from_model({"intent": "broken"}, objects=[_object()])
    assert result["ok"] is False
    assert result["error"] == "invalid_model_plan"
    assert "targetObjectIds must be a non-empty list" in result["detail"]


def test_unknown_target_object_fails_closed(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    result = engine.plan_from_model(_translate_plan("nope"), objects=[_object()])
    assert result["ok"] is False
    assert result["error"] == "unknown_target_objects"
    assert result["missing"] == ["nope"]


def test_unimplemented_tool_is_rejected(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    value = {
        "intent": "insert a line below",
        "targetObjectIds": ["obj-1"],
        "requestedResult": "text inserted",
        "toolCalls": [{"tool": "insert_text", "arguments": {"text": "hello"}}],
        "riskLevel": "local_write",
        "needsConfirmation": False,
        "expectedVerification": "read_back_and_compare",
    }
    result = engine.plan_from_model(value, objects=[_object()])
    assert result["ok"] is False
    assert result["error"] == "invalid_model_plan"
    assert "not implemented yet" in result["detail"]


def test_multi_tool_plan_fails_closed_instead_of_dropping_steps(tmp_path: Path) -> None:
    engine = FabricEngine(root=tmp_path)
    value = _translate_plan()
    value["toolCalls"] = [
        {"tool": "translate_text", "arguments": {"language": "en"}},
        {"tool": "summarize_text", "arguments": {}},
    ]

    result = engine.plan_from_model(value, objects=[_object()])

    assert result["ok"] is False
    assert result["error"] == "multi_tool_plan_not_supported"
    assert result["toolCount"] == 2


def test_model_plan_copy_text_executes_end_to_end(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    settings = FabricSettings()
    settings.permissions.default_write = "allow"
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
        ocr_reader=lambda _path: "订单号 138 0013 8000",
    )
    image = tmp_path / "pointer-region.png"
    image.write_bytes(b"fixture")
    obj = {
        "id": "screen-1",
        "kind": "screen_region",
        "label": "THIS",
        "content": "",
        "bbox": [20, 30, 400, 260],
        "source": {"app": "screen", "path": str(image), "captureAttestation": {"status": "verified", "phase": "complete"}},
    }
    value = {
        "intent": "copy the text in this region",
        "targetObjectIds": ["screen-1"],
        "requestedResult": "text copied to clipboard",
        "toolCalls": [{"tool": "copy_text"}],
        "riskLevel": "local_write",
        "needsConfirmation": False,
        "expectedVerification": "clipboard_hash",
    }
    result = engine.plan_from_model(value, objects=[obj])
    assert result["ok"] is True, result
    plan = result["plan"]
    assert plan["recipeId"] == "text.ocr_copy"

    receipt = engine.execute(plan, confirmed=True)
    assert receipt["status"] == "succeeded"
    assert receipt["verified"] is True
    assert clipboard["value"] == "订单号 138 0013 8000"  # copy_text preserves spacing; clean_ocr_text strips it
