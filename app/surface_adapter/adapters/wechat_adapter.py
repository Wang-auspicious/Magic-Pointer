"""WeChat public-surface adapter with honest chat semantics.

The Windows client may expose either a bounded UIA subtree or only a painted
message pane. UIA text is emitted in visual order, but unavailable message
semantics stay blank and explicitly request visual observation.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from app.adapters.uia_text_adapter import _run_uia_selection_probe
from app.surface_adapter.manifest import SurfaceAdapterManifest
from app.surface_adapter.protocol import RawObject, ResolveResult, SurfaceResolver

__all__ = ["WeChatSurfaceAdapter", "WECHAT_MANIFEST"]

WECHAT_MANIFEST = SurfaceAdapterManifest(
    id="wechat",
    display_name="微信",
    app_ids=("wechat.exe", "weixin.exe", "wechatappex.exe"),
    window_class_patterns=("wechatmainwndforpc", "wechat_ui_main"),
    title_patterns=("微信", "wechat"),
    object_kinds=("conversation", "chat_message", "message_list", "attachment"),
    capabilities=(
        "read_raw_objects",
        "read_current_conversation",
        "read_visible_history",
        "discover_attachments",
    ),
    notes="公开桌面界面适配；UIA 缺少消息语义时保留区域锚点并请求视觉观察。",
)


def _optional_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _rect(value: Any) -> tuple[int, int, int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        result = tuple(int(round(float(item))) for item in value)
    except (TypeError, ValueError):
        return None
    if result[2] <= 0 or result[3] <= 0:
        return None
    return result


def _conversation_identity(
    adapter_id: str,
    window: Mapping[str, Any],
    probe_data: Mapping[str, Any],
) -> dict[str, Any]:
    hwnd = int(window.get("hwnd") or 0)
    native_id = _optional_text(
        window.get("nativeConversationId")
        or window.get("conversation_id")
        or probe_data.get("native_conversation_id")
    )
    account_key = _optional_text(
        window.get("accountKey")
        or window.get("account_id")
        or probe_data.get("account_key")
    )
    surface_id = _optional_text(
        probe_data.get("conversation_surface_id")
        or probe_data.get("automation_id")
    )
    if native_id:
        conversation_key = f"{account_key}:{native_id}" if account_key else native_id
        provenance = "native"
    else:
        # This binds the observed app/window surface; it does not claim the app
        # exposed a native conversation id. HWND keeps equal titles distinct.
        conversation_key = f"{adapter_id}:window:{hwnd}:surface:{surface_id or 'root'}"
        provenance = "window-surface"
    return {
        "adapterId": adapter_id,
        "conversationKey": conversation_key,
        "keyProvenance": provenance,
        "nativeConversationId": native_id,
        "accountKey": account_key,
        "windowHwnd": hwnd,
        "processId": int(window.get("process_id") or window.get("pid") or 0) or None,
        "surfaceRuntimeId": surface_id,
        "title": _optional_text(
            probe_data.get("conversation_title") or window.get("title")
        ),
        "type": _optional_text(
            probe_data.get("conversation_type") or window.get("conversation_type")
        ),
    }


class WeChatSurfaceAdapter(SurfaceResolver):
    """Resolve a WeChat chat surface; subclasses can reuse the contract."""

    manifest = WECHAT_MANIFEST
    adapter_id = "wechat"
    display_name = "微信"

    def matches(self, window: dict[str, Any]) -> bool:
        return self.manifest.matches_window(window)

    def conversation_identity(self, window: Mapping[str, Any]) -> dict[str, Any]:
        """Bind a frozen window record without performing another live read."""
        return _conversation_identity(self.adapter_id, window, {})

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
            probe = _run_uia_selection_probe(
                hwnd,
                target_point=target_point,
                target_region=target_region,
                timeout=3.0,
            )
        except Exception as exc:
            probe = None
            notes.append(f"probe_failed:{type(exc).__name__}")
        data = dict(getattr(probe, "data", {}) or {})
        identity = _conversation_identity(self.adapter_id, window, data)
        objects: list[RawObject] = [RawObject(
            id=f"{self.adapter_id}-conversation-surface",
            kind="conversation",
            label=f"当前{self.display_name}会话",
            text=str(identity.get("title") or ""),
            rect_xywh=None,
            order_index=0,
            confidence=0.9 if identity.get("nativeConversationId") else 0.7,
            evidence=(
                "uia:native_conversation_identity"
                if identity.get("nativeConversationId")
                else "window:surface_binding"
            ),
            fields={"conversationIdentity": identity},
        )]

        raw_elements = [
            dict(item) for item in list(data.get("region_elements") or ())
            if isinstance(item, Mapping) and str(item.get("text") or "").strip()
        ]
        raw_elements.sort(key=lambda item: (
            (_rect(item.get("rect")) or (0, 0, 0, 0))[1],
            (_rect(item.get("rect")) or (0, 0, 0, 0))[0],
        ))
        if getattr(probe, "ok", False) and raw_elements:
            for visible_index, item in enumerate(raw_elements):
                automation_id = _optional_text(item.get("automation_id"))
                native_message_id = _optional_text(item.get("native_message_id"))
                speaker = _optional_text(item.get("speaker"))
                timestamp = _optional_text(item.get("time"))
                reply_to = _optional_text(item.get("reply_to"))
                raw_attachments = item.get("attachments")
                attachments = (
                    [copy.deepcopy(dict(value)) for value in raw_attachments if isinstance(value, Mapping)]
                    if isinstance(raw_attachments, list)
                    else []
                )
                missing = [
                    field for field, value in (
                        ("speaker", speaker),
                        ("time", timestamp),
                        ("nativeMessageId", native_message_id),
                    )
                    if value is None
                ]
                objects.append(RawObject(
                    # Visible order is an object-graph anchor, not a native id.
                    id=f"{self.adapter_id}-visible-message-{visible_index}",
                    kind="chat_message",
                    label="可见消息",
                    text=str(item.get("text") or "").strip(),
                    rect_xywh=_rect(item.get("rect")),
                    order_index=visible_index + 1,
                    confidence=0.9 if not missing else 0.6,
                    evidence="uia:region_element",
                    fields={
                        "conversationIdentity": identity,
                        "visibleObjectId": automation_id,
                        "idProvenance": "uia-automation" if automation_id else "visible-order",
                        "nativeMessageId": native_message_id,
                        "speaker": speaker,
                        "time": timestamp,
                        "replyTo": reply_to,
                        "attachment": attachments[0] if len(attachments) == 1 else None,
                        "attachments": attachments,
                        "requiresVisualObservation": bool(missing),
                        "missingSemantics": missing,
                    },
                ))
            notes.append("ordered_uia_elements_exposed")
        else:
            text = str(data.get("text") or "").strip()
            if getattr(probe, "ok", False) and text:
                objects.append(RawObject(
                    id=f"{self.adapter_id}-container",
                    kind="message_list",
                    label="消息列表（UIA 容器子树）",
                    text=text[:4000],
                    rect_xywh=None,
                    order_index=1,
                    confidence=0.55,
                    evidence="uia:container",
                    fields={
                        "conversationIdentity": identity,
                        "requiresVisualObservation": True,
                        "missingSemantics": [
                            "orderedMessages", "speaker", "time", "replyTo", "attachments",
                        ],
                    },
                ))
                notes.append("container_uia_exposed_without_message_semantics")
            else:
                objects.append(RawObject(
                    id=f"{self.adapter_id}-list-region",
                    kind="message_list",
                    label="消息列表区域（像素证据）",
                    text="",
                    rect_xywh=None,
                    order_index=1,
                    confidence=0.5,
                    evidence="pixel:region_anchor",
                    fields={
                        "conversationIdentity": identity,
                        "requiresVisualObservation": True,
                        "missingSemantics": [
                            "orderedMessages", "speaker", "time", "replyTo", "attachments",
                        ],
                    },
                ))
                notes.append("opaque_tree_region_anchor")
        return ResolveResult(
            adapter_id=self.adapter_id,
            objects=tuple(objects),
            window=dict(window),
            notes=tuple(notes),
        )
