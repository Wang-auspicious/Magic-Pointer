from __future__ import annotations

from typing import Any

import json
import pytest

from app.actions.figma import FigmaActionHandler
from app.adapters.figma_client import FigmaClient, FigmaClientConfig
from app.artifacts.document_patch import PatchOperation
from app.context_pack.sources import FragmentLocator, SourceRef
from app.surface_adapter.adapters.figma_adapter import (
    FigmaSourceReader,
    FigmaSurfaceAdapter,
    figma_runtime_materials,
)


class FakeClient:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.characters = "Old label"

    def request(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((operation, arguments))
        if self.fail:
            raise ConnectionError("plugin disconnected")
        node = {
            "id": "1:2",
            "type": "TEXT",
            "name": "Button label",
            "parentId": "1:1",
            "characters": self.characters,
            "bounds": {"x": 10, "y": 20, "width": 90, "height": 24},
            "layoutMode": "NONE",
            "capabilities": {
                "replaceText": True,
                "setFill": True,
                "setSpacing": False,
                "resize": True,
                "move": True,
            },
        }
        if operation == "read_selection":
            return {
                "selectionIds": ["1:2"],
                "pageId": "0:7",
                "pageName": "Checkout",
                "nodes": [node, {
                    "id": "1:1",
                    "type": "FRAME",
                    "name": "Hero",
                    "parentId": "0:7",
                    "layoutMode": "VERTICAL",
                }],
            }
        if operation in {"read_nodes", "readback"}:
            return {"nodes": [node]}
        if operation == "apply_patch":
            patch = arguments["operations"][0]
            self.characters = (
                self.characters[: patch["start"]]
                + patch["after"]
                + self.characters[patch["end"] :]
            )
            return {"appliedCount": 1, "nodes": [{**node, "characters": self.characters}]}
        raise AssertionError(operation)


class FillClient:
    task_id = "task-figma"
    document_session_id = "document-a"

    def __init__(self, *, fail_readback: bool = False) -> None:
        self.fail_readback = fail_readback
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fills: list[dict[str, Any]] = [{
            "type": "SOLID",
            "color": {"r": 1.0, "g": 0.0, "b": 0.0},
            "opacity": 0.75,
            "blendMode": "NORMAL",
        }]

    def request(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((operation, arguments))
        if operation == "read_nodes":
            return {"nodes": [{"id": "1:2", "type": "RECTANGLE", "fills": self.fills}]}
        if operation == "apply_patch":
            raw = arguments["operations"][0]
            assert raw["before"] == self.fills
            color = dict(raw["after"])
            self.fills = [{
                "type": "SOLID",
                "color": {key: color[key] for key in ("r", "g", "b")},
                "opacity": color.get("a", 1),
            }]
            return {"appliedCount": 1}
        if operation == "readback":
            if self.fail_readback:
                raise ConnectionError("lost after confirmed apply")
            return {"nodes": [{"id": "1:2", "type": "RECTANGLE", "fills": self.fills}]}
        raise AssertionError(operation)


class FakeResponse:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: Any) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.value).encode("utf-8")


def source() -> SourceRef:
    return SourceRef(
        source_id="source-figma",
        task_id="task-figma",
        kind="figma",
        title="Checkout design",
        identity={
            "documentSessionId": "document-a",
            "documentName": "Checkout design",
            "pageId": "0:7",
        },
        revision={"selectionRevision": 4},
        capabilities=("read", "follow", "patch"),
        origin="user-pointed",
        parent_source_id=None,
    )


def test_figma_client_keeps_control_credential_private_and_polls_bound_command() -> None:
    token = "control-secret-that-must-not-be-rendered"
    config = FigmaClientConfig.from_dict({
        "baseUrl": "http://127.0.0.1:37843",
        "controlToken": token,
        "taskId": "task-figma",
        "documentSessionId": "document-a",
        "pollIntervalS": 0.01,
    })
    assert token not in repr(config)
    calls = []
    responses = iter([
        {"ok": True, "commandId": "command-1", "status": "queued"},
        {"commandId": "command-1", "status": "dispatched"},
        {"commandId": "command-1", "status": "completed", "result": {"nodes": []}},
    ])

    def open_request(request, *, timeout):
        calls.append((request, timeout))
        return FakeResponse(next(responses))

    result = FigmaClient(config, opener=open_request, sleep=lambda _seconds: None).request(
        "read_nodes", {"nodeIds": ["1:2"]}
    )

    assert result == {"nodes": []}
    assert calls[0][0].full_url.endswith("/requests")
    assert json.loads(calls[0][0].data)["documentSessionId"] == "document-a"
    assert calls[0][0].get_header("Authorization") == f"Bearer {token}"
    assert calls[-1][0].full_url.endswith("/results/command-1")


def test_figma_client_rejects_non_loopback_runtime_configuration() -> None:
    with pytest.raises(ValueError, match="127.0.0.1"):
        FigmaClientConfig.from_dict({
            "baseUrl": "https://example.com",
            "controlToken": "x" * 32,
            "taskId": "task-figma",
            "documentSessionId": "document-a",
        })


