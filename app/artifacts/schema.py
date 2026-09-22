
from __future__ import annotations

import enum
import hashlib
from dataclasses import dataclass
from typing import Any


class DraftState(enum.StrEnum):
    GENERATED = "generated"
    EDITED = "edited"
    APPROVED = "approved"


class ArtifactProjectionError(RuntimeError):
    pass


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class DraftPatch:
    revision: int
    author: str
    content_hash: str
    seq: int


@dataclass(frozen=True, slots=True)
class DraftArtifact:
    artifact_id: str
    revision: int
    content: str
    content_hash: str
    state: DraftState
    history: tuple[DraftPatch, ...]
    kind: str = "text"
    patch_payload: dict[str, Any] | None = None
    accepted_revision: int | None = None
    title: str = ""
