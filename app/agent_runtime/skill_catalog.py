"""本机 skill 发现：deepseek-harness skill-filesystem 的 MP 等价物。

根与排序对照 DSH：项目级（``<project>/.dsh/skills``、``<project>/.agents/skills``）
先于用户级（``~/.dsh/skills``、``~/.agents/skills``），同名取第一个（项目覆盖
用户）。SKILL.md 需要 YAML frontmatter 的 ``name``（kebab-case）与
``description``；``user-invocable: false`` 只藏出人类目录，正文仍可显式加载。
解析失败的目录跳过并记原因，不让一个坏 skill 毁掉整次扫描。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

__all__ = ["SkillCatalog", "skill_roots"]

SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


@dataclass(frozen=True)
class _Root:
    path: Path
    source: str


def skill_roots(
    project_root: Path | None = None,
    user_home: Path | None = None,
    *,
    include_project: bool = True,
) -> list[_Root]:
    """DSH 同款发现根，按优先级排序（项目先于用户）。"""
    from pathlib import Path as _Path

    home = _Path(user_home) if user_home is not None else _Path.home()
    roots: list[_Root] = []
    if include_project:
        project = _Path(project_root) if project_root is not None else _Path.cwd()
        roots.extend([
            _Root(project / ".dsh" / "skills", "project-dsh"),
            _Root(project / ".agents" / "skills", "project-agents"),
        ])
    roots.extend([
        _Root(home / ".dsh" / "skills", "user-dsh"),
        _Root(home / ".agents" / "skills", "user-agents"),
    ])
    return roots


class SkillCatalog:
    """扫描 DSH 兼容根并解析 SKILL.md。"""

    def __init__(
        self,
        project_root: Path | None = None,
        user_home: Path | None = None,
        *,
        include_project: bool = True,
    ) -> None:
        self.project_root = Path(project_root) if project_root is not None else Path.cwd()
        self.user_home = Path(user_home) if user_home is not None else Path.home()
        self._roots = skill_roots(
            project_root,
            user_home,
            include_project=include_project,
        )
        # name → (root, path)：第一个根胜出（项目覆盖用户）。惰性扫描。
        self._resolved: dict[str, tuple[_Root, Path]] | None = None
        self._errors: list[str] = []

    def _scan(self) -> dict[str, tuple[_Root, Path]]:
        if self._resolved is not None:
            return self._resolved
        resolved: dict[str, tuple[_Root, Path]] = {}
        for root in self._roots:
            if not root.path.is_dir():
                continue
            try:
                children = sorted(root.path.iterdir())
            except OSError as exc:
                self._errors.append(f"{root.path}: {exc}")
                continue
            for child in children:
                if not child.is_dir():
                    continue
                skill_file = child / "SKILL.md"
                if not skill_file.is_file():
                    continue
                parsed = self._parse(skill_file)
                if parsed is None:
                    continue
                name, record = parsed
                if record.get("_invalid"):
                    self._errors.append(f"{skill_file}: {record['_invalid']}")
                    continue
                resolved.setdefault(name, (root, skill_file))
        self._resolved = resolved
        return resolved

    # -- 解析 -------------------------------------------------------------

    def _parse(self, path: Path) -> tuple[str, dict] | None:
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            return None
        match = FRONTMATTER.match(raw)
        if match is None:
            return path.parent.name, {"_invalid": "缺少 YAML frontmatter"}
        try:
            data = yaml.safe_load(match.group(1)) or {}
        except yaml.YAMLError as exc:
            return path.parent.name, {"_invalid": f"frontmatter 不是合法 YAML：{exc}"}
        if not isinstance(data, dict):
            return path.parent.name, {"_invalid": "frontmatter 不是键值表"}
        name = str(data.get("name") or "").strip()
        description = str(data.get("description") or "").strip()
        if not name or not description:
            return path.parent.name, {"_invalid": "frontmatter 需要 name 与 description"}
        if not SKILL_NAME.match(name):
            return name, {"_invalid": f"名字不是 kebab-case：{name}"}
        record: dict = {"description": description}
        when_to_use = str(data.get("whenToUse") or "").strip()
        if when_to_use:
            record["whenToUse"] = when_to_use
        user_invocable = data.get("user-invocable")
        if user_invocable is False or user_invocable in ("false", "no", "off", 0, "0"):
            record["userInvocable"] = False
        return name, record

    # -- 对外 -------------------------------------------------------------

    def list_skills(self, user_only: bool = True) -> list[dict]:
        """目录条目（按名字排序）。``user_only=False`` 连 user-invocable:false 也带出。"""
        rows: list[dict] = []
        for name, (root, path) in sorted(self._scan().items()):
            record = self._parse(path)  # 重读保持简单：目录不大，正确优先
            if record is None:
                continue
            _, data = record
            if data.get("_invalid"):
                continue
            if user_only and data.get("userInvocable") is False:
                continue
            rows.append({
                "name": name,
                "description": str(data.get("description") or ""),
                **({"whenToUse": data["whenToUse"]} if data.get("whenToUse") else {}),
                "source": root.source,
                "path": str(path),
            })
        return rows

    def load_skill_body(self, name: str) -> str | None:
        """加载并剥掉 frontmatter 的正文；未知名字返回 None。"""
        resolved = self._scan().get(str(name or "").strip())
        if resolved is None:
            return None
        _root, path = resolved
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            return None
        match = FRONTMATTER.match(raw)
        body = raw[match.end():] if match else raw
        return body.strip()

    @property
    def errors(self) -> list[str]:
        return list(self._errors)
