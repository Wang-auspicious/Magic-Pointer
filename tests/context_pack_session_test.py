from __future__ import annotations

from pathlib import Path

import pytest

from app.context_pack.session import ContextSessionConflict, ContextSessionError, ContextSessionStore


def native_snapshot(*, snapshot_id: str = "snap-1", text: str = "selected code") -> dict:
    return {
        "snapshot_id": snapshot_id,
        "captured_at": "2026-07-22T10:00:00+08:00",
        "source_kind": "native_selection",
        "source_window": {
            "title": "app.py - Visual Studio Code",
            "hwnd": 101,
            "process_id": 102,
            "process_name": "Code.exe",
        },
        "target_point": {"x": 640, "y": 480},
        "context": {
            "app": "code",
            "label": r"D:\repo\app.py",
            "content": text,
            "method": "uia:text-pattern",
            "artifacts": {
                "document": r"D:\repo\app.py",
                "selection_context": f"before {text} after",
                "selection_rectangles": [[100, 200, 300, 40]],
            },
        },
    }


def visual_capture(*, object_id: str = "object-1") -> dict:
    return {
        "object_id": object_id,
        "captured_at": "2026-07-22T10:01:00+08:00",
        "source_window": {
            "title": "Broken checkout - Chrome",
            "hwnd": 201,
            "process_id": 202,
            "process_name": "chrome.exe",
        },
        "source_confidence": "point_hit",
        "raw_image_path": r"D:\tmp\screen.png",
        "pointer_image_path": r"D:\tmp\pointer.png",
        "point": [420, 260],
        "bbox": [400, 240, 180, 90],
        "capture_bbox": [0, 0, 1920, 1080],
        "grounding": {
            "label": "red checkout error card",
            "method": "pointer-stroke+vision",
            "confidence": 0.84,
        },
        "file_context": {
            "path": r"D:\repo\checkout.html",
            "method": "html:bs4",
            "text": "<section class=error>Payment failed</section>",
        },
        "app_context": {"url": "https://example.test/checkout", "role": "document"},
        "vision_observation": "A red Payment failed card appears below the form.",
    }


def test_store_persists_native_and_visual_items_in_capture_order(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1", "item-2"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))

    first = store.record_native(native_snapshot(), "这是当前实现入口", now="2026-07-22T10:02:00+08:00")
    second = store.record_visual(visual_capture(), "这是需要修复的错误状态", now="2026-07-22T10:03:00+08:00")
    reopened = ContextSessionStore(root=tmp_path).active()

    assert first["session_id"] == second["session_id"] == "context-1"
    assert reopened is not None
    assert reopened["item_count"] == 2
    assert [item["modality"] for item in reopened["items"]] == ["native_selection", "visual_pointer"]
    assert reopened["items"][0]["selected_text"] == "selected code"
    assert reopened["items"][0]["source"]["document_path"] == r"D:\repo\app.py"
    assert reopened["items"][0]["geometry"]["point"] == [640, 480]
    assert reopened["items"][1]["images"]["pointer"] == r"D:\tmp\pointer.png"
    assert reopened["items"][1]["geometry"]["bbox"] == [400.0, 240.0, 180.0, 90.0]
    assert reopened["items"][1]["source"]["url"] == "https://example.test/checkout"
    assert reopened["items"][1]["source"]["confidence"] == "point_hit"
    assert reopened["items"][1]["vision_observation"].startswith("A red Payment failed")
    assert reopened["items"][1]["grounding"]["confidence"] == 0.84


def test_store_deduplicates_same_evidence_and_instruction(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))

    first = store.record_native(native_snapshot(), "这是实现入口")
    replay = store.record_native(native_snapshot(), "这是实现入口")

    assert first["recorded"] is True
    assert replay["recorded"] is False
    assert replay["item"]["item_id"] == first["item"]["item_id"]
    assert store.active()["item_count"] == 1  # type: ignore[index]


def test_store_rejects_empty_explanation_or_ungrounded_evidence(tmp_path: Path) -> None:
    store = ContextSessionStore(root=tmp_path)

    with pytest.raises(ContextSessionError, match="explanation is empty"):
        store.record_native(native_snapshot(), " ")
    with pytest.raises(ContextSessionError, match="grounded native selection"):
        store.record_native({"snapshot_id": "bad", "context": None}, "important")
    with pytest.raises(ContextSessionError, match="grounded visual capture"):
        store.record_visual({"object_id": "bad"}, "important")


