"""SurfaceAdapter SDK tests: manifest matching, registry chain, WeChat sample."""

from __future__ import annotations

import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.surface_adapter import (  # noqa: E402
    RawObject,
    ResolveResult,
    SurfaceAdapterManifest,
    SurfaceAdapterRegistry,
    get_surface_registry,
)
from app.surface_adapter.adapters.wechat_adapter import (  # noqa: E402
    WeChatSurfaceAdapter,
    WECHAT_MANIFEST,
)


def test_manifest_claims_wechat_windows() -> None:
    assert WECHAT_MANIFEST.matches_window({"process_name": "WeChat.exe"}) is True
    assert WECHAT_MANIFEST.matches_window({"class_name": "WeChatMainWndForPC"}) is True
    assert WECHAT_MANIFEST.matches_window({"title": "微信"}) is True
    assert WECHAT_MANIFEST.matches_window({"process_name": "notepad.exe"}) is False


def test_manifest_does_not_claim_lookalike_processes_or_titles() -> None:
    """Perception-audit P2: substring app-id matching used to claim
    evilwechat.exe and any window whose title merely contained 微信."""
    assert WECHAT_MANIFEST.matches_window({"process_name": "evilwechat.exe"}) is False
    assert WECHAT_MANIFEST.matches_window({"process_name": "WeChat.exe.bak"}) is False
    assert WECHAT_MANIFEST.matches_window({"title": "微信使用技巧 - Chrome"}) is False
    assert WECHAT_MANIFEST.matches_window({"title": "微信"}) is True


def test_manifest_rejects_type_confused_array_fields() -> None:
    import pytest

    from app.surface_adapter.manifest import SurfaceAdapterManifest

    # A string instead of an array used to iterate into single characters and
    # claim almost every window (perception-audit P2).
    with pytest.raises(ValueError, match="app_ids must be an array"):
        SurfaceAdapterManifest.from_dict(
            {"id": "x", "display_name": "x", "app_ids": "wechat"}
        )
    with pytest.raises(ValueError, match="version must be an integer"):
        SurfaceAdapterManifest.from_dict(
            {"id": "x", "display_name": "x", "app_ids": ["a.exe"], "version": 1.5}
        )


def test_manifest_from_dict_rejects_missing_identity() -> None:
    import pytest

    with pytest.raises(ValueError):
        SurfaceAdapterManifest.from_dict({"id": "x", "display_name": "x"})


def test_manifest_round_trip_via_file() -> None:
    from app.surface_adapter.manifest import load_manifest

    path = Path("data/surface_adapters/wechat.manifest.json")
    manifest = load_manifest(path)
    assert manifest.id == "wechat"
    assert any("wechat" in app_id.casefold() for app_id in manifest.app_ids)


def test_registry_returns_first_claiming_adapter() -> None:
    class Fake:
        def matches(self, window):
            return window.get("process_name") == "target.exe"

        def resolve(self, window, target_point, target_region):
            return ResolveResult(
                adapter_id="fake",
                objects=(RawObject(
                    id="o1", kind="row", label="行", text="hello",
                    rect_xywh=(0, 0, 10, 10), order_index=0,
                    confidence=1.0, evidence="fake",
                ),),
                window=window,
            )

    registry = SurfaceAdapterRegistry()
    registry.register(Fake())
    result = registry.try_resolve({"process_name": "target.exe"}, {"x": 1, "y": 2})
    assert result is not None and result.adapter_id == "fake"
    assert result.ordered_text == "[0] 行: hello"
    assert registry.try_resolve({"process_name": "other.exe"}, None, None) is None


def test_registry_survives_raising_adapter() -> None:
    class Boom:
        def matches(self, window):
            raise RuntimeError("boom")

        def resolve(self, window, target_point, target_region):
            return None

    registry = SurfaceAdapterRegistry()
    registry.register(Boom())
    assert registry.try_resolve({"hwnd": 1}, None, None) is None


