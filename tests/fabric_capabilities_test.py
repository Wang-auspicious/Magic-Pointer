from __future__ import annotations

from app.fabric.capabilities import CapabilityRegistry


def test_search_is_bounded_and_pins_selected_recipe() -> None:
    matches = CapabilityRegistry().search(
        "让 Codex 修这个界面",
        objects=[{"kind": "screen_region"}],
        selected_recipe_id="agent.handoff",
        limit=6,
    )
    assert 3 <= len(matches) <= 6
    assert matches[0]["id"] == "agent.handoff"
    assert matches[0]["selected"] is True
    assert all(item["score"] >= 0 for item in matches)


def test_limit_is_clamped_between_three_and_eight() -> None:
    registry = CapabilityRegistry()
    minimum = registry.search("处理这个", objects=[{"kind": "text"}], limit=1)
    maximum = registry.search("处理这个", objects=[{"kind": "text"}], limit=99)
    assert len(minimum) == 3
    assert len(maximum) == 8


def test_provider_availability_is_reported_without_inventing_support() -> None:
    matches = CapabilityRegistry().search(
        "把这个公式转成 LaTeX",
        objects=[{"kind": "formula_image"}],
        selected_recipe_id="formula.to_latex",
        provider_availability={"native_math": False, "vision_math": False},
        limit=4,
    )
    formula = matches[0]
    assert formula["id"] == "formula.to_latex"
    assert formula["available"] is False
    assert formula["availableProviders"] == []
    assert formula["providerStrategies"] == ["native_math", "vision_math"]


def test_unprobed_provider_state_is_unknown_not_claimed_available() -> None:
    result = CapabilityRegistry().search(
        "提取图表数据",
        objects=[{"kind": "chart_image"}],
        selected_recipe_id="chart.extract_data",
        provider_availability=None,
        limit=3,
    )[0]
    assert result["id"] == "chart.extract_data"
    assert result["availability"] == "unknown"
    assert result["available"] is None
    assert result["availableProviders"] == []


def test_platform_mismatch_is_visible_but_selected_contract_stays_first() -> None:
    matches = CapabilityRegistry().search(
        "recipe: agent.handoff",
        objects=[{"kind": "grounded_object"}],
        selected_recipe_id="agent.handoff",
        platform="linux",
        limit=3,
    )
    assert matches[0]["id"] == "agent.handoff"
    assert matches[0]["platformSupported"] is False
