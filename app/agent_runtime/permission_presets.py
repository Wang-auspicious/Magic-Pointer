"""DSH 式权限预设：sandbox 模式 × 审批策略两个旋钮的预设捆绑。

对照 deepseek-harness ``packages/interaction/permission-presets``：预设表把
(``sandbox/mode``, ``approval/policy``) 两个独立旋钮捆成一个用户可切换的
档位；``custom`` 是折叠态不匹配任何预设时的派生展示态，永远不是切换目标；
``danger-full-access`` 带显式确认门。MP 的执行语义仍在
:mod:`app.agent_runtime.permission_modes` 的效果表里——这一层只做预设↔效果
档的映射，loop 照旧消费 ``PermissionMode``。
"""

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
    """一个预设捆绑的 sandbox/approval 旋钮值与展示元数据。"""

    sandbox: str
    approval: str
    name: str
    description: str
    confirm: bool = False


PRESETS: dict[str, PermissionPresetSpec] = {
    "plan": PermissionPresetSpec(
        sandbox="workspace-write",
        approval="ask",
        name="计划模式",
        description="先列出计划再逐步执行；进度实时显示，做完一项划掉一项。",
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

# 预设 → MP 效果表档位。plan 落 PLAN（读直行、写问、destructive/purchase 拒）；
# read-only 落 SAFE（读直行、其余全问）；
# workspace-write 落 DEFAULT（可逆写在环内、不可逆问）；danger-full-access
# 落 BYPASS（购买仍问——那是 MP 自己的红线，不在 DSH 语义内）。
_PRESET_MODES: dict[str, PermissionMode] = {
    # 计划模式的"先计划后执行"是提示契约（todo_write 列步骤→立即执行→逐步更新），
    # 不是效果门——Codex update_plan 就是这么做的。
    "plan": PermissionMode.DEFAULT,
    "read-only": PermissionMode.SAFE,
    "workspace-write": PermissionMode.DEFAULT,
    "danger-full-access": PermissionMode.BYPASS,
}


def resolve_preset(name: str) -> PermissionPresetSpec:
    """解析一个预设名；未知名（含 ``custom``）抛 ``KeyError``。"""
    return PRESETS[name]


def mode_for_preset(name: str) -> PermissionMode:
    """预设 → 效果表档位；``custom`` 与未知名不是切换目标。"""
    return _PRESET_MODES[name]


def preset_select(current: str) -> dict:
    """渲染层下拉的完整载荷：预设表全部选项 + 当前值。

    ``current`` 可以是预设名或 ``custom``（后者会把 custom 追加进选项列表，
    仅作当前态展示）。
    """
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
