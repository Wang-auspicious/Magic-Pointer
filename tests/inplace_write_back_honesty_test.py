"""The in-place text recipes must not claim a write-back they did not perform.

`text.rewrite_in_place` and `text.translate_in_place` promise the user that the
text they selected changes, in the app they selected it in. Both used to route to
the `model.text` provider, which writes the model's output to a .md file under
data/artifacts and returns status="succeeded" with verified=True. Outside Word
(the one path with a real COM write-back) nothing was ever written back, and the
UI reported success anyway.

That path had no test coverage at all before this file, which is how it survived.
These tests pin the honest contract: produce the replacement text, keep it so the
user's work is not lost, and refuse to report success until something has actually
written it back.
"""

import json
from pathlib import Path

from app.fabric.engine import FabricEngine, provider_for_recipe
from app.fabric.executors import FabricExecutors
from app.fabric.schema import OperationPlan, RiskLevel


IN_PLACE_RECIPES = ("text.rewrite_in_place", "text.translate_in_place")


def _plan(recipe_id: str, *, provider: str, content: str = "original text") -> OperationPlan:
    return OperationPlan(
        id="plan-inplace",
        recipe_id=recipe_id,
        command="改得更正式",
        provider=provider,
        risk=RiskLevel.LOCAL_WRITE,
        object_ids=("obj-1",),
        parameters={"objects": [{"id": "obj-1", "content": content}]},
        idempotency_key="inplace-key-0123456789abcdef",
    )


def _executors(tmp_path: Path, *, transform=None) -> FabricExecutors:
    return FabricExecutors(
        root=tmp_path,
        model_transform=transform or (lambda command, source, recipe: "rewritten text"),
    )


def test_in_place_recipes_do_not_share_the_artifact_only_provider() -> None:
    for recipe_id in IN_PLACE_RECIPES:
        assert provider_for_recipe(recipe_id) == "inplace.text"


def test_summarize_route_keeps_the_artifact_only_provider() -> None:
    # text.summarize_route's contract genuinely is "produce an artifact", so
    # model.text is correct for it. Guards against fixing the lie by changing
    # _model_text and breaking the recipe that legitimately depends on it.
    assert provider_for_recipe("text.summarize_route") == "model.text"


def test_in_place_write_back_is_never_reported_as_succeeded(tmp_path: Path) -> None:
    executors = _executors(tmp_path)
    for recipe_id in IN_PLACE_RECIPES:
        receipt = executors.execute(_plan(recipe_id, provider="inplace.text"))
        assert receipt.status != "succeeded", receipt.status
        assert receipt.verified is False
        assert receipt.error == "inplace_write_back_requires_action_proposal"


def test_in_place_success_claim_is_impossible_through_the_real_routing(tmp_path: Path) -> None:
    # The tests above pass an explicit provider, so they exercise the executor
    # while bypassing the routing table -- and the original bug lived in the
    # routing. This drives the provider the way the engine does, so reverting
    # the manifest's provider back to model.text fails here.
    executors = _executors(tmp_path)
    for recipe_id in IN_PLACE_RECIPES:
        routed = provider_for_recipe(recipe_id)
        receipt = executors.execute(_plan(recipe_id, provider=routed))
        assert not (receipt.status == "succeeded" and receipt.verified is True), (
            f"{recipe_id} routed to {routed!r} and reported a write-back it did not perform"
        )
        assert receipt.verification.get("mode") != "artifact_only"


def test_in_place_receipt_fails_the_action_layer_success_gate(tmp_path: Path) -> None:
    # app/actions/executor.py:_fabric_receipt_result promotes a receipt to
    # SUCCEEDED only on status == "succeeded" and verified is True. This asserts
    # the receipt cannot pass that gate, which is what the UI reads.
    executors = _executors(tmp_path)
    receipt = executors.execute(_plan("text.rewrite_in_place", provider="inplace.text"))
    payload = json.loads(json.dumps(receipt.to_dict()))
    assert not (payload["status"] == "succeeded" and payload["verified"] is True)


def test_replacement_text_is_preserved_so_the_users_work_is_not_lost(tmp_path: Path) -> None:
    executors = _executors(tmp_path)
    receipt = executors.execute(_plan("text.rewrite_in_place", provider="inplace.text"))
    assert receipt.output["text"] == "rewritten text"
    artifact = Path(receipt.output["artifact"])
    assert artifact.exists()
    assert artifact.read_text(encoding="utf-8").strip() == "rewritten text"
    assert receipt.output["proposalRequired"] is True


def test_empty_selection_and_empty_model_output_stay_distinguishable(tmp_path: Path) -> None:
    empty_source = _executors(tmp_path).execute(
        _plan("text.rewrite_in_place", provider="inplace.text", content="")
    )
    assert empty_source.error == "selected_text_is_empty"

    empty_model = _executors(tmp_path, transform=lambda *_: "  ").execute(
        _plan("text.rewrite_in_place", provider="inplace.text")
    )
    assert empty_model.error == "text_model_returned_empty"


def test_missing_text_model_does_not_hand_in_place_work_to_an_agent() -> None:
    # An agent told to "rewrite this in place" writes somewhere else: the recipe's
    # words are satisfied while the user's document is untouched. engine.py must
    # not route these recipes to agent.task when no text model is configured.
    engine = FabricEngine(model_transform=None)
    assert engine.model_transform_available is False
    parameters: dict[str, object] = {}
    provider = engine._provider("text.rewrite_in_place", parameters)
    assert provider != "agent.task"
    assert parameters.get("capabilityFallback") == "direct_text_model_not_configured"
