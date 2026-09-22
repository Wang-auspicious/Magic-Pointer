
from __future__ import annotations

import json
from typing import Any, Protocol, runtime_checkable

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.evidence.contract import (
    Evidence,
    EvidenceSource,
    apply_container_heuristic,
    busy_evidence,
    empty_confirmed,
    ok_evidence,
)

RADIUS_MIN = 1
RADIUS_MAX = 10
DEPTH_MIN = 1
DEPTH_MAX = 8

CONTAINER_LIKE_TEXTS = frozenset(
    {"Window", "Pane", "List", "Group", "Tree", "Tab", "Menu", "ScrollBar", "Edit"}
)


class BackendBusy(Exception):
    pass


@runtime_checkable
class PerceptionBackend(Protocol):

    def read_around(self, anchor: str, radius: int) -> list[dict]:
        ...

    def dump_subtree(self, anchor: str, depth: int) -> dict | None:
        ...

    def find_in_window(self, pattern: str) -> list[dict]:
        ...

    def list_windows(self) -> list[dict]:
        ...

    def get_focused(self) -> dict | None:
        ...


class PerceptionTools:

    def __init__(self, backend: PerceptionBackend) -> None:
        self._backend = backend
        self.source = EvidenceSource.UIA


    def read_around(self, anchor: str, radius: int = 3, scope: object = None) -> Evidence:
        radius = _clamp_int(radius, RADIUS_MIN, RADIUS_MAX)
        try:
            items = self._backend.read_around(anchor=anchor, radius=radius)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"read_around timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"read_around failed: {exc}") from exc
        if not items:
            return empty_confirmed(self.source)
        texts = [item.get("text") for item in items if isinstance(item, dict)]
        texts = [t for t in texts if isinstance(t, str) and t]
        joined = "\n".join(texts)
        if not joined.strip():
            return empty_confirmed(self.source)
        sources = {item.get("source") for item in items if isinstance(item, dict) and item.get("source")}
        note = f"{len(texts)} items from {len(sources)} source(s)"
        evidence = ok_evidence(joined, self.source, note=note)
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def dump_subtree(self, anchor: str, depth: int = 4, scope: object = None) -> Evidence:
        depth = _clamp_int(depth, DEPTH_MIN, DEPTH_MAX)
        try:
            tree = self._backend.dump_subtree(anchor=anchor, depth=depth)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"dump_subtree timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"dump_subtree failed: {exc}") from exc
        if tree is None:
            return empty_confirmed(self.source)
        value, cycle, depth_capped = _serialize_tree(tree, depth)
        notes = []
        if cycle:
            notes.append("cycle detected, truncated")
        if depth_capped:
            notes.append(f"capped at depth {depth}")
        note = "; ".join(notes) if notes else None
        evidence = ok_evidence(value, self.source, note=note)
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def find_in_window(self, pattern: str, scope: object = None) -> Evidence:
        try:
            hits = self._backend.find_in_window(pattern=pattern)
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"find_in_window timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"find_in_window failed: {exc}") from exc
        if not hits:
            return empty_confirmed(self.source)
        rows = [
            {"text": hit.get("text"), "bbox_ltrb": hit.get("bbox_ltrb")}
            for hit in hits
            if isinstance(hit, dict) and hit.get("text")
        ]
        if not rows:
            return empty_confirmed(self.source)
        value = json.dumps(rows, ensure_ascii=False)
        evidence = ok_evidence(
            value, self.source, note=f"{len(rows)} match(es) for {pattern!r}"
        )
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def list_windows(self, scope: object = None) -> Evidence:
        try:
            windows = self._backend.list_windows()
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"list_windows timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"list_windows failed: {exc}") from exc
        if not windows:
            return empty_confirmed(self.source)
        value = json.dumps(windows, ensure_ascii=False)
        evidence = ok_evidence(
            value, self.source, note=f"{len(windows)} window(s)"
        )
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)

    def locate_chat_file(
        self,
        file_name: str,
        process_name: str = "",
        scope: object = None,
    ) -> Evidence:
        del scope
        from app.context_pack.chat_local_files import (
            WECHAT_PROCESSES, DINGTALK_PROCESSES, FEISHU_PROCESSES,
            chat_data_roots, locate_chat_file, looks_like_filename,
        )
        name = str(file_name or "").strip()
        if not looks_like_filename(name):
            return empty_confirmed(
                self.source,
                note=(
                    "这不是一个文件名。" if name else "没有给出文件名。"
                ) + "只按完整文件名精确查找，不做模糊匹配。",
            )
        requested = str(process_name or "").strip().casefold()
        known = WECHAT_PROCESSES + DINGTALK_PROCESSES + FEISHU_PROCESSES
        processes = [requested] if requested else list(known)
        searched: list[str] = []
        found: list[str] = []
        for process in processes:
            roots = chat_data_roots(process)
            if not roots:
                continue
            for root in roots:
                text = str(root)
                if text not in searched:
                    searched.append(text)
            for path in locate_chat_file(process, name, roots=roots):
                if path not in found:
                    found.append(path)
        if not found:
            return empty_confirmed(
                self.source,
                note=(
                    f"没有在本机找到 {name!r}。查过："
                    + ("、".join(searched) if searched else "没有任何已知的聊天文件仓库")
                    + "。这个文件可能没下载到本机，或者被用户改过名字——不要猜路径。"
                ),
            )
        return ok_evidence(
            json.dumps({"fileName": name, "localPaths": found}, ensure_ascii=False),
            self.source,
            note=f"{len(found)} 个匹配（同名文件可能不止一个，用修改时间区分）",
        )

    def get_focused(self, scope: object = None) -> Evidence:
        try:
            focused = self._backend.get_focused()
        except BackendBusy as exc:
            return busy_evidence(
                self.source, latency_ms=None, note=f"backend busy: {exc}"
            )
        except ActionFailure:
            raise
        except TimeoutError as exc:
            raise ActionFailure(FailureType.TIMEOUT, f"get_focused timed out: {exc}") from exc
        except Exception as exc:
            raise ActionFailure(FailureType.TOOL_ERROR, f"get_focused failed: {exc}") from exc
        if focused is None:
            return empty_confirmed(self.source)
        value = json.dumps(focused, ensure_ascii=False)
        evidence = ok_evidence(value, self.source, note="focused window")
        return apply_container_heuristic(evidence, CONTAINER_LIKE_TEXTS)


    def register_all(self, registry: ToolRegistry) -> None:
        registry.register_alias("read_around", "Around")
        registry.register_alias("dump_subtree", "Tree")
        registry.register_alias("find_in_window", "Find")
        registry.register_alias("list_windows", "ListWindows")
        registry.register_alias("get_focused", "GetFocus")
        registry.register(
            ToolSpec(
                name="Around",
                description=(
                    "Read text around an anchor point in the frozen snapshot "
                    "captured for this turn (historical state, not the live "
                    "screen — for the current state call Observe). "
                    "anchor is a stable element/anchor identifier; radius "
                    "controls how many surrounding items to include (1..10). "
                    "Returns the concatenated text of the read items."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {"type": "string", "description": "stable anchor identifier"},
                        "radius": {"type": "integer", "description": "read radius, clamped to 1..10"},
                    },
                    "required": ["anchor"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.read_around,
                deferred=True,
            )
        )
        registry.register(
            ToolSpec(
                name="Tree",
                description=(
                    "Dump the structured accessibility subtree rooted at an "
                    "anchor in the frozen snapshot captured for this turn "
                    "(historical state — for the live UI call Observe). "
                    "depth controls how many levels to descend (clamped to "
                    "1..8). Cyclic data is truncated and noted."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "anchor": {"type": "string", "description": "stable anchor identifier"},
                        "depth": {"type": "integer", "description": "subtree depth, clamped to 1..8"},
                    },
                    "required": ["anchor"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.dump_subtree,
                deferred=True,
            )
        )
        registry.register(
            ToolSpec(
                name="Find",
                description=(
                    "Find text matching a pattern inside the frozen snapshot "
                    "captured for this turn (historical state — for the live "
                    "UI call Observe). Returns the matched texts with "
                    "their bounding boxes."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "text or regex pattern to find"},
                    },
                    "required": ["pattern"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.find_in_window,
                deferred=True,
            )
        )
        registry.register(
            ToolSpec(
                name="LocateFile",
                description=(
                    "Find where a file the user pointed at actually lives on this "
                    "machine. Use it with the exact file name you read off a chat "
                    "file card (微信 / 钉钉 / 飞书) — the card shows a name, the file "
                    "is in the app's own store. Exact name only: never guess a path, "
                    "and if it returns nothing, say so instead of inventing one."
                ),
                input_schema={
                    "type": "object",
                    "properties": {
                        "file_name": {"type": "string", "description": "the exact file name, extension included"},
                        "process_name": {"type": "string", "description": "optional: Weixin.exe / DingTalk.exe / Feishu.exe to search one app only"},
                    },
                    "required": ["file_name"],
                },
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="local_filesystem",
                execute=self.locate_chat_file,
                deferred=True,
            )
        )
        registry.register(
            ToolSpec(
                name="ListWindows",
                description=(
                    "List all top-level windows (hwnd, title, process_name, "
                    "pid) as a JSON table."
                ),
                input_schema={"type": "object", "properties": {}, "required": []},
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.list_windows,
                deferred=True,
            )
        )
        registry.register(
            ToolSpec(
                name="GetFocus",
                description=(
                    "Return the currently focused window descriptor "
                    "(hwnd, title, process_name, pid) or empty when nothing "
                    "is focused."
                ),
                input_schema={"type": "object", "properties": {}, "required": []},
                effect=Effect.READ,
                is_concurrency_safe=True,
                used_backend="perception_backend",
                execute=self.get_focused,
                deferred=True,
            )
        )


def evidence_to_text(evidence: Evidence) -> str:
    return json.dumps(
        {
            "status": evidence.status.value,
            "confidence": evidence.confidence,
            "value": evidence.value,
            "note": evidence.note,
        },
        ensure_ascii=False,
    )


def _clamp_int(value: object, lo: int, hi: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        return lo
    return max(lo, min(hi, value))


def _serialize_tree(
    node: Any, depth_remaining: int, visited: set[int] | None = None
) -> tuple[str, bool, bool]:
    if visited is None:
        visited = set()
    root = node
    cycle = False
    capped = False

    def walk(item: Any, level: int) -> Any:
        nonlocal cycle, capped
        if level > depth_remaining:
            capped = True
            return "[max_depth]"
        if isinstance(item, dict):
            ident = id(item)
            if ident in visited:
                cycle = True
                return "[cycle]"
            visited.add(ident)
            out = {k: walk(v, level + 1) for k, v in item.items()}
            visited.remove(ident)
            return out
        if isinstance(item, (list, tuple)):
            return [walk(v, level) for v in item]
        if item is None or isinstance(item, (str, int, float, bool)):
            return item
        return str(item)

    return json.dumps(walk(root, 1), ensure_ascii=False, sort_keys=True), cycle, capped
