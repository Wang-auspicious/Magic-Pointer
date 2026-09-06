"""SourceReader for a browser document bound by instance, target and epoch."""

from __future__ import annotations

import time
from typing import Any, Protocol

from .sources import Coverage, FragmentLocator, ReadFragment, ReadResult, SourceRef


class BrowserDocumentBackend(Protocol):
    def read_document(self, **request: Any) -> dict[str, Any]: ...


class BrowserContextReader:
    """Read screen-off DOM without selecting a tab by URL or title.

    The SourceRef created at gesture time carries three independent identities:
    browser instance, page target and document epoch. A navigation changes the
    epoch, making every old node locator unusable before it can be rebound or
    used by a write tool.
    """

    def __init__(self, backend: BrowserDocumentBackend) -> None:
        self._backend = backend

    @staticmethod
    def _identity(source: SourceRef) -> tuple[str, str, str]:
        instance = str(source.identity.get("browserInstanceId") or "").strip()
        target = str(source.identity.get("targetId") or "").strip()
        epoch = str(
            source.identity.get("documentEpoch")
            or source.revision.get("documentEpoch")
            or ""
        ).strip()
        if not instance or not target or not epoch:
            raise ValueError("browser source requires browserInstanceId, targetId and documentEpoch")
        return instance, target, epoch

    @staticmethod
    def _empty(
        source: SourceRef,
        *,
        started: float,
        backend: str,
        reason: str,
        status: str = "degraded",
    ) -> ReadResult:
        return ReadResult(
            source_id=source.source_id,
            fragments=(),
            coverage=Coverage(
                extent="document",
                read_ranges=(),
                total_units=None,
                complete=False,
                next_cursor=None,
                missing_reason=reason,
            ),
            evidence_status=status,
            used_backend=backend,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )

    def _read(
        self,
        source: SourceRef,
        *,
        locator: FragmentLocator | None,
        query: str | None,
        cursor: str | None,
        limit: int,
        describe: bool = False,
    ) -> ReadResult:
        started = time.perf_counter()
        default_backend = "cdp.dom.document"
        try:
            instance, target, expected_epoch = self._identity(source)
            if locator is not None:
                locator_instance = str(locator.value.get("browserInstanceId") or instance)
                locator_target = str(locator.value.get("targetId") or target)
                locator_epoch = str(locator.value.get("documentEpoch") or expected_epoch)
                if (locator_instance, locator_target, locator_epoch) != (
                    instance, target, expected_epoch,
                ):
                    return self._empty(
                        source,
                        started=started,
                        backend=default_backend,
                        reason="browser-locator-identity-mismatch",
                    )
            response = dict(self._backend.read_document(
                browser_instance_id=instance,
                target_id=target,
                document_epoch=expected_epoch,
                locator=locator.to_dict() if locator is not None else None,
                query=query,
                cursor=cursor,
                limit=max(1, min(int(limit), 200)),
                describe=describe,
            ) or {})
        except Exception as exc:
            return self._empty(
                source,
                started=started,
                backend=default_backend,
                reason=f"browser-read-error:{type(exc).__name__}",
                status="error",
            )

        backend = str(response.get("usedBackend") or default_backend)
        actual_instance = str(response.get("browserInstanceId") or "")
        actual_target = str(response.get("targetId") or "")
        actual_epoch = str(response.get("documentEpoch") or "")
        if actual_instance != instance or actual_target != target:
            return self._empty(
                source,
                started=started,
                backend=backend,
                reason="browser-target-identity-changed",
            )
        if actual_epoch != expected_epoch:
            return self._empty(
                source,
                started=started,
                backend=backend,
                reason="browser-document-epoch-changed",
            )

        fragments: list[ReadFragment] = []
        for index, raw_node in enumerate(response.get("nodes") or []):
            if not isinstance(raw_node, dict):
                continue
            node = dict(raw_node)
            text = str(node.pop("text", "") or "")
            selector = str(node.pop("selector", "") or "")
            node_id = str(node.pop("nodeId", "") or f"node-{index}")
            node_locator = FragmentLocator("dom-node", {
                "browserInstanceId": instance,
                "targetId": target,
                "documentEpoch": actual_epoch,
                "nodeId": node_id,
                "selector": selector,
            })
            fragments.append(ReadFragment(
                fragment_id=f"fragment:{source.source_id}:dom:{node_id}",
                locator=node_locator,
                text=text,
                metadata={
                    **node,
                    "pageTitle": str(response.get("title") or ""),
                    "pageUrl": str(response.get("url") or ""),
                    "sourceRevision": dict(source.revision),
                },
                citations=({"sourceId": source.source_id, "locator": node_locator.to_dict()},),
            ))

        limitations = [str(item) for item in response.get("limitations") or [] if str(item)]
        complete = response.get("complete") is True and not limitations
        next_cursor = str(response.get("nextCursor") or "").strip() or None
        if next_cursor is not None:
            complete = False
        total_raw = response.get("totalUnits")
        total_units = int(total_raw) if isinstance(total_raw, int) and not isinstance(total_raw, bool) else None
        status = "degraded" if limitations else ("ok" if fragments else "empty_confirmed")
        extent = "query-results" if query is not None else "document"
        return ReadResult(
            source_id=source.source_id,
            fragments=tuple(fragments),
            coverage=Coverage(
                extent=extent,
                read_ranges=tuple(fragment.locator.to_dict() for fragment in fragments),
                total_units=total_units,
                complete=complete,
                next_cursor=next_cursor,
                missing_reason=";".join(limitations) or None,
            ),
            evidence_status=status,
            used_backend=backend,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )

    def describe(self, source: SourceRef) -> ReadResult:
        return self._read(
            source,
            locator=None,
            query=None,
            cursor=None,
            limit=1,
            describe=True,
        )

    def read(
        self,
        source: SourceRef,
        locator: FragmentLocator | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        return self._read(
            source,
            locator=locator,
            query=None,
            cursor=cursor,
            limit=limit,
        )

    def search(
        self,
        source: SourceRef,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        if not str(query or "").strip():
            raise ValueError("query must be non-empty")
        return self._read(
            source,
            locator=None,
            query=str(query),
            cursor=cursor,
            limit=limit,
        )

    def follow(self, source: SourceRef, fragment_id: str) -> tuple[SourceRef, ...]:
        del source, fragment_id
        return ()


__all__ = ["BrowserContextReader", "BrowserDocumentBackend"]
