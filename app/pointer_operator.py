from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.actions import ActionProposal, ActionTarget, SafetyLevel
from app.grounding.base import GroundingBundle, GroundingTrace
from app.grounding.explorer_adapter import ExplorerFileGrounder
from app.grounding.schema import GroundedObject, PointerSelection

JsonDict = dict[str, Any]

COPY_PATH_TOKENS = ("复制路径", "完整路径", "文件路径", "copy path", "file path", "full path", "路径")


def wants_copy_path(command: str) -> bool:
    command_l = (command or "").strip().lower()
    return any(token in command_l for token in COPY_PATH_TOKENS)


@dataclass(frozen=True)
class PointerOperatorResult:
    """Pointer-first observation output.

    It is intentionally not an autonomous CU loop. Human pointer input anchors
    THIS; local grounders enrich it; action proposals are optional and safe by
    default.
    """

    grounding: GroundingBundle
    proposals: list[ActionProposal] = field(default_factory=list)

    def to_dict(self) -> JsonDict:
        return {
            "grounding": self.grounding.to_dict(),
            "proposals": [proposal.to_dict() for proposal in self.proposals],
        }


class MagicPointerOperator:
    """Minimal pointer-first operator inspired by UFO + UI-TARS.

    This class replaces the autonomous screenshot->click loop with:
    human pointer selection -> local grounding -> optional typed proposal.
    """

    def __init__(self) -> None:
        self.grounders = [ExplorerFileGrounder()]

    def observe(
        self,
        *,
        selection: PointerSelection,
        command: str = "",
        windows: list[JsonDict] | None = None,
        stroke_points: list[tuple[int, int]] | None = None,
        row_candidates: list[JsonDict] | None = None,
    ) -> PointerOperatorResult:
        objects: list[GroundedObject] = []
        traces: list[GroundingTrace] = []
        primary_object_id: str | None = None
        for grounder in self.grounders:
            bundle = grounder.ground(
                selection,
                windows=windows or [],
                stroke_points=stroke_points or [],
                row_candidates=row_candidates or [],
            )
            objects.extend(bundle.objects)
            traces.extend(bundle.traces)
            if not primary_object_id and bundle.primary_object_id:
                primary_object_id = bundle.primary_object_id
        grounding = GroundingBundle(selection=selection, objects=objects, primary_object_id=primary_object_id, traces=traces)
        proposals = self.propose(command, grounding)
        return PointerOperatorResult(grounding=grounding, proposals=proposals)

    def propose(self, command: str, grounding: GroundingBundle) -> list[ActionProposal]:
        primary = grounding.primary
        if not primary:
            return []
        path = str(primary.metadata.get("path") or "")
        proposals: list[ActionProposal] = []
        if path and wants_copy_path(command):
            proposals.append(
                ActionProposal(
                    id=f"proposal:{primary.id}:copy_path",
                    action_type="copy_text_to_clipboard",
                    target=ActionTarget.from_grounded_object(primary),
                    parameters={"text": path},
                    safety_level=SafetyLevel.MEDIUM,
                    confirmation_required=True,
                    rationale="Copying a local file path changes clipboard contents and should be confirmed.",
                    metadata={"source": "magic_pointer_operator", "object_kind": primary.kind},
                )
            )
        return proposals


def format_grounding_for_prompt(result: PointerOperatorResult) -> str:
    grounding = result.grounding
    if not grounding.objects:
        return ""
    lines = [
        "Local object grounding v1:",
        "These are local structured objects inferred from the user's Magic Pointer stroke. Prefer high-confidence local objects over visual OCR guesses.",
    ]
    primary = grounding.primary
    if primary:
        lines.append(f"primary_object_id={primary.id!r}")
    for i, obj in enumerate(grounding.objects[:5], 1):
        meta = obj.metadata or {}
        path = meta.get("path") or meta.get("folder_path") or ""
        lines.append(
            f"{i}. id={obj.id!r}, kind={obj.kind!r}, label={obj.label!r}, text={obj.text!r}, "
            f"confidence={obj.confidence:.3f}, bbox={obj.bbox}, path={path!r}, app_title={obj.app_title!r}"
        )
    if result.proposals:
        lines.append("action_proposals:")
        for proposal in result.proposals[:3]:
            lines.append(
                f"- id={proposal.id!r}, type={proposal.action_type!r}, safety={proposal.safety_level.value}, "
                f"needs_confirmation={proposal.needs_confirmation()}, rationale={proposal.rationale!r}"
            )
    return "\n".join(lines)
