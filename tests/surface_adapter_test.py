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
from app.surface_adapter.adapters.dingtalk_adapter import (  # noqa: E402
    DINGTALK_MANIFEST,
    DingTalkSurfaceAdapter,
)
from app.surface_adapter.adapters.figma_adapter import (  # noqa: E402
    FIGMA_MANIFEST,
)
from app.surface_adapter.adapters.wechat_adapter import (  # noqa: E402
    WECHAT_MANIFEST,
    WeChatSurfaceAdapter,
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


def test_figma_surface_manifest_is_packaged_with_native_node_capabilities() -> None:
    from app.surface_adapter.manifest import load_manifest

    manifest = load_manifest(Path("data/surface_adapters/figma.manifest.json"))

    assert manifest.id == "figma"
    assert manifest.app_ids == ("figma.exe",)
    assert {"read_selection", "read_nodes", "patch_nodes", "export_preview"}.issubset(
        manifest.capabilities
    )


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
    assert result.objects[0].kind == "conversation"
    anchor = next(item for item in result.objects if item.kind == "message_list")
    assert anchor.text == ""
    assert anchor.evidence == "pixel:region_anchor"
    assert anchor.fields["requiresVisualObservation"] is True
    assert anchor.fields["missingSemantics"] == [
        "orderedMessages", "speaker", "time", "replyTo", "attachments",
    ]
    assert not any(item.kind == "chat_message" for item in result.objects)
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
    message_list = next(item for item in result.objects if item.kind == "message_list")
    assert message_list.text == "消息一"
    assert message_list.evidence == "uia:container"


def test_wechat_adapter_orders_exposed_message_objects_without_fake_semantics(monkeypatch):
    from app.surface_adapter.adapters import wechat_adapter

    fake_probe = type("ProbeResult", (), {
        "ok": True,
        "data": {
            "text": "later\nearlier",
            "automation_id": "message-pane",
            "region_elements": [
                {
                    "text": "later",
                    "control_type": "ControlType.Text",
                    "automation_id": "",
                    "rect": [30, 220, 200, 30],
                },
                {
                    "text": "earlier",
                    "control_type": "ControlType.Text",
                    "automation_id": "",
                    "rect": [30, 120, 200, 30],
                },
            ],
        },
    })()
    monkeypatch.setattr(wechat_adapter, "_run_uia_selection_probe", lambda *args, **kwargs: fake_probe)

    result = WeChatSurfaceAdapter().resolve(
        {"hwnd": 41, "process_id": 7, "title": "Project chat"},
        None,
        {"x": 0, "y": 0, "width": 500, "height": 500},
    )

    assert result is not None
    messages = [item for item in result.objects if item.kind == "chat_message"]
    assert [item.text for item in messages] == ["earlier", "later"]
    assert [item.order_index for item in messages] == [1, 2]
    assert all(item.fields["speaker"] is None for item in messages)
    assert all(item.fields["time"] is None for item in messages)
    assert all(item.fields["nativeMessageId"] is None for item in messages)
    assert all(item.fields["requiresVisualObservation"] is True for item in messages)
    assert result.objects[0].fields["conversationIdentity"]["conversationKey"] != "Project chat"


def test_same_chat_title_in_two_windows_does_not_become_the_identity(monkeypatch):
    from app.surface_adapter.adapters import wechat_adapter

    fake_probe = type("ProbeResult", (), {"ok": False, "data": {}})()
    monkeypatch.setattr(wechat_adapter, "_run_uia_selection_probe", lambda *args, **kwargs: fake_probe)
    adapter = WeChatSurfaceAdapter()

    first = adapter.resolve({"hwnd": 100, "title": "同名群"}, None, None)
    second = adapter.resolve({"hwnd": 200, "title": "同名群"}, None, None)

    assert first is not None and second is not None
    first_identity = first.objects[0].fields["conversationIdentity"]
    second_identity = second.objects[0].fields["conversationIdentity"]
    assert first_identity["title"] == second_identity["title"] == "同名群"
    assert first_identity["conversationKey"] != second_identity["conversationKey"]


def test_dingtalk_manifest_and_adapter_use_the_same_honest_chat_contract(monkeypatch):
    from app.surface_adapter.adapters import wechat_adapter

    assert DINGTALK_MANIFEST.matches_window({"process_name": "DingTalk.exe"}) is True
    assert DINGTALK_MANIFEST.matches_window({"process_name": "not-dingtalk.exe"}) is False
    fake_probe = type("ProbeResult", (), {"ok": False, "data": {}})()
    monkeypatch.setattr(wechat_adapter, "_run_uia_selection_probe", lambda *args, **kwargs: fake_probe)

    result = DingTalkSurfaceAdapter().resolve(
        {"hwnd": 88, "process_name": "DingTalk.exe", "title": "钉钉"}, None, None
    )

    assert result is not None
    assert result.adapter_id == "dingtalk"
    assert result.objects[0].fields["conversationIdentity"]["adapterId"] == "dingtalk"
    assert next(item for item in result.objects if item.kind == "message_list").fields[
        "requiresVisualObservation"
    ] is True


def test_default_registry_has_wechat_dingtalk_and_figma() -> None:
    registry = get_surface_registry()
    assert any(
        getattr(adapter, "manifest", None) is WECHAT_MANIFEST
        for adapter in registry.list_adapters()
    )
    assert any(
        getattr(adapter, "manifest", None) is DINGTALK_MANIFEST
        for adapter in registry.list_adapters()
    )
    assert any(
        getattr(adapter, "manifest", None) is FIGMA_MANIFEST
        for adapter in registry.list_adapters()
    )


def test_surface_harness_boots_builtin_chat_adapters() -> None:
    from app.harness.builtin_bundle import boot_surface_context

    report = boot_surface_context(plugin_dir=Path("data/plugins"))
    registry = report.ctx.get("surface_adapters")
    assert any(
        getattr(adapter, "manifest", None) is WECHAT_MANIFEST
        for adapter in registry.list_adapters()
    )
    assert any(
        getattr(adapter, "manifest", None) is DINGTALK_MANIFEST
        for adapter in registry.list_adapters()
    )
    assert any(
        getattr(adapter, "manifest", None) is FIGMA_MANIFEST
        for adapter in registry.list_adapters()
    )
    report.ctx.unload()
    assert registry.list_adapters() == []
