
from __future__ import annotations

import os
import pathlib
import tempfile

_ORIGINAL_PATH_MKDIR = pathlib.Path.mkdir
_ORIGINAL_OS_MKDIR = os.mkdir


def _mkdir_with_listable_mode(self, mode=0o777, parents=False, exist_ok=False):  # noqa: B008
    return _ORIGINAL_PATH_MKDIR(self, 0o777, parents=parents, exist_ok=exist_ok)


def _os_mkdir_with_listable_mode(path, mode=0o777, *args, **kwargs):  # noqa: B008
    return _ORIGINAL_OS_MKDIR(path, 0o777, *args, **kwargs)


pathlib.Path.mkdir = _mkdir_with_listable_mode  # type: ignore[method-assign]
os.mkdir = _os_mkdir_with_listable_mode  # type: ignore[assignment]

_ROOT = pathlib.Path(__file__).resolve().parent


def _default_basetemp_root() -> pathlib.Path:
    try:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    except Exception:  # noqa: BLE001 - environment probing is best-effort
        user = "unknown"
    return pathlib.Path(tempfile.gettempdir()) / f"pytest-of-{user}"


def _is_unusable(path: pathlib.Path) -> bool:
    if not path.exists():
        return False
    try:
        next(os.scandir(path), None)
    except OSError:
        return True
    return False


def pytest_configure(config) -> None:
    if config.option.basetemp:
        return
    if not _is_unusable(_default_basetemp_root()):
        return
    fallback = _ROOT / ".pytest-tmp" / f"basetemp-{os.getpid()}"
    fallback.parent.mkdir(parents=True, exist_ok=True)
    config.option.basetemp = str(fallback)
