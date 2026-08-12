"""Tests for failure repair dialogue data (harness gap review L15).

Every failure produces an attributed title (never a bare "出错了" then
spinner), a UI message, and 1-4 suggested repair actions.
"""

from __future__ import annotations

import dataclasses

import pytest

from app.failure_flow.repair_prompt import (
    RepairAction,
    RepairSuggestion,
    build_repair,
    to_dict,
)

# (failure_type, evidence_status, title keywords [any-of], expected actions)
_MAPPING_TABLE = [
    ("timeout", None, {"读取超时", "忙"}, (RepairAction.USE_LOOK, RepairAction.RETRY)),
    (None, "busy", {"读取超时", "忙"}, (RepairAction.USE_LOOK, RepairAction.RETRY)),
    (None, "timeout", {"读取超时", "忙"}, (RepairAction.USE_LOOK, RepairAction.RETRY)),
    (None, "empty_confirmed", {"确认没有内容"}, (RepairAction.REPICK, RepairAction.ASK_USER)),
    ("stale_anchor", None, {"目标已变化", "失效"}, (RepairAction.REPICK, RepairAction.RECHOOSE_CANDIDATE)),
    (None, "error", {"目标已变化", "失效"}, (RepairAction.REPICK, RepairAction.RECHOOSE_CANDIDATE)),
    (None, "ambiguous", {"有多个候选"}, (RepairAction.RECHOOSE_CANDIDATE, RepairAction.ASK_USER)),
    ("unsupported", None, {"不支持", "未配置"}, (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.USE_LOOK)),
    (None, "unsupported", {"不支持", "未配置"}, (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.USE_LOOK)),
    ("permission_denied", None, {"权限"}, (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.ASK_USER)),
    ("some_unknown_failure", "ok", {"无法确定"}, (RepairAction.ASK_USER, RepairAction.USE_LOOK)),
    (None, None, {"无法确定"}, (RepairAction.ASK_USER, RepairAction.USE_LOOK)),
]


@pytest.mark.parametrize("failure_type,evidence_status,title_keys,actions", _MAPPING_TABLE)
def test_mapping_table(failure_type, evidence_status, title_keys, actions):
    suggestion = build_repair(failure_type, evidence_status)
    assert any(key in suggestion.title for key in title_keys)
    assert suggestion.actions == actions


@pytest.mark.parametrize("failure_type,evidence_status,title_keys,actions", _MAPPING_TABLE)
def test_actions_count_within_1_to_4(failure_type, evidence_status, title_keys, actions):
    suggestion = build_repair(failure_type, evidence_status)
    assert 1 <= len(suggestion.actions) <= 4


@pytest.mark.parametrize("failure_type,evidence_status,title_keys,actions", _MAPPING_TABLE)
def test_title_is_attributed_not_bare(failure_type, evidence_status, title_keys, actions):
    suggestion = build_repair(failure_type, evidence_status)
    assert suggestion.title.strip()
    assert suggestion.title not in {"出错了", "出错", "失败"}


@pytest.mark.parametrize("failure_type,evidence_status,title_keys,actions", _MAPPING_TABLE)
def test_message_is_non_empty(failure_type, evidence_status, title_keys, actions):
    suggestion = build_repair(failure_type, evidence_status)
    assert suggestion.message.strip()


def test_permission_denied_wins_over_error_evidence():
    suggestion = build_repair("permission_denied", "error")
    assert "权限" in suggestion.title
    assert suggestion.actions == (RepairAction.EXPLAIN_WHAT_FAILED, RepairAction.ASK_USER)


def test_timeout_failure_wins_over_ambiguous_evidence():
    suggestion = build_repair("timeout", "ambiguous")
    assert "读取超时" in suggestion.title
    assert suggestion.actions == (RepairAction.USE_LOOK, RepairAction.RETRY)


def test_target_type_is_woven_into_title():
    suggestion = build_repair("timeout", None, target_type="table_region")
    assert "表格区域" in suggestion.title
    assert "读取超时" in suggestion.title


def test_target_type_unknown_value_falls_back_to_raw():
    suggestion = build_repair("timeout", None, target_type="weird_thing")
    assert "weird_thing" in suggestion.title


def test_target_type_with_default_failure():
    suggestion = build_repair(None, None, target_type="file_line")
    assert "文件行" in suggestion.title
    assert "无法确定" in suggestion.title


def test_evidence_status_passthrough():
    suggestion = build_repair(None, "busy")
    assert suggestion.evidence_status == "busy"


def test_evidence_status_none_defaults():
    suggestion = build_repair("timeout", None)
    assert suggestion.evidence_status is None


def test_to_dict_fields_and_types():
    suggestion = build_repair("timeout", "busy", target_type="text_selection")
    data = to_dict(suggestion)
    assert set(data) == {"title", "message", "actions", "evidence_status"}
    assert data["title"] == suggestion.title
    assert data["message"] == suggestion.message
    assert data["actions"] == ["use_look", "retry"]
    assert data["evidence_status"] == "busy"


def test_to_dict_round_trip():
    suggestion = build_repair("stale_anchor", None, target_type="table_region")
    data = to_dict(suggestion)
    rebuilt = RepairSuggestion(
        title=data["title"],
        message=data["message"],
        actions=tuple(RepairAction(action) for action in data["actions"]),
        evidence_status=data["evidence_status"],
    )
    assert rebuilt == suggestion


def test_repair_suggestion_rejects_empty_title():
    with pytest.raises(ValueError):
        RepairSuggestion(title="", message="msg", actions=(RepairAction.RETRY,))


def test_repair_suggestion_rejects_bare_failure_title():
    with pytest.raises(ValueError):
        RepairSuggestion(title="出错了", message="msg", actions=(RepairAction.RETRY,))


def test_repair_suggestion_rejects_empty_actions():
    with pytest.raises(ValueError):
        RepairSuggestion(title="有原因", message="msg", actions=())


def test_repair_suggestion_rejects_more_than_four_actions():
    actions = tuple(RepairAction)  # 6 actions
    with pytest.raises(ValueError):
        RepairSuggestion(title="有原因", message="msg", actions=actions)


def test_repair_suggestion_is_frozen():
    suggestion = build_repair("timeout", None)
    with pytest.raises(dataclasses.FrozenInstanceError):
        suggestion.title = "改写"  # type: ignore[misc]
