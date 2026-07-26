from __future__ import annotations

from pathlib import Path

import pytest

from app.context_pack.compiler import (
    compile_context_prompt,
    detect_agent_profile,
    write_context_prompt_artifact,
)


def context_session() -> dict:
    return {
        "session_id": "context-1",
        "status": "active",
        "items": [
            {
                "item_id": "item-1",
                "sequence": 1,
                "modality": "native_selection",
                "instruction": "这是实现入口，不要改函数签名",
                "source": {
                    "app": "code",
                    "document_path": r"D:\repo\app.py",
                    "document_label": "app.py",
                    "method": "uia:text-pattern",
                    "window": {"title": "app.py - Visual Studio Code"},
                },
                "selected_text": "def checkout(order):",
                "surrounding_context": "def checkout(order):\n    return charge(order)",
                "geometry": {"point": [100, 200], "selection_rectangles": [[10, 20, 30, 40]]},
                "images": {},
                "grounding": {},
                "vision_observation": "",
            },
            {
                "item_id": "item-2",
                "sequence": 2,
                "modality": "visual_pointer",
                "instruction": "这是用户看到的错误状态",
                "source": {
                    "app": "browser",
                    "url": "https://example.test/checkout",
                    "method": "pointer-stroke+vision",
                    "window": {"title": "Broken checkout - Chrome"},
                },
                "selected_text": "",
                "surrounding_context": "",
                "geometry": {"point": [420, 260], "bbox": [400, 240, 180, 90]},
                "images": {"raw": r"D:\tmp\screen.png", "pointer": r"D:\tmp\pointer.png"},
                "grounding": {"label": "red error card", "method": "vision", "confidence": 0.84},
                "vision_observation": "A red Payment failed card appears below the form.",
            },
        ],
    }


@pytest.mark.parametrize(
    ("window", "profile_id"),
    [
        ({"title": "Codex", "process_name": "Codex.exe"}, "codex"),
        ({"title": "Claude Code", "process_name": "claude.exe"}, "claude"),
        ({"title": "Gemini CLI", "process_name": "WindowsTerminal.exe"}, "gemini"),
        ({"title": "Pi coding agent", "process_name": "pi.exe"}, "pi"),
        ({"title": "Unknown Agent", "process_name": "agent.exe"}, "generic"),
    ],
)
def test_detect_agent_profile_from_process_or_window(window: dict, profile_id: str) -> None:
    assert detect_agent_profile(window)["id"] == profile_id


def test_compiler_preserves_user_words_sources_geometry_and_uncertainty() -> None:
    prompt = compile_context_prompt(
        context_session(),
        task_instruction="修复结账错误并运行相关测试",
        target_profile="codex",
    )

    assert "修复结账错误并运行相关测试" in prompt
    assert "这是实现入口，不要改函数签名" in prompt
    assert "这是用户看到的错误状态" in prompt
    assert r"D:\repo\app.py" in prompt
    assert "https://example.test/checkout" in prompt
    assert "[420, 260]" in prompt
    assert r"D:\tmp\pointer.png" in prompt
    assert "A red Payment failed card" in prompt
    assert "0.84" in prompt
    assert "不要把视觉观察或模型推断改写成用户事实" in prompt
    assert "Codex" in prompt


def test_compiler_exposes_visual_failure_instead_of_hiding_missing_observation() -> None:
    session = context_session()
    session["items"][1]["vision_observation"] = ""
    session["items"][1]["vision_error"] = "TimeoutError: vision unavailable"

    prompt = compile_context_prompt(session, task_instruction="分析这个界面")

    assert "视觉转译失败" in prompt
    assert "TimeoutError: vision unavailable" in prompt


def test_compiler_does_not_invent_a_task_when_user_did_not_supply_one() -> None:
    prompt = compile_context_prompt(context_session(), target_profile="generic")

    assert "最终任务：未提供" in prompt
    assert "先向用户确认最终任务" in prompt


def test_compiler_rejects_empty_session_and_unknown_profile() -> None:
    with pytest.raises(ValueError, match="session id"):
        compile_context_prompt({"items": context_session()["items"]})
    with pytest.raises(ValueError, match="has no items"):
        compile_context_prompt({"session_id": "empty", "items": []})
    with pytest.raises(ValueError, match="target profile"):
        compile_context_prompt(context_session(), target_profile="not-real")


def test_compiler_bounds_large_context_and_writes_utf8_artifact(tmp_path: Path) -> None:
    session = context_session()
    session["items"][0]["surrounding_context"] = "附近上下文" * 10000

    prompt = compile_context_prompt(session, task_instruction="定位问题")
    artifact = write_context_prompt_artifact(session, prompt, root=tmp_path)

    assert len(prompt) < 40000
    assert "已省略" in prompt
    assert artifact == tmp_path / "context" / "artifacts" / "context-1-prompt.md"
    assert artifact.read_text(encoding="utf-8") == prompt + "\n"


def test_compiler_enforces_global_budget_but_keeps_catalog_of_all_items() -> None:
    session = context_session()
    template = session["items"][0]
    session["items"] = []
    for index in range(1, 65):
        item = {**template}
        item["item_id"] = f"item-{index}"
        item["sequence"] = index
        item["instruction"] = f"用户说明 {index} " + ("重要" * 500)
        item["surrounding_context"] = "上下文" * 3000
        item["app_context"] = {f"metadata-{part}": "value" * 2000 for part in range(20)}
        session["items"].append(item)

    prompt = compile_context_prompt(session, task_instruction="处理全部条目")

    assert len(prompt) <= 60000
    assert "item-1" in prompt and "item-64" in prompt
    assert "详细证据预算已用尽" in prompt
    assert "原始 Context Pack" in prompt


def test_runtime_issue_prompt_makes_agent_locate_source_from_live_evidence() -> None:
    session = context_session()
    session["workflow_kind"] = "runtime_issue"
    session["task_instruction"] = "这个保存按钮太靠下，应该和右侧卡片顶部对齐"
    session["items"][0]["role"] = "issue"
    session["items"][1]["role"] = "reference"
    session["items"][1]["instruction"] = "参考这个卡片的间距和按钮位置"

    prompt = compile_context_prompt(session, target_profile="codex")

    assert prompt.startswith("# Runtime UI issue")
    assert "这个保存按钮太靠下，应该和右侧卡片顶部对齐" in prompt
    assert "待修现场（issue）" in prompt
    assert "期望参考（reference）" in prompt
    assert "自行检查当前工作区并定位负责源码" in prompt
    assert "不要要求用户寻找文件" in prompt
    assert r"D:\tmp\pointer.png" in prompt
    assert "修改后运行与目标相匹配的测试、构建或视觉检查" in prompt
    assert len(prompt) <= 60000
