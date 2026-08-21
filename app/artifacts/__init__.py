"""Typed DraftArtifact projections over the Agent Runtime session log."""

from .projection import project_artifacts
from .schema import (
    ArtifactProjectionError,
    DraftArtifact,
    DraftPatch,
    DraftState,
    content_hash,
)

__all__ = [
    "ArtifactProjectionError",
    "DraftArtifact",
    "DraftPatch",
    "DraftState",
    "content_hash",
    "project_artifacts",
]