def test_plugin_scoped_surface_adapter_unwinds() -> None:
    from app.harness.context import Context

    class Fake:
        def matches(self, window):
            return False

        def resolve(self, window, target_point, target_region):
            return None

    root = Context()
    registry = SurfaceAdapterRegistry()
    root.provide("surface_adapters", registry)
    root.inject(
        ["surface_adapters"],
        lambda plugin_ctx: plugin_ctx.get("surface_adapters").register(Fake()),
    )
    assert len(registry.list_adapters()) == 1

    root.unload()

    assert registry.list_adapters() == []


def test_plugin_unload_waits_for_inflight_surface_resolution() -> None:
    from app.harness.context import Context

    entered = threading.Event()
    release = threading.Event()
    unloaded = threading.Event()

    class Slow:
        def matches(self, window):
            return True

        def resolve(self, window, target_point, target_region):
            entered.set()
            assert release.wait(timeout=2)
            return ResolveResult(adapter_id="slow", objects=(), window=window)

    root = Context()
    registry = SurfaceAdapterRegistry()
    root.provide("surface_adapters", registry)
    root.inject(
        ["surface_adapters"],
        lambda plugin_ctx: plugin_ctx.get("surface_adapters").register(Slow()),
    )
    resolving = threading.Thread(
        target=lambda: registry.try_resolve({"hwnd": 1}, None, None),
        daemon=True,
    )
    resolving.start()
    assert entered.wait(timeout=1)
    unloading = threading.Thread(
        target=lambda: (root.unload(), unloaded.set()),
        daemon=True,
    )
    unloading.start()

    assert not unloaded.wait(timeout=0.05)
    release.set()
    resolving.join(timeout=1)
    unloading.join(timeout=1)

    assert unloaded.is_set()
    assert registry.list_adapters() == []


def test_wechat_adapter_opaque_tree_returns_anchor(monkeypatch):
    """Opaque UIA tree: honest region anchor, pixel evidence merges on top."""
    from app.surface_adapter.adapters import wechat_adapter

    fake_probe = type("ProbeResult", (), {"ok": False, "data": {}})()
    monkeypatch.setattr(
        wechat_adapter,
        "_run_uia_selection_probe",
        lambda hwnd, **kwargs: fake_probe,
    )
    adapter = WeChatSurfaceAdapter()
    result = adapter.resolve({"hwnd": 1, "title": "微信"}, None, None)
    assert result is not None
    assert result.objects[0].kind == "message_list"
    assert result.objects[0].text == ""
    assert result.objects[0].evidence == "pixel:region_anchor"
    assert "opaque_tree_region_anchor" in result.notes


def test_wechat_adapter_uses_container_uia_when_exposed(monkeypatch):
    """Some builds expose an accessibility subtree: use it, with evidence."""
    from app.surface_adapter.adapters import wechat_adapter

    fake_probe = type("ProbeResult", (), {"ok": True, "data": {"text": "消息一"}})()
    monkeypatch.setattr(
        wechat_adapter,
        "_run_uia_selection_probe",
        lambda hwnd, **kwargs: fake_probe,
    )
    adapter = WeChatSurfaceAdapter()
    result = adapter.resolve({"hwnd": 1}, None, None)
    assert result is not None
    assert result.objects[0].text == "消息一"
    assert result.objects[0].evidence == "uia:container"


def test_default_registry_has_wechat() -> None:
    registry = get_surface_registry()
    assert any(
        getattr(adapter, "manifest", None) is WECHAT_MANIFEST
        for adapter in registry.list_adapters()
    )


def test_surface_harness_boots_builtin_wechat_adapter() -> None:
    from app.harness.builtin_bundle import boot_surface_context

    report = boot_surface_context(plugin_dir=Path("data/plugins"))
    registry = report.ctx.get("surface_adapters")
    assert any(
        getattr(adapter, "manifest", None) is WECHAT_MANIFEST
        for adapter in registry.list_adapters()
    )
    report.ctx.unload()
    assert registry.list_adapters() == []
