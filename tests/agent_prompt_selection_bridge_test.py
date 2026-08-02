from __future__ import annotations

from pathlib import Path

from app.adapters import AdapterReadContext
from app.fabric.engine import FabricEngine
from scripts.selection_bridge import build_agent_prompt_draft


def _context() -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia",
        app="word",
        window={"title": "Draft.docx - Word", "hwnd": 10},
        content="第一段需要改得更正式。",
        label="Draft.docx",
        method="uia:text-pattern",
        artifacts={"document_path": r"D:\docs\Draft.docx"},
    )


def _snapshot() -> dict:
    return {
        "snapshot_id": "snap-agent-prompt",
        "source_kind": "native_selection",
        "target_point": {"x": 100, "y": 200},
        "target_point_space": "physical_screen_pixels",
    }


def test_selection_and_instruction_become_editable_model_prompt(tmp_path: Path) -> None:
    result = build_agent_prompt_draft(
        {
            "command": "把这段改得更正式并检查排版",
            "workspaceRoot": str(tmp_path),
            "selectionSessionId": "session-1",
        },
        {"title": "Draft.docx - Word", "process_name": "WINWORD.EXE", "hwnd": 10},
        _context(),
        _snapshot(),
        engine=FabricEngine(root=tmp_path),
        model_compiler=lambda instruction, _grounded: f"请执行：{instruction}",
    )

    assert result["ok"] is True
    assert result["kind"] == "agent-prompt-draft"
    assert result["contextPrompt"] == "请执行：把这段改得更正式并检查排版"
    assert result["generatedBy"] == "model"
    assert result["contextPacket"]["schemaVersion"] == 2
    assert result["contextPacket"]["objects"][0]["content"] == "第一段需要改得更正式。"
    assert result["actionProposals"] == []


def test_model_failure_keeps_grounded_fallback_without_faking_success(tmp_path: Path) -> None:
    result = build_agent_prompt_draft(
        {"command": "修复这段", "workspaceRoot": str(tmp_path)},
        {"title": "Draft.docx - Word", "process_name": "WINWORD.EXE", "hwnd": 10},
        _context(),
        _snapshot(),
        engine=FabricEngine(root=tmp_path),
        model_compiler=lambda _instruction, _grounded: "AI 调用失败：HTTP 503",
    )

    assert result["ok"] is True
    assert result["generatedBy"] == "grounded_fallback"
    assert result["modelError"] == "AI 调用失败：HTTP 503"
    assert "第一段需要改得更正式。" in result["contextPrompt"]
    assert result["actionProposals"] == []
