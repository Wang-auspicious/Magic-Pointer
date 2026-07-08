from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.actions import ActionProposal, SafetyLevel
from app.actions.executor import SafeActionExecutor
from app.grounding.base import GroundingBundle
from app.grounding.explorer_adapter import ExplorerFileGrounder, file_url_to_path, is_explorer_window, resolve_child_path, score_item_against_stroke
from app.grounding.schema import GroundedObject, PointerSelection
from app.pointer_operator import MagicPointerOperator, format_grounding_for_prompt, wants_copy_path


def test_file_url_to_path() -> None:
    assert file_url_to_path("file:///C:/Users/demo/Desktop") == r"C:\Users\demo\Desktop"
    assert file_url_to_path("https://example.com") is None


def test_resolve_child_path_handles_hidden_extension_names() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        file_path = folder / "demo.pdf"
        file_path.write_text("x", encoding="utf-8")
        assert resolve_child_path(str(folder), "demo.pdf") == str(file_path)
        assert resolve_child_path(str(folder), "demo") == str(file_path)

        em_dash = chr(0x2014)
        replacement = chr(0xFFFD)
        special = folder / ("Shaping the future of AI interaction by reimagining the mouse pointer " + em_dash + " Google DeepMind.html")
        special.write_text("x", encoding="utf-8")
        mangled = "Shaping the future of AI interaction by reimagining the mouse pointer " + replacement * 2 + " Google DeepMind.html"
        assert resolve_child_path(str(folder), mangled) == str(special)


def test_copy_path_intent_detection() -> None:
    assert wants_copy_path('把这个文件的完整路径复制到剪贴板') is True
    assert wants_copy_path("copy path") is True
    assert wants_copy_path("explain this file") is False


def test_stroke_scoring_prefers_hit_rect() -> None:
    selection = (10, 10, 40, 30)
    stroke = [(12, 18), (20, 18), (35, 18)]
    hit = score_item_against_stroke((0, 0, 100, 40), selection, stroke)
    miss = score_item_against_stroke((0, 80, 100, 120), selection, stroke)
    assert hit > miss
    assert hit > 1




def test_horizontal_underline_prefers_row_above() -> None:
    selection = (20, 36, 280, 62)
    stroke = [(30, 44), (120, 45), (260, 44)]
    row_above = (0, 0, 300, 40)
    row_below = (0, 48, 300, 88)
    above_score = score_item_against_stroke(row_above, selection, stroke)
    below_score = score_item_against_stroke(row_below, selection, stroke)
    assert above_score > below_score


def test_explorer_grounder_degrades_without_optional_deps() -> None:
    selection = PointerSelection(id="sel", point=(20, 20), bbox=(10, 10, 80, 60))
    grounder = ExplorerFileGrounder()
    # Simulate Windows Explorer being present while both optional backends are unavailable.
    grounder._read_shell_window = lambda hwnd: (None, [], ["win32com unavailable: test"])  # type: ignore[method-assign]
    grounder._read_uia_items = lambda hwnd, folder_path: ([], ["pywinauto unavailable: test"])  # type: ignore[method-assign]
    bundle = grounder.ground(
        selection,
        windows=[{
            "hwnd": 1234,
            "title": "Downloads - File Explorer",
            "class_name": "CabinetWClass",
            "z_order": 0,
            "selection_coverage": 1.0,
        }],
        stroke_points=[(20, 20), (30, 30)],
    )
    assert bundle.objects
    assert bundle.objects[0].kind == "explorer_window"
    assert bundle.objects[0].confidence < 0.5
    assert MagicPointerOperator().propose("复制路径", bundle) == []


def test_explorer_window_detection_includes_chinese_title() -> None:
    assert is_explorer_window({"title": "文件资源管理器", "class_name": ""}) is True


def test_operator_no_explorer_is_non_destructive() -> None:
    selection = PointerSelection(id="sel", point=(10, 10), bbox=(8, 8, 20, 20))
    result = MagicPointerOperator().observe(selection=selection, command="explain", windows=[], stroke_points=[])
    assert result.grounding.objects == []
    assert result.proposals == []


def test_format_grounding_and_copy_path_proposal() -> None:
    selection = PointerSelection(id="sel", point=(10, 10), bbox=(8, 8, 20, 20))
    obj = GroundedObject.from_selection(
        id="obj",
        kind="file",
        selection=selection,
        label="demo.txt",
        confidence=0.95,
        metadata={"path": r"D:\demo\demo.txt"},
    )
    bundle = GroundingBundle(selection=selection, objects=[obj], primary_object_id="obj")
    proposals = MagicPointerOperator().propose("复制路径", bundle)
    assert len(proposals) == 1
    proposal = proposals[0]
    assert proposal.action_type == "copy_text_to_clipboard"
    assert proposal.needs_confirmation() is True
    text = format_grounding_for_prompt(type("R", (), {"grounding": bundle, "proposals": proposals})())
    assert "Local object grounding v1" in text
    assert "demo.txt" in text


def test_executor_requires_confirmation() -> None:
    proposal = ActionProposal(
        id="p1",
        action_type="copy_text_to_clipboard",
        parameters={"text": "hello"},
        safety_level=SafetyLevel.MEDIUM,
    )
    result = SafeActionExecutor().execute(proposal, confirmed=False)
    assert result.status.value == "skipped"
    assert result.error == "confirmation required"


def main() -> None:
    test_file_url_to_path()
    test_resolve_child_path_handles_hidden_extension_names()
    test_copy_path_intent_detection()
    test_stroke_scoring_prefers_hit_rect()
    test_horizontal_underline_prefers_row_above()
    test_explorer_grounder_degrades_without_optional_deps()
    test_explorer_window_detection_includes_chinese_title()
    test_operator_no_explorer_is_non_destructive()
    test_format_grounding_and_copy_path_proposal()
    test_executor_requires_confirmation()
    print("grounding operator test ok")


if __name__ == "__main__":
    main()
