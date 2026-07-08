import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.actions.schema import ActionProposal, ActionTarget, ConfirmationPolicy, ExecutionResult, ExecutionStatus, SafetyLevel
from app.grounding.schema import GroundedObject, PointerSelection


def test_grounding_serialization() -> None:
    selection = PointerSelection(
        id="sel_1",
        point=(120, 240),
        bbox=(100, 220, 180, 280),
        screen_size=(1920, 1080),
        selected_at="2026-07-07T12:00:00Z",
        modifiers=("shift",),
        metadata={"surface": "desktop"},
    )
    selection_payload = json.loads(json.dumps(selection.to_dict(), ensure_ascii=False))
    restored_selection = PointerSelection.from_dict(selection_payload)
    assert restored_selection == selection

    obj = GroundedObject.from_selection(
        id="obj_1",
        kind="button",
        selection=restored_selection,
        label="Submit",
        confidence=0.98,
        text="提交",
        app_title="Demo",
        metadata={"role": "primary"},
    )
    obj_payload = json.loads(json.dumps(obj.to_dict(), ensure_ascii=False))
    restored_obj = GroundedObject.from_dict(obj_payload)
    assert restored_obj == obj
    assert restored_obj.source_selection_id == "sel_1"
    assert restored_obj.bbox == (100, 220, 180, 280)


def test_action_and_result_serialization() -> None:
    obj = GroundedObject(
        id="obj_2",
        kind="input",
        bbox=(10, 20, 200, 48),
        label="Search",
        source_selection_id="sel_2",
    )
    proposal = ActionProposal(
        id="act_1",
        action_type="type_text",
        target=ActionTarget.from_grounded_object(obj, point=(20, 30)),
        parameters={"text": "hello"},
        safety_level=SafetyLevel.MEDIUM,
        rationale="Typing changes focused UI state.",
    )
    payload = json.loads(json.dumps(proposal.to_dict(), ensure_ascii=False))
    assert payload["safety_level"] == "medium"
    assert payload["confirmation_required"] is True

    restored = ActionProposal.from_dict(payload)
    assert restored.id == "act_1"
    assert restored.target is not None
    assert restored.target.bbox == (10, 20, 200, 48)
    assert restored.target.point == (20, 30)
    assert restored.needs_confirmation() is True

    result = ExecutionResult(
        proposal_id=restored.id,
        action_type=restored.action_type,
        status=ExecutionStatus.SUCCEEDED,
        output={"typed": 5},
        confirmed_by_user=True,
    )
    restored_result = ExecutionResult.from_dict(json.loads(json.dumps(result.to_dict())))
    assert restored_result == result


def test_confirmation_policy() -> None:
    default_policy = ConfirmationPolicy()
    assert ActionProposal(id="read", action_type="inspect", safety_level=SafetyLevel.READ_ONLY).needs_confirmation(default_policy) is False
    assert ActionProposal(id="low", action_type="hover", safety_level=SafetyLevel.LOW).needs_confirmation(default_policy) is False
    assert ActionProposal(id="medium", action_type="type_text", safety_level=SafetyLevel.MEDIUM).needs_confirmation(default_policy) is True
    assert ActionProposal(id="high", action_type="send", safety_level=SafetyLevel.HIGH).needs_confirmation(default_policy) is True
    assert ActionProposal(
        id="forced",
        action_type="click",
        safety_level=SafetyLevel.LOW,
        confirmation_required=True,
    ).needs_confirmation(default_policy) is True
    assert ActionProposal(
        id="blocked_downgrade",
        action_type="delete",
        safety_level=SafetyLevel.DESTRUCTIVE,
        confirmation_required=False,
    ).needs_confirmation(default_policy) is True

    strict_policy = ConfirmationPolicy(confirm_at_or_above=SafetyLevel.LOW)
    assert ActionProposal(id="strict_read", action_type="inspect", safety_level=SafetyLevel.READ_ONLY).needs_confirmation(strict_policy) is False
    assert ActionProposal(id="strict_low", action_type="click", safety_level=SafetyLevel.LOW).needs_confirmation(strict_policy) is True


def main() -> None:
    test_grounding_serialization()
    test_action_and_result_serialization()
    test_confirmation_policy()
    print("schema test ok")


if __name__ == "__main__":
    main()

