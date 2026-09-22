

def test_ask_feedback_for_dangerous_effects_never_offers_a_grant():
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
        assert "AskUser" not in text, f"{effect} 不得出现快授通道"
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
    assert "AskUser" in text
