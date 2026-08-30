"""Skill writer: closes Hermes' self-evolution loop (agent writes its own skills).

Hermes' edge is that the agent distills recurring lessons into skill files and
its own future sessions pick them up. MP already had the read side
(:class:`~app.agent_runtime.memory.SkillLoader` injects relevant skills from
``<user_data>/skills``); this adds the write side: one ``save_skill`` tool the
model calls to persist a distilled procedure. Next turn, the loader routes it
back in by token overlap — no extra machinery.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_skill_writer"]

_SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_MAX_SKILL_CHARS = 12_000


def register_skill_writer(registry: ToolRegistry, *, skills_root: Path | str) -> None:
    # 旧名别名（一个版本）：历史授权/旧调用仍路由到规范工具；别名不进 schema。
    registry.register_alias("save_skill", "SaveSkill")
    root = Path(skills_root)

    def save_skill(name: str, content: str, overwrite: bool = False, **_: Any) -> str:
        skill_name = str(name or "").strip()
        if not _SKILL_NAME.fullmatch(skill_name):
            raise ValueError(
                f"skill name {skill_name!r} must be kebab-case (a-z0-9, dashes)"
            )
        body = str(content or "").strip()
        if not body:
            raise ValueError("content is required")
        if len(body) > _MAX_SKILL_CHARS:
            raise ValueError(
                f"skill too large ({len(body)} chars; cap {_MAX_SKILL_CHARS}) — "
                "distill the procedure, do not archive the transcript"
            )
        match = _FRONTMATTER.match(body)
        frontmatter = match.group(1) if match else ""
        if "description:" not in frontmatter:
            raise ValueError(
                "content must start with YAML frontmatter containing at least "
                "'name:' and 'description:' lines between --- markers"
            )
        target = root / skill_name / "SKILL.md"
        if target.exists() and not overwrite:
            raise ValueError(
                f"skill {skill_name!r} already exists; pass overwrite=true to replace it"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body.rstrip() + "\n", encoding="utf-8", newline="\n")
        return (
            f"saved skill {skill_name!r} to {target}; it will be injected "
            "automatically when a future command matches its description"
        )

    registry.register(ToolSpec(
        name="SaveSkill",
        description=(
            "把一条可复用的经验沉淀成 skill 文件（何时做某类任务、步骤、坑）。"
            "名字用 kebab-case，content 以 YAML frontmatter 开头（必须有 "
            "name 和 description）。之后相关任务会自动注入这条 skill。"
            "只在确实可复用时保存，不要存一次性任务的流水账。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "kebab-case 技能名"},
                "content": {"type": "string", "description": "完整 SKILL.md 内容（含 frontmatter）"},
                "overwrite": {"type": "boolean", "description": "覆盖同名技能，默认 false"},
            },
            "required": ["name", "content"],
        },
        execute=save_skill,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=False,
        used_backend="workspace_fs",
        timeout_ms=10_000,
        deferred=True,  # 经验沉淀是低频动作
    ))
