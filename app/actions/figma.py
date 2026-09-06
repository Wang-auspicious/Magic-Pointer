"""Finite Figma node operations routed through the local plugin bridge."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.artifacts.document_patch import (
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
)
from app.context_pack.sources import SourceRef


class FigmaActionHandler:
    def __init__(self, client: Any | None) -> None:
        self._client = client

    def _ensure(self, source: SourceRef, operation: PatchOperation) -> tuple[Any, str]:
        if self._client is None:
            raise RuntimeError("figma-current-document-connection-required")
        if operation.locator.kind != "figma-node":
            raise ValueError("Figma operation requires a figma-node locator")
        node_id = str(operation.locator.value.get("nodeId") or "").strip()
        if not node_id:
            raise ValueError("Figma locator is missing nodeId")
        expected_document = str(source.identity.get("documentSessionId") or "")
        client_document = str(getattr(self._client, "document_session_id", expected_document))
        client_task = str(getattr(self._client, "task_id", source.task_id))
        if client_document != expected_document or client_task != source.task_id:
            raise ValueError("figma source/client identity mismatch")
        return self._client, node_id

    @staticmethod
    def _node(payload: Mapping[str, Any], node_id: str) -> dict[str, Any]:
        for raw in payload.get("nodes") or []:
            if isinstance(raw, Mapping) and str(raw.get("id") or "") == node_id:
                return dict(raw)
        raise RuntimeError(f"figma-node-not-found:{node_id}")

    @staticmethod
    def _current(node: Mapping[str, Any], operation: PatchOperation) -> Any:
        if operation.operation == "replace_text":
            characters = str(node.get("characters") or "")
            start = int(operation.locator.value.get("textStart", 0))
            end = int(operation.locator.value.get("textEnd", len(characters)))
            return characters[start:end]
        if operation.operation == "set_figma_fill":
            fills = node.get("fills")
            if not isinstance(fills, list) or not fills or not isinstance(fills[0], Mapping):
                return None
            paint = dict(fills[0])
            color = paint.get("color")
            if not isinstance(color, Mapping):
                return None
            return {
                "r": color.get("r"),
                "g": color.get("g"),
                "b": color.get("b"),
                "a": paint.get("opacity", 1),
            }
        if operation.operation == "set_figma_spacing":
            after = operation.after
            if not isinstance(after, Mapping):
                return None
            property_name = str(after.get("property") or "")
            return {"property": property_name, "value": node.get(property_name)}
        if operation.operation == "set_figma_size":
            return {"width": node.get("width"), "height": node.get("height")}
        if operation.operation == "set_figma_position":
            return {"x": node.get("x"), "y": node.get("y")}
        raise ValueError(f"unsupported Figma patch operation: {operation.operation}")

    @staticmethod
    def _plugin_operation(
        operation: PatchOperation,
        node_id: str,
        node: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if operation.operation == "replace_text":
            return {
                "op": "replace_text",
                "nodeId": node_id,
                "start": int(operation.locator.value.get("textStart", 0)),
                "end": int(operation.locator.value.get("textEnd", 0)),
                "before": operation.before,
                "after": operation.after,
            }
        if operation.operation == "set_figma_fill":
            if node is None:
                raise ValueError("Figma fill operation requires a fresh node read")
            return {
                "op": "set_fill",
                "nodeId": node_id,
                # DocumentPatch exposes a normalized RGBA value to the user, while
                # the plugin compares the complete native paint array immediately
                # before mutation.  Keep both checks instead of weakening either.
                "before": node.get("fills"),
                "after": operation.after,
            }
        if operation.operation == "set_figma_spacing":
            if not isinstance(operation.before, Mapping) or not isinstance(operation.after, Mapping):
                raise ValueError("Figma spacing before/after must contain property and value")
            if operation.before.get("property") != operation.after.get("property"):
                raise ValueError("Figma spacing property cannot change")
            return {
                "op": "set_spacing",
                "nodeId": node_id,
                "property": operation.after.get("property"),
                "before": operation.before.get("value"),
                "after": operation.after.get("value"),
            }
        if operation.operation == "set_figma_size":
            return {"op": "resize", "nodeId": node_id, "before": operation.before, "after": operation.after}
        if operation.operation == "set_figma_position":
            return {"op": "move", "nodeId": node_id, "before": operation.before, "after": operation.after}
        raise ValueError(f"unsupported Figma patch operation: {operation.operation}")

    def read_current(self, source: SourceRef, operation: PatchOperation) -> OperationReadResult:
        try:
            client, node_id = self._ensure(source, operation)
            node = self._node(client.request("read_nodes", {"nodeIds": [node_id]}), node_id)
            return OperationReadResult(
                True,
                self._current(node, operation),
                "figma-plugin-loopback",
            )
        except Exception as exc:
            return OperationReadResult(
                False,
                used_backend="figma-plugin-loopback",
                error=f"figma-read-failed:{type(exc).__name__}:{exc}",
            )

    def execute(self, source: SourceRef, operation: PatchOperation) -> OperationWriteResult:
        applied = False
        try:
            client, node_id = self._ensure(source, operation)
            node = None
            if operation.operation == "set_figma_fill":
                node = self._node(
                    client.request("read_nodes", {"nodeIds": [node_id]}),
                    node_id,
                )
            client.request("apply_patch", {
                "operations": [self._plugin_operation(operation, node_id, node)],
            })
            applied = True
            node = self._node(client.request("readback", {"nodeIds": [node_id]}), node_id)
            if self._current(node, operation) != operation.after:
                return OperationWriteResult(
                    False,
                    True,
                    "figma-plugin-loopback",
                    "figma-readback-mismatch",
                )
            return OperationWriteResult(True, True, "figma-plugin-loopback")
        except Exception as exc:
            return OperationWriteResult(
                False,
                applied,
                "figma-plugin-loopback",
                f"figma-write-failed:{type(exc).__name__}:{exc}",
            )


__all__ = ["FigmaActionHandler"]
