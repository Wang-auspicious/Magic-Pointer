"""DingTalk public desktop-surface adapter."""

from __future__ import annotations

from app.surface_adapter.manifest import SurfaceAdapterManifest

from .wechat_adapter import WeChatSurfaceAdapter

__all__ = ["DingTalkSurfaceAdapter", "DINGTALK_MANIFEST"]

DINGTALK_MANIFEST = SurfaceAdapterManifest(
    id="dingtalk",
    display_name="钉钉",
    app_ids=("dingtalk.exe", "dingtalklite.exe"),
    window_class_patterns=("standardframe_ding", "dingtalk"),
    title_patterns=("钉钉", "dingtalk"),
    object_kinds=("conversation", "chat_message", "message_list", "attachment"),
    capabilities=(
        "read_raw_objects",
        "read_current_conversation",
        "read_visible_history",
        "discover_attachments",
    ),
    notes="公开桌面界面适配；不读取或解密客户端私有数据库。",
)


class DingTalkSurfaceAdapter(WeChatSurfaceAdapter):
    manifest = DINGTALK_MANIFEST
    adapter_id = "dingtalk"
    display_name = "钉钉"
