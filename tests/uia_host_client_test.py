"""Resident UIA host client tests: protocol + circuit breaker (no OS pipe)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.uia_host_client import (  # noqa: E402
    UiaHostClient,
    build_request_line,
    parse_response,
)


def test_build_request_line_plain_hwnd() -> None:
    assert build_request_line(1234) == "1234"


def test_build_request_line_with_point() -> None:
    assert build_request_line(1234, target_point={"x": 10, "y": 20}) == "1234|10|20"


def test_build_request_line_with_region() -> None:
    assert (
        build_request_line(1234, target_region={"x": 1, "y": 2, "width": 3, "height": 4})
        == "1234|region|1|2|3|4"
    )


def test_build_request_line_tolerates_bad_geometry() -> None:
    assert build_request_line(1234, target_point={"x": "junk"}) == "1234"
    assert build_request_line(1234, target_region={"x": None}) == "1234"


def test_parse_response_strips_id_and_keeps_probe_shape() -> None:
    data = parse_response('{"id":7,"ok":true,"result_kind":"document_text","text":"hi"}')
    assert data == {"ok": True, "result_kind": "document_text", "text": "hi"}


def test_parse_response_requires_matching_id_when_expected() -> None:
    line = '{"id":9,"ok":true,"text":"other-request"}'
    assert parse_response(line, expected_id="7") is None
    assert parse_response(line, expected_id="9") == {"ok": True, "text": "other-request"}


def test_parse_response_accepts_missing_id_when_unexpected() -> None:
    assert parse_response('{"ok":true}') == {"ok": True}


def test_parse_response_rejects_junk() -> None:
    assert parse_response("not json") is None
    assert parse_response("[1,2]") is None
    assert parse_response("") is None


def _client(**overrides) -> UiaHostClient:
    kwargs = dict(
        connect_timeout_s=0.1,
        response_timeout_s=0.1,
        cooldown_s=30.0,
        max_failures=3,
    )
    kwargs.update(overrides)
    return UiaHostClient(**kwargs)


def test_ping_round_trips_and_records_success() -> None:
    calls: list[str] = []
    client = _client()

    def exchange(line: str) -> str:
        calls.append(line)
        return '{"id":1,"ok":true,"result_kind":"ping"}'

    client._exchange = exchange  # type: ignore[assignment]
    assert client.ping() is True
    assert calls == ["1|ping"]
    assert client.available() is True


def test_circuit_opens_after_repeated_transport_failures() -> None:
    client = _client(max_failures=2)

    def dead(_line: str) -> None:
        return None

    client._exchange = dead  # type: ignore[assignment]
    assert client.ping() is False
    assert client.ping() is False
    assert client.available() is False  # circuit open
    assert client.probe(1234) is None
    # open circuit refuses without touching the transport
    count = {"n": 0}

    def counting(_line: str) -> str:
        count["n"] += 1
        return '{"ok":true}'

    client._exchange = counting  # type: ignore[assignment]
    assert client.probe(1234) is None
    assert count["n"] == 0


def test_probe_sends_full_request_line_and_parses_result() -> None:
    client = _client()
    sent: list[str] = []

    def exchange(line: str) -> str:
        sent.append(line)
        request_id = line.split("|", 1)[0]
        return f'{{"id":{request_id},"ok":true,"result_kind":"document_text","text":"abc"}}'

    client._exchange = exchange  # type: ignore[assignment]
    data = client.probe(42, target_point={"x": 5, "y": 6})
    assert sent == ["1|42|5|6"]
    assert data == {"ok": True, "result_kind": "document_text", "text": "abc"}


def test_probe_returns_none_on_host_level_failure() -> None:
    client = _client()

    def exchange(_line: str) -> str:
        return '{"id":1,"ok":false,"error":"invalid_request"}'

    client._exchange = exchange  # type: ignore[assignment]
    data = client.probe(1)
    assert data == {"ok": False, "error": "invalid_request"}


def test_success_resets_consecutive_failures() -> None:
    client = _client(max_failures=2)
    outcomes = iter([None, '{"id":2,"ok":true,"result_kind":"ping"}', None, None])

    def exchange(_line: str) -> str | None:
        return next(outcomes)

    client._exchange = exchange  # type: ignore[assignment]
    assert client.ping() is False
    assert client.ping() is True  # success resets the streak
    assert client.ping() is False
    assert client.available() is True  # streak is 1, below the limit
