"""斜杠目录：作曲家 ``+`` 菜单背后的命令 + 技能清单。

DSH 的 ``+`` 打开的是 input-trigger 菜单（命令 / 技能 / 子智能体分组）。
MP 的等价物：命令只列真实现的（permission / model）；技能来自
:mod:`app.agent_runtime.skill_catalog` 的本机扫描。选中即把 ``/name `` 插入
草稿，提交后由 :mod:`scripts.conversation_bridge.route_slash_command` 结算。
"""

from __future__ import annotations

from pathlib import Path

__all__ = ["SLASH_COMMANDS", "directory_payload"]

# 命令目录：名字 → 一句话说明。只列 bridge 真的路由的命令。
SLASH_COMMANDS: dict[str, str] = {
    "permission": "切换权限预设（sandbox × approval 捆绑档）",
    "model": "切换默认模型（写 secrets/model.txt，立即生效）",
    "cwd": "查看/设置编码工作区目录（coding tools 的沙箱根）",
    "rewind": "回滚 agent 对文件的最近改动（checkpoint 恢复，可带步数）",
}


def directory_payload(project_root: Path | None = None, user_home: Path | None = None) -> dict:
    """``+`` 菜单的一次性载荷：命令组 + 技能组（按名字排序）。"""
    from app.agent_runtime.skill_catalog import SkillCatalog

    catalog = SkillCatalog(project_root=project_root, user_home=user_home)
    skills = catalog.list_skills()
    return {
        "ok": True,
        "commands": [
            {"name": name, "description": description}
            for name, description in SLASH_COMMANDS.items()
        ],
        "skills": skills,
        "errors": catalog.errors,
    }
