from __future__ import annotations

from pathlib import Path

from app.grounding.component_source import ComponentSourceResolver


def _browser_context(**overrides) -> dict:
    value = {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Checkout", "url": "http://127.0.0.1:5173/checkout"},
        "node": {
            "tag": "button",
            "id": "retry-payment",
            "classes": ["primary"],
            "role": "button",
            "accessibleName": "Retry payment",
            "text": "Retry",
            "attributes": {"data-testid": "retry-payment", "aria-label": "Retry payment"},
        },
        "selector": "#retry-payment",
        "componentHints": {"framework": "unknown", "owners": []},
    }
    value.update(overrides)
    return value


def test_direct_runtime_component_source_is_high_confidence_and_repo_bounded(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "components" / "RetryButton.tsx"
    source.parent.mkdir(parents=True)
    source.write_text("export function RetryButton() { return <button>Retry</button>; }\n", encoding="utf-8")
    context = _browser_context(componentHints={
        "framework": "react",
        "owners": [{
            "name": "RetryButton",
            "source": {"file": source.as_uri(), "line": 7, "column": 3},
        }],
    })

    result = ComponentSourceResolver().resolve(
        browser_context=context,
        objects=[],
        workspace_root=repo,
    )

    assert result["state"] == "resolved"
    assert result["autoModificationAllowed"] is True
    assert result["policy"] == "high_confidence_direct_source"
    assert result["candidates"][0]["path"] == str(source.resolve())
    assert result["candidates"][0]["relativePath"] == "src/components/RetryButton.tsx"
    assert result["candidates"][0]["line"] == 7
    assert result["candidates"][0]["componentName"] == "RetryButton"
    assert result["candidates"][0]["confidence"] >= 0.95
    assert "runtime_source_exact" in result["candidates"][0]["evidence"]


def test_repository_signal_match_outputs_ranked_candidates_but_blocks_auto_edit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "src" / "RetryButton.tsx"
    source.parent.mkdir(parents=True)
    source.write_text(
        'export const RetryButton = () => <button data-testid="retry-payment" aria-label="Retry payment">Retry</button>;\n',
        encoding="utf-8",
    )
    decoy = repo / "src" / "Copy.tsx"
    decoy.write_text("export const Copy = () => <p>Retry</p>;\n", encoding="utf-8")

    result = ComponentSourceResolver().resolve(
        browser_context=_browser_context(),
        objects=[],
        workspace_root=repo,
    )

    assert result["state"] == "ambiguous"
    assert result["autoModificationAllowed"] is False
    assert result["policy"] == "candidate_only_inspect_before_edit"
    assert result["candidates"][0]["relativePath"] == "src/RetryButton.tsx"
    assert result["candidates"][0]["confidence"] < 0.9
    assert "data_testid_exact" in result["candidates"][0]["evidence"]
    assert "accessible_name_exact" in result["candidates"][0]["evidence"]


def test_screenshot_text_can_find_low_confidence_component_without_auto_edit(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    source = repo / "ui" / "BillingSummary.vue"
    source.parent.mkdir(parents=True)
    source.write_text("<template><h2>Billing summary</h2></template>\n", encoding="utf-8")

    result = ComponentSourceResolver().resolve(
        browser_context=None,
        objects=[{
            "kind": "screen_region",
            "label": "Billing summary",
            "content": "Billing summary",
            "source": {"app": "Figma"},
        }],
        workspace_root=repo,
    )

    assert result["state"] == "ambiguous"
    assert result["candidates"][0]["relativePath"] == "ui/BillingSummary.vue"
    assert result["candidates"][0]["confidenceBand"] == "low"
    assert result["autoModificationAllowed"] is False


def test_runtime_source_outside_workspace_is_rejected(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()
    outside = tmp_path / "private" / "Secret.tsx"
    outside.parent.mkdir()
    outside.write_text("export const Secret = 1\n", encoding="utf-8")
    context = _browser_context(
        node={"tag": "div", "attributes": {}, "accessibleName": "", "text": ""},
        selector="div",
        componentHints={
            "framework": "react",
            "owners": [{"name": "Secret", "source": {"file": outside.as_uri(), "line": 1}}],
        },
    )

    result = ComponentSourceResolver().resolve(
        browser_context=context,
        objects=[],
        workspace_root=repo,
    )

    assert result["state"] == "unavailable"
    assert result["candidates"] == []
    assert result["autoModificationAllowed"] is False
    assert "Secret.tsx" not in str(result)
