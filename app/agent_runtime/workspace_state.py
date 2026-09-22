
from __future__ import annotations

from pathlib import Path

__all__ = ["read_workspace", "write_workspace"]


def _state_path(root: Path) -> Path:
    return Path(root) / "data" / "runtime" / "workspace.txt"


def read_workspace(root: Path) -> Path:
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
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_dir():
        raise NotADirectoryError(str(resolved))
    state = _state_path(root)
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(str(resolved), encoding="utf-8")
    return resolved
