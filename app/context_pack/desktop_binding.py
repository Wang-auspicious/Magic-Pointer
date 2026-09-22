
from __future__ import annotations

import re
from pathlib import PureWindowsPath
from typing import Any

from .source_scope import ScopeGrant, grant_source_scope, scope_from_events
from .source_store import register_source, task_sources
from .sources import SourceRef


def bind_named_windows(session: Any, instruction: str, windows: list[dict]) -> list[SourceRef]:
    if not instruction.strip():
        return []

    def mentioned(text: str) -> bool:
        return len(text) >= 3 and re.search(
            r"(?<![a-z0-9_])" + re.escape(text) + r"(?![a-z0-9_])", instruction, re.IGNORECASE,
        ) is not None

    groups: dict[str, list[dict]] = {}
    for window in windows:
        process = PureWindowsPath(str(window.get("process_name") or "")).stem.casefold()
        if process and window.get("hwnd") and window.get("pid"):
            groups.setdefault(process, []).append(window)
    selected = []
    for process, candidates in groups.items():
        named_documents = [window for window in candidates if mentioned(
            str(window.get("title") or "").split(" - ")[0].strip(),
        )]
        if len(named_documents) == 1:
            selected.extend(named_documents)
        elif mentioned(process) and len(candidates) == 1:
            selected.extend(candidates)

    if not selected:
        return []
    known = {source.source_id: source for source in task_sources(session.events)}
    grants = scope_from_events(session.events, task_id=session.id).grants
    bound = []
    for window in selected:
        hwnd, pid = int(window["hwnd"]), int(window["pid"])
        source_id = f"window-{hwnd}-{pid}"
        source = known.get(source_id) or SourceRef(
            source_id=source_id, task_id=session.id, kind="capture",
            title=str(window.get("title") or window["process_name"]),
            identity={"hwnd": hwnd, "pid": pid, "process_name": window["process_name"]},
            revision={}, capabilities=("read", "patch"),
            origin="task-discovered", parent_source_id=None,
        )
        if source_id not in known:
            register_source(session, source)
        grant = ScopeGrant(
            grant_id=source_id, task_id=session.id, source_ids=(source_id,),
            folder_roots=(), window_ids=(f"w-{hwnd}",), recipients=(),
            actions=("read", "patch"), expires_at_ms=None,
        )
        if grant not in grants:
            grant_source_scope(session, grants=(grant,))
        bound.append(source)
    return bound
