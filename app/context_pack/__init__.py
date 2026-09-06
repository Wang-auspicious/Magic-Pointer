"""Persistent, agent-neutral context packs built from desktop evidence."""

from .browser_reader import BrowserContextReader
from .chat_reader import ChatReader, DesktopChatNavigator, SurfaceChatHistoryBackend
from .capture_policy import (
    build_context_capture_policy,
    build_stored_object_capture_policy,
    context_item_object,
    stored_pointer_object,
)
from .compiler import compile_context_prompt, detect_agent_profile, write_context_prompt_artifact
from .document_reader import DocumentReader
from .intent import ContextIntent, ContextIntentKind, parse_context_intent
from .session import ContextSessionConflict, ContextSessionError, ContextSessionStore
from .source_scope import (
    AccessDecision,
    AccessRequest,
    ScopeGrant,
    TaskSourceScope,
    authorize_access,
    ensure_folder_read_scope,
    grant_source_scope,
    resolve_access,
    scope_from_events,
)
from .sources import (
    Coverage,
    FragmentLocator,
    ReadFragment,
    ReadResult,
    ReferenceBinding,
    ReferenceUpdate,
    SourceReader,
    SourceReaderRegistry,
    SourceRef,
    TaskInput,
    TimelineEvent,
)

__all__ = [
    "ContextIntent",
    "ContextIntentKind",
    "ContextSessionError",
    "ContextSessionConflict",
    "ContextSessionStore",
    "AccessDecision",
    "AccessRequest",
    "Coverage",
    "DocumentReader",
    "BrowserContextReader",
    "ChatReader",
    "DesktopChatNavigator",
    "SurfaceChatHistoryBackend",
    "FragmentLocator",
    "ReadFragment",
    "ReadResult",
    "ScopeGrant",
    "ReferenceBinding",
    "ReferenceUpdate",
    "SourceReader",
    "SourceReaderRegistry",
    "SourceRef",
    "TaskInput",
    "TaskSourceScope",
    "TimelineEvent",
    "build_context_capture_policy",
    "build_stored_object_capture_policy",
    "compile_context_prompt",
    "context_item_object",
    "authorize_access",
    "ensure_folder_read_scope",
    "grant_source_scope",
    "stored_pointer_object",
    "detect_agent_profile",
    "parse_context_intent",
    "resolve_access",
    "scope_from_events",
    "write_context_prompt_artifact",
]
