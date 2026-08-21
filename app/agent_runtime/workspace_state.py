"""Studio 工作区状态：编码工具绑定的根目录，跨回合持久。

Codex/CC 的核心产品语义之一是“agent 在哪个仓库里工作”。MP 的等价物：
``/cwd <path>`` 把工作区写进 ``<runtime>/workspace.txt``，之后每个对话回合
的 coding tools 都沙箱限定在这个目录；没有设置过就回落到进程 cwd（开发树
里即仓库根，安装版里即用户启动目录）。
"""

from __future__ import annotations

from pathlib import Path

__all__ = ["read_workspace", "write_workspace"]


def _state_path(root: Path) -> Path:
    return Path(root) / "data" / "runtime" / "workspace.txt"


def read_workspace(root: Path) -> Path:
    """当前工作区；从未设置或路径已消失时回落 cwd。"""
    state = _state_path(root)
    try:
        raw = state.read_text(encoding="utf-8").strip()
    except OSError:
        raw = ""
    if raw:
        candidate = Path(raw)
        if candidate.is_dir():
            return candidate
    return Path.cwd()


def write_workspace(root: Path, path: Path) -> Path:
    """校验并持久化工作区目录；返回规范化路径。目录不存在直接抛错。"""
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_dir():
        raise NotADirectoryError(str(resolved))
    state = _state_path(root)
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(str(resolved), encoding="utf-8")
    return resolved
