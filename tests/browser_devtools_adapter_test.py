from __future__ import annotations

from app.adapters.browser_devtools_adapter import (
    BROWSER_DOM_PROBE_SCRIPT,
    BrowserDevToolsAdapter,
    ChromeDevToolsProbe,
    DevToolsProbeResult,
    sanitize_browser_context,
)
from app.adapters.registry import default_adapter_registry


def _window() -> dict[str, object]:
    return {
        "hwnd": 42,
        "pid": 314,
        "class_name": "Chrome_WidgetWin_1",
        "title": "Checkout failure - Microsoft Edge",
        "bbox": [100, 200, 1300, 1000],
    }


def _context() -> dict:
    return {
        "schemaVersion": 1,
        "state": "resolved",
        "method": "cdp:dom-point",
        "page": {"title": "Checkout failure", "url": "http://127.0.0.1:8765/fixture.html"},
        "node": {
            "tag": "button",
            "id": "retry",
            "classes": ["primary"],
            "role": "button",
            "accessibleName": "Retry payment",
            "text": "Retry",
            "attributes": {"data-testid": "retry-payment"},
        },
        "selector": "button[data-testid=\"retry-payment\"]",
        "coordinates": {
            "pointerScreenPhysical": {"x": 640, "y": 520},
            "pointerViewportCss": {"x": 524.0, "y": 241.0},
            "elementViewportCss": {"x": 500, "y": 220, "width": 120, "height": 44},
            "elementScreenPhysical": {"x": 616, "y": 499, "width": 120, "height": 44},
            "devicePixelRatio": 1,
        },
        "networkFailures": [{
            "url": "http://127.0.0.1:9/api/payment",
            "errorText": "net::ERR_CONNECTION_REFUSED",
            "source": "devtools_log",
            "timestamp": "2026-07-27T21:00:00Z",
        }],
        "provenance": {"endpoint": "http://127.0.0.1:9222", "targetId": "page-1", "structural": True},
        "componentHints": {
            "framework": "react",
            "owners": [
                {
                    "name": "RetryButton",
                    "source": {"file": "file:///D:/work/src/RetryButton.tsx?token=secret", "line": 12, "column": 4},
                    "private": "drop",
                },
                {
                    "name": "CheckoutPanel",
                    "source": {"file": r"D:\work\src\CheckoutPanel.tsx?token=secret", "line": 4},
                },
            ],
        },
        "uncertainty": [],
    }


def test_browser_adapter_matches_chromium_but_not_magic_pointer() -> None:
    adapter = BrowserDevToolsAdapter(probe=lambda *_args, **_kwargs: None)
    assert adapter.match_window(_window()) is True
    assert adapter.match_window({"class_name": "Chrome_WidgetWin_1", "title": "Magic Pointer Panel"}) is False
    assert adapter.match_window({"class_name": "MozillaWindowClass", "title": "Firefox"}) is False


def test_browser_adapter_returns_dom_selector_accessible_name_network_and_coordinates() -> None:
    calls = []

    def probe(window, target_point):
        calls.append((window, target_point))
        return DevToolsProbeResult(True, _context())

    ctx = BrowserDevToolsAdapter(probe=probe).read_context(
        _window(),
        target_point={"x": 640, "y": 520},
    )

    assert calls == [(_window(), {"x": 640, "y": 520})]
    assert ctx.method == "cdp:dom-point"
    assert ctx.app == "browser"
    assert ctx.content == "Retry"
    assert ctx.label == "Retry payment"
    assert ctx.artifacts["browser_context"]["selector"] == 'button[data-testid="retry-payment"]'
    assert ctx.artifacts["browser_context"]["networkFailures"][0]["errorText"] == "net::ERR_CONNECTION_REFUSED"
    assert ctx.artifacts["browser_context"]["coordinates"]["pointerScreenPhysical"] == {"x": 640, "y": 520}
    assert [cap.name for cap in ctx.capabilities] == ["read_dom_node"]


