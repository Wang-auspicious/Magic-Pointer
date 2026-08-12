"""Tests for the agent runtime contract types (harness port T2.1).

Covers: enum completeness, message/tool dataclass defaults, TurnState
defaults and whole-state rebuild, dict roundtrip with unknown-field
rejection, Terminal, Trajectory, and ActionFailure retryability.
"""

import pytest

from app.agent_runtime import (
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    ActionFailure,
    AgentMessage,
    FailureType,
    Role,
    Terminal,
    ToolCall,
    ToolResult,
    Trajectory,
    TransitionReason,
    TurnState,
    with_transition,
)


class TestEnums:
    def test_role_has_all_contract_values(self) -> None:
        assert {r.value for r in Role} == {"user", "assistant", "tool"}

    def test_transition_reason_has_all_contract_values(self) -> None:
        assert {t.value for t in TransitionReason} == {
            "tool_result",
            "tool_error",
            "max_output_tokens_recovered",
            "compact_triggered",
            "stop_hook",
            "user_interrupt",
            "budget_exhausted",
            "max_turns",
        }

    def test_failure_type_has_all_contract_values(self) -> None:
        assert {f.value for f in FailureType} == {
            "stale_anchor",
            "focus_lost",
            "content_changed",
            "blocked_by_modal",
            "permission_denied",
            "timeout",
            "tool_error",
        }

    def test_enums_are_str_enums(self) -> None:
        assert Role("user") is Role.USER
        assert Role.USER == "user"
        assert TransitionReason("max_turns") is TransitionReason.MAX_TURNS
        assert FailureType("timeout") is FailureType.TIMEOUT
        assert FailureType.TIMEOUT == "timeout"


class TestAgentMessage:
    def test_construct_user_message(self) -> None:
        msg = AgentMessage(role=Role.USER, content="hello", tool_call_id=None, name=None)
        assert msg.role is Role.USER
        assert msg.content == "hello"
        assert msg.tool_call_id is None
        assert msg.name is None
        assert msg.is_error is False

    def test_is_error_defaults_false_and_explicit_true(self) -> None:
        assert AgentMessage(role=Role.USER, content="x", tool_call_id=None, name=None).is_error is False
        err = AgentMessage(
            role=Role.TOOL,
            content="boom",
            tool_call_id="t1",
            name=None,
            is_error=True,
        )
        assert err.is_error is True

    def test_tool_message_fields(self) -> None:
        msg = AgentMessage(
            role=Role.TOOL,
            content="42",
            tool_call_id="call_1",
            name="read_file",
        )
        assert msg.tool_call_id == "call_1"
        assert msg.name == "read_file"

    def test_content_and_ids_may_be_none(self) -> None:
        msg = AgentMessage(role=Role.ASSISTANT, content=None, tool_call_id=None, name=None)
        assert msg.content is None
        assert msg.tool_call_id is None
        assert msg.name is None

    def test_is_frozen(self) -> None:
        msg = AgentMessage(role=Role.USER, content="hi", tool_call_id=None, name=None)
        with pytest.raises(AttributeError):
            msg.content = "mutated"


class TestToolCall:
    def test_construct_with_arguments(self) -> None:
        call = ToolCall(
            id="call_1",
            name="read_file",
            arguments={"path": "a.txt", "offset": 3},
        )
        assert call.id == "call_1"
        assert call.name == "read_file"
        assert call.arguments == {"path": "a.txt", "offset": 3}

    def test_arguments_allow_empty_dict(self) -> None:
        call = ToolCall(id="c", name="noop", arguments={})
        assert call.arguments == {}

    def test_is_frozen(self) -> None:
        call = ToolCall(id="c", name="noop", arguments={})
        with pytest.raises(AttributeError):
            call.name = "other"


class TestToolResult:
    def test_construct_full(self) -> None:
        result = ToolResult(
            tool_call_id="call_1",
            value="done",
            is_error=False,
            failure_type=None,
            used_backend="uia",
            latency_ms=12.5,
        )
        assert result.tool_call_id == "call_1"
        assert result.value == "done"
        assert result.is_error is False
        assert result.failure_type is None
        assert result.used_backend == "uia"
        assert result.latency_ms == 12.5

    def test_error_result_fields(self) -> None:
        result = ToolResult(
            tool_call_id="call_2",
            value="permission denied",
            is_error=True,
            failure_type=FailureType.PERMISSION_DENIED,
            used_backend=None,
            latency_ms=None,
        )
        assert result.is_error is True
        assert result.failure_type is FailureType.PERMISSION_DENIED
        assert result.used_backend is None
        assert result.latency_ms is None


