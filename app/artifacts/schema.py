"""DraftArtifact value objects.

The durable source is still :mod:`app.agent_runtime.session`.  These frozen
objects are the product the user edits: a completed answer is a revisioned
draft, not a chat bubble that evaporates when three characters change.
"""

from __future__ import annotations

import enum
import hashlib
from dataclasses import dataclass


class DraftState(enum.StrEnum):
    GENERATED = "generated"
    EDITED = "edited"
    APPROVED = "approved"


class ArtifactProjectionError(RuntimeError):
    """The event stream cannot be projected into a draft without inventing state."""


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
    accepted_revision: int | None = None
