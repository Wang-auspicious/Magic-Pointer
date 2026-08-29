"""语义句柄文法（Hermes drive 通道的移植）：圈选完成后在屏幕上回放
「元素框 + 句柄标签」的句柄在这里生成。

文法（三级降级，与 Hermes 观察到的规则一致）：
1. 元素自带 automation_id → ``A#<id>``（应用自己给的锚点，最稳）；
2. 否则 ``<TYPE>-<文本slug>``（内容寻址，模型可直接读懂）；
3. slug 冲突 → 同组追加序号 ``-2``、``-3``（不是全局索引）。
"""

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
    """快照桥的 context 带结构化元素时必须发出 element_handles。

    这是屏幕回放（Hermes drive 通道）的数据源：主进程读到它才画框+标签。
    """
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

    # 自绘应用（无 region_elements）原样返回，不造假框。
    bare = {"adapter": "screen_region", "artifacts": {"capture_path": "x.png"}}
    assert _context_with_element_handles(bare) is bare
