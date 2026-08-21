"""Kimi-shaped desktop action surface on the main ToolRegistry."""

from .session import (
    DesktopActionSession,
    InputOwnershipLock,
    KIMI_WINDOWS_TOOLS,
    default_session,
    process_input_lock,
    register_desktop_action_tools,
)

__all__ = [
    "DesktopActionSession",
    "InputOwnershipLock",
    "KIMI_WINDOWS_TOOLS",
    "default_session",
    "process_input_lock",
    "register_desktop_action_tools",
]