class TestTurnStateDefaults:
    def test_defaults(self) -> None:
        state = TurnState(messages=[], tool_calls_pending=[])
        assert state.messages == []
        assert state.tool_calls_pending == []
        assert state.max_output_tokens_recovery_count == 0
        assert state.has_attempted_reactive_compact is False
        assert state.stop_hook_active is False
        assert state.turn_count == 1
        assert state.transition is None
        assert state.budget_remaining_ms is None
        assert state.last_result is None

    def test_is_frozen(self) -> None:
        state = TurnState(messages=[], tool_calls_pending=[])
        with pytest.raises(AttributeError):
            state.turn_count = 2


class TestWithTransition:
    def _state(self) -> TurnState:
        return TurnState(
            messages=[AgentMessage(role=Role.USER, content="q", tool_call_id=None, name=None)],
            tool_calls_pending=[ToolCall(id="c", name="read", arguments={})],
            max_output_tokens_recovery_count=1,
            has_attempted_reactive_compact=True,
            stop_hook_active=True,
            turn_count=3,
            budget_remaining_ms=42.0,
            last_result=ToolResult(
                tool_call_id="c",
                value="ok",
                is_error=False,
                failure_type=None,
                used_backend="test",
                latency_ms=1.0,
            ),
        )

    def test_returns_new_object_and_sets_transition(self) -> None:
        state = self._state()
        new_state = with_transition(state, TransitionReason.TOOL_RESULT)
        assert new_state is not state
        assert state.transition is None
        assert new_state.transition is TransitionReason.TOOL_RESULT

    def test_original_object_unchanged(self) -> None:
        state = self._state()
        with_transition(state, TransitionReason.COMPACT_TRIGGERED)
        assert state.transition is None
        assert state.turn_count == 3
        assert state.max_output_tokens_recovery_count == 1
        assert state.messages[0].content == "q"

    def test_overrides_apply_and_rest_carry_over(self) -> None:
        state = self._state()
        new_state = with_transition(
            state,
            TransitionReason.MAX_OUTPUT_TOKENS_RECOVERED,
            max_output_tokens_recovery_count=2,
        )
        assert new_state.max_output_tokens_recovery_count == 2
        assert new_state.turn_count == 3
        assert new_state.stop_hook_active is True
        assert new_state.has_attempted_reactive_compact is True
        assert new_state.budget_remaining_ms == 42.0
        assert new_state.last_result is state.last_result
        assert new_state.messages == state.messages
        assert new_state.tool_calls_pending == state.tool_calls_pending

    def test_no_overrides_keeps_every_field(self) -> None:
        state = self._state()
        new_state = with_transition(state, TransitionReason.USER_INTERRUPT)
        assert new_state.max_output_tokens_recovery_count == 1
        assert new_state.turn_count == 3
        assert new_state.budget_remaining_ms == 42.0

    def test_unknown_override_rejected(self) -> None:
        state = self._state()
        with pytest.raises(TypeError):
            with_transition(state, TransitionReason.TOOL_RESULT, bogus_field=1)


