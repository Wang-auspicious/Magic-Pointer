"""Figma plugin surface and task-source adapters."""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any

from app.adapters.figma_client import FigmaClient, FigmaClientConfig
from app.context_pack.sources import (
    Coverage,
    FragmentLocator,
    ReadFragment,
    ReadResult,
    SourceRef,
)
from app.surface_adapter.manifest import SurfaceAdapterManifest
from app.surface_adapter.protocol import RawObject, ResolveResult

FIGMA_MANIFEST = SurfaceAdapterManifest(
    id="figma",
    display_name="Figma",
    app_ids=("figma.exe",),
    window_class_patterns=("figma",),
    title_patterns=("figma",),
    object_kinds=("figma_node", "figma_connection"),
    capabilities=("read_selection", "read_nodes", "patch_nodes", "export_preview"),
    notes="Design Mode plugin connection; canvas pixels remain visual fallback evidence.",
)


def _node_text(node: Mapping[str, Any]) -> str:
    name = str(node.get("name") or node.get("type") or "Figma node")
    characters = node.get("characters")
    return f"{name}: {characters}" if isinstance(characters, str) else name


def figma_runtime_materials(
    task_id: str,
    raw_connections: Any,
) -> tuple[tuple[SourceRef, FigmaClient], ...]:
    if raw_connections is None:
        raw_connections = []
    if not isinstance(raw_connections, (list, tuple)):
        raise ValueError("Figma runtime connections must be an array")
    results = []
    for raw in raw_connections:
        if not isinstance(raw, Mapping):
            raise ValueError("Figma runtime connection must be an object")
        config = FigmaClientConfig.from_dict(raw)
        if config.task_id != task_id:
            raise ValueError("Figma runtime connection belongs to another task")
        source = SourceRef(
            source_id=f"source:figma:{config.document_session_id}",
            task_id=task_id,
            kind="figma",
            title=config.document_name or "Connected Figma document",
            identity={
                "documentSessionId": config.document_session_id,
                "documentName": config.document_name,
                **({"pageId": config.page_id} if config.page_id else {}),
                **({"pageName": config.page_name} if config.page_name else {}),
            },
            revision={
                "authority": "live-figma-plugin",
                "selectionIds": list(config.selection_ids),
            },
            capabilities=("read", "search", "follow", "patch"),
            origin="user-pointed",
            parent_source_id=None,
        )
        results.append((source, FigmaClient(config)))
    return tuple(results)