def test_figma_runtime_material_exposes_source_identity_but_not_control_token() -> None:
    token = "private-control-token-1234567890"
    materials = figma_runtime_materials("task-figma", [{
        "baseUrl": "http://127.0.0.1:37843",
        "controlToken": token,
        "taskId": "task-figma",
        "documentSessionId": "document-a",
        "documentName": "Checkout design",
        "pageId": "0:7",
        "pageName": "Checkout",
        "selectionIds": ["1:2"],
    }])

    material_source, client = materials[0]
    assert material_source.kind == "figma"
    assert material_source.identity["documentSessionId"] == "document-a"
    assert material_source.revision["selectionIds"] == ["1:2"]
    assert token not in str(material_source.to_dict())
    assert client.task_id == "task-figma"


def test_figma_reader_maps_plugin_nodes_to_bounded_source_fragments() -> None:
    client = FakeClient()
    reader = FigmaSourceReader(client)

    described = reader.describe(source())

    assert described.evidence_status == "ok"
    assert described.used_backend == "figma-plugin-loopback"
    assert [item.locator.value["nodeId"] for item in described.fragments] == ["1:2", "1:1"]
    assert described.fragments[0].text == "Button label: Old label"
    assert described.fragments[0].metadata["parentId"] == "1:1"
    assert described.fragments[0].metadata["capabilities"]["replaceText"] is True
    assert client.calls == [("read_selection", {})]

    exact = reader.read(
        source(),
        FragmentLocator("figma-node", {"nodeId": "1:2"}),
        cursor=None,
        limit=10,
    )
    assert len(exact.fragments) == 1
    assert client.calls[-1] == ("read_nodes", {"nodeIds": ["1:2"]})


def test_figma_reader_reports_missing_current_document_connection_honestly() -> None:
    result = FigmaSourceReader(FakeClient(fail=True)).describe(source())

    assert result.fragments == ()
    assert result.evidence_status == "unsupported"
    assert result.coverage.complete is False
    assert result.coverage.missing_reason == "figma-current-document-connection-required"
    assert result.used_backend == "figma-plugin-unavailable"


def test_figma_surface_adapter_uses_connected_state_without_canvas_dom_guessing() -> None:
    adapter = FigmaSurfaceAdapter(lambda: {
        "connected": True,
        "taskId": "task-figma",
        "documentSessionId": "document-a",
        "documentName": "Checkout design",
        "pageId": "0:7",
        "selectionIds": ["1:2"],
        "nodes": [{"id": "1:2", "type": "TEXT", "name": "Button label", "characters": "Pay"}],
    })

    assert adapter.matches({"process_name": "Figma.exe"}) is True
    resolved = adapter.resolve({"process_name": "Figma.exe", "hwnd": 44}, None, None)

    assert resolved is not None
    assert resolved.adapter_id == "figma"
    assert resolved.objects[0].id == "1:2"
    assert resolved.objects[0].fields["documentSessionId"] == "document-a"
    assert resolved.objects[0].evidence == "figma:plugin"


def test_figma_document_patch_reads_base_writes_and_reads_back() -> None:
    client = FakeClient()
    handler = FigmaActionHandler(client)
    operation = PatchOperation(
        operation_id="op-figma-text",
        operation="replace_text",
        reference_id="ref-figma",
        source_id="source-figma",
        locator=FragmentLocator(
            "figma-node",
            {"nodeId": "1:2", "textStart": 0, "textEnd": 3},
        ),
        before="Old",
        after="New",
    )

    current = handler.read_current(source(), operation)
    assert current.ok is True
    assert current.value == "Old"

    written = handler.execute(source(), operation)
    assert written.ok is True
    assert written.wrote is True
    assert written.used_backend == "figma-plugin-loopback"
    assert client.characters == "New label"
    assert [call[0] for call in client.calls[-2:]] == ["apply_patch", "readback"]


def test_figma_fill_uses_fresh_raw_paints_for_plugin_base_check() -> None:
    client = FillClient()
    handler = FigmaActionHandler(client)
    operation = PatchOperation(
        operation_id="op-figma-fill",
        operation="set_figma_fill",
        reference_id="ref-figma",
        source_id="source-figma",
        locator=FragmentLocator("figma-node", {"nodeId": "1:2"}),
        before={"r": 1.0, "g": 0.0, "b": 0.0, "a": 0.75},
        after={"r": 0.0, "g": 0.5, "b": 1.0, "a": 1.0},
    )

    assert handler.read_current(source(), operation).value == operation.before
    result = handler.execute(source(), operation)

    assert result.ok is True
    assert result.wrote is True
    assert [call[0] for call in client.calls] == ["read_nodes", "read_nodes", "apply_patch", "readback"]


def test_figma_write_reports_possible_effect_when_readback_connection_drops() -> None:
    client = FillClient(fail_readback=True)
    handler = FigmaActionHandler(client)
    operation = PatchOperation(
        operation_id="op-figma-fill",
        operation="set_figma_fill",
        reference_id="ref-figma",
        source_id="source-figma",
        locator=FragmentLocator("figma-node", {"nodeId": "1:2"}),
        before={"r": 1.0, "g": 0.0, "b": 0.0, "a": 0.75},
        after={"r": 0.0, "g": 0.5, "b": 1.0, "a": 1.0},
    )

    result = handler.execute(source(), operation)

    assert result.ok is False
    assert result.wrote is True
    assert "lost after confirmed apply" in str(result.error)
