from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit


_SOURCE_SUFFIXES = {
    ".tsx", ".jsx", ".vue", ".svelte", ".html", ".htm",
    ".ts", ".js", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less",
}
_COMPONENT_SUFFIXES = {".tsx", ".jsx", ".vue", ".svelte", ".html", ".htm", ".ts", ".js", ".mjs", ".cjs"}
_IGNORED_DIRECTORIES = {
    ".git", ".hg", ".svn", ".idea", ".vscode", ".tmp", "node_modules",
    ".agents", ".claude", ".codex", ".omx", ".playwright-cli", ".superpowers",
    "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit",
    "vendor", "external", "external_zip", "release", "__pycache__", "data", "artifacts",
}
_IGNORED_DIRECTORY_PREFIXES = (".tmp-", ".tmp_", ".pytest-", ".pytest_")
_VISUAL_KINDS = {"screen_region", "ui-control", "image", "canvas", "design_component", "browser_dom"}
_VISUAL_APPS = {"browser", "figma", "sketch", "photoshop", "edge", "chrome", "chromium"}


def _inside(root: Path, candidate: Path) -> Path | None:
    try:
        resolved = candidate.expanduser().resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return resolved


def _runtime_path(reference: object, root: Path) -> Path | None:
    raw = str(reference or "").strip()
    if not raw:
        return None
    try:
        parsed = urlsplit(raw)
    except ValueError:
        parsed = None
    candidates: list[Path] = []
    if parsed is not None and parsed.scheme == "file":
        value = unquote(parsed.path)
        if re.match(r"^/[A-Za-z]:/", value):
            value = value[1:]
        candidates.append(Path(value))
    elif parsed is not None and parsed.scheme in {"webpack", "webpack-internal", "vite", "http", "https"}:
        value = unquote(parsed.path).lstrip("/").removeprefix("./")
        for marker in ("src/", "app/", "packages/", "components/"):
            index = value.find(marker)
            if index >= 0:
                candidates.append(root / value[index:])
        candidates.append(root / value)
    else:
        value = re.split(r"[?#]", raw, maxsplit=1)[0]
        path = Path(value)
        candidates.append(path if path.is_absolute() else root / path)
    for candidate in candidates:
        resolved = _inside(root, candidate)
        if resolved is not None and resolved.is_file() and resolved.suffix.casefold() in _SOURCE_SUFFIXES:
            return resolved
    return None


def _line_for(text: str, needle: str) -> int:
    index = text.casefold().find(needle.casefold())
    return text.count("\n", 0, index) + 1 if index >= 0 else 0


def _ignored_directory(name: str) -> bool:
    folded = str(name or "").casefold()
    return folded in _IGNORED_DIRECTORIES or folded.startswith(_IGNORED_DIRECTORY_PREFIXES)


def _looks_like_browser_profile(path: Path) -> bool:
    """Reject Chromium user-data trees accidentally created inside a repo.

    Their caches can contain thousands of generated ``.js`` files and are not
    source candidates. A profile root has both ``Local State`` and ``Default``;
    requiring the pair avoids excluding an ordinary project directory called
    Default or a source file that happens to be named Local State.
    """
    try:
        return (path / "Local State").is_file() and (path / "Default").is_dir()
    except OSError:
        return False


