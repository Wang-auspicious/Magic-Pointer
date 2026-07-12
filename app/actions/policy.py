from __future__ import annotations

from dataclasses import dataclass

from app.actions.schema import ActionProposal, SafetyLevel

BLOCKED_ACTIONS = {
    "send_message",
    "submit_form",
    "delete_file",
    "run_shell",
    "install_package",
}
READ_ONLY_PREFIXES = ("read_", "inspect_", "explain_")
WRITE_ACTIONS = {
    "office_replace_selection",
    "office_write_selection",
    "office_undo_last_action",
    "paste_text_to_foreground",
    "wechat_send_message",
}
INTERNAL_DASHBOARD_ACTIONS = {
    "shopping_list_add",
    "shopping_list_set_checked",
    "shopping_list_undo_add",
}
SHOPPING_LIST_TARGET_URI = "magic-pointer://dashboard/shopping-list/default"


@dataclass(frozen=True)
class PermissionDecision:
    allowed: bool
    requires_confirmation: bool
    reason: str
    safety_level: SafetyLevel

    def to_dict(self) -> dict[str, object]:
        return {
            "allowed": self.allowed,
            "requires_confirmation": self.requires_confirmation,
            "reason": self.reason,
            "safety_level": self.safety_level.value,
        }


class LocalPermissionPolicy:
    """Hard local policy; model text cannot grant itself permission."""

    def decide(self, proposal: ActionProposal) -> PermissionDecision:
        action_type = proposal.action_type
        if action_type in BLOCKED_ACTIONS:
            return PermissionDecision(False, True, f"{action_type} is blocked until an adapter-specific verifier exists.", SafetyLevel.DESTRUCTIVE)
        if action_type in WRITE_ACTIONS:
            return PermissionDecision(True, True, f"{action_type} writes to another app and needs explicit confirmation.", SafetyLevel.HIGH)
        if action_type in INTERNAL_DASHBOARD_ACTIONS:
            target_uri = proposal.target.object_id if proposal.target is not None else None
            if target_uri != SHOPPING_LIST_TARGET_URI:
                return PermissionDecision(False, True, "internal dashboard action target is not allowlisted", SafetyLevel.DESTRUCTIVE)
            return PermissionDecision(True, False, "reversible local Magic Pointer dashboard action", SafetyLevel.LOW)
        if action_type.startswith(READ_ONLY_PREFIXES) or proposal.safety_level == SafetyLevel.READ_ONLY:
            return PermissionDecision(True, False, "read-only adapter action", SafetyLevel.READ_ONLY)
        return PermissionDecision(True, proposal.needs_confirmation(), "default confirmation policy", proposal.safety_level)