class FigmaSourceReader:
    def __init__(self, client: Any) -> None:
        self._client = client

    def _identity(self, source: SourceRef) -> None:
        expected_task = getattr(self._client, "task_id", source.task_id)
        expected_document = getattr(
            self._client,
            "document_session_id",
            source.identity.get("documentSessionId"),
        )
        if source.task_id != expected_task:
            raise ValueError("figma source belongs to another task")
        if source.identity.get("documentSessionId") != expected_document:
            raise ValueError("figma source belongs to another document session")

    @staticmethod
    def _fragments(source: SourceRef, nodes: list[Any], limit: int) -> tuple[ReadFragment, ...]:
        fragments: list[ReadFragment] = []
        for raw in nodes[: max(1, min(int(limit), 100))]:
            if not isinstance(raw, Mapping):
                continue
            node = dict(raw)
            node_id = str(node.get("id") or "").strip()
            if not node_id:
                continue
            locator = FragmentLocator("figma-node", {
                "nodeId": node_id,
                "documentSessionId": source.identity.get("documentSessionId"),
                **({"pageId": source.identity["pageId"]} if source.identity.get("pageId") else {}),
            })
            metadata = dict(node)
            metadata.pop("id", None)
            fragments.append(ReadFragment(
                fragment_id=f"fragment:{source.source_id}:figma:{node_id}",
                locator=locator,
                text=_node_text(node),
                metadata=metadata,
                citations=({"sourceId": source.source_id, "locator": locator.to_dict()},),
            ))
        return tuple(fragments)

    def _run(
        self,
        source: SourceRef,
        operation: str,
        arguments: dict[str, Any],
        *,
        extent: str,
        limit: int,
    ) -> ReadResult:
        started = time.perf_counter()
        try:
            self._identity(source)
            payload = self._client.request(operation, arguments)
            nodes = payload.get("nodes")
            if not isinstance(nodes, list):
                nodes = []
            fragments = self._fragments(source, nodes, limit)
            return ReadResult(
                source_id=source.source_id,
                fragments=fragments,
                coverage=Coverage(
                    extent=extent,
                    read_ranges=tuple(item.locator.to_dict() for item in fragments),
                    total_units=len(nodes),
                    complete=True,
                    next_cursor=None,
                    missing_reason=None,
                ),
                evidence_status="ok" if fragments else "empty_confirmed",
                used_backend="figma-plugin-loopback",
                latency_ms=(time.perf_counter() - started) * 1000.0,
            )
        except Exception:
            return ReadResult(
                source_id=source.source_id,
                fragments=(),
                coverage=Coverage(
                    extent=extent,
                    read_ranges=(),
                    total_units=None,
                    complete=False,
                    next_cursor=None,
                    missing_reason="figma-current-document-connection-required",
                ),
                evidence_status="unsupported",
                used_backend="figma-plugin-unavailable",
                latency_ms=(time.perf_counter() - started) * 1000.0,
            )

    def describe(self, source: SourceRef) -> ReadResult:
        return self._run(source, "read_selection", {}, extent="neighborhood", limit=100)

    def read(
        self,
        source: SourceRef,
        locator: FragmentLocator | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        del cursor
        if locator is None:
            return self._run(source, "read_selection", {}, extent="neighborhood", limit=limit)
        if locator.kind != "figma-node" or not locator.value.get("nodeId"):
            raise ValueError("Figma read requires a figma-node locator")
        return self._run(
            source,
            "read_nodes",
            {"nodeIds": [str(locator.value["nodeId"])]},
            extent="selection",
            limit=limit,
        )

    def search(
        self,
        source: SourceRef,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        del cursor
        needle = str(query).strip().casefold()
        if not needle:
            raise ValueError("query must be non-empty")
        result = self._run(source, "read_selection", {}, extent="query-results", limit=100)
        fragments = tuple(
            item for item in result.fragments
            if needle in f"{item.text} {item.metadata}".casefold()
        )[: max(1, min(int(limit), 100))]
        return ReadResult(
            source_id=result.source_id,
            fragments=fragments,
            coverage=Coverage(
                extent="query-results",
                read_ranges=tuple(item.locator.to_dict() for item in fragments),
                total_units=len(fragments),
                complete=result.coverage.complete,
                next_cursor=None,
                missing_reason=result.coverage.missing_reason,
            ),
            evidence_status=result.evidence_status if result.evidence_status == "unsupported" else (
                "ok" if fragments else "empty_confirmed"
            ),
            used_backend=result.used_backend,
            latency_ms=result.latency_ms,
        )

    def follow(self, source: SourceRef, fragment_id: str) -> tuple[SourceRef, ...]:
        del source, fragment_id
        return ()


class FigmaSurfaceAdapter:
    manifest = FIGMA_MANIFEST
    adapter_id = "figma"

    def __init__(self, state_provider: Callable[[], Mapping[str, Any]] | None = None) -> None:
        self._state_provider = state_provider or (lambda: {"connected": False})

    def matches(self, window: dict[str, Any]) -> bool:
        return self.manifest.matches_window(window)

    def resolve(
        self,
        window: dict[str, Any],
        target_point: dict[str, int] | None,
        target_region: dict[str, int] | None,
    ) -> ResolveResult:
        del target_point, target_region
        state = dict(self._state_provider() or {})
        if state.get("connected") is not True:
            return ResolveResult(
                adapter_id=self.adapter_id,
                objects=(RawObject(
                    id="figma:connection-required",
                    kind="figma_connection",
                    label="Figma document connection",
                    text="",
                    rect_xywh=None,
                    order_index=0,
                    confidence=1.0,
                    evidence="figma:plugin-unavailable",
                    fields={
                        "connected": False,
                        "requiresVisualObservation": True,
                        "missingSemantics": ["documentSessionId", "selectionIds", "nodes"],
                    },
                ),),
                window=window,
                notes=("current_figma_document_connection_required",),
            )
        common = {
            "taskId": state.get("taskId"),
            "documentSessionId": state.get("documentSessionId"),
            "documentName": state.get("documentName"),
            "pageId": state.get("pageId"),
        }
        objects = []
        for index, raw in enumerate(state.get("nodes") or []):
            if not isinstance(raw, Mapping) or not raw.get("id"):
                continue
            node = dict(raw)
            objects.append(RawObject(
                id=str(node["id"]),
                kind="figma_node",
                label=str(node.get("name") or node.get("type") or "Figma node"),
                text=str(node.get("characters") or ""),
                rect_xywh=None,
                order_index=index,
                confidence=1.0,
                evidence="figma:plugin",
                fields={**common, **node},
            ))
        return ResolveResult(
            adapter_id=self.adapter_id,
            objects=tuple(objects),
            window=window,
            notes=("figma_design_mode_plugin",),
        )


__all__ = [
    "FIGMA_MANIFEST",
    "FigmaSourceReader",
    "FigmaSurfaceAdapter",
    "figma_runtime_materials",
]