class TestDictRoundtrip:
    def test_agent_message_roundtrip(self) -> None:
        msg = AgentMessage(
            role=Role.TOOL,
            content="err",
            tool_call_id="t1",
            name="read_file",
            is_error=True,
        )
        assert AgentMessage.from_dict(msg.to_dict()) == msg

    def test_agent_message_roundtrip_defaults(self) -> None:
        msg = AgentMessage(role=Role.USER, content="hi", tool_call_id=None, name=None)
        assert AgentMessage.from_dict(msg.to_dict()) == msg

    def test_turn_state_roundtrip_full(self) -> None:
        state = TurnState(
            messages=[AgentMessage(role=Role.USER, content="q", tool_call_id=None, name=None)],
            tool_calls_pending=[ToolCall(id="c", name="read", arguments={"p": "x"})],
            max_output_tokens_recovery_count=2,
            has_attempted_reactive_compact=True,
            stop_hook_active=False,
            turn_count=4,
            transition=TransitionReason.TOOL_ERROR,
            budget_remaining_ms=7.5,
            last_result=ToolResult(
                tool_call_id="c",
                value="v",
                is_error=True,
                failure_type=FailureType.TIMEOUT,
                used_backend="uia",
                latency_ms=300.0,
            ),
        )
        assert TurnState.from_dict(state.to_dict()) == state

    def test_turn_state_roundtrip_defaults(self) -> None:
        state = TurnState(messages=[], tool_calls_pending=[])
        assert TurnState.from_dict(state.to_dict()) == state

    def test_terminal_roundtrip(self) -> None:
        terminal = Terminal(
            reason=TransitionReason.MAX_TURNS,
            message="ran out",
            turns=5,
            results=(
                ToolResult(
                    tool_call_id="c",
                    value="v",
                    is_error=False,
                    failure_type=None,
                    used_backend="test",
                    latency_ms=2.0,
                ),
            ),
        )
        assert Terminal.from_dict(terminal.to_dict()) == terminal

    def test_agent_message_unknown_field_rejected(self) -> None:
        with pytest.raises(ValueError):
            AgentMessage.from_dict(
                {"role": "user", "content": "hi", "bogus": 1}
            )

    def test_agent_message_missing_field_rejected(self) -> None:
        with pytest.raises(ValueError):
            AgentMessage.from_dict({"role": "user"})

    def test_agent_message_invalid_enum_value_rejected(self) -> None:
        with pytest.raises(ValueError):
            AgentMessage.from_dict({"role": "narrator", "content": "hi"})

    def test_turn_state_unknown_field_rejected(self) -> None:
        with pytest.raises(ValueError):
            TurnState.from_dict(
                {
                    "messages": [],
                    "tool_calls_pending": [],
                    "bogus": 1,
                }
            )

    def test_terminal_unknown_field_rejected(self) -> None:
        terminal = Terminal(
            reason=TransitionReason.BUDGET_EXHAUSTED,
            message="m",
            turns=1,
            results=(),
        )
        data = terminal.to_dict()
        data["bogus"] = 1
        with pytest.raises(ValueError):
            Terminal.from_dict(data)

    def test_to_dict_uses_plain_values(self) -> None:
        msg = AgentMessage(role=Role.ASSISTANT, content="text", tool_call_id=None, name=None)
        data = msg.to_dict()
        assert data["role"] == "assistant"
        assert isinstance(data["role"], str)
        assert data["is_error"] is False


class TestTerminal:
    def test_construct(self) -> None:
        terminal = Terminal(
            reason=TransitionReason.STOP_HOOK,
            message="hook prevented",
            turns=2,
            results=(),
        )
        assert terminal.reason is TransitionReason.STOP_HOOK
        assert terminal.message == "hook prevented"
        assert terminal.turns == 2
        assert terminal.results == ()


class TestTrajectory:
    def test_defaults(self) -> None:
        traj = Trajectory(
            recipe_id="t1",
            first_user_message="select and read",
            recommended_tools=("read_file",),
        )
        assert traj.recipe_id == "t1"
        assert traj.first_user_message == "select and read"
        assert traj.recommended_tools == ("read_file",)
        assert traj.max_turns == 3
        assert traj.risk == "read"

    def test_custom_turns_and_risk(self) -> None:
        traj = Trajectory(
            recipe_id=None,
            first_user_message="fill it",
            recommended_tools=("write", "press"),
            max_turns=5,
            risk="write",
        )
        assert traj.recipe_id is None
        assert traj.max_turns == 5
        assert traj.risk == "write"

    def test_is_frozen(self) -> None:
        traj = Trajectory(
            recipe_id=None,
            first_user_message="x",
            recommended_tools=(),
        )
        with pytest.raises(AttributeError):
            traj.max_turns = 9


class TestActionFailure:
    def test_is_exception_with_message(self) -> None:
        failure = ActionFailure(
            failure_type=FailureType.TIMEOUT,
            message="worker busy",
        )
        assert isinstance(failure, Exception)
        assert str(failure) == "worker busy"
        assert failure.message == "worker busy"
        assert failure.recovery_hint is None

    def test_recovery_hint_stored(self) -> None:
        failure = ActionFailure(
            failure_type=FailureType.FOCUS_LOST,
            message="window gone",
            recovery_hint="re-issue the gesture",
        )
        assert failure.recovery_hint == "re-issue the gesture"

    def test_retryability_table(self) -> None:
        expected = {
            FailureType.STALE_ANCHOR: False,
            FailureType.FOCUS_LOST: True,
            FailureType.CONTENT_CHANGED: False,
            FailureType.BLOCKED_BY_MODAL: False,
            FailureType.PERMISSION_DENIED: False,
            FailureType.TIMEOUT: True,
            FailureType.TOOL_ERROR: False,
        }
        assert len(expected) == 7
        for failure_type, retryable in expected.items():
            failure = ActionFailure(
                failure_type=failure_type,
                message="m",
            )
            assert failure.is_retryable() is retryable, failure_type

    def test_recovery_limit_constant(self) -> None:
        assert MAX_OUTPUT_TOKENS_RECOVERY_LIMIT == 3