class ComponentSourceResolver:
    def __init__(self, *, max_files: int = 2500, max_file_bytes: int = 512_000, max_candidates: int = 8) -> None:
        self.max_files = max(100, min(int(max_files), 10_000))
        self.max_file_bytes = max(16_000, min(int(max_file_bytes), 2_000_000))
        self.max_candidates = max(1, min(int(max_candidates), 20))

    @staticmethod
    def _is_relevant(browser_context: dict[str, Any] | None, objects: list[dict[str, Any]]) -> bool:
        if browser_context:
            return True
        for obj in objects:
            source = dict(obj.get("source") or {}) if isinstance(obj.get("source"), dict) else {}
            if str(obj.get("kind") or "").casefold() in _VISUAL_KINDS:
                return True
            if str(source.get("app") or "").casefold() in _VISUAL_APPS:
                return True
        return False

    @staticmethod
    def _owners(browser_context: dict[str, Any] | None) -> list[dict[str, Any]]:
        hints = dict((browser_context or {}).get("componentHints") or {})
        return [dict(item) for item in list(hints.get("owners") or [])[:12] if isinstance(item, dict)]

    def _files(self, root: Path) -> Iterable[Path]:
        count = 0
        for directory, names, files in os.walk(root):
            parent = Path(directory)
            names[:] = sorted(
                name
                for name in names
                if not _ignored_directory(name)
                and not _looks_like_browser_profile(parent / name)
            )
            for name in sorted(files):
                path = Path(directory) / name
                if path.suffix.casefold() not in _SOURCE_SUFFIXES:
                    continue
                try:
                    if path.stat().st_size > self.max_file_bytes:
                        continue
                except OSError:
                    continue
                yield path
                count += 1
                if count >= self.max_files:
                    return

    @staticmethod
    def _signals(browser_context: dict[str, Any] | None, objects: list[dict[str, Any]]) -> list[tuple[str, str, float]]:
        signals: list[tuple[str, str, float]] = []
        seen: set[tuple[str, str]] = set()

        def add(kind: str, value: object, weight: float) -> None:
            text = str(value or "").strip()
            key = (kind, text.casefold())
            if len(text) < 3 or len(text) > 240 or key in seen:
                return
            seen.add(key)
            signals.append((kind, text, weight))

        browser = dict(browser_context or {})
        node = dict(browser.get("node") or {})
        attributes = dict(node.get("attributes") or {})
        add("data_testid_exact", attributes.get("data-testid"), .34)
        add("data_test_exact", attributes.get("data-test"), .32)
        add("data_qa_exact", attributes.get("data-qa"), .32)
        add("dom_id_exact", node.get("id") or attributes.get("id"), .30)
        add("accessible_name_exact", node.get("accessibleName") or attributes.get("aria-label"), .24)
        add("node_text_exact", node.get("text"), .16)
        for owner in ComponentSourceResolver._owners(browser):
            add("component_name_exact", owner.get("name"), .34)
        for class_name in list(node.get("classes") or [])[:5]:
            add("class_name_exact", class_name, .05)
        if not browser:
            for obj in objects[:12]:
                add("visual_label_exact", obj.get("label"), .22)
                add("visual_text_exact", obj.get("content"), .18)
                for element in list(obj.get("elements") or [])[:12]:
                    if isinstance(element, dict):
                        add("visual_element_name_exact", element.get("name"), .18)
        return signals

    @staticmethod
    def _candidate(path: Path, root: Path, *, confidence: float, evidence: list[str], line: int, component_name: str = "") -> dict[str, Any]:
        return {
            "path": str(path),
            "relativePath": path.relative_to(root).as_posix(),
            "line": int(line) if line > 0 else None,
            "column": None,
            "componentName": str(component_name or path.stem)[:240],
            "kind": "component" if path.suffix.casefold() in _COMPONENT_SUFFIXES else "stylesheet",
            "confidence": round(max(0.0, min(float(confidence), 1.0)), 3),
            "confidenceBand": "high" if confidence >= .9 else "medium" if confidence >= .5 else "low",
            "evidence": list(dict.fromkeys(evidence))[:12],
        }

    def resolve(
        self,
        *,
        browser_context: dict[str, Any] | None,
        objects: Iterable[dict[str, Any]],
        workspace_root: Path | str,
    ) -> dict[str, Any]:
        clean_objects = [dict(item) for item in objects if isinstance(item, dict)][:12]
        try:
            root = Path(workspace_root).expanduser().resolve()
        except (OSError, ValueError):
            root = Path()
        base = {
            "schemaVersion": 1,
            "state": "unavailable",
            "method": "runtime-source+bounded-repository-signals",
            "candidates": [],
            "autoModificationAllowed": False,
            "policy": "candidate_only_inspect_before_edit",
            "reason": "workspace_unavailable",
        }
        if not root.is_dir() or not self._is_relevant(browser_context, clean_objects):
            if root.is_dir():
                base["reason"] = "component_link_not_applicable"
            return base

        direct: list[dict[str, Any]] = []
        for index, owner in enumerate(self._owners(browser_context)):
            source = dict(owner.get("source") or {}) if isinstance(owner.get("source"), dict) else {}
            path = _runtime_path(source.get("file"), root)
            if path is None:
                continue
            confidence = max(.95, .99 - (index * .02))
            candidate = self._candidate(
                path,
                root,
                confidence=confidence,
                evidence=["runtime_source_exact", "workspace_boundary_verified"],
                line=int(source.get("line") or 0),
                component_name=str(owner.get("name") or ""),
            )
            candidate["column"] = int(source.get("column") or 0) or None
            if all(item["path"] != candidate["path"] for item in direct):
                direct.append(candidate)
        direct.sort(key=lambda item: (-item["confidence"], item["relativePath"]))
        if direct:
            margin = direct[0]["confidence"] - (direct[1]["confidence"] if len(direct) > 1 else 0)
            allow = direct[0]["confidence"] >= .95 and (len(direct) == 1 or margin >= .12)
            return {
                **base,
                "state": "resolved" if allow else "ambiguous",
                "candidates": direct[:self.max_candidates],
                "autoModificationAllowed": allow,
                "policy": "high_confidence_direct_source" if allow else "candidate_only_inspect_before_edit",
                "reason": "direct_runtime_source_verified" if allow else "multiple_runtime_sources",
            }

        signals = self._signals(browser_context, clean_objects)
        candidates: list[dict[str, Any]] = []
        for path in self._files(root):
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            folded = text.casefold()
            score = 0.0
            evidence: list[str] = []
            best_line = 0
            for kind, value, weight in signals:
                if value.casefold() not in folded:
                    continue
                score += weight
                evidence.append(kind)
                if not best_line:
                    best_line = _line_for(text, value)
            if path.suffix.casefold() in _COMPONENT_SUFFIXES and evidence:
                score += .04
                evidence.append("component_file_type")
            if score < .12:
                continue
            candidates.append(self._candidate(
                path.resolve(),
                root,
                confidence=min(score, .89),
                evidence=evidence,
                line=best_line,
            ))
        candidates.sort(key=lambda item: (-item["confidence"], item["relativePath"]))
        if not candidates:
            base["reason"] = "no_repository_signal_match"
            return base
        return {
            **base,
            "state": "ambiguous",
            "candidates": candidates[:self.max_candidates],
            "autoModificationAllowed": False,
            "policy": "candidate_only_inspect_before_edit",
            "reason": "repository_signals_require_inspection",
        }
