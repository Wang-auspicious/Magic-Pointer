"""Anchor model: cross-time target handles and their resolution union (L3).

Pure Python: no UI automation, Electron, or OS-specific APIs here.
"""

from .anchor import (
    Anchor,
    AnchorResolution,
    AppIdentity,
    ResolutionAmbiguous,
    ResolutionChanged,
    ResolutionExact,
    ResolutionGone,
    ResolutionMoved,
    SpatialHint,
    build_anchor,
    from_dict,
    resolution_name,
    to_dict,
)

__all__ = [
    "Anchor",
    "AnchorResolution",
    "AppIdentity",
    "ResolutionAmbiguous",
    "ResolutionChanged",
    "ResolutionExact",
    "ResolutionGone",
    "ResolutionMoved",
    "SpatialHint",
    "build_anchor",
    "from_dict",
    "resolution_name",
    "to_dict",
]