def test_store_records_compilation_and_finishes_without_reusing_session(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1", "context-2", "item-2"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(native_snapshot(), "入口")

    compiled = store.save_compilation(
        task_instruction="修复这个状态",
        target_profile="codex",
        prompt="# task",
        prompt_artifact=r"D:\tmp\context-1.md",
        expected_session_id=store.active()["session_id"],  # type: ignore[index]
        expected_revision=store.active()["store_revision"],  # type: ignore[index]
        expected_items_digest=store.active()["items_digest"],  # type: ignore[index]
        now="2026-07-22T10:05:00+08:00",
    )
    finished = store.finish(now="2026-07-22T10:06:00+08:00")
    next_item = store.record_native(native_snapshot(snapshot_id="snap-2"), "第二轮")

    assert compiled["task_instruction"] == "修复这个状态"
    assert compiled["target_profile"] == "codex"
    assert compiled["compiled_prompt"] == "# task"
    assert finished["status"] == "finished"
    assert next_item["session_id"] == "context-2"


def test_empty_store_cannot_compile_or_finish(tmp_path: Path) -> None:
    store = ContextSessionStore(root=tmp_path)

    with pytest.raises(ContextSessionError, match="no active context session"):
        store.save_compilation(
            task_instruction="task",
            target_profile="generic",
            prompt="p",
            prompt_artifact="p.md",
            expected_session_id="context-none",
            expected_revision=0,
            expected_items_digest="0" * 64,
        )
    with pytest.raises(ContextSessionError, match="no active context session"):
        store.finish()


def test_compilation_uses_compare_and_swap_when_items_change(tmp_path: Path) -> None:
    ids = iter(["context-1", "item-1", "item-2"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(native_snapshot(), "入口")
    stale = store.active()
    assert stale is not None
    store.record_native(native_snapshot(snapshot_id="snap-2", text="second"), "第二条")

    with pytest.raises(ContextSessionConflict, match="changed while compiling"):
        store.save_compilation(
            task_instruction="修复",
            target_profile="codex",
            prompt="stale prompt",
            prompt_artifact="stale.md",
            expected_session_id=stale["session_id"],
            expected_revision=stale["store_revision"],
            expected_items_digest=stale["items_digest"],
        )

    current = store.active()
    assert current is not None
    assert current["item_count"] == 2
    assert current["compiled_prompt"] is None


@pytest.mark.parametrize(
    "corrupt_state",
    [
        {"version": 1, "revision": 0, "active_session_id": None, "sessions": [1]},
        {"version": 1, "revision": 0, "active_session_id": "missing", "sessions": []},
        {
            "version": 1,
            "revision": 0,
            "active_session_id": "context-1",
            "sessions": [{"session_id": "context-1", "status": "active", "items": ["bad"]}],
        },
    ],
)
def test_corrupt_but_valid_json_fails_as_context_session_error(tmp_path: Path, corrupt_state: dict) -> None:
    path = tmp_path / "context" / "context_sessions.json"
    path.parent.mkdir(parents=True)
    path.write_text(__import__("json").dumps(corrupt_state), encoding="utf-8")

    with pytest.raises(ContextSessionError, match="invalid context"):
        ContextSessionStore(root=tmp_path).active()


def test_runtime_issue_locks_first_statement_and_assigns_reference_roles(tmp_path: Path) -> None:
    ids = iter(["context-runtime", "item-issue", "item-reference"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))

    first = store.record_runtime_visual(
        visual_capture(object_id="problem-button"),
        "这个保存按钮太靠下，应该和右侧卡片顶部对齐",
        now="2026-07-23T09:00:00+08:00",
    )
    second = store.record_runtime_visual(
        visual_capture(object_id="reference-button"),
        "参考这个卡片的间距和按钮位置",
        now="2026-07-23T09:01:00+08:00",
    )
    active = store.active()

    assert first["item"]["role"] == "issue"
    assert second["item"]["role"] == "reference"
    assert active is not None
    assert active["workflow_kind"] == "runtime_issue"
    assert active["task_instruction"] == "这个保存按钮太靠下，应该和右侧卡片顶部对齐"
    assert [item["role"] for item in active["items"]] == ["issue", "reference"]
    assert active["item_count"] == 2


def test_runtime_issue_rolls_over_legacy_context_instead_of_mixing_evidence(tmp_path: Path) -> None:
    ids = iter(["context-legacy", "item-legacy", "context-runtime", "item-issue"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    legacy = store.record_native(native_snapshot(), "旧代码上下文")

    runtime = store.record_runtime_visual(
        visual_capture(object_id="runtime-problem"),
        "运行中的按钮位置不对",
        now="2026-07-23T09:05:00+08:00",
    )
    state = __import__("json").loads(store.path.read_text(encoding="utf-8"))

    assert legacy["session_id"] == "context-legacy"
    assert runtime["session_id"] == "context-runtime"
    assert state["active_session_id"] == "context-runtime"
    assert state["sessions"][0]["status"] == "finished"
    assert state["sessions"][0]["finished_at"] == "2026-07-23T09:05:00+08:00"
    assert state["sessions"][1]["workflow_kind"] == "runtime_issue"
    assert [item["item_id"] for item in state["sessions"][1]["items"]] == ["item-issue"]


def test_runtime_issue_rejects_blank_statement_without_finishing_existing_context(tmp_path: Path) -> None:
    ids = iter(["context-legacy", "item-legacy"])
    store = ContextSessionStore(root=tmp_path, id_factory=lambda: next(ids))
    store.record_native(native_snapshot(), "保留这条上下文")

    with pytest.raises(ContextSessionError, match="statement is empty"):
        store.record_runtime_visual(visual_capture(), " ")

    active = store.active()
    assert active is not None
    assert active["session_id"] == "context-legacy"
    assert active["status"] == "active"


def test_finish_rejects_a_different_expected_runtime_session(tmp_path: Path) -> None:
    store = ContextSessionStore(
        root=tmp_path,
        id_factory=iter(["context-runtime", "item-issue"]).__next__,
    )
    store.record_runtime_visual(visual_capture(), "按钮错位")

    with pytest.raises(ContextSessionConflict, match="changed before finish"):
        store.finish(expected_session_id="context-other")

    assert store.active() is not None
