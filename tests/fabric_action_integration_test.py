from __future__ import annotations

from pathlib import Path

from app.actions.executor import SafeActionExecutor
from app.fabric.action import make_fabric_action_proposal
from app.fabric.engine import FabricEngine
from app.fabric.settings import FabricSettings
from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import _fabric_response


def _engine(tmp_path: Path, clipboard: dict[str, str]) -> FabricEngine:
    return FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )


def test_fabric_plan_uses_existing_action_token_and_confirmation_boundary(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    engine = _engine(tmp_path, clipboard)
    plan = engine.plan(
        "复制这段文字",
        objects=[{"id": "one", "kind": "text", "content": "hello"}],
    )["plan"]
    proposal = make_fabric_action_proposal(plan)
    assert proposal.action_type == "fabric_recipe_execute"
    assert proposal.confirmation_required is True
    assert proposal.parameters["plan"]["integrityToken"]

    executor = SafeActionExecutor(fabric_engine=engine)
    skipped = executor.execute(proposal, confirmed=False)
    assert skipped.status.value == "skipped"
    assert clipboard["value"] == ""

    executed = executor.execute(proposal, confirmed=True)
    assert executed.status.value == "succeeded"
    assert executed.output["fabric_receipt"]["verified"] is True
    assert clipboard["value"] == "hello"


def test_fabric_action_rejects_tampered_plan_even_with_valid_proposal_shape(tmp_path: Path) -> None:
    clipboard = {"value": ""}
    engine = _engine(tmp_path, clipboard)
    plan = engine.plan(
        "recipe: image.compose",
        objects=[{"id": "a", "content": "a"}, {"id": "b", "content": "b"}],
    )["plan"]
    proposal = make_fabric_action_proposal(plan)
    proposal.parameters["plan"]["provider"] = "internal"
    result = SafeActionExecutor(fabric_engine=engine).execute(proposal, confirmed=True)
    assert result.status.value == "failed"
    assert result.error == "invalid_plan_signature"


def test_selection_bridge_returns_real_fabric_proposal_for_supported_recipe(tmp_path: Path) -> None:
    settings = FabricSettings.defaults()
    settings.permissions.recipe_overrides["research.evidence_card"] = "allow"
    engine = FabricEngine(root=tmp_path, settings=settings)
    app_ctx = AdapterReadContext(
        adapter="uia",
        app="pdf",
        window={"title": "paper.pdf", "hwnd": 42},
        content="bounded claim",
        label="selected paragraph",
        method="TextPattern",
        artifacts={"page": 3, "rectangles": [[10, 20, 200, 80]]},
    )
    response = _fabric_response(
        {
            "command": "把这段和图保存到项目笔记",
            "selectionSessionId": "session-1",
            "interactionEpisode": {"version": 1, "episodeId": "ep-1", "slots": {}},
        },
        {"title": "paper.pdf", "hwnd": 42},
        app_ctx,
        {"snapshot_id": "snap-1", "source_kind": "native_selection"},
        engine=engine,
    )
    assert response is not None
    assert response["intentKind"] == "fabric_recipe"
    assert response["recipe"]["id"] == "research.evidence_card"
    assert response["actionProposals"][0]["action_type"] == "fabric_recipe_execute"
    assert response["autoExecuteProposalId"] == response["actionProposals"][0]["id"]


def test_selection_bridge_leaves_generic_explanation_to_existing_answer_path(tmp_path: Path) -> None:
    app_ctx = AdapterReadContext(adapter="uia", app="browser", content="hello")
    response = _fabric_response(
        {"command": "解释这个", "selectionSessionId": "s"},
        {"title": "Browser"},
        app_ctx,
        {"snapshot_id": "snap"},
        engine=FabricEngine(root=tmp_path),
    )
    assert response is None

