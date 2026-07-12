from __future__ import annotations

from pathlib import Path

import pytest

from app.review.session import ReviewSessionError, ReviewSessionStore


def pdf_snapshot(*, page: int, text: str, snapshot_id: str) -> dict:
    return {
        "snapshot_id": snapshot_id,
        "captured_at": "2026-07-12T10:00:00+08:00",
        "source_kind": "native_selection",
        "source_window": {
            "title": "paper.pdf - Microsoft Edge",
            "hwnd": 210,
            "process_id": 310,
        },
        "context": {
            "adapter": "uia_text_selection",
            "app": "pdf",
            "window": {"title": "paper.pdf - Microsoft Edge", "hwnd": 210},
            "content": text,
            "label": r"D:\papers\paper.pdf",
            "method": "pdf:screen-highlight+local-text-layer",
            "capabilities": [],
            "artifacts": {
                "pdf_document_path": r"D:\papers\paper.pdf",
                "pdf_page_number": page,
                "selection_context": f"Context around {text}",
                "selection_rectangles": [[100.0, 200.0, 300.0, 40.0]],
            },
        },
    }


def test_review_store_keeps_pdf_page_anchors_across_processes(tmp_path: Path) -> None:
    ids = iter(["review-1", "anchor-1", "anchor-2"])
    store = ReviewSessionStore(root=tmp_path, id_factory=lambda: next(ids))

    first = store.record(
        pdf_snapshot(page=2, text="Figure 2", snapshot_id="snap-2"),
        "图注和正文不一致",
        now="2026-07-12T10:01:00+08:00",
    )
    second = store.record(
        pdf_snapshot(page=7, text="Table 4", snapshot_id="snap-7"),
        "这个表格的单位需要统一",
        now="2026-07-12T10:02:00+08:00",
    )
    reopened = ReviewSessionStore(root=tmp_path).active()

    assert first["session_id"] == second["session_id"] == "review-1"
    assert reopened is not None
    assert [item["page_number"] for item in reopened["anchors"]] == [2, 7]
    assert reopened["anchors"][0]["instruction"] == "图注和正文不一致"
    assert reopened["anchors"][0]["selected_text"] == "Figure 2"
    assert reopened["anchors"][0]["surrounding_context"] == "Context around Figure 2"
    assert reopened["anchors"][0]["selection_rectangles"] == [[100.0, 200.0, 300.0, 40.0]]
    assert reopened["artifact"]["document_path"] == r"D:\papers\paper.pdf"
    assert reopened["anchor_count"] == 2


def test_review_store_deduplicates_replayed_snapshot_and_instruction(tmp_path: Path) -> None:
    ids = iter(["review-1", "anchor-1"])
    store = ReviewSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    snapshot = pdf_snapshot(page=2, text="Figure 2", snapshot_id="snap-2")

    first = store.record(snapshot, "图注和正文不一致")
    replay = store.record(snapshot, "图注和正文不一致")

    assert replay["recorded"] is False
    assert replay["anchor"]["anchor_id"] == first["anchor"]["anchor_id"]
    assert store.active()["anchor_count"] == 1  # type: ignore[index]


def test_review_store_rejects_blank_or_ungrounded_notes(tmp_path: Path) -> None:
    store = ReviewSessionStore(root=tmp_path)

    with pytest.raises(ReviewSessionError, match="instruction is empty"):
        store.record(pdf_snapshot(page=1, text="Intro", snapshot_id="snap-1"), "  ")

    with pytest.raises(ReviewSessionError, match="grounded selection context"):
        store.record({"snapshot_id": "empty", "context": None}, "这里要修改")


def test_finished_session_is_not_reused(tmp_path: Path) -> None:
    ids = iter(["review-1", "anchor-1", "review-2", "anchor-2"])
    store = ReviewSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record(pdf_snapshot(page=1, text="A", snapshot_id="snap-a"), "第一处")

    finished = store.finish(now="2026-07-12T11:00:00+08:00")
    next_record = store.record(pdf_snapshot(page=3, text="B", snapshot_id="snap-b"), "第二处")

    assert finished["status"] == "finished"
    assert next_record["session_id"] == "review-2"
    assert store.active()["anchor_count"] == 1  # type: ignore[index]
