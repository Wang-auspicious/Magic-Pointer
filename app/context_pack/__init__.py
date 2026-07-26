"""Persistent, agent-neutral context packs built from desktop evidence."""

from .compiler import compile_context_prompt, detect_agent_profile, write_context_prompt_artifact
from .intent import ContextIntent, ContextIntentKind, parse_context_intent
from .session import ContextSessionConflict, ContextSessionError, ContextSessionStore

__all__ = [
    "ContextIntent",
    "ContextIntentKind",
    "ContextSessionError",
    "ContextSessionConflict",
    "ContextSessionStore",
    "compile_context_prompt",
    "detect_agent_profile",
    "parse_context_intent",
    "write_context_prompt_artifact",
]
