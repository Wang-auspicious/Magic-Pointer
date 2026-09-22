
from __future__ import annotations

from app.perception.element_handles import assign_element_handles, element_ref, slugify_text


def test_automation_id_wins_over_text_slug():
    ref = element_ref({"automation_id": "up_49364745", "control_type": "Button", "text": "▲"})
    assert ref == "A#up_49364745"


def test_text_slug_is_semantic_and_readable():
    ref = element_ref({"control_type": "Hyperlink", "text": "OpenRouter is joining Stripe"})
    assert ref == "LNK-openrouter-is-joining-stripe"


def test_unknown_control_type_falls_back_to_element_token():
    ref = element_ref({"control_type": "Custom", "text": "魔卡少女"})
    assert ref == "ELM-魔卡少女"


def test_slug_collision_appends_per_group_ordinals():
    elements = [
        {"control_type": "Hyperlink", "text": "hide", "rect": [0, i * 20, 40, 16]}
        for i in range(3)
    ]
    handles = assign_element_handles(elements)
    refs = [h["ref"] for h in handles]
    assert refs == ["LNK-hide", "LNK-hide-2", "LNK-hide-3"]


def test_unnamed_elements_get_role_only_refs_and_stay_distinct():
    handles = assign_element_handles([
        {"control_type": "Button", "text": "", "rect": [0, 0, 9, 9]},
        {"control_type": "Button", "text": "", "rect": [0, 20, 9, 9]},
    ])
    assert handles[0]["ref"] == "BTN"
    assert handles[1]["ref"] == "BTN-2"


def test_elements_without_rect_are_dropped():
    handles = assign_element_handles([
        {"control_type": "Text", "text": "没有坐标的忽略"},
        {"control_type": "Text", "text": "有坐标的保留", "rect": [10, 20, 30, 12]},
    ])
    assert len(handles) == 1
    assert handles[0]["ref"] == "TXT-有坐标的保留"
    assert handles[0]["rect"] == [10, 20, 30, 12]


def test_budget_caps_output():
    elements = [{"control_type": "Text", "text": f"第{i}行", "rect": [0, i, 9, 9]} for i in range(64)]
    handles = assign_element_handles(elements, budget=12)
    assert len(handles) == 12


def test_role_tokens_cover_common_types():
    assert element_ref({"control_type": "Link", "text": "a"}) == "LNK-a"
    assert element_ref({"control_type": "Edit", "text": "b"}) == "EDT-b"
    assert element_ref({"control_type": "Text", "text": "c"}) == "TXT-c"
    assert element_ref({"control_type": "ListItem", "text": "d"}) == "ITM-d"


def test_snapshot_bridge_attaches_handles_to_structured_context():
    from scripts.selection_snapshot_bridge import _context_with_element_handles

    context = {
        "adapter": "uia",
        "artifacts": {
            "region_elements": [
                {"text": "复制", "control_type": "Button",
                 "automation_id": "copy-btn", "rect": [100, 200, 48, 32]},
            ],
        },
    }
    enriched = _context_with_element_handles(context)
    handles = enriched["artifacts"]["element_handles"]
    assert handles[0]["ref"] == "A#copy-btn"
    assert enriched["artifacts"]["element_handles_coordinate_space"] == "physical_screen_pixels"

    bare = {"adapter": "screen_region", "artifacts": {"capture_path": "x.png"}}
    assert _context_with_element_handles(bare) is bare


def test_element_handles_are_resolvable_as_look_anchors():
    from scripts.selection_bridge import _frozen_reference_resolver

    snapshot = {
        "snapshot_id": "selection-abc",
        "context": {
            "artifacts": {
                "element_handles": [
                    {"ref": "A#copy-btn", "role": "Button", "name": "复制", "rect": [100, 200, 48, 32]},
                    {"ref": "TXT-标题", "role": "Text", "name": "标题", "rect": [10, 10, 0, 0]},
                ],
                "element_handles_format": "xywh",
                "element_handles_coordinate_space": "physical_screen_pixels",
            },
        },
    }
    resolve = _frozen_reference_resolver((), snapshot)
    assert resolve("element:A#copy-btn") == (100, 200, 148, 232)
    assert resolve("element:TXT-标题") is None
    assert resolve("element:A#missing") is None
    assert _frozen_reference_resolver((), {"snapshot_id": "s", "context": {}})("element:A#copy-btn") is None
    assert _frozen_reference_resolver((), None)("element:A#copy-btn") is None


def test_element_handles_reach_the_model_as_addressable_facts():
    import json

    from app.adapters.base import AdapterReadContext
    from app.input_artifact import compile_input_artifact

    window = {"hwnd": 42, "title": "记事本", "process_name": "notepad.exe", "bbox": [0, 0, 900, 700]}
    context = AdapterReadContext(
        adapter="uia_text_selection",
        app="application",
        window=window,
        content="正文一段",
        method="uia:region-elements",
        artifacts={
            "element_handles": [
                {"ref": "A#copy-btn", "role": "Button", "name": "复制", "rect": [100, 200, 48, 32]},
            ],
        },
    )
    artifact = compile_input_artifact(
        "把这个按钮指给我看", window, context, {"perception_trace": {"readState": "resolved"}},
    )
    facts = artifact.to_model_dict()["facts"]
    handle_fact = next(fact for fact in facts if fact["kind"] == "element_handles")
    parsed = json.loads(handle_fact["value"])
    assert parsed == [{"ref": "A#copy-btn", "role": "Button", "name": "复制", "rect": [100, 200, 48, 32]}]

    many = AdapterReadContext(
        adapter="uia_text_selection", app="application", window=window, content="正文一段",
        artifacts={"element_handles": [
            {"ref": f"A#button-{index}", "role": "Button", "name": "很长的按钮名字" * 8, "rect": [index, index, 40, 20]}
            for index in range(64)
        ]},
    )
    wide = compile_input_artifact("看这些按钮", window, many, {"perception_trace": {"readState": "resolved"}})
    wide_fact = next(fact for fact in wide.to_model_dict()["facts"] if fact["kind"] == "element_handles")
    decoded = json.loads(wide_fact["value"])
    assert 0 < len(decoded) < 64
    assert len(wide_fact["value"]) <= 4_000
