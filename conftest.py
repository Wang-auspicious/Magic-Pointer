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
"""

from __future__ import annotations

import os
import pathlib

_ORIGINAL_PATH_MKDIR = pathlib.Path.mkdir
_ORIGINAL_OS_MKDIR = os.mkdir


def _mkdir_with_listable_mode(self, mode=0o777, parents=False, exist_ok=False):  # noqa: B008
    return _ORIGINAL_PATH_MKDIR(self, 0o777, parents=parents, exist_ok=exist_ok)


def _os_mkdir_with_listable_mode(path, mode=0o777, *args, **kwargs):  # noqa: B008
    return _ORIGINAL_OS_MKDIR(path, 0o777, *args, **kwargs)


pathlib.Path.mkdir = _mkdir_with_listable_mode  # type: ignore[method-assign]
os.mkdir = _os_mkdir_with_listable_mode  # type: ignore[assignment]
