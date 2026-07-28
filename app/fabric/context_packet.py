from __future__ import annotations

import json
import os
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from app.fabric.capture_policy import CaptureDecision
from app.fabric.runtime_workspace import RuntimeWorkspaceResolver
from app.adapters.browser_devtools_adapter import sanitize_browser_context
from app.grounding.component_source import ComponentSourceResolver
from app.grounding.terminal_evidence import TerminalEvidenceExtractor, sanitize_terminal_evidence


_VISUAL_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".webp",
    ".heic",
    ".avif",
}
_MAX_PROMPT_CHARS = 20_000


def _bounded(value: Any, limit: int) -> str:
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}\n[…truncated {len(text) - limit} chars…]"


def _is_visual(value: str) -> bool:
    return Path(str(value or "")).suffix.casefold() in _VISUAL_SUFFIXES


def _resolved_path(value: str) -> str:
    path = Path(value).expanduser()
    try:
        return str(path.resolve())
    except OSError:
        return str(path)


def _run_git(cwd: Path, *args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), *args],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=2.5,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return completed.stdout.rstrip() if completed.returncode == 0 else ""


def probe_workspace(cwd: Path | str) -> dict[str, Any]:
    path = Path(cwd or Path.cwd()).expanduser()
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path
    if not resolved.is_dir():
        resolved = resolved.parent if resolved.parent.is_dir() else Path.cwd().resolve()
    repo_raw = _run_git(resolved, "rev-parse", "--show-toplevel")
    repo = Path(repo_raw).resolve() if repo_raw else None
    branch = _run_git(resolved, "branch", "--show-current") if repo else ""
    head = _run_git(resolved, "rev-parse", "--short=12", "HEAD") if repo else ""
    status = _run_git(resolved, "status", "--porcelain=v1", "--untracked-files=normal") if repo else ""
    changed_files: list[str] = []
    for line in status.splitlines():
        candidate = line[3:].strip() if len(line) >= 4 else ""
        if " -> " in candidate:
            candidate = candidate.split(" -> ", 1)[1]
        if candidate and candidate not in changed_files:
            changed_files.append(candidate)
    diff_stat = _run_git(resolved, "diff", "--stat", "--", ".") if repo else ""
    staged_stat = _run_git(resolved, "diff", "--cached", "--stat", "--", ".") if repo else ""
    combined_stat = "\n".join(item for item in (diff_stat, staged_stat) if item)
    diff = _run_git(resolved, "diff", "--no-ext-diff", "--unified=3", "--", ".") if repo else ""
    staged_diff = _run_git(resolved, "diff", "--cached", "--no-ext-diff", "--unified=3", "--", ".") if repo else ""
    combined_diff = "\n".join(item for item in (diff, staged_diff) if item)
    return {
        "cwd": str(resolved),
        "repoRoot": str(repo) if repo else "",
        "branch": _bounded(branch, 240),
        "head": _bounded(head, 40),
        "isDirty": bool(status),
        "changedFiles": changed_files[:80],
        "diffStat": _bounded(combined_stat, 6000),
        "diffExcerpt": _bounded(combined_diff, 6000),
    }


