from __future__ import annotations

import pytest

from app.context_pack.intent import ContextIntentKind, parse_context_intent


@pytest.mark.parametrize(
    ("command", "instruction"),
    [
        ("收集：这是错误状态", "这是错误状态"),
        ("记住: 这个文件是实现入口", "这个文件是实现入口"),
        ("加入上下文：和上一个对象比较", "和上一个对象比较"),
        ("context: the red card is the broken state", "the red card is the broken state"),
    ],
)
def test_parse_explicit_collect_commands(command: str, instruction: str) -> None:
    intent = parse_context_intent(command)

    assert intent is not None
    assert intent.kind == ContextIntentKind.COLLECT
    assert intent.instruction == instruction


@pytest.mark.parametrize(
    ("command", "kind", "instruction"),
    [
        ("生成提示词：根据这些对象修复当前页面", ContextIntentKind.COMPILE, "根据这些对象修复当前页面"),
        ("整理上下文", ContextIntentKind.COMPILE, ""),
        ("compile context: explain the regression", ContextIntentKind.COMPILE, "explain the regression"),
        ("发送到这里：实现并验证这些修改", ContextIntentKind.DELIVER, "实现并验证这些修改"),
        ("填入这里", ContextIntentKind.DELIVER, ""),
        ("交给这个 Agent：只生成测试", ContextIntentKind.DELIVER, "只生成测试"),
        ("deliver here: fix it", ContextIntentKind.DELIVER, "fix it"),
        ("清空上下文", ContextIntentKind.CLEAR, ""),
    ],
)
def test_parse_session_commands(command: str, kind: ContextIntentKind, instruction: str) -> None:
    intent = parse_context_intent(command)

    assert intent is not None
    assert intent.kind == kind
    assert intent.instruction == instruction


@pytest.mark.parametrize(
    "command",
    [
        "解释这段代码",
        "发送一封邮件给同事",
        "remember why this failed",
        "context matters here",
        "",
    ],
)
def test_ordinary_commands_do_not_mutate_context_session(command: str) -> None:
    assert parse_context_intent(command) is None


def test_collect_requires_a_user_explanation() -> None:
    intent = parse_context_intent("收集：  ")

    assert intent is not None
    assert intent.kind == ContextIntentKind.COLLECT
    assert intent.instruction == ""
