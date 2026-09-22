
from __future__ import annotations

from dataclasses import dataclass

from app.agent_runtime.permission_modes import PermissionMode

__all__ = [
    "APPROVAL_POLICIES",
    "CUSTOM_PRESET",
    "PRESETS",
    "SANDBOX_MODES",
    "PermissionPresetSpec",
    "mode_for_preset",
    "preset_select",
    "resolve_preset",
]


SANDBOX_MODES = ("read-only", "workspace-write", "danger-full-access")
APPROVAL_POLICIES = ("ask", "never")

CUSTOM_PRESET = "custom"

CONFIRM_TITLE = "确认启用 Full access？"
CONFIRM_DESCRIPTION = (
    "启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，"
    "包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。"
)


@dataclass(frozen=True)
class PermissionPresetSpec:

    sandbox: str
    approval: str
    name: str
    description: str
    confirm: bool = False


PRESETS: dict[str, PermissionPresetSpec] = {
    "auto": PermissionPresetSpec(
        sandbox="workspace-write",
        approval="never",
        name="自动",
        description="可逆的写入直接执行，不可逆的操作和越出工作区的动作仍然会问。",
    ),
    "plan": PermissionPresetSpec(
        sandbox="workspace-write",
        approval="ask",
        name="计划模式",
        description="只读研究并提出计划；用户批准退出计划模式后才能修改。",
    ),
    "read-only": PermissionPresetSpec(
        sandbox="read-only",
        approval="ask",
        name="只读",
        description="只允许读取；任何写入、发送或删除都要先经你确认。",
    ),
    "workspace-write": PermissionPresetSpec(
        sandbox="workspace-write",
        approval="ask",
        name="工作区写入",
        description="工作区内可逆写入直接执行；更大范围的重试需要确认。",
    ),
    "danger-full-access": PermissionPresetSpec(
        sandbox="danger-full-access",
        approval="never",
        name="完全访问",
        description="完整文件访问，不再弹出确认提示。",
        confirm=True,
    ),
}

_PRESET_MODES: dict[str, PermissionMode] = {
    "auto": PermissionMode.ACCEPT_REVERSIBLE,
    "plan": PermissionMode.PLAN,
    "read-only": PermissionMode.SAFE,
    "workspace-write": PermissionMode.DEFAULT,
    "danger-full-access": PermissionMode.BYPASS,
}


def resolve_preset(name: str) -> PermissionPresetSpec:
    return PRESETS[name]


def mode_for_preset(name: str) -> PermissionMode:
    return _PRESET_MODES[name]


def preset_select(current: str) -> dict:
    options = [
        {
            "value": name,
            "name": spec.name,
            "description": spec.description,
            **({"confirmTitle": CONFIRM_TITLE, "confirmDescription": CONFIRM_DESCRIPTION} if spec.confirm else {}),
        }
        for name, spec in PRESETS.items()
    ]
    if current == CUSTOM_PRESET:
        options.append({
            "value": CUSTOM_PRESET,
            "name": "自定义",
            "description": "当前权限设置不匹配任何预设。",
        })
    return {"options": options, "currentValue": current}
