from __future__ import annotations

from app.actions.calendar_draft import parse_calendar_draft, wants_calendar_draft
from app.adapters.base import AdapterReadContext


def context(text: str) -> AdapterReadContext:
    return AdapterReadContext(
        adapter="uia_text_selection",
        app="pdf",
        window={"title": "活动海报.pdf - Microsoft Edge", "hwnd": 123},
        content=text,
        label="活动海报.pdf",
        method="uia:text-pattern.selection",
    )


def test_calendar_intent_is_strict() -> None:
    for command in ("添加到日历", "把这个加入日历", "Add this to my calendar", "create a calendar event from this"):
        assert wants_calendar_draft(command)
    for command in ("解释这个", "日历是什么", "add more dates", ""):
        assert not wants_calendar_draft(command)


def test_parse_explicit_chinese_event_fields() -> None:
    draft = parse_calendar_draft(
        context("产品发布会\n2026年7月20日 14:00—16:00\n地点：上海徐汇滨江"),
        selection_snapshot_id="snapshot-calendar-1",
    )
    assert draft["title"] == "产品发布会"
    assert draft["date"] == "2026-07-20"
    assert draft["start_time"] == "14:00"
    assert draft["end_time"] == "16:00"
    assert draft["location"] == "上海徐汇滨江"
    assert draft["timezone"] == "Asia/Shanghai"
    assert draft["missing_fields"] == []
    assert draft["event"]["start_at"] == "2026-07-20T14:00:00+08:00"


def test_parse_current_year_date_and_single_time_defaults_to_one_hour() -> None:
    draft = parse_calendar_draft(
        context("设计评审\n7月22日下午3点\n地址：A 会议室"),
        selection_snapshot_id="snapshot-calendar-2",
        current_year=2026,
    )
    assert draft["date"] == "2026-07-22"
    assert draft["start_time"] == "15:00"
    assert draft["end_time"] == "16:00"


def test_missing_date_stays_a_non_executable_draft() -> None:
    draft = parse_calendar_draft(
        context("团队同步\n地点：线上会议"),
        selection_snapshot_id="snapshot-calendar-3",
    )
    assert "date" in draft["missing_fields"]
    assert "start_time" in draft["missing_fields"]
    assert draft["event"] is None


def test_ambiguous_relative_date_is_not_guessed() -> None:
    draft = parse_calendar_draft(
        context("客户回访\n下周五 10:00-11:00\n地点：线上"),
        selection_snapshot_id="snapshot-calendar-4",
    )
    assert "date" in draft["missing_fields"]
    assert draft["event"] is None
    assert draft["warnings"]
