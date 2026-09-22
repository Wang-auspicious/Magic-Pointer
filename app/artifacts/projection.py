
from __future__ import annotations

import copy
from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from .schema import (
    ArtifactProjectionError,
    DraftArtifact,
    DraftPatch,
    DraftState,
    content_hash,
)


def project_artifacts(events: Iterable[Any]) -> tuple[DraftArtifact, ...]:
    ordered: list[DraftArtifact] = []
    by_id: dict[str, int] = {}
    for event in events:
        event_type = str(getattr(event, "type", "") or "")
        data = dict(getattr(event, "data", {}) or {})
        seq = int(getattr(event, "seq", -1))
        if event_type == "artifact/generated":
            artifact_id = str(data.get("artifactId") or "")
            content = str(data.get("content") or "")
            if not artifact_id:
                raise ArtifactProjectionError(f"generated draft at event {seq} has no id")
            if artifact_id in by_id:
                raise ArtifactProjectionError(f"duplicate artifact id {artifact_id!r}")
            if not content.strip():
                raise ArtifactProjectionError(f"generated draft {artifact_id!r} is empty")
            digest = str(data.get("contentHash") or content_hash(content))
            kind = str(data.get("kind") or "text")
            patch_payload = data.get("patchPayload")
            if patch_payload is not None and not isinstance(patch_payload, dict):
                raise ArtifactProjectionError(
                    f"generated draft {artifact_id!r} has invalid patch payload"
                )
            draft = DraftArtifact(
                artifact_id=artifact_id,
                revision=1,
                content=content,
                content_hash=digest,
                state=DraftState.GENERATED,
                kind=kind,
                title=str(data.get("title") or ""),
                patch_payload=copy.deepcopy(patch_payload),
                history=(DraftPatch(
                    revision=1,
                    author=str(data.get("author") or "model"),
                    content_hash=digest,
                    seq=seq,
                ),),
            )
            by_id[artifact_id] = len(ordered)
            ordered.append(draft)
            continue
        if event_type == "artifact/patched":
            artifact_id = str(data.get("artifactId") or "")
            index = by_id.get(artifact_id)
            if index is None:
                raise ArtifactProjectionError(
                    f"patch at event {seq} has no generated draft {artifact_id!r}"
                )
            current = ordered[index]
            content = str(data.get("content") or "")
            if not content.strip():
                raise ArtifactProjectionError(f"patched draft {artifact_id!r} is empty")
            revision = int(data.get("revision") or 0)
            if revision != current.revision + 1:
                raise ArtifactProjectionError(
                    f"draft {artifact_id!r} jumped from revision {current.revision} to {revision}"
                )
            digest = str(data.get("contentHash") or content_hash(content))
            author = str(data.get("author") or "")
            kind = str(data.get("kind") or current.kind)
            patch_payload = data.get("patchPayload", current.patch_payload)
            if patch_payload is not None and not isinstance(patch_payload, dict):
                raise ArtifactProjectionError(
                    f"patched draft {artifact_id!r} has invalid patch payload"
                )
            ordered[index] = replace(
                current,
                revision=revision,
                content=content,
                content_hash=digest,
                state=DraftState.EDITED,
                accepted_revision=None,
                kind=kind,
                title=str(data.get("title", current.title) or ""),
                patch_payload=copy.deepcopy(patch_payload),
                history=current.history + (DraftPatch(
                    revision=revision,
                    author=author,
                    content_hash=digest,
                    seq=seq,
                ),),
            )
            continue
        if event_type != "artifact/accepted":
            continue
        artifact_id = str(data.get("artifactId") or "")
        index = by_id.get(artifact_id)
        if index is None:
            raise ArtifactProjectionError(
                f"accept at event {seq} has no generated draft {artifact_id!r}"
            )
        current = ordered[index]
        revision = int(data.get("revision") or 0)
        digest = str(data.get("contentHash") or "")
        if revision != current.revision or digest != current.content_hash:
            raise ArtifactProjectionError(
                f"accept at event {seq} does not match draft {artifact_id!r}"
            )
        ordered[index] = replace(
            current,
            state=DraftState.APPROVED,
            accepted_revision=revision,
        )
    return tuple(ordered)


def latest_turn_artifacts(events: Iterable[Any]) -> tuple[DraftArtifact, ...]:
    events = tuple(events)
    start = max((event.seq for event in events if event.type == "turn/start"), default=-1)
    changed = {
        str(event.data.get("artifactId") or "") for event in events
        if event.type in {"artifact/generated", "artifact/patched"} and event.seq > start
    }
    return tuple(item for item in project_artifacts(events) if item.artifact_id in changed)


def latest_turn_artifact_summaries(events: Iterable[Any]) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    for artifact in latest_turn_artifacts(events):
        name = artifact.title or next(
            (line.strip() for line in artifact.content.splitlines() if line.strip()), "Draft",
        )[:120]
        summaries.append({
            "artifactId": artifact.artifact_id,
            "revision": artifact.revision,
            "kind": artifact.kind,
            "state": artifact.state.value,
            "title": artifact.title,
            "name": name,
            "summary": artifact.content.strip().replace("\r", " ").replace("\n", " ")[:240],
        })
    return summaries
