"""One MCP stdio connection must have exactly one response reader at a time."""

from __future__ import annotations

import io
import json
import threading
import time
from types import SimpleNamespace

import pytest

from app.fabric.mcp_client import (
    MAX_RESPONSE_CHARS,
    McpClientError,
    McpServerConfig,
    McpStdioClient,
)


def test_request_holds_connection_lock_through_write_and_response_phase() -> None:
    client = McpStdioClient(McpServerConfig(name="fake", command="fake"), timeout=0.1)
    first_entered = threading.Event()
    second_entered = threading.Event()
    release_first = threading.Event()
    call_count = 0
    count_lock = threading.Lock()

    def blocked_write(_message) -> None:
        nonlocal call_count
        with count_lock:
            call_count += 1
            current = call_count
        if current == 1:
            first_entered.set()
            release_first.wait(0.5)
        else:
            second_entered.set()
        raise RuntimeError("stop after lock observation")

    client._write = blocked_write  # type: ignore[method-assign]

    def request() -> None:
        try:
            client._request("tools/list", {})
        except RuntimeError:
            return

    first = threading.Thread(target=request)
    second = threading.Thread(target=request)
    first.start()
    assert first_entered.wait(0.2)
    second.start()
    try:
        assert not second_entered.wait(0.05)
    finally:
        release_first.set()
        first.join(timeout=0.5)
        second.join(timeout=0.5)

    assert not first.is_alive()
    assert not second.is_alive()


def test_oversized_response_line_fails_closed() -> None:
    client = McpStdioClient(McpServerConfig(name="fake", command="fake"), timeout=0.2)
    payload = {"jsonrpc": "2.0", "id": 1, "result": {"text": "x" * MAX_RESPONSE_CHARS}}
    client._process = SimpleNamespace(  # type: ignore[assignment]
        stdout=io.StringIO(json.dumps(payload) + "\n"),
    )
    client._write = lambda _message: None  # type: ignore[method-assign]

    with pytest.raises(McpClientError, match="response line exceeds"):
        client._request("tools/call", {})


def test_request_timeout_aborts_process_without_close_grace_period() -> None:
    released = threading.Event()

    class BlockingStdout:
        def readline(self, _limit):
            released.wait(1.0)
            return ""

    class Process:
        stdout = BlockingStdout()
        stdin = None
        killed = False

        def wait(self, timeout):
            time.sleep(0.35)
            raise TimeoutError(timeout)

        def kill(self):
            self.killed = True
            released.set()

    process = Process()
    client = McpStdioClient(McpServerConfig(name="fake", command="fake"), timeout=0.03)
    client._process = process  # type: ignore[assignment]
    client._write = lambda _message: None  # type: ignore[method-assign]

    started = time.perf_counter()
    with pytest.raises(McpClientError, match="did not answer"):
        client._request("tools/list", {})
    elapsed = time.perf_counter() - started

    assert elapsed < 0.2
    assert process.killed is True
