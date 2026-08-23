

def test_ask_feedback_for_dangerous_effects_never_offers_a_grant():
    """Hermes/Codex plan-mode 契约：外发/破坏/购买是「脚本级变更」，
    只能走计划提案确认卡，绝不提供「总是允许」快授。"""
    from app.agent_runtime.permission_modes import (
        PermissionDecision,
        PermissionDecisionResult,
        PermissionMode,
    )
    from app.agent_runtime.tool_registry import Effect

    for effect in (Effect.EXTERNAL_SEND, Effect.DESTRUCTIVE, Effect.PURCHASE):
        text = PermissionDecisionResult(
            decision=PermissionDecision.ASK,
            mode=PermissionMode.PLAN,
            effect=effect,
        ).feedback("send_email")
        assert "ask_user_question" not in text, f"{effect} 不得出现快授通道"
        assert "propose a plan" in text


def test_grantable_feedback_keeps_the_grant_channel():
    from app.agent_runtime.permission_modes import (
        PermissionDecision,
        PermissionDecisionResult,
        PermissionMode,
    )
    from app.agent_runtime.tool_registry import Effect

    text = PermissionDecisionResult(
        decision=PermissionDecision.ASK,
        mode=PermissionMode.DEFAULT,
        effect=Effect.LOCAL_IRREVERSIBLE,
    ).feedback("run_command")
    assert "ask_user_question" in text