def _decision_value(decision: CaptureDecision | dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(decision, CaptureDecision):
        return {
            "objectId": decision.object_id,
            "mode": decision.mode,
            "allowStructure": decision.allow_structure,
            "allowLocalPixels": decision.allow_local_pixels,
            "allowUpload": decision.allow_upload,
            "reason": decision.reason,
        }.get(key, default)
    return decision.get(key, default)


def _object_visual_paths(obj: dict[str, Any]) -> list[str]:
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    values: list[str] = []
    for candidate in (
        obj.get("path"),
        source.get("imagePath"),
        source.get("screenshotPath"),
        source.get("capturePath"),
        source.get("annotatedPath"),
        source.get("path"),
    ):
        value = str(candidate or "").strip()
        if value and _is_visual(value):
            resolved = _resolved_path(value)
            if resolved not in values:
                values.append(resolved)
    return values


def _safe_elements(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    results: list[dict[str, Any]] = []
    for raw in value[:200]:
        if not isinstance(raw, dict):
            continue
        results.append({
            key: item
            for key, item in raw.items()
            if key in {"id", "role", "name", "label", "text", "bbox", "value", "state"}
        })
    return results


def _safe_capture_attestation(source: dict[str, Any]) -> dict[str, Any] | None:
    raw = source.get("captureAttestation") or source.get("capture_attestation")
    if not isinstance(raw, dict):
        return None
    expected = raw.get("expected")
    expected = dict(expected) if isinstance(expected, dict) else {}
    value = {
        "status": _bounded(raw.get("status"), 80),
        "phase": _bounded(raw.get("phase"), 80),
        "expected": {
            key: expected.get(key)
            for key in ("hwnd", "processId", "processName", "title", "desktopId")
            if expected.get(key) not in (None, "", 0)
        },
    }
    return {
        key: item
        for key, item in value.items()
        if item not in (None, "", {})
    }


def _safe_perception_trace(source: dict[str, Any]) -> dict[str, Any] | None:
    raw = source.get("perceptionTrace") or source.get("perception_trace")
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        return None
    attempts: list[dict[str, str]] = []
    for item in list(raw.get("attempts") or [])[:12]:
        if not isinstance(item, dict):
            continue
        attempt = {
            key: _bounded(item.get(key), 120)
            for key in ("layer", "adapter", "method", "status", "reason")
            if str(item.get(key) or "").strip()
        }
        if attempt:
            attempts.append(attempt)
    value = {
        "schemaVersion": 1,
        "selectedLayer": _bounded(raw.get("selectedLayer"), 40),
        "selectedAdapter": _bounded(raw.get("selectedAdapter"), 80),
        "selectedMethod": _bounded(raw.get("selectedMethod"), 120),
        "pixelFallbackUsed": raw.get("pixelFallbackUsed") is True,
        "fallbackReason": _bounded(raw.get("fallbackReason"), 120),
        "policyMode": _bounded(raw.get("policyMode"), 40),
        "attempts": attempts,
    }
    return {
        key: item
        for key, item in value.items()
        if item not in (None, "", [])
    }


def _safe_terminal_evidence(source: dict[str, Any]) -> dict[str, Any] | None:
    return sanitize_terminal_evidence(
        source.get("terminalEvidence") or source.get("terminal_evidence")
    )


def _safe_browser_context(source: dict[str, Any]) -> dict[str, Any] | None:
    return sanitize_browser_context(
        source.get("browserContext") or source.get("browser_context")
    )


def _bbox_center(value: Any) -> tuple[float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 4:
        try:
            left, top, right, bottom = (float(item) for item in value)
        except (TypeError, ValueError):
            return None
        return ((left + right) / 2, (top + bottom) / 2)
    if isinstance(value, dict):
        try:
            x = float(value.get("x"))
            y = float(value.get("y"))
            width = float(value.get("width"))
            height = float(value.get("height"))
        except (TypeError, ValueError):
            return None
        return (x + width / 2, y + height / 2)
    return None


def _spatial_relations(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for left_index, left in enumerate(objects):
        left_label = str(left.get("referenceLabel") or "").strip()
        left_center = _bbox_center(left.get("bbox"))
        if not left_label or left_center is None:
            continue
        for right in objects[left_index + 1:]:
            right_label = str(right.get("referenceLabel") or "").strip()
            right_center = _bbox_center(right.get("bbox"))
            if not right_label or right_center is None:
                continue
            dx = round(right_center[0] - left_center[0], 1)
            dy = round(right_center[1] - left_center[1], 1)
            results.append({
                "from": left_label,
                "to": right_label,
                "horizontal": "aligned" if abs(dx) <= 2 else "left_of" if dx > 0 else "right_of",
                "vertical": "aligned" if abs(dy) <= 2 else "above" if dy > 0 else "below",
                "delta": [dx, dy],
            })
    return results


def _sanitize_object(
    obj: dict[str, Any],
    decision: CaptureDecision | dict[str, Any],
) -> dict[str, Any] | None:
    if _decision_value(decision, "mode") == "deny" or _decision_value(decision, "allowStructure") is False:
        return None
    source = obj.get("source")
    source = dict(source) if isinstance(source, dict) else {}
    safe_source = {
        "app": _bounded(source.get("app"), 300),
        "title": _bounded(source.get("title"), 1000),
        "hwnd": source.get("hwnd"),
        "processId": source.get("processId") or source.get("process_id") or source.get("pid"),
        "url": _bounded(source.get("url"), 4000),
        "page": source.get("page"),
        "fileSha256": _bounded(source.get("fileSha256") or source.get("file_sha256"), 128),
        "captureAttestation": _safe_capture_attestation(source),
        "perceptionTrace": _safe_perception_trace(source),
        "terminalEvidence": _safe_terminal_evidence(source),
        "browserContext": _safe_browser_context(source),
    }
    document_path = str(source.get("documentPath") or source.get("document_path") or "").strip()
    generic_path = str(source.get("path") or "").strip()
    if document_path:
        safe_source["documentPath"] = _resolved_path(document_path)
    elif generic_path and not _is_visual(generic_path):
        safe_source["path"] = _resolved_path(generic_path)
    if _decision_value(decision, "allowUpload") is True:
        visual_paths = _object_visual_paths(obj)
        if visual_paths:
            safe_source["visualPaths"] = visual_paths
    return {
        "id": _bounded(obj.get("id") or obj.get("objectId"), 240),
        "referenceLabel": _bounded(obj.get("referenceLabel"), 12).upper(),
        "kind": _bounded(obj.get("kind"), 120),
        "label": _bounded(obj.get("label"), 500),
        "content": _bounded(obj.get("content") or obj.get("text"), 12_000),
        "bbox": obj.get("bbox"),
        "elements": _safe_elements(obj.get("elements")),
        "source": {
            key: value
            for key, value in safe_source.items()
            if value is not None and value != "" and value != []
        },
        "captureMode": str(_decision_value(decision, "mode") or ""),
    }


def _artifact_paths(
    attachments: Iterable[str],
    *,
    uploadable_visual_paths: set[str],
) -> list[str]:
    results: list[str] = []
    for raw in attachments:
        value = str(raw or "").strip()
        if not value:
            continue
        resolved = _resolved_path(value)
        if _is_visual(resolved) and resolved not in uploadable_visual_paths:
            continue
        if resolved not in results:
            results.append(resolved)
    return results[:32]


def _safe_visual_relays(
    value: Iterable[dict[str, Any]],
    *,
    uploadable_visual_paths: set[str],
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
            continue
        mode = str(raw.get("mode") or "")
        if mode not in {"direct_visual", "structured_text"}:
            continue
        target = dict(raw.get("target") or {})
        grounding = dict(raw.get("grounding") or {})
        appearance = dict(raw.get("appearance") or {})
        spatial = dict(raw.get("spatial") or {})
        attachments = []
        if mode == "direct_visual":
            attachments = [
                _resolved_path(str(item))
                for item in raw.get("attachments") or []
                if _resolved_path(str(item)) in uploadable_visual_paths
            ][:2]
        safe = {
            "schemaVersion": 1,
            "mode": mode,
            "profileId": _bounded(raw.get("profileId"), 64),
            "target": {
                "objectId": _bounded(target.get("objectId"), 240),
                "kind": _bounded(target.get("kind"), 120),
                "label": _bounded(target.get("label"), 1000),
                "bbox": target.get("bbox"),
                "app": _bounded(target.get("app"), 300),
                "windowTitle": _bounded(target.get("windowTitle"), 1000),
            },
            "grounding": {
                "ocr": _bounded(grounding.get("ocr"), 8000),
                "role": _bounded(grounding.get("role"), 120),
                "hierarchy": [_bounded(item, 300) for item in grounding.get("hierarchy") or []][:24],
                "locatorHints": [_bounded(item, 500) for item in grounding.get("locatorHints") or []][:24],
            },
            "appearance": {
                "foreground": _bounded(appearance.get("foreground"), 80),
                "background": _bounded(appearance.get("background"), 80),
                "shape": _bounded(appearance.get("shape"), 160),
                "localImageSummary": _bounded(appearance.get("localImageSummary"), 1200),
            },
            "spatial": {
                "relativeToPointer": _bounded(spatial.get("relativeToPointer"), 120),
                "neighbors": [_bounded(item, 500) for item in spatial.get("neighbors") or []][:20],
            },
            "uncertainty": [_bounded(item, 500) for item in raw.get("uncertainty") or []][:20],
            "provenance": [_bounded(item, 120) for item in raw.get("provenance") or []][:20],
            "intent": _bounded(raw.get("intent"), 6000),
            "attachments": attachments,
        }
        if mode == "direct_visual":
            safe["locatorText"] = _bounded(raw.get("locatorText"), 2400)
        else:
            safe["capabilityNotice"] = _bounded(raw.get("capabilityNotice"), 120)
            safe["structuredText"] = _bounded(raw.get("structuredText"), 12_000)
        results.append(safe)
    return results[:12]


class ContextPacketBuilder:
    def __init__(
        self,
        *,
        runtime_resolver: RuntimeWorkspaceResolver | None = None,
        component_resolver: ComponentSourceResolver | None = None,
    ) -> None:
        self.runtime_resolver = runtime_resolver
        self.component_resolver = component_resolver or ComponentSourceResolver()

    def build(
        self,
        *,
        command: str,
        recipe_id: str,
        objects: Iterable[dict[str, Any]],
        cwd: Path | str,
        target_lease: dict[str, Any],
        capture_decisions: Iterable[CaptureDecision | dict[str, Any]],
        capabilities: Iterable[dict[str, Any]],
        terminal_excerpt: str = "",
        attachments: Iterable[str] = (),
        visual_relays: Iterable[dict[str, Any]] = (),
    ) -> dict[str, Any]:
        clean_objects = [dict(item) for item in objects if isinstance(item, dict)][:12]
        decisions = list(capture_decisions)[:len(clean_objects)]
        if len(decisions) < len(clean_objects):
            raise ValueError("capture decision is required for every context object")
        safe_objects: list[dict[str, Any]] = []
        denied_ids: list[str] = []
        uploadable_visual_paths: set[str] = set()
        local_pixel_count = 0
        for obj, decision in zip(clean_objects, decisions):
            if _decision_value(decision, "allowLocalPixels") is True:
                local_pixel_count += 1
            if _decision_value(decision, "allowUpload") is True:
                uploadable_visual_paths.update(_object_visual_paths(obj))
            safe = _sanitize_object(obj, decision)
            if safe is None:
                denied_ids.append(str(obj.get("id") or obj.get("objectId") or ""))
            else:
                safe_objects.append(safe)

        safe_relays = _safe_visual_relays(
            visual_relays,
            uploadable_visual_paths=uploadable_visual_paths,
        )
        terminal_evidence = next((
            dict((item.get("source") or {}).get("terminalEvidence") or {})
            for item in safe_objects
            if isinstance(item.get("source"), dict)
            and isinstance((item.get("source") or {}).get("terminalEvidence"), dict)
        ), None)
        if terminal_evidence is None and str(terminal_excerpt or "").strip():
            terminal_evidence = TerminalEvidenceExtractor().extract(
                terminal_excerpt,
                method="provided_excerpt",
            )
        terminal_window_text = str(
            ((terminal_evidence or {}).get("window") or {}).get("text") or ""
        )
        browser_context = next((
            dict((item.get("source") or {}).get("browserContext") or {})
            for item in safe_objects
            if isinstance(item.get("source"), dict)
            and isinstance((item.get("source") or {}).get("browserContext"), dict)
        ), None)
        process_binding = (
            self.runtime_resolver.resolve(clean_objects, fallback_cwd=cwd)
            if self.runtime_resolver is not None and recipe_id in {"agent.handoff", "agent.background_task", "vision.prompt_bridge"}
            else {
                "schemaVersion": 1,
                "state": "fallback_unverified",
                "relation": "explicit_cwd_fallback",
                "targetProcessId": None,
                "workspaceProcessId": None,
                "cwd": str(Path(cwd).expanduser().resolve()),
                "repoRoot": "",
                "executablePath": "",
                "launchCommand": "",
                "sourceOrigin": "",
            }
        )
        workspace = probe_workspace(str(process_binding.get("cwd") or cwd))
        workspace["bindingState"] = str(process_binding.get("state") or "fallback_unverified")
        workspace["bindingRelation"] = str(process_binding.get("relation") or "explicit_cwd_fallback")
        component_link = self.component_resolver.resolve(
            browser_context=browser_context,
            objects=safe_objects,
            workspace_root=str(workspace.get("repoRoot") or workspace.get("cwd") or cwd),
        )
        packet = {
            "schemaVersion": 2,
            "packetId": str(uuid.uuid4()),
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "intent": {
                "command": _bounded(command, 6000),
                "recipeId": _bounded(recipe_id, 200),
            },
            "targetLease": {
                key: value
                for key, value in dict(target_lease).items()
                if key != "captureFiles"
            },
            "objects": safe_objects,
            "spatialRelations": _spatial_relations(safe_objects),
            "visualRelays": safe_relays,
            "workspace": workspace,
            "runtime": {
                "terminalExcerpt": _bounded(terminal_window_text, 8000),
                "terminalEvidence": terminal_evidence,
                "browserContext": browser_context,
                "componentLink": component_link,
                "processBinding": process_binding,
            },
            "capabilities": [dict(item) for item in capabilities if isinstance(item, dict)][:8],
            "artifacts": _artifact_paths(
                attachments,
                uploadable_visual_paths=uploadable_visual_paths,
            ),
            "privacy": {
                "objectCount": len(clean_objects),
                "structuredObjectCount": len(safe_objects),
                "localPixelObjectCount": local_pixel_count,
                "uploadableVisualObjectCount": sum(
                    1 for decision in decisions
                    if _decision_value(decision, "allowUpload") is True
                ),
                "deniedObjectIds": denied_ids,
                "withheldVisualObjectCount": sum(
                    1
                    for obj, decision in zip(clean_objects, decisions)
                    if _object_visual_paths(obj)
                    and _decision_value(decision, "allowUpload") is not True
                ),
            },
        }
        return packet


def write_context_packet_artifact(
    packet: dict[str, Any],
    *,
    root: Path | str,
) -> Path:
    packet_id = re.sub(r"[^A-Za-z0-9._-]+", "-", str(packet.get("packetId") or "")).strip("-.")
    if not packet_id or packet.get("schemaVersion") != 2:
        raise ValueError("valid Context Packet v2 is required")
    artifact = Path(root) / "artifacts" / f"{packet_id}-context-packet.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    temporary = artifact.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(packet, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, artifact)
    return artifact


def build_agent_prompt(
    packet: dict[str, Any],
    *,
    artifact_path: Path | str,
) -> str:
    if packet.get("schemaVersion") != 2:
        raise ValueError("Context Packet v2 is required")
    intent = dict(packet.get("intent") or {})
    workspace = dict(packet.get("workspace") or {})
    runtime = dict(packet.get("runtime") or {})
    process_binding = dict(runtime.get("processBinding") or {})
    privacy = dict(packet.get("privacy") or {})
    lease = dict(packet.get("targetLease") or {})
    lines = [
        "# Magic Pointer grounded object handoff",
        "",
        f"User intent: {_bounded(intent.get('command'), 6000)}",
        f"Selected recipe: {_bounded(intent.get('recipeId'), 200)}",
        f"Context Packet: {artifact_path}",
        f"Target lease: {lease.get('leaseId') or ''} / fingerprint={lease.get('objectFingerprint') or ''}",
        "",
        "## Workspace",
        f"- cwd: {workspace.get('cwd') or ''}",
        f"- repo: {workspace.get('repoRoot') or 'not detected'}",
        f"- branch/head: {workspace.get('branch') or ''} / {workspace.get('head') or ''}",
        f"- changed files: {', '.join(str(item) for item in workspace.get('changedFiles') or []) or 'none'}",
        f"- target binding: {workspace.get('bindingState') or 'unknown'} / {workspace.get('bindingRelation') or 'unknown'}; target pid={process_binding.get('targetProcessId') or 'unknown'}; workspace pid={process_binding.get('workspaceProcessId') or 'unknown'}",
        f"- launch command: {process_binding.get('launchCommand') or 'not available'}",
        f"- recent diff excerpt:\n{_bounded(workspace.get('diffExcerpt'), 4000) or 'none'}",
        "",
        "## Pointed objects",
    ]
    for index, obj in enumerate(packet.get("objects") or [], 1):
        source = dict(obj.get("source") or {})
        lines.extend([
            f"{index}. reference={obj.get('referenceLabel') or ''} id={obj.get('id') or ''} kind={obj.get('kind') or ''} label={obj.get('label') or ''}",
            f"   app={source.get('app') or ''} window={source.get('title') or ''} bbox={json.dumps(obj.get('bbox'), ensure_ascii=False)}",
        ])
        perception = dict(source.get("perceptionTrace") or {})
        if perception:
            lines.append(
                f"   perception={perception.get('selectedLayer') or 'none'} / "
                f"{perception.get('selectedMethod') or 'none'}; "
                f"pixelFallback={perception.get('pixelFallbackUsed') is True}; "
                f"fallbackReason={perception.get('fallbackReason') or 'none'}"
            )
        content = _bounded(obj.get("content"), 4000)
        if content:
            lines.append(f"   content={content}")
    terminal_evidence = dict(runtime.get("terminalEvidence") or {})
    if terminal_evidence:
        terminal_window = dict(terminal_evidence.get("window") or {})
        exit_code = terminal_evidence.get("exitCode")
        lines.extend([
            "",
            "## Terminal error evidence",
            f"- method/state: {terminal_evidence.get('method') or 'unknown'} / {terminal_evidence.get('state') or 'unknown'}",
            f"- observed at: {terminal_evidence.get('timestamp') or terminal_evidence.get('capturedAt') or 'unknown'}",
            f"- command: {terminal_evidence.get('command') or 'not available'}",
            f"- exit code: {exit_code if exit_code is not None else 'not observed'}",
            f"- bounded log lines: {terminal_window.get('startLine') or 0}-{terminal_window.get('endLine') or 0} ({terminal_window.get('lineCount') or 0} lines)",
            "```text",
            _bounded(terminal_window.get("text"), 8000),
            "```",
            "Treat an absent exit code as unknown. Do not infer it from error wording.",
        ])
    browser_context = dict(runtime.get("browserContext") or {})
    if browser_context:
        browser_page = dict(browser_context.get("page") or {})
        browser_node = dict(browser_context.get("node") or {})
        browser_coordinates = dict(browser_context.get("coordinates") or {})
        lines.extend([
            "",
            "## Browser DevTools evidence",
            f"- page: {browser_page.get('title') or ''} / {browser_page.get('url') or ''}",
            f"- selector: {browser_context.get('selector') or 'not available'}",
            f"- node: tag={browser_node.get('tag') or ''}; role={browser_node.get('role') or ''}; accessibleName={browser_node.get('accessibleName') or ''}",
            f"- pointer screen/viewport: {json.dumps(browser_coordinates.get('pointerScreenPhysical'), ensure_ascii=False)} / {json.dumps(browser_coordinates.get('pointerViewportCss'), ensure_ascii=False)}",
            f"- element screen bbox: {json.dumps(browser_coordinates.get('elementScreenPhysical'), ensure_ascii=False)}",
        ])
        failures = [dict(item) for item in browser_context.get("networkFailures") or [] if isinstance(item, dict)]
        if failures:
            lines.append("- observed network failures:")
            for failure in failures[:20]:
                lines.append(
                    f"  - {failure.get('errorText') or 'network failure'}; "
                    f"url={failure.get('url') or 'unknown'}; source={failure.get('source') or 'unknown'}"
                )
        else:
            lines.append("- observed network failures: none in the available DevTools history")
    component_link = dict(runtime.get("componentLink") or {})
    component_candidates = [dict(item) for item in component_link.get("candidates") or [] if isinstance(item, dict)]
    if component_candidates:
        lines.extend([
            "",
            "## Component source candidates",
            f"- state: {component_link.get('state') or 'unavailable'}",
            f"- automatic modification gate: {'allowed for verified direct source' if component_link.get('autoModificationAllowed') is True else 'blocked; inspect candidates first'}",
            "- Low-confidence candidates are hints only. Inspect the DOM/source and verify the target before editing.",
        ])
        for candidate in component_candidates[:8]:
            location = f"{candidate.get('path') or ''}:{candidate.get('line') or 1}"
            lines.append(
                f"  - confidence {candidate.get('confidence')}: {location}; "
                f"component={candidate.get('componentName') or ''}; "
                f"evidence={','.join(candidate.get('evidence') or [])}"
            )
    relations = [dict(item) for item in packet.get("spatialRelations") or [] if isinstance(item, dict)]
    if relations:
        lines.extend(["", "## Spatial relationships"])
        for item in relations:
            lines.append(
                f"- {item.get('from')} -> {item.get('to')}: "
                f"horizontal={item.get('horizontal')}, vertical={item.get('vertical')}, delta={item.get('delta')}"
            )
    relays = [dict(item) for item in packet.get("visualRelays") or [] if isinstance(item, dict)]
    if relays:
        lines.extend(["", "## Visual relay for text-only models and visual-capable targets"])
        for index, relay in enumerate(relays, 1):
            target = dict(relay.get("target") or {})
            lines.append(
                f"{index}. mode={relay.get('mode') or ''} object={target.get('objectId') or ''} "
                f"label={target.get('label') or ''}"
            )
            if relay.get("mode") == "direct_visual":
                lines.append(_bounded(relay.get("locatorText"), 2400))
            else:
                lines.append(_bounded(relay.get("structuredText"), 12_000))
    lines.extend([
        "",
        "## Relevant capabilities (bounded search)",
    ])
    for item in packet.get("capabilities") or []:
        lines.append(
            f"- {item.get('id')}: {item.get('title') or ''}; "
            f"risk={item.get('risk') or 'unknown'}; verification={item.get('verification') or 'unknown'}"
        )
    artifacts = [str(item) for item in packet.get("artifacts") or [] if str(item)]
    if artifacts:
        lines.extend(["", "## Policy-allowed local artifacts"])
        lines.extend(f"- {item}" for item in artifacts[:32])
    lines.extend([
        "",
        "## Privacy and execution boundary",
        f"- withheld visual objects: {privacy.get('withheldVisualObjectCount') or 0}",
        f"- uploadable visual objects: {privacy.get('uploadableVisualObjectCount') or 0}",
        "- Inspect the current workspace yourself before changing files.",
        "- Treat the pointed object and paths as location evidence, not as permission to access unrelated apps or repositories.",
        "- Do not send, submit, purchase, delete, or publish external data.",
        "- Verify any change on the relevant surface and report the exact artifact or target changed.",
        "- If the target no longer matches the lease, stop instead of modifying a similar object.",
    ])
    prompt = "\n".join(lines).rstrip()
    return prompt[:_MAX_PROMPT_CHARS]
