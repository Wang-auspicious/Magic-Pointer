from __future__ import annotations

from pathlib import Path

from app.actions.executor import SafeActionExecutor
from app.actions.schema import ActionProposal
from app.actions.shopping_list import (
    make_shopping_list_add_proposal,
    make_shopping_list_check_proposal,
    make_shopping_list_undo_proposal,
    wants_shopping_list_add,
)
from app.adapters.base import AdapterReadContext
from app.dashboard.shopping_list import ShoppingListStore


def context(text: str = "1 lb Spaghetti") -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia_text_selection",
        app="pdf",
        window={"title": "Recipe.pdf - Microsoft Edge", "hwnd": 123},
        content=text,
        label="Recipe.pdf",
        method="uia:text-pattern.selection",
    )


def test_strict_add_intent_and_proposal() -> None:
    for command in ("Add this", "add it to my shopping list", "添加这个", "加入清单", "把这个加入购物清单"):
        assert wants_shopping_list_add(command)
    for command in ("Explain this", "Add more detail to this paragraph", "address this", ""):
        assert not wants_shopping_list_add(command)

    proposal = make_shopping_list_add_proposal(
        context(),
        command="Add this",
        selection_session_id="session-1",
        selection_snapshot_id="snap-1",
    )
    assert proposal is not None
    assert proposal.action_type == "shopping_list_add"
    assert proposal.target is not None
    assert proposal.target.object_id == "magic-pointer://dashboard/shopping-list/default"
    assert proposal.confirmation_required is False
    assert proposal.parameters["item_text"] == "1 lb Spaghetti"
    assert proposal.metadata["trusted_local_intent"] is True
    assert proposal.metadata["auto_execute"] is True
    assert make_shopping_list_add_proposal(
        context("x" * 161),
        command="Add this",
        selection_session_id="session-1",
        selection_snapshot_id="snap-1",
    ) is None


def test_executor_adds_verifies_checks_and_precisely_undoes(tmp_path: Path) -> None:
    store = ShoppingListStore(tmp_path)
    executor = SafeActionExecutor(shopping_list_store=store)
    add = make_shopping_list_add_proposal(
        context(),
        command="Add this",
        selection_session_id="session-1",
        selection_snapshot_id="snap-1",
    )
    assert add is not None
    result = executor.execute(add, confirmed=False)
    assert result.status.value == "succeeded"
    assert result.output["verified"] is True
    assert result.output["item"]["text"] == "1 lb Spaghetti"
    assert result.output["created"] is True
    undo_data = result.output["undo_proposal"]
    assert undo_data["action_type"] == "shopping_list_undo_add"
    assert len(store.public_list()["items"]) == 1

    retry = executor.execute(add, confirmed=False)
    assert retry.status.value == "succeeded"
    assert retry.output["created"] is False
    assert len(store.public_list()["items"]) == 1

    item = result.output["item"]
    check = make_shopping_list_check_proposal(item, checked=True)
    checked = executor.execute(check, confirmed=False)
    assert checked.status.value == "succeeded"
    assert checked.output["item"]["checked"] is True

    stale_undo = executor.execute(ActionProposal.from_dict(undo_data), confirmed=False)
    assert stale_undo.status.value == "failed"
    assert len(store.public_list()["items"]) == 1

    fresh_undo = make_shopping_list_undo_proposal(
        receipt_id=result.output["receipt_id"],
        item=checked.output["item"],
    )
    undone = executor.execute(fresh_undo, confirmed=False)
    assert undone.status.value == "succeeded"
    assert undone.output["verified"] is True
    assert store.public_list()["items"] == []

