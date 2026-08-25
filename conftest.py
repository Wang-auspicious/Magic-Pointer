"""Root pytest configuration.

Environment shim (2026-08-14, plugin-kernel batch): this machine's sandbox
honors POSIX mode bits on directory creation — a directory created with
mode 0o700 becomes unlistable even for the creating process. pytest's
``tmp_path`` machinery hardcodes ``mode=0o700``, so every tmp_path-based
test dies at setup with PermissionError during its own basetemp cleanup
(the same environment problem STATUS.md documents as "basetemp 权限").

Forcing a listable mode for directories created during a test session
fixes pytest's machinery without touching production code (nothing in
``app/`` or ``scripts/`` passes an explicit restrictive mode), and is a
no-op on real Windows where ``os.mkdir`` ignores the mode argument.

The shim only covers directories this session creates. A basetemp root
poisoned by an *earlier* session (before the shim existed) survives in
``%TEMP%`` and cannot be chmod'd or removed afterwards — pytest then dies
at ``tmp_path`` setup for every test that wants a temp dir, which silently
turned ~300 real tests into setup errors. ``pytest_configure`` below
detects that unreadable root and redirects basetemp into a repo-local,
git-ignored directory so a poisoned ``%TEMP%`` can never mask test results
again.
"""

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
    """Mirror how pytest names its per-user basetemp root under %TEMP%."""
    try:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    except Exception:  # noqa: BLE001 - environment probing is best-effort
        user = "unknown"
    return pathlib.Path(tempfile.gettempdir()) / f"pytest-of-{user}"


def _is_unusable(path: pathlib.Path) -> bool:
    """True when the root exists but this process cannot list it."""
    if not path.exists():
        return False
    try:
        next(os.scandir(path), None)
    except OSError:
        return True
    return False


def pytest_configure(config) -> None:
    """Route around a %TEMP% basetemp root poisoned by an earlier session.

    Without this, every ``tmp_path`` test errors at setup with WinError 5 and
    the suite reports hundreds of "errors" that have nothing to do with the
    code under test — which is exactly how a green suite can hide real bugs.
    """
    if config.option.basetemp:  # an explicit --basetemp always wins
        return
    if not _is_unusable(_default_basetemp_root()):
        return
    fallback = _ROOT / ".pytest-tmp" / "basetemp"
    fallback.parent.mkdir(parents=True, exist_ok=True)
    config.option.basetemp = str(fallback)
