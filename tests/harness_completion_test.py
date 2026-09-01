"""Tests for the harness completion pieces: prompt sections, memory,
compaction, permission modes, streaming SSE parser, guard factory."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.action_guard.guard_factory import (  # noqa: E402
    anchor_from_arguments,
    build_context_factory,
)
from app.agent_runtime.memory import MemoryLoader, SkillLoader, compact_messages  # noqa: E402
from app.agent_runtime.model_client import _parse_sse  # noqa: E402
from app.governance.cancellation import CancelledError, CancellationToken  # noqa: E402
from app.agent_runtime.permission_modes import (  # noqa: E402
    PermissionDecision,
    PermissionMode,
    decide_effect,
)
from app.agent_runtime.system_prompt import default_builder  # noqa: E402
from app.agent_runtime.tool_registry import Effect  # noqa: E402
from app.agent_runtime.types import AgentMessage, Role  # noqa: E402
from app.anchor import Anchor, AppIdentity, ResolutionExact  # noqa: E402


def _anchor() -> Anchor:
    return Anchor(
        anchor_id="a1",
        app_identity=AppIdentity(process_name="notepad.exe"),
        content_hash="h1",
        captured_at_utc="2026-08-13T00:00:00Z",
    )


def test_system_prompt_builder_sections_and_dynamic_boundary() -> None:
    prompt = default_builder().build({
        "permission_mode": "plan",
        "memory": "用户习惯：总结要带要点编号。",
        "language": "用中文",
    })
    assert "Magic Pointer" in prompt
    assert "权限模式：plan" in prompt
    assert "用户习惯" in prompt
    assert "用中文" in prompt
    assert prompt.index("Identity") < prompt.index("System")


def test_memory_loader_layered_and_cached(tmp_path: Path) -> None:
    user = tmp_path / "user"
    workspace = tmp_path / "workspace"
    (user / "learning").mkdir(parents=True)
    workspace.mkdir()
    (user / "MAGIC_POINTER.md").write_text("用户规则", encoding="utf-8")
    (user / "learning" / "MEMORY.md").write_text("已批准学习", encoding="utf-8")
    (workspace / "MAGIC_POINTER.md").write_text("项目记忆", encoding="utf-8")
    loader = MemoryLoader(user_dir=user, workspace_root=workspace)
    text = loader.load()
    assert "用户规则" in text
    assert "已批准学习" in text
    assert "项目记忆" in text
    assert text.index("用户规则") < text.index("已批准学习") < text.index("项目记忆")
    assert loader.load() is loader.load() or loader.load() == text


def test_skill_loader_selects_only_relevant_user_approved_skills(tmp_path: Path) -> None:
    email = tmp_path / "skills" / "email"
    code = tmp_path / "skills" / "code"
    email.mkdir(parents=True)
    code.mkdir(parents=True)
    (email / "SKILL.md").write_text(
        "---\ndescription: 处理邮件回复\n---\n先识别收件人与语气。",
        encoding="utf-8",
    )
    (code / "SKILL.md").write_text(
        "---\ndescription: 修复 Python 代码\n---\n先运行测试。",
        encoding="utf-8",
    )

    loaded = SkillLoader(tmp_path, command="帮我回复这封邮件").load()

    assert "skill: email" in loaded
    assert "先识别收件人与语气" in loaded
    assert "skill: code" not in loaded


def test_compaction_summarizes_head() -> None:
    messages = [
        AgentMessage(role=Role.USER, content=f"m{i}", tool_call_id=None, name=None)
        for i in range(10)
    ]
    # Each "mN" is one token, so a 3-token tail keeps the last three verbatim.
    compacted = compact_messages(
        messages, lambda source: "前半段摘要", tail_token_budget=3
    )
    assert len(compacted) == 4
    assert "前半段摘要" in compacted[0].content
    assert compacted[0].injected is True
    # The summary round-trips through a model; it must come back with the
    # data fence so injected imperative text cannot be upgraded into an
    # instruction (red-team T3).
    assert "<<<MAGIC_POINTER_EVIDENCE>>>" in compacted[0].content
    assert compacted[0].origin == "data"


def test_manual_compaction_can_summarize_one_legacy_evidence_message() -> None:
    source = AgentMessage(
        role=Role.USER,
        content="[旧对话首次迁移]\n" + "旧问答内容" * 1000,
        tool_call_id=None,
        name=None,
        origin="data",
        injected=True,
    )
    seen: list[str] = []

    compacted = compact_messages(
        [source],
        lambda text: seen.append(text) or "旧历史摘要",
        force=True,
    )

    assert seen and "旧问答内容" in seen[0]
    assert len(compacted) == 1
    assert compacted[0] != source
    assert "旧历史摘要" in compacted[0].content
    assert "<<<MAGIC_POINTER_EVIDENCE>>>" in compacted[0].content


def test_bulky_tail_messages_do_not_all_survive_compaction() -> None:
    """A message-count tail lets four 64k tool results ride through untouched.

    Sizing the tail by tokens is the whole point: the run that most needs
    compaction is exactly the one whose recent messages are huge.
    """
    messages = [
        AgentMessage(role=Role.USER, content="开始", tool_call_id=None, name=None)
    ]
    for index in range(6):
        messages.append(AgentMessage(
            role=Role.ASSISTANT,
            content="",
            tool_call_id=None,
            name=None,
            origin="data",
            tool_calls=({"id": f"c{index}", "name": "dump_subtree", "arguments": {}},),
        ))
        messages.append(AgentMessage(
            role=Role.TOOL,
            content="u" * 40_000,
            tool_call_id=f"c{index}",
            name="dump_subtree",
            origin="data",
        ))

    compacted = compact_messages(
        messages, lambda _source: "摘要", tail_token_budget=2000
    )

    # 2000 tokens is one 40k-char result, not six.
    assert len(compacted) < len(messages)
    assert sum(len(m.content or "") for m in compacted) < 100_000


def test_compaction_prunes_duplicate_tool_results_before_summarizing() -> None:
    payload = ("same subtree " * 80) + "END"
    messages = [
        AgentMessage(role=Role.USER, content="开始", tool_call_id=None, name=None)
    ]
    for index in range(4):
        messages.append(AgentMessage(
            role=Role.ASSISTANT,
            content="",
            tool_call_id=None,
            name=None,
            origin="data",
            tool_calls=({"id": f"d{index}", "name": "dump_subtree", "arguments": {}},),
        ))
        messages.append(AgentMessage(
            role=Role.TOOL,
            content=payload,
            tool_call_id=f"d{index}",
            name="dump_subtree",
            origin="data",
        ))
    seen: list[str] = []

    def summarize(source: str) -> str:
        seen.append(source)
        return "摘要"

    compacted = compact_messages(messages, summarize, tail_token_budget=200)
    assert seen
    assert seen[0].count(payload) <= 1
    assert "Duplicate tool output" in seen[0] or "dump_subtree" in seen[0]
    assert sum(len(m.content or "") for m in compacted) < sum(
        len(m.content or "") for m in messages
    )


def test_compaction_never_orphans_a_tool_result_from_its_assistant_call() -> None:
    # 尾部消息用 ASCII：CJK 计数修正后「现在呢」= 3 token 会提前截住尾部，
    # 走不到工具结果分支；这个测试要覆盖的正是「边界落在 TOOL 上时回退到
    # 它的 assistant 调用」的孤儿守卫。
    messages = [
        AgentMessage(role=Role.USER, content=f"old-{index}", tool_call_id=None, name=None)
        for index in range(3)
    ]
    messages.extend([
        AgentMessage(
            role=Role.ASSISTANT,
            content="",
            tool_call_id=None,
            name=None,
            origin="data",
            tool_calls=({"id": "c1", "name": "read", "arguments": {}},),
        ),
        AgentMessage(
            role=Role.TOOL,
            content="42",
            tool_call_id="c1",
            name="read",
            origin="data",
        ),
        AgentMessage(role=Role.USER, content="now?", tool_call_id=None, name=None),
    ])

    compacted = compact_messages(
        messages, lambda _source: "旧对话摘要", tail_token_budget=2
    )

    assert [message.role for message in compacted] == [
        Role.USER,
        Role.ASSISTANT,
        Role.TOOL,
        Role.USER,
    ]
    assert compacted[1].tool_calls[0]["id"] == compacted[2].tool_call_id


def test_compaction_summary_keeps_old_tool_evidence_and_provenance() -> None:
    captured: list[str] = []
    messages = [
        AgentMessage(role=Role.USER, content="find it", tool_call_id=None, name=None),
        AgentMessage(
            role=Role.ASSISTANT,
            content="",
            tool_call_id=None,
            name=None,
            origin="data",
            tool_calls=(
                {"id": "call-7", "name": "read_file", "arguments": {"path": "a.txt"}},
            ),
        ),
        AgentMessage(
            role=Role.TOOL,
            content="the durable fact is 42",
            tool_call_id="call-7",
            name="read_file",
            origin="data",
        ),
        AgentMessage(role=Role.USER, content="continue", tool_call_id=None, name=None),
    ]

    compact_messages(
        messages,
        lambda source: captured.append(source) or "summary",
        tail_token_budget=1,
        min_tail_messages=1,
    )

    assert "read_file" in captured[0]
    assert "call-7" in captured[0]
    assert "a.txt" in captured[0]
    assert "the durable fact is 42" in captured[0]


def test_permission_modes_never_allow_more_than_the_mode() -> None:
    assert decide_effect(PermissionMode.DEFAULT, Effect.READ) is PermissionDecision.ALLOW
    assert decide_effect(PermissionMode.DEFAULT, Effect.DESTRUCTIVE) is PermissionDecision.ASK
    assert decide_effect(PermissionMode.PLAN, Effect.DESTRUCTIVE) is PermissionDecision.DENY
    assert decide_effect(PermissionMode.PLAN, Effect.READ) is PermissionDecision.ALLOW
    assert decide_effect(PermissionMode.BYPASS, Effect.PURCHASE) is PermissionDecision.ASK


def test_sse_parser_accumulates_deltas_and_tool_calls() -> None:
    frames = [
        'data: {"choices":[{"delta":{"content":"你"}}]}',
        'data: {"choices":[{"delta":{"content":"好"}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_around","arguments":"{\\"anchor\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a1\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]
    events = list(_parse_sse(frames))
    texts = [e.text for e in events if type(e).__name__ == "MessageDelta"]
    assert "".join(texts) == "你好"
    calls = [e for e in events if type(e).__name__ == "ToolCallArrived"]
    assert len(calls) == 1
    assert calls[0].call.name == "read_around"
    assert calls[0].call.arguments == {"anchor": "a1"}


def test_sse_parser_supports_anthropic_messages_text_and_tool_use() -> None:
    frames = [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I will "}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_around","input":{}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"anchor\\":"}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a1\\"}"}}',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
    ]

    events = list(_parse_sse(frames, api_mode="messages"))

    assert "".join(
        event.text for event in events if type(event).__name__ == "MessageDelta"
    ) == "I will "
    calls = [event.call for event in events if type(event).__name__ == "ToolCallArrived"]
    assert len(calls) == 1
    assert calls[0].id == "toolu_1"
    assert calls[0].name == "read_around"
    assert calls[0].arguments == {"anchor": "a1"}
    done = next(event for event in events if type(event).__name__ == "TurnDone")
    assert done.usage == {"input_tokens": 12, "output_tokens": 7}


def test_openai_length_finish_is_withheld_for_continuation() -> None:
    events = list(_parse_sse([
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
        "data: [DONE]",
    ]))

    withheld = [event for event in events if type(event).__name__ == "TurnWithheld"]
    assert [event.reason for event in withheld] == ["max_output_tokens"]


def test_anthropic_max_tokens_stop_is_withheld_for_continuation() -> None:
    events = list(_parse_sse(
        [
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
            'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":64}}',
            'data: {"type":"message_stop"}',
        ],
        api_mode="messages",
    ))

    withheld = [event for event in events if type(event).__name__ == "TurnWithheld"]
    assert [event.reason for event in withheld] == ["max_output_tokens"]


def test_chat_reasoning_only_eof_is_not_a_fake_success() -> None:
    events = list(_parse_sse([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]))
    assert any(type(event).__name__ == "ReasoningDelta" for event in events)
    assert [
        event.reason for event in events if type(event).__name__ == "TurnWithheld"
    ] == ["backend_error:empty_response"]


def test_messages_reasoning_only_eof_is_not_a_fake_success() -> None:
    events = list(_parse_sse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"thinking"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        'data: {"type":"message_stop"}',
    ], api_mode="messages"))
    assert any(type(event).__name__ == "ReasoningDelta" for event in events)
    assert [
        event.reason for event in events if type(event).__name__ == "TurnWithheld"
    ] == ["backend_error:empty_response"]


def test_sse_parser_stops_consuming_after_cancellation() -> None:
    token = CancellationToken()

    def frames():
        yield 'data: {"choices":[{"delta":{"content":"first"}}]}'
        token.cancel()
        yield 'data: {"choices":[{"delta":{"content":"late"}}]}'

    with pytest.raises(CancelledError):
        list(_parse_sse(frames(), cancel_scope=token))


def test_guard_factory_fail_closed_without_anchor() -> None:
    from app.anchor import to_dict

    class FakeProbe:
        def resolve_anchor(self, anchor):
            return ResolutionExact(anchor=anchor, evidence=("app",))

        def is_focused(self, anchor):
            return True

        def content_hash_at(self, anchor):
            return anchor.content_hash

        def modal_seen_since(self, anchor):
            return False

    factory = build_context_factory(FakeProbe(), anchor_from_arguments)
    assert factory(type("Call", (), {"arguments": {}})()) is None

    context = factory(type("Call", (), {
        "arguments": {"anchor": to_dict(_anchor())},
    })())
    assert context is not None
    assert context.target_focused is True
    assert context.actual_content_hash == "h1"
