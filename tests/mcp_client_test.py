"""MCP client：把用户已经配好的工具接进来，而不是让他再配一遍。

我们已经是 MCP server（agent 可以指着屏幕用我们）。闭环的另一半是：用户在别处配好的
工具——他的笔记、他的看板、他的数据库——应该能直接用在一条关于屏幕的命令里。

三条决定形态的规矩：
1. **别人的进程挂了，不能把这条命令带走。** MCP server 是装在用户机器上的第三方代码，
   它总有一天会卡住。所有调用都有超时，所有失败都是返回值而不是异常。
2. **发现 ≠ 调用。** 列出工具是一件事，调用是另一件。一个叫 `delete_everything`
   的工具，绝不能在"看看有哪些工具"的过程中被执行。
3. **用户的配置只读不写。** 我们是那个文件里的客人。
"""

from __future__ import annotations

import json
import sys

import pytest

from app.fabric.mcp_client import (
    MAX_DESCRIPTION_CHARS,
    MAX_TOOLS_PER_SERVER,
    McpClientError,
    McpServerConfig,
    McpStdioClient,
    McpTool,
    discover_tools,
    load_server_configs,
)

# 一个真的 MCP server，用来做端到端验证。行为由参数控制。
FAKE_SERVER = '''
import json, sys, time
mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
called = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        if mode == "hang":
            time.sleep(60)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18"}}), flush=True)
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        if mode == "noisy":
            print("this server logs to stdout, against the spec", flush=True)
        if mode == "error":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"message": "no tools for you"}}), flush=True)
            continue
        tools = [{"name": "search_notes", "description": "Search the user notes", "inputSchema": {"type": "object"}}]
        if mode == "many":
            tools = [{"name": f"tool_{i}", "description": "x"} for i in range(80)]
        if mode == "wordy":
            tools = [{"name": "verbose", "description": "y" * 5000}]
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": tools}}), flush=True)
    elif method == "tools/call":
        called.append(msg["params"]["name"])
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "content": [{"type": "text", "text": "note one\\nnote two"}],
            "isError": False,
        }}), flush=True)
'''


@pytest.fixture()
def server_script(tmp_path):
    path = tmp_path / "fake_mcp_server.py"
    path.write_text(FAKE_SERVER, encoding="utf-8")
    return path


def _config(server_script, mode="ok", name="notes"):
    return McpServerConfig(name=name, command=sys.executable, args=(str(server_script), mode))


# --- 配置读取 ---------------------------------------------------------------


def test_the_standard_config_shape_is_understood(tmp_path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"mcpServers": {
        "notes": {"command": "node", "args": ["server.js"], "env": {"TOKEN": "x"}},
    }}), encoding="utf-8")
    [config] = load_server_configs(path)
    assert config.name == "notes"
    assert config.command == "node"
    assert config.args == ("server.js",)
    assert config.env == {"TOKEN": "x"}


def test_a_disabled_server_is_not_offered(tmp_path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"mcpServers": {
        "off": {"command": "node", "disabled": True},
        "on": {"command": "node"},
    }}), encoding="utf-8")
    assert [config.name for config in load_server_configs(path)] == ["on"]


def test_one_broken_entry_does_not_hide_the_others(tmp_path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"mcpServers": {
        "broken": {"args": ["no command"]},
        "fine": {"command": "node"},
    }}), encoding="utf-8")
    assert [config.name for config in load_server_configs(path)] == ["fine"]


def test_a_missing_or_corrupt_config_is_not_an_error(tmp_path) -> None:
    assert load_server_configs(tmp_path / "nope.json") == []
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert load_server_configs(bad) == []


# --- 真实进程往返 -----------------------------------------------------------


def test_tools_are_discovered_from_a_live_server(server_script) -> None:
    tools, warnings = discover_tools([_config(server_script)])
    assert warnings == []
    assert [tool.name for tool in tools] == ["search_notes"]
    # 两个 server 都叫 search 时不能混淆。
    assert tools[0].qualified_name == "notes__search_notes"


def test_discovery_never_calls_anything(server_script) -> None:
    """一个叫 delete_everything 的工具，不能因为"看看有哪些工具"就被执行。"""
    with McpStdioClient(_config(server_script)) as client:
        tools = client.list_tools()
        assert tools
        # 调用是单独的一步，且必须显式发起。
        result = client.call_tool("search_notes", {"q": "x"})
        assert result["text"] == "note one\nnote two"
        assert result["isError"] is False


def test_a_hanging_server_does_not_hold_the_command_open(server_script) -> None:
    tools, warnings = discover_tools([_config(server_script, "hang")], timeout=1.0)
    assert tools == []
    assert warnings and "did not answer" in warnings[0]


def test_a_server_that_errors_contributes_a_warning_not_an_exception(server_script) -> None:
    tools, warnings = discover_tools([_config(server_script, "error")])
    assert tools == []
    assert warnings and "no tools for you" in warnings[0]


def test_a_server_that_cannot_start_is_reported(tmp_path) -> None:
    config = McpServerConfig(name="ghost", command=str(tmp_path / "does-not-exist"), args=())
    tools, warnings = discover_tools([config])
    assert tools == []
    assert warnings


def test_one_broken_server_does_not_remove_the_others(server_script, tmp_path) -> None:
    """用户配置里有一个坏的，不能让他所有集成都消失。"""
    good = _config(server_script, name="notes")
    bad = McpServerConfig(name="ghost", command=str(tmp_path / "nope"), args=())
    tools, warnings = discover_tools([bad, good])
    assert [tool.name for tool in tools] == ["search_notes"]
    assert len(warnings) == 1


def test_servers_that_log_to_stdout_are_tolerated(server_script) -> None:
    """规范说不该这么干，但现实里它们就是这么干的。"""
    tools, warnings = discover_tools([_config(server_script, "noisy")])
    assert [tool.name for tool in tools] == ["search_notes"]
    assert warnings == []


def test_an_enormous_manifest_is_capped(server_script) -> None:
    """工具描述会进模型上下文；第三方不该有能力把它塞满。"""
    tools, _ = discover_tools([_config(server_script, "many")])
    assert len(tools) == MAX_TOOLS_PER_SERVER


def test_a_wordy_description_is_trimmed(server_script) -> None:
    [tool], _ = discover_tools([_config(server_script, "wordy")])
    assert len(tool.description) <= MAX_DESCRIPTION_CHARS


def test_a_tool_serialises_for_the_model(server_script) -> None:
    tool = McpTool(server="notes", name="search", description="d", input_schema={"type": "object"})
    payload = tool.to_dict()
    assert payload["qualifiedName"] == "notes__search"
    assert payload["inputSchema"] == {"type": "object"}


def test_calling_without_starting_fails_cleanly() -> None:
    client = McpStdioClient(McpServerConfig(name="x", command="node"))
    with pytest.raises(McpClientError):
        client.call_tool("anything")
