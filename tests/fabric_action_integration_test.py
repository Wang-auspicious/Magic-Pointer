from __future__ import annotations

from pathlib import Path

from app.actions.executor import SafeActionExecutor
from app.fabric.action import make_fabric_action_proposal
from app.fabric.engine import FabricEngine
from app.fabric.settings import FabricSettings
from app.adapters.base import AdapterReadContext
from scripts.selection_bridge import _fabric_response
import scripts.selection_bridge as selection_bridge_module
from app.fabric.workflow_task_store import WorkflowTaskStore


def _engine(tmp_path: Path, clipboard: dict[str, str]) -> FabricEngine:
    return FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: clipboard.__setitem__("value", value),
        clipboard_reader=lambda: clipboard["value"],
    )


def test_gui_action_and_cli_resume_share_workflow_and_never_repeat_execution(tmp_path: Path) -> None:
    writes: list[str] = []
    clipboard = {"value": ""}
    engine = FabricEngine(
        root=tmp_path,
        clipboard_writer=lambda value: (writes.append(value), clipboard.__setitem__("value", value)),
        clipboard_reader=lambda: clipboard["value"],
    )
    plan = engine.plan(
        "复制这段文字",
        objects=[{"id": "one", "kind": "text", "content": "hello"}],
    )["plan"]
    workflow = WorkflowTaskStore(tmp_path / "workflow-tasks").create(plan, surface="gui")
    proposal = make_fabric_action_proposal(plan, workflow_task_id=workflow["taskId"])
    executor = SafeActionExecutor(fabric_engine=engine)

    first = executor.execute(proposal, confirmed=True)
    duplicate = executor.execute(proposal, confirmed=True)

    assert first.output["fabric_receipt"]["status"] == "succeeded"
    assert duplicate.output["fabric_receipt"]["id"] == first.output["fabric_receipt"]["id"]
    assert duplicate.metadata["workflow_reused"] is True
    assert writes == ["hello"]


def test_workflow_execution_exception_is_terminal_and_not_retried(tmp_path: Path) -> None:
    signing_engine = FabricEngine(root=tmp_path)
    plan = signing_engine.plan(
        "复制这段文字",
        objects=[{"id": "one", "kind": "text", "content": "hello"}],
    )["plan"]
    workflow = WorkflowTaskStore(tmp_path / "workflow-tasks").create(plan, surface="gui")
    proposal = make_fabric_action_proposal(plan, workflow_task_id=workflow["taskId"])

    class BrokenEngine:
        root = tmp_path
        calls = 0

        def execute(self, _plan, *, confirmed=False):
            self.calls += 1
            raise RuntimeError("provider leaked detail must not escape")

    broken = BrokenEngine()
    executor = SafeActionExecutor(fabric_engine=broken)
    first = executor.execute(proposal, confirmed=True)
    duplicate = executor.execute(proposal, confirmed=True)

    assert first.status.value == "failed"
    assert first.error == "execution_exception:RuntimeError"
    assert duplicate.output["fabric_receipt"]["id"] == first.output["fabric_receipt"]["id"]
    assert duplicate.metadata["workflow_reused"] is True
    assert broken.calls == 1


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


def test_selection_bridge_leaves_generic_explanation_to_existing_answer_path(tmp_path: Path, monkeypatch) -> None:
    app_ctx = AdapterReadContext(adapter="uia", app="browser", content="hello")
    monkeypatch.setattr(
        selection_bridge_module,
        "FabricEngine",
        lambda: (_ for _ in ()).throw(AssertionError("generic explanation must not initialize FabricEngine")),
    )
    response = _fabric_response(
        {"command": "解释这个", "selectionSessionId": "s"},
        {"title": "Browser"},
        app_ctx,
        {"snapshot_id": "snap"},
    )
    assert response is None


def test_selection_bridge_binds_selection_session_into_target_lease(tmp_path: Path) -> None:
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: {"taskId": "task-1", "status": "queued"},
    )
    app_ctx = AdapterReadContext(
        adapter="uia",
        app="code",
        window={"title": "app.py - Code", "hwnd": 42},
        content="broken layout",
        label="THIS",
        method="TextPattern",
        artifacts={"rectangles": [[10, 20, 200, 80]]},
    )
    response = _fabric_response(
        {
            "command": "让 Pi 修这个",
            "selectionSessionId": "selection-session-42",
            "workspaceRoot": str(tmp_path),
            "interactionEpisode": {"version": 1, "episodeId": "ep-1", "slots": {}},
        },
        {"title": "app.py - Code", "hwnd": 42, "process_id": 314, "process_name": "code.exe"},
        app_ctx,
        {"snapshot_id": "snap-1", "source_kind": "native_selection"},
        engine=engine,
    )
    assert response is not None
    lease = response["plan"]["parameters"]["targetLease"]
    assert lease["selectionSessionId"] == "selection-session-42"
    assert lease["window"]["hwnd"] == 42
    assert lease["window"]["processId"] == 314


