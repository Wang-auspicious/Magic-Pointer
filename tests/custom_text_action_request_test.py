import pytest

from app.text_actions.custom_action_request import compile_custom_text_action_request


def test_compiles_a_selection_direct_request_for_an_arbitrary_source_application():
    request = compile_custom_text_action_request(
        selection={
            "text": "Please make this update concise.",
            "source_app": "Contoso Writer",
            "snapshot_id": "selection-42",
            "range_ref": "native-range-7",
        },
        action={
            "id": "concise",
            "label": "Make concise",
            "instructions": "Keep all factual claims.",
        },
    )

    assert request == {
        "version": "custom-text-action-request-v1",
        "invocation": "selection-direct",
        "action": {
            "id": "concise",
            "label": "Make concise",
            "instructions": "Keep all factual claims.",
        },
        "selection": {
            "text": "Please make this update concise.",
            "source_app": "Contoso Writer",
            "snapshot_id": "selection-42",
            "range_ref": "native-range-7",
        },
    }


@pytest.mark.parametrize("text", ["", "   ", None])
def test_rejects_a_missing_or_blank_selected_text(text):
    with pytest.raises(ValueError, match="selection.text"):
        compile_custom_text_action_request(
            selection={"text": text, "source_app": "Any application"},
            action={"id": "translate", "label": "Translate", "instructions": "Translate."},
        )


def test_rejects_an_action_without_a_stable_identifier():
    with pytest.raises(ValueError, match="action.id"):
        compile_custom_text_action_request(
            selection={"text": "Selected text", "source_app": "Any application"},
            action={"label": "Translate", "instructions": "Translate."},
        )
