"""WeChat SurfaceAdapter (design §8 sample adapter).

WeChat 4.x is the canonical self-drawn app: its UIA tree is an opaque
container, PrintWindow fails, and the message list is pixel-only. This
adapter owns that surface:

- ``matches``: process name (WeChat.exe / Weixin.exe / WeChatAppEx) or
  the known window class / title pattern;
- ``resolve``: tries the container's UIA text/child elements first (some
  builds expose an accessibility subtree); when the tree is opaque it
  returns **one raw region object** anchored at the message list area with
  empty text — the caller merges OCR/vision evidence onto that anchor and
  the object graph stays the anchor for ordered message semantics.

Honest limits recorded in ``notes``: nothing here pretends to have
ordered per-message objects when the accessibility subtree is absent.
"""

from __future__ import annotations

from typing import Any

from app.adapters.uia_text_adapter import _run_uia_selection_probe
from app.surface_adapter.manifest import SurfaceAdapterManifest
from app.surface_adapter.protocol import RawObject, ResolveResult, SurfaceResolver

__all__ = ["WeChatSurfaceAdapter", "WECHAT_MANIFEST"]

WECHAT_MANIFEST = SurfaceAdapterManifest(
    id="wechat",
    display_name="微信",
    app_ids=("wechat.exe", "weixin.exe", "wechatappex.exe", "wechat"),
    window_class_patterns=("wechatmainwndforpc", "wechat_ui_main"),
    title_patterns=("微信", "wechat"),
    object_kinds=("chat_message", "message_list"),
    capabilities=("read_raw_objects",),
    notes=(
        "自绘应用样例：UIA 树不透明时返回列表区域原始对象，"
        "OCR/视觉证据叠加在该锚点上。"
    ),
)


class WeChatSurfaceAdapter:
    """The WeChat surface: container UIA when present, list-area anchor otherwise."""

    manifest = WECHAT_MANIFEST

    def matches(self, window: dict[str, Any]) -> bool:
        return WECHAT_MANIFEST.matches_window(window)

    def resolve(
        self,
        window: dict[str, Any],
        target_point: dict[str, int] | None,
        target_region: dict[str, int] | None,
    ) -> ResolveResult | None:
        hwnd = int(window.get("hwnd") or 0)
        notes: list[str] = []
        if not hwnd:
            return None
        try:
            probe = _run_uia_selection_probe(hwnd, target_point=target_point, timeout=3.0)
        except Exception as exc:
            probe = None
            notes.append(f"probe_failed:{type(exc).__name__}")
        if probe is not None and probe.ok:
            text = str(probe.data.get("text") or "").strip()
            if text:
                objects = (
                    RawObject(
                        id="wechat-container",
                        kind="message_list",
                        label="消息列表（UIA 容器子树）",
                        text=text[:4000],
                        rect_xywh=None,
                        order_index=0,
                        confidence=0.9,
                        evidence="uia:container",
                    ),
                )
                notes.append("container_uia_exposed")
                return ResolveResult(
                    adapter_id="wechat",
                    objects=objects,
                    window=dict(window),
                    notes=tuple(notes),
                )
        # Opaque tree: anchor the raw list region; pixel evidence (OCR/vision)
        # merges onto this anchor, the object graph keeps order semantics.
        objects = (
            RawObject(
                id="wechat-list-region",
                kind="message_list",
                label="消息列表区域（像素证据）",
                text="",
                rect_xywh=None,
                order_index=0,
                confidence=0.5,
                evidence="pixel:region_anchor",
            ),
        )
        notes.append("opaque_tree_region_anchor")
        return ResolveResult(
            adapter_id="wechat",
            objects=objects,
            window=dict(window),
            notes=tuple(notes),
        )
