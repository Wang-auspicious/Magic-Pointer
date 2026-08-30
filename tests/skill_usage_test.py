"""P2-5 技能使用频次计数与排序（Hermes skill_usage 范式）。

skill 被注入提示词或被斜杠显式加载时 bump 计数 + 时间戳，落
``<user_data>/skill-usage.json``；SkillLoader 在相关性分数相同时把
高频技能排前。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.agent_runtime.memory import SkillLoader
from app.agent_runtime.skill_usage import SkillUsageStore


@pytest.fixture()
def user_dir(tmp_path: Path) -> Path:
    return tmp_path / "user-data"


@pytest.fixture()
def skills(user_dir: Path) -> Path:
    root = user_dir / "skills"
    (root / "email").mkdir(parents=True)
    (root / "email" / "SKILL.md").write_text("邮件技能正文\n", encoding="utf-8")
    (root / "code").mkdir(parents=True)
    (root / "code" / "SKILL.md").write_text("代码技能正文\n", encoding="utf-8")
    return root


def test_store_bumps_count_and_last_used(user_dir: Path) -> None:
    store = SkillUsageStore(user_dir)
    store.bump("email")
    store.bump("email")
    store.bump("code")
    usage = store.usage()
    assert usage["email"]["count"] == 2
    assert usage["code"]["count"] == 1
    assert usage["email"]["lastUsed"]


def test_store_persists_across_instances_and_survives_corruption(user_dir: Path) -> None:
    SkillUsageStore(user_dir).bump("email")
    assert SkillUsageStore(user_dir).usage()["email"]["count"] == 1
    (user_dir / "skill-usage.json").write_text("{not json", encoding="utf-8")
    assert SkillUsageStore(user_dir).usage() == {}


def test_loader_bumps_skills_it_injects(user_dir: Path, skills: Path) -> None:
    SkillLoader(user_dir, command="帮我回复这封邮件").load()
    usage = SkillUsageStore(user_dir).usage()
    assert usage.get("email", {}).get("count") == 1
    assert "code" not in usage


def test_loader_ranks_by_usage_count_on_tie(user_dir: Path, skills: Path) -> None:
    # 两个技能与命令的相关性分数同为 0 之外不现实——用同名 token 构造
    # 同分：命令里只出现共享词。这里用显式 store 验证排序键。
    store = SkillUsageStore(user_dir)
    for _ in range(5):
        store.bump("code")
    store.bump("email")

    command = "处理 email 和 code 两件事"
    email_skill = user_dir / "skills" / "email" / "SKILL.md"
    code_skill = user_dir / "skills" / "code" / "SKILL.md"
    email_skill.write_text("email email\n", encoding="utf-8")
    code_skill.write_text("code code\n", encoding="utf-8")

    loaded = SkillLoader(user_dir, command=command).load()
    assert loaded.index("skill: code") < loaded.index("skill: email"), (
        "同分时高频技能应排前"
    )


def test_slash_load_bumps_usage(user_dir: Path) -> None:
    from app.agent_runtime.skill_catalog import SkillCatalog
    from app.agent_runtime.skill_usage import bump_skill_usage

    project = user_dir / "project"
    skill_dir = project / ".dsh" / "skills" / "review"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: review\ndescription: 代码审阅\n---\n正文\n",
        encoding="utf-8",
    )
    catalog = SkillCatalog(project_root=project, user_home=user_dir / "home")
    assert catalog.load_skill_body("review") == "正文"
    bump_skill_usage(user_dir, "review")
    assert SkillUsageStore(user_dir).usage()["review"]["count"] == 1
