"""Reader for evidence already frozen by the pointer selection pipeline."""

from __future__ import annotations

import time
from dataclasses import dataclass

from .sources import (
    Coverage,
    FragmentLocator,
    ReadFragment,
    ReadResult,
    SourceReader,
    SourceRef,
)


@dataclass(frozen=True, slots=True)
class FrozenSelectionMaterial:
    source_id: str
    text: str
    locator: FragmentLocator
    coverage: Coverage
    used_backend: str


class FrozenSelectionReader:
    def __init__(
        self,
        materials: tuple[FrozenSelectionMaterial, ...],
        *,
        fallback: SourceReader | None = None,
    ) -> None:
        self._materials = {item.source_id: item for item in materials}
        self._fallback = fallback

    def _material(self, source: SourceRef) -> FrozenSelectionMaterial:
        try:
            return self._materials[source.source_id]
        except KeyError as exc:
            raise KeyError(f"frozen material is unavailable for {source.source_id}") from exc

    @staticmethod
    def _result(
        source: SourceRef,
        material: FrozenSelectionMaterial,
        *,
        locator: FragmentLocator,
        text: str,
        extent: str | None = None,
    ) -> ReadResult:
        started = time.perf_counter()
        fragment = ReadFragment(
            fragment_id=f"fragment:{source.source_id}:selection",
            locator=locator,
            text=text,
            metadata={"title": source.title, "revision": dict(source.revision)},
            citations=({"sourceId": source.source_id, "locator": locator.to_dict()},),
        )
        coverage = material.coverage
        if extent is not None and coverage.extent != extent:
            coverage = Coverage(
                extent=extent,
                read_ranges=coverage.read_ranges,
                total_units=coverage.total_units,
                complete=coverage.complete,
                next_cursor=coverage.next_cursor,
                missing_reason=coverage.missing_reason,
            )
        return ReadResult(
            source_id=source.source_id,
            fragments=(fragment,) if text else (),
            coverage=coverage,
            evidence_status="ok",
            used_backend=material.used_backend,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )

    def describe(self, source: SourceRef) -> ReadResult:
        material = self._material(source)
        return self._result(
            source,
            material,
            locator=material.locator,
            text=material.text[:500],
        )

    def read(
        self,
        source: SourceRef,
        locator: FragmentLocator | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        material = self._material(source)
        if locator is not None and locator != material.locator and self._fallback is not None:
            return self._fallback.read(source, locator, cursor, limit)
        return self._result(
            source,
            material,
            locator=locator or material.locator,
            text=material.text,
        )

    def search(
        self,
        source: SourceRef,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        material = self._material(source)
        text = material.text if str(query).casefold() in material.text.casefold() else ""
        live = self._result(
            source,
            material,
            locator=material.locator,
            text=text,
            extent="query-results",
        )
        if self._fallback is None:
            return live
        disk = self._fallback.search(source, query, cursor, limit)
        if not live.fragments:
            return disk
        locators = {fragment.locator.to_dict().__repr__() for fragment in live.fragments}
        merged = live.fragments + tuple(
            fragment for fragment in disk.fragments
            if fragment.locator.to_dict().__repr__() not in locators
        )
        return ReadResult(
            source_id=source.source_id,
            fragments=merged[: max(1, int(limit))],
            coverage=Coverage(
                extent="query-results",
                read_ranges=tuple(fragment.locator.to_dict() for fragment in merged[: max(1, int(limit))]),
                total_units=disk.coverage.total_units,
                complete=disk.coverage.complete and len(merged) <= max(1, int(limit)),
                next_cursor=disk.coverage.next_cursor,
                missing_reason="live-selection-overlays-disk-revision",
            ),
            evidence_status="degraded" if disk.evidence_status in {"error", "unsupported"} else "ok",
            used_backend=f"{material.used_backend}+{disk.used_backend}",
            latency_ms=live.latency_ms + disk.latency_ms,
        )

    def follow(self, source: SourceRef, fragment_id: str) -> tuple[SourceRef, ...]:
        self._material(source)
        return self._fallback.follow(source, fragment_id) if self._fallback is not None else ()


__all__ = ["FrozenSelectionMaterial", "FrozenSelectionReader"]
