"""本机 skill 发现（DSH skill-filesystem 的 MP 等价物）。

根与排序对照 deepseek-harness：``<project>/.dsh/skills``、``<project>/.agents/skills``
先于用户级 ``~/.dsh/skills``、``~/.agents/skills``（项目同名 skill 覆盖用户级）。
SKILL.md 解析：YAML frontmatter 必须有 name（kebab-case）与 description；
``user-invocable: false`` 的不进人类目录。正文加载剥掉 frontmatter。
"""

from __future__ import annotations

from pathlib import Path

from app.agent_runtime.skill_catalog import SkillCatalog


def _write_skill(root: Path, name: str, description: str, body: str = "# 内容", extra: str = "") -> None:
    directory = root / name
    directory.mkdir(parents=True, exist_ok=True)
    front = f"---\nname: {name}\ndescription: {description}\n{extra}---\n\n"
    (directory / "SKILL.md").write_text(front + body, encoding="utf-8")


def _catalog(tmp_path: Path) -> SkillCatalog:
    project = tmp_path / "project"
    user = tmp_path / "user"
    for sub in (".dsh/skills", ".agents/skills"):
        (project / sub).mkdir(parents=True, exist_ok=True)
    for sub in (".dsh/skills", ".agents/skills"):
        (user / sub).mkdir(parents=True, exist_ok=True)
    return SkillCatalog(project_root=project, user_home=user)


def test_scan_lists_all_roots_in_rank_order(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    _write_skill(catalog.project_root / ".agents" / "skills", "project-skill", "项目级")
    _write_skill(catalog.user_home / ".dsh" / "skills", "user-dsh-skill", "用户 dsh")
    _write_skill(catalog.user_home / ".agents" / "skills", "user-agents-skill", "用户 agents")
    entries = catalog.list_skills()
    by_name = {entry["name"]: entry for entry in entries}
    assert set(by_name) == {"project-skill", "user-dsh-skill", "user-agents-skill"}
    assert by_name["project-skill"]["source"] == "project-agents"
    assert by_name["user-dsh-skill"]["source"] == "user-dsh"
    assert by_name["user-agents-skill"]["source"] == "user-agents"


def test_project_overrides_user_on_name_clash(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    _write_skill(catalog.project_root / ".dsh" / "skills", "dup-skill", "项目版")
    _write_skill(catalog.user_home / ".agents" / "skills", "dup-skill", "用户版")
    entries = catalog.list_skills()
    assert len(entries) == 1
    assert entries[0]["description"] == "项目版"
    assert entries[0]["source"] == "project-dsh"


def test_invalid_skills_are_skipped_not_fatal(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    skills = catalog.user_home / ".agents" / "skills"
    _write_skill(skills, "good-skill", "正常")
    (skills / "no-frontmatter").mkdir(parents=True, exist_ok=True)
    (skills / "no-frontmatter" / "SKILL.md").write_text("# 没有 frontmatter", encoding="utf-8")
    (skills / "bad-name").mkdir(parents=True, exist_ok=True)
    (skills / "bad-name" / "SKILL.md").write_text(
        "---\nname: BadName\ndescription: 名字不是 kebab-case\n---\n\n# 内容", encoding="utf-8")
    (skills / "missing-desc").mkdir(parents=True, exist_ok=True)
    (skills / "missing-desc" / "SKILL.md").write_text(
        "---\nname: missing-desc\n---\n\n# 内容", encoding="utf-8")
    entries = catalog.list_skills()
    assert [entry["name"] for entry in entries] == ["good-skill"]


def test_user_invocable_false_hidden_from_human_catalog(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    skills = catalog.user_home / ".agents" / "skills"
    _write_skill(skills, "hidden-skill", "模型可调", extra="user-invocable: false\n")
    _write_skill(skills, "visible-skill", "都能调")
    entries = catalog.list_skills()
    assert [entry["name"] for entry in entries] == ["visible-skill"]
    # 但正文仍可加载（/hidden-skill 显式点名仍然给）
    body = catalog.load_skill_body("hidden-skill")
    assert body and "模型可调" not in body and "# 内容" in body


def test_load_skill_body_strips_frontmatter(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    _write_skill(catalog.user_home / ".agents" / "skills", "loader-skill", "描述", body="# 正文标题\n\n细节")
    body = catalog.load_skill_body("loader-skill")
    assert body.startswith("# 正文标题")
    assert "name: loader-skill" not in body
    assert catalog.load_skill_body("no-such-skill") is None


def test_when_to_use_carried_through(tmp_path: Path) -> None:
    catalog = _catalog(tmp_path)
    skills = catalog.user_home / ".agents" / "skills"
    _write_skill(skills, "guided-skill", "描述", extra="whenToUse: 用户想深讲一个知识点时\n")
    entry = next(e for e in catalog.list_skills() if e["name"] == "guided-skill")
    assert entry["whenToUse"] == "用户想深讲一个知识点时"
