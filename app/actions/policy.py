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
    "shopping_list_add_many",
    "shopping_list_set_checked",
    "shopping_list_undo_add",
}
SHOPPING_LIST_TARGET_URI = "magic-pointer://dashboard/shopping-list/default"
CALENDAR_TARGET_URI = "magic-pointer://dashboard/calendar/local"
CALENDAR_ACTIONS = {"calendar_event_create", "calendar_event_undo_create"}
FABRIC_TARGET_PREFIX = "magic-pointer://fabric/recipe/"


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
        if action_type == "paste_text_to_foreground":
            explicit_no_submit = (
                proposal.metadata.get("trusted_local_intent") is True
                and proposal.metadata.get("explicit_user_delivery_intent") is True
                and proposal.metadata.get("no_submit") is True
                and proposal.parameters.get("submit") is False
                and bool(proposal.parameters.get("target_hwnd"))
                and bool(proposal.parameters.get("text_sha256"))
            )
            if explicit_no_submit:
                return PermissionDecision(
                    True,
                    False,
                    "explicit user-requested local draft delivery with submit disabled",
                    SafetyLevel.LOW,
                )
            return PermissionDecision(
                True,
                True,
                "cross-application text write requires explicit user intent",
                SafetyLevel.HIGH,
            )
        if action_type in WRITE_ACTIONS:
            return PermissionDecision(True, True, f"{action_type} writes to another app and needs explicit confirmation.", SafetyLevel.HIGH)
        if action_type in INTERNAL_DASHBOARD_ACTIONS:
            target_uri = proposal.target.object_id if proposal.target is not None else None
            if target_uri != SHOPPING_LIST_TARGET_URI:
                return PermissionDecision(False, True, "internal dashboard action target is not allowlisted", SafetyLevel.DESTRUCTIVE)
            return PermissionDecision(True, False, "reversible local Magic Pointer dashboard action", SafetyLevel.LOW)
        if action_type in CALENDAR_ACTIONS:
            target_uri = proposal.target.object_id if proposal.target is not None else None
            if target_uri != CALENDAR_TARGET_URI:
                return PermissionDecision(False, True, "local calendar action target is not allowlisted", SafetyLevel.DESTRUCTIVE)
            if action_type == "calendar_event_create":
                return PermissionDecision(True, True, "calendar creation requires explicit review and confirmation", SafetyLevel.MEDIUM)
            return PermissionDecision(True, False, "receipt-bound local calendar undo", SafetyLevel.LOW)
        if action_type == "fabric_recipe_execute":
            target_uri = proposal.target.object_id if proposal.target is not None else None
            trusted = (
                isinstance(target_uri, str)
                and target_uri.startswith(FABRIC_TARGET_PREFIX)
                and proposal.metadata.get("trusted_local_intent") is True
                and proposal.metadata.get("fabric_plan_signed") is True
                and isinstance(proposal.parameters.get("plan"), dict)
            )
            if not trusted:
                return PermissionDecision(False, True, "fabric action is not a signed local plan", SafetyLevel.DESTRUCTIVE)
            return PermissionDecision(
                True,
                proposal.needs_confirmation(),
                "signed Magic Pointer Recipe plan; executor verifies HMAC and provider capability",
                proposal.safety_level,
            )
        if action_type.startswith(READ_ONLY_PREFIXES) or proposal.safety_level == SafetyLevel.READ_ONLY:
            return PermissionDecision(True, False, "read-only adapter action", SafetyLevel.READ_ONLY)
        return PermissionDecision(True, proposal.needs_confirmation(), "default confirmation policy", proposal.safety_level)