def test_browser_adapter_fails_closed_without_devtools_or_pointer() -> None:
    adapter = BrowserDevToolsAdapter(
        probe=lambda _window, _point: DevToolsProbeResult(False, {}, "cdp_endpoint_unavailable")
    )
    missing_pointer = adapter.read_context(_window())
    unavailable = adapter.read_context(_window(), target_point={"x": 640, "y": 520})

    assert missing_pointer.content is None
    assert missing_pointer.error == "A physical pointer coordinate is required for DOM hit-testing."
    assert unavailable.content is None
    assert unavailable.error == "cdp_endpoint_unavailable"


def test_browser_context_sanitizer_drops_secrets_and_caps_network_failures() -> None:
    raw = _context()
    raw["page"]["url"] = "https://user:pass@example.test/page?token=secret#frag"
    raw["networkFailures"] = [
        {"url": f"https://example.test/api/{index}?token=secret", "errorText": "x" * 1000, "source": "network.loadingFailed", "private": "drop"}
        for index in range(40)
    ]
    raw["private"] = "drop"
    safe = sanitize_browser_context(raw)

    assert safe is not None
    assert safe["page"]["url"] == "https://example.test/page"
    assert len(safe["networkFailures"]) == 20
    assert "secret" not in str(safe)
    assert "private" not in str(safe)
    assert len(safe["networkFailures"][0]["errorText"]) <= 300
    assert safe["componentHints"]["framework"] == "react"
    assert safe["componentHints"]["owners"][0]["name"] == "RetryButton"
    assert safe["componentHints"]["owners"][0]["source"]["file"] == "file:///D:/work/src/RetryButton.tsx"
    assert safe["componentHints"]["owners"][1]["source"]["file"] == r"D:\work\src\CheckoutPanel.tsx"
    assert "private" not in str(safe["componentHints"])


def test_dom_probe_script_builds_stable_selector_and_accessible_name_at_point() -> None:
    assert "document.elementFromPoint" in BROWSER_DOM_PROBE_SCRIPT
    assert "data-testid" in BROWSER_DOM_PROBE_SCRIPT
    assert "aria-labelledby" in BROWSER_DOM_PROBE_SCRIPT
    assert "accessibleName" in BROWSER_DOM_PROBE_SCRIPT
    assert "pointerScreenPhysical" in BROWSER_DOM_PROBE_SCRIPT
    assert "__reactFiber$" in BROWSER_DOM_PROBE_SCRIPT
    assert "__vueParentComponent" in BROWSER_DOM_PROBE_SCRIPT
    assert "componentHints" in BROWSER_DOM_PROBE_SCRIPT


def test_devtools_status_reports_only_safe_connection_counts() -> None:
    probe = ChromeDevToolsProbe(endpoints=["http://127.0.0.1:9222", "http://localhost:9333"])
    probe._inventory = lambda: (
        ["http://127.0.0.1:9222"],
        [
            ("http://127.0.0.1:9222", {"type": "page", "title": "private", "url": "https://secret.test/?token=x"}),
            ("http://127.0.0.1:9222", {"type": "page", "title": "another"}),
        ],
    )

    status = probe.status()

    assert status == {
        "state": "available",
        "configuredEndpointCount": 2,
        "reachableEndpointCount": 1,
        "pageCount": 2,
        "endpoints": ["http://127.0.0.1:9222", "http://localhost:9333"],
        "reason": "",
    }
    assert "private" not in str(status)
    assert "secret" not in str(status)


def test_devtools_status_is_honestly_unavailable_without_reachable_endpoint() -> None:
    probe = ChromeDevToolsProbe(endpoints=["http://127.0.0.1:65431"])
    probe._inventory = lambda: ([], [])

    assert probe.status()["state"] == "unavailable"
    assert probe.status()["reason"] == "cdp_endpoint_unavailable"


def test_default_registry_respects_saved_browser_connection_settings() -> None:
    disabled = default_adapter_registry(browser_devtools_enabled=False)
    assert "browser_devtools" not in [adapter.name for adapter in disabled.adapters]

    enabled = default_adapter_registry(
        browser_devtools_enabled=True,
        browser_devtools_endpoints=["http://127.0.0.1:9333"],
    )
    browser = next(adapter for adapter in enabled.adapters if adapter.name == "browser_devtools")
    assert tuple(browser._probe.__self__.endpoints) == ("http://127.0.0.1:9333",)
