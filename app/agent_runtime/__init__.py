"""Agent runtime contract: turn state, tool vocabulary, failures.

Pure Python, stdlib-only. Ported from the Claude Code query-loop and
tool-execution study notes (docs/harness-port-notes/2026-08-12-*).
"""

from .errors import (
    MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
    ActionFailure,
    FailureType,
)
from .types import (
    AgentMessage,
    Role,
    Terminal,
    ToolCall,
    ToolResult,
    Trajectory,
    TransitionReason,
    TurnState,
    with_transition,
)

__all__ = [
    "MAX_OUTPUT_TOKENS_RECOVERY_LIMIT",
    "ActionFailure",
    "FailureType",
    "AgentMessage",
    "Role",
    "Terminal",
    "ToolCall",
    "ToolResult",
    "Trajectory",
    "TransitionReason",
    "TurnState",
    "with_transition",
]