def test_n01_visual_handoff_packet_contains_pointer_image_transcript_source_and_bbox(tmp_path: Path) -> None:
    raw = tmp_path / "screen.png"
    annotated = tmp_path / "screen.pointer.png"
    raw.write_bytes(b"raw")
    annotated.write_bytes(b"pointer")
    settings = FabricSettings.defaults()
    settings.privacy.upload_screenshots = True
    engine = FabricEngine(
        root=tmp_path,
        settings=settings,
        agent_availability={"pi": True},
        agent_starter=lambda payload: starts.append(payload) or {"taskId": "task-n01", "status": "queued"},
        target_probe=lambda _lease: [{
            "hwnd": 42,
            "pid": 314,
            "title": "Settings - Magic Pointer",
            "desktopId": "desktop-1",
        }],
    )
    starts: list[dict] = []
    command = "让 Pi 修这个保存按钮"
    response = _fabric_response(
        {
            "command": command,
            "selectionSessionId": "selection-n01",
            "workspaceRoot": str(tmp_path),
            "interactionEpisode": {"version": 1, "episodeId": "ep-n01", "slots": {}},
        },
        {
            "title": "Settings - Magic Pointer",
            "hwnd": 42,
            "process_id": 314,
            "process_name": "magic-pointer.exe",
        },
        None,
        {
            "snapshot_id": "snap-n01",
            "source_kind": "screen_region",
            "selection_bbox": [100, 200, 520, 420],
            "capture_path": str(raw),
            "annotated_path": str(annotated),
            "capture_attestation": {
                "status": "verified",
                "phase": "complete",
                "expected": {
                    "hwnd": 42,
                    "processId": 314,
                    "processName": "magic-pointer.exe",
                    "title": "Settings - Magic Pointer",
                    "desktopId": "desktop-1",
                },
            },
        },
        engine=engine,
    )

    assert response is not None and response["ok"] is True
    packet = response["plan"]["parameters"]["contextPacket"]
    assert packet["intent"]["command"] == command
    assert packet["objects"][0]["bbox"] == [100, 200, 520, 420]
    assert packet["objects"][0]["source"]["app"] == "magic-pointer.exe"
    assert packet["objects"][0]["source"]["title"] == "Settings - Magic Pointer"
    assert packet["objects"][0]["source"]["captureAttestation"]["status"] == "verified"
    assert packet["objects"][0]["source"]["visualPaths"] == [str(raw.resolve()), str(annotated.resolve())]
    assert packet["artifacts"] == [str(raw.resolve()), str(annotated.resolve())]
    assert response["plan"]["parameters"]["capturePolicy"]["uploadAllowedPaths"] == [
        str(raw.resolve()),
        str(annotated.resolve()),
    ]
    receipt = engine.execute(response["plan"], confirmed=True)
    assert receipt["status"] == "accepted"
    assert starts[0]["attachments"] == [str(raw), str(annotated)]


def test_n02_agent_handoff_uses_only_labeled_abc_objects_in_stable_order_with_spatial_relations(tmp_path: Path) -> None:
    engine = FabricEngine(
        root=tmp_path,
        agent_availability={"pi": True},
        agent_starter=lambda payload: {"taskId": "task-n02", "status": "queued"},
    )
    objects = [
        {
            "objectId": "object-a",
            "referenceLabel": "A",
            "kind": "screen_region",
            "label": "Header A",
            "content": "blue header",
            "bbox": [10, 20, 210, 120],
            "source": {"app": "figma.exe", "title": "Design A", "hwnd": 101, "processId": 201},
        },
        {
            "objectId": "object-b",
            "referenceLabel": "B",
            "kind": "screen_region",
            "label": "Header B",
            "content": "gray header",
            "bbox": [310, 20, 510, 120],
            "source": {"app": "chrome.exe", "title": "Preview B", "hwnd": 102, "processId": 202},
        },
        {
            "objectId": "object-c",
            "referenceLabel": "C",
            "kind": "screen_region",
            "label": "Footer C",
            "content": "footer must stay unchanged",
            "bbox": [310, 220, 510, 320],
            "source": {"app": "chrome.exe", "title": "Preview C", "hwnd": 102, "processId": 202},
        },
    ]
    response = _fabric_response(
        {
            "command": "让 Pi 比较 A、B、C，把 A 的样式应用到 B，C 保持不变",
            "selectionSessionId": "selection-n02",
            "workspaceRoot": str(tmp_path),
            "interactionEpisode": {
                "version": 1,
                "episodeId": "ep-n02",
                "slots": {"this": objects[2], "that": objects[1], "these": objects, "here": None},
                "objects": objects,
            },
        },
        {"title": "Unrelated fresh capture", "hwnd": 999, "process_id": 999, "process_name": "other.exe"},
        None,
        {
            "snapshot_id": "unrelated-snapshot",
            "source_kind": "screen_region",
            "selection_bbox": [700, 700, 800, 800],
        },
        engine=engine,
    )

    assert response is not None and response["ok"] is True
    assert response["recipe"]["id"] == "agent.handoff"
    packet = response["plan"]["parameters"]["contextPacket"]
    assert [item["id"] for item in packet["objects"]] == ["object-a", "object-b", "object-c"]
    assert [item["referenceLabel"] for item in packet["objects"]] == ["A", "B", "C"]
    assert packet["spatialRelations"] == [
        {"from": "A", "to": "B", "horizontal": "left_of", "vertical": "aligned", "delta": [300.0, 0.0]},
        {"from": "A", "to": "C", "horizontal": "left_of", "vertical": "above", "delta": [300.0, 200.0]},
        {"from": "B", "to": "C", "horizontal": "aligned", "vertical": "above", "delta": [0.0, 200.0]},
    ]
