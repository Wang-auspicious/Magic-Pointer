from __future__ import annotations

from app.actions.route_draft import parse_route_draft, wants_route_draft


def episode(*, this="上海虹桥站", that="上海博物馆", these=None):
    return {
        "version": 1,
        "episodeId": "episode-route",
        "slots": {
            "this": {"objectId": "selection:b", "label": "终点", "content": this, "app": "pdf"},
            "that": {"objectId": "selection:a", "label": "起点", "content": that, "app": "browser"},
            "these": these or [],
        },
    }


def test_route_intent_is_strict():
    for command in ("规划路线", "这两个地方怎么走", "Route these", "get directions between these"):
        assert wants_route_draft(command)
    for command in ("解释路线", "这个地方在哪里", "route table", ""):
        assert not wants_route_draft(command)


def test_that_is_origin_and_this_is_destination():
    draft = parse_route_draft(episode())
    assert draft["origin"] == "上海博物馆"
    assert draft["destination"] == "上海虹桥站"
    assert draft["origin_source"]["objectId"] == "selection:a"
    assert draft["destination_source"]["objectId"] == "selection:b"
    assert draft["missing_fields"] == []


def test_two_these_preserve_collection_order():
    these = [
        {"objectId": "selection:first", "content": "杭州东站"},
        {"objectId": "selection:second", "content": "西湖风景区"},
    ]
    draft = parse_route_draft(episode(these=these))
    assert draft["origin"] == "杭州东站"
    assert draft["destination"] == "西湖风景区"


def test_missing_or_unsafe_location_stays_incomplete():
    draft = parse_route_draft(episode(this="", that="A"))
    assert "destination" in draft["missing_fields"]
    draft = parse_route_draft(episode(this="x" * 241, that="A"))
    assert "destination" in draft["missing_fields"]
