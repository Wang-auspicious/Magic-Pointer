"""Run one office/design acceptance case through Magic Pointer's own Runtime.

This is intentionally a small local runner, not a second eval platform.  It
launches ``scripts/conversation_bridge.py`` with the same payload shape as
Studio, captures Runtime progress/result records, and writes a local report.
The deterministic assessment never substitutes for the case's manual checks.

Examples::

    python scripts/eval_office_scenarios.py --case O03 \
      --fixture contract_pdf=D:/fixtures/contract.pdf

    python scripts/eval_office_scenarios.py --case D01 \
      --fixture mixed_font_deck=D:/fixtures/deck.pptx \
      --permission-preset workspace-write --model-config secrets/eval-model.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
DEFAULT_CATALOG = PROJECT_ROOT / "docs" / "evals" / "office-design-cases.json"
DEFAULT_OUTPUT_ROOT = PROJECT_ROOT / "data" / "runtime" / "evals"
EXPECTED_CASE_IDS = (
    "O01", "O02", "O03", "O04", "O05", "D01",
    "D02", "D03", "C01", "C02", "C03", "C04",
)
ASSERTION_KEYS = {
    "requiredEvidenceIds",
    "requiredModifiedTargets",
    "requiredUnchangedTargets",
    "requiredStates",
    "forbiddenEffects",
    "requiresReopenableArtifact",
}
SECRET_KEY = re.compile(r"(?:api.?key|authorization|credential|password|secret|token)", re.I)
SECRET_VALUE = re.compile(r"\b(?:sk|key|token)-[A-Za-z0-9._-]{12,}\b")
PDF_PAGE_INDEX = re.compile(r"[\"']pageIndex[\"']\s*:\s*(\d+)")
PAGE_CITATION = re.compile(r"(?:第\s*\d+\s*页|\bpage\s+\d+\b)", re.I)
LIABILITY_CONTEXT = re.compile(r"(?:liability|aggregate\s+cap|责任限制|责任上限)", re.I)
PROGRESS_PREFIX = "@@mp "


def _string_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{name} must be a list of non-empty strings")
    if len(value) != len(set(value)):
        raise ValueError(f"{name} contains duplicate values")
    return list(value)


def load_case_catalog(path: Path | str = DEFAULT_CATALOG) -> dict[str, dict[str, Any]]:
    """Load and validate the committed twelve-case catalog in declared order."""

    catalog_path = Path(path)
    raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise ValueError("office scenario catalog schemaVersion must be 1")
    cases = raw.get("cases")
    if not isinstance(cases, list):
        raise ValueError("office scenario catalog cases must be an array")
    by_id: dict[str, dict[str, Any]] = {}
    for index, value in enumerate(cases):
        if not isinstance(value, dict):
            raise ValueError(f"cases[{index}] must be an object")
        case_id = str(value.get("id") or "").strip()
        if not case_id or case_id in by_id:
            raise ValueError(f"invalid or duplicate case id at cases[{index}]")
        if not str(value.get("userRequest") or "").strip():
            raise ValueError(f"{case_id}.userRequest is required")
        fixtures = value.get("fixtures")
        if not isinstance(fixtures, list) or not fixtures:
            raise ValueError(f"{case_id}.fixtures must be a non-empty array")
        aliases: set[str] = set()
        for fixture in fixtures:
            if not isinstance(fixture, dict):
                raise ValueError(f"{case_id}.fixtures entries must be objects")
            alias = str(fixture.get("alias") or "").strip()
            if not alias or alias in aliases:
                raise ValueError(f"{case_id} has an invalid or duplicate fixture alias")
            aliases.add(alias)
        assertions = value.get("assertions")
        if not isinstance(assertions, dict) or set(assertions) != ASSERTION_KEYS:
            raise ValueError(f"{case_id}.assertions must declare exactly {sorted(ASSERTION_KEYS)}")
        for key in ASSERTION_KEYS - {"requiresReopenableArtifact"}:
            _string_list(assertions[key], f"{case_id}.assertions.{key}")
        if not isinstance(assertions["requiresReopenableArtifact"], bool):
            raise ValueError(f"{case_id}.assertions.requiresReopenableArtifact must be boolean")
        _string_list(value.get("manualChecks"), f"{case_id}.manualChecks")
        by_id[case_id] = value
    if tuple(by_id) != EXPECTED_CASE_IDS:
        raise ValueError(
            f"office scenario catalog ids/order must be {list(EXPECTED_CASE_IDS)}, got {list(by_id)}"
        )
    return by_id


def _normalized_observation(value: Mapping[str, Any] | None) -> dict[str, Any]:
    raw = dict(value or {})
    normalized: dict[str, Any] = {}
    for key in ("evidenceIds", "modifiedTargets", "unchangedTargets", "effects", "states"):
        items = raw.get(key) if isinstance(raw.get(key), list) else []
        normalized[key] = sorted({str(item) for item in items if str(item).strip()})
    normalized["reopenableArtifact"] = raw.get("reopenableArtifact") is True
    normalized["trajectory"] = list(raw.get("trajectory") or []) if isinstance(raw.get("trajectory"), list) else []
    return normalized


def assess_observation(case: Mapping[str, Any], observation: Mapping[str, Any] | None) -> dict[str, Any]:
    """Compare exact observable state with one case's deterministic boundary."""

    observed = _normalized_observation(observation)
    assertions = dict(case.get("assertions") or {})
    failures: list[str] = []
    pairs = (
        ("requiredEvidenceIds", "evidenceIds", "required evidence"),
        ("requiredModifiedTargets", "modifiedTargets", "required modified target"),
        ("requiredUnchangedTargets", "unchangedTargets", "required unchanged target"),
        ("requiredStates", "states", "required state"),
    )
    for required_key, observed_key, label in pairs:
        for expected in assertions.get(required_key) or []:
            if expected not in observed[observed_key]:
                failures.append(f"missing {label}: {expected}")
    for target in assertions.get("requiredUnchangedTargets") or []:
        if target in observed["modifiedTargets"]:
            failures.append(f"required unchanged target was modified: {target}")
    for effect in assertions.get("forbiddenEffects") or []:
        if effect in observed["effects"]:
            failures.append(f"forbidden effect observed: {effect}")
    if assertions.get("requiresReopenableArtifact") and not observed["reopenableArtifact"]:
        failures.append("required artifact was not reopened successfully")
    return {
        "caseId": str(case.get("id") or ""),
        "deterministicPassed": not failures,
        "failures": failures,
        "manualRequired": bool(case.get("manualChecks")),
        "manualChecks": list(case.get("manualChecks") or []),
        "observed": observed,
    }


def build_runtime_payload(
    case: Mapping[str, Any],
    *,
    fixtures: Mapping[str, Path],
    model_runtime: Mapping[str, Any] | None = None,
    request_id: str | None = None,
    workspace_root: Path | None = None,
    permission_preset: str = "read-only",
) -> dict[str, Any]:
    """Build the Studio-compatible request consumed by conversation_bridge."""

    if permission_preset not in {"read-only", "workspace-write"}:
        raise ValueError("eval runner permission preset must be read-only or workspace-write")
    fixture_specs = list(case.get("fixtures") or [])
    required = {
        str(spec.get("alias")) for spec in fixture_specs
        if isinstance(spec, dict) and spec.get("required") is not False
    }
    missing = sorted(required - set(fixtures))
    if missing:
        raise ValueError(f"missing required fixture(s) for {case.get('id')}: {', '.join(missing)}")
    resolved = {alias: Path(value).expanduser().resolve() for alias, value in fixtures.items()}
    absent = sorted(alias for alias, value in resolved.items() if not value.exists())
    if absent:
        raise ValueError(f"fixture path does not exist: {', '.join(absent)}")
    attachments = [str(resolved[alias]) for alias in resolved]
    rid = str(request_id or f"eval-{case.get('id', 'case').lower()}-{uuid.uuid4().hex[:12]}")
    captured_at = int(time.time() * 1000)
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "-", rid).strip("-")[:80] or uuid.uuid4().hex
    session_id = f"agent-studio-new-{safe_id}"
    source_ids = [f"source:attachment:{path.as_posix()}" for path in resolved.values()]
    question = str(case.get("userRequest") or "").strip()
    payload: dict[str, Any] = {
        "question": question,
        "turns": [],
        "object": {
            "app": "Magic Pointer Eval",
            "label": str(case.get("title") or case.get("id") or "Office scenario"),
            "caseId": str(case.get("id") or ""),
        },
        "permissionPreset": permission_preset,
        "effort": "high",
        "requestId": rid,
        "agentSessionId": session_id,
        "attachments": attachments,
        "taskInput": {
            "inputId": f"input:{safe_id}",
            "taskId": session_id,
            "target": "next-step",
            "instruction": question,
            "referenceUpdates": [],
            "sourceIds": source_ids,
            "timeline": [{
                "eventId": f"utterance:input:{safe_id}",
                "kind": "utterance",
                "startMs": captured_at,
                "endMs": captured_at,
                "text": question,
            }],
            "capturedAtMs": captured_at,
        },
        "modelRuntime": dict(model_runtime or {}),
    }
    if workspace_root is not None:
        payload["workspaceRoot"] = str(Path(workspace_root).expanduser().resolve())
    return payload


def _replace_fixture_paths(text: str, replacements: Mapping[str, str]) -> str:
    result = text
    for path_text, alias in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        for spelling in {path_text, path_text.replace("\\", "/"), path_text.replace("/", "\\") }:
            if spelling:
                result = result.replace(spelling, f"<fixture:{alias}>")
    result = SECRET_VALUE.sub("[redacted-secret]", result)
    return result if len(result) <= 12_000 else result[:12_000] + "…[truncated]"


def sanitize_for_report(
    value: Any,
    *,
    fixture_paths: Mapping[Path, str] | None = None,
) -> Any:
    """Redact credentials and replace private fixture paths with stable aliases."""

    replacements = {
        str(Path(path).expanduser().resolve()): str(alias)
        for path, alias in (fixture_paths or {}).items()
    }

    def visit(current: Any, key: str = "") -> Any:
        if SECRET_KEY.search(key):
            return "[redacted]"
        if isinstance(current, Mapping):
            return {str(item_key): visit(item_value, str(item_key)) for item_key, item_value in current.items()}
        if isinstance(current, (list, tuple)):
            return [visit(item) for item in current]
        if isinstance(current, Path):
            current = str(current)
        if isinstance(current, str):
            return _replace_fixture_paths(current, replacements)
        return current

    return visit(value)


def _parse_progress(stderr: str) -> tuple[list[dict[str, Any]], list[str]]:
    records: list[dict[str, Any]] = []
    diagnostics: list[str] = []
    for line in stderr.splitlines():
        if not line.startswith(PROGRESS_PREFIX):
            if line.strip():
                diagnostics.append(line[:2_000])
            continue
        fields: dict[str, Any] = {}
        for token in line[len(PROGRESS_PREFIX):].split():
            key, separator, raw_value = token.partition("=")
            if not separator:
                continue
            if key in {"ms", "d", "turn"}:
                try:
                    fields[key] = int(raw_value)
                    continue
                except ValueError:
                    pass
            fields[key] = raw_value
        records.append(fields)
    return records, diagnostics


def _last_json(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise RuntimeError("Magic Pointer Runtime returned no JSON result")


def run_mp_runtime(payload: Mapping[str, Any], *, timeout_seconds: float = 0) -> dict[str, Any]:
    """Invoke the same MP conversation bridge as Studio; never call a model directly."""

    command = [sys.executable, str(PROJECT_ROOT / "scripts" / "conversation_bridge.py")]
    started = time.perf_counter()
    process = subprocess.Popen(
        command,
        cwd=PROJECT_ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=os.environ.copy(),
    )
    try:
        stdout, stderr = process.communicate(
            json.dumps(dict(payload), ensure_ascii=False) + "\n",
            timeout=timeout_seconds if timeout_seconds > 0 else None,
        )
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate()
        raise RuntimeError(f"eval runner timeout after {timeout_seconds:g}s")
    progress, diagnostics = _parse_progress(stderr)
    result = _last_json(stdout)
    return {
        "exitCode": process.returncode,
        "wallTimeMs": round((time.perf_counter() - started) * 1000, 1),
        "progress": progress,
        "diagnostics": diagnostics,
        "result": result,
    }


def _collect_string_values(value: Any, keys: set[str]) -> set[str]:
    found: set[str] = set()
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key) in keys:
                if isinstance(child, str) and child:
                    found.add(child)
                elif isinstance(child, Sequence) and not isinstance(child, (str, bytes)):
                    found.update(str(item) for item in child if str(item).strip())
            found.update(_collect_string_values(child, keys))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for child in value:
            found.update(_collect_string_values(child, keys))
    return found


def observation_from_runtime(run: Mapping[str, Any]) -> dict[str, Any]:
    """Extract only facts the Runtime record actually exposes; leave the rest missing."""

    result = run.get("result") if isinstance(run.get("result"), Mapping) else {}
    evidence = _collect_string_values(result, {"evidenceId", "sourceId", "referenceId"})
    modified = _collect_string_values(result, {"modifiedTarget", "modifiedTargets", "targetIdentity"})
    unchanged = _collect_string_values(result, {"unchangedTarget", "unchangedTargets"})
    effects = _collect_string_values(result, {"effect", "effects"})
    states = _collect_string_values(result, {"state", "status"})
    trajectory = list(result.get("trajectory") or []) if isinstance(result.get("trajectory"), list) else []
    tool_names = _collect_string_values(trajectory, {"tool", "name", "toolName"})
    runtime_events = list(result.get("events") or []) if isinstance(result.get("events"), list) else []
    for event in runtime_events:
        if not isinstance(event, Mapping):
            continue
        tool_name = str(event.get("name") or event.get("toolName") or "").strip()
        if tool_name:
            tool_names.add(tool_name)
        result_text = str(event.get("result") or "")
        page_indexes = sorted({
            int(match.group(1)) for match in PDF_PAGE_INDEX.finditer(result_text)
        })
        for page_index in page_indexes:
            evidence.add(f"pdf:page:{page_index + 1}")
        arguments = event.get("arguments")
        query = (
            str(arguments.get("query") or "")
            if isinstance(arguments, Mapping)
            else ""
        )
        has_adjacent_pages = any(
            right == left + 1
            for left, right in zip(page_indexes, page_indexes[1:])
        )
        if (
            tool_name in {"Context.read", "Context.search"}
            and has_adjacent_pages
            and LIABILITY_CONTEXT.search(f"{query}\n{result_text}")
        ):
            evidence.add("pdf:liability-neighborhood")
    if result.get("ok") is True:
        states.add("runtime-completed")
    if PAGE_CITATION.search(str(result.get("answer") or "")):
        states.add("page-citation-present")
    lowered_tools = {name.casefold() for name in tool_names}
    if any("send" in name for name in lowered_tools):
        effects.add("send")
    if any("delete" in name or "remove" in name for name in lowered_tools):
        effects.add("delete")
    reopenable = False
    for artifact in result.get("artifacts") or []:
        if not isinstance(artifact, Mapping):
            continue
        for key in ("path", "outputPath", "artifactPath"):
            raw_path = artifact.get(key)
            if isinstance(raw_path, str) and raw_path and Path(raw_path).exists():
                reopenable = True
    return {
        "evidenceIds": sorted(evidence),
        "modifiedTargets": sorted(modified),
        "unchangedTargets": sorted(unchanged),
        "effects": sorted(effects),
        "states": sorted(states),
        "reopenableArtifact": reopenable,
        "trajectory": trajectory,
        "toolNames": sorted(tool_names),
    }


def _git_value(*args: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *args],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def environment_record(model_runtime: Mapping[str, Any]) -> dict[str, Any]:
    package = json.loads((PROJECT_ROOT / "package.json").read_text(encoding="utf-8"))
    return {
        "commit": _git_value("rev-parse", "HEAD"),
        "dirty": bool(_git_value("status", "--porcelain")),
        "packageVersion": str(package.get("version") or ""),
        "python": sys.version.split()[0],
        "modelRuntime": dict(model_runtime),
    }


def _parse_fixture_arguments(values: Sequence[str]) -> dict[str, Path]:
    fixtures: dict[str, Path] = {}
    for value in values:
        alias, separator, raw_path = value.partition("=")
        alias = alias.strip()
        raw_path = raw_path.strip()
        if not separator or not alias or not raw_path:
            raise ValueError(f"fixture must use alias=path: {value}")
        if alias in fixtures:
            raise ValueError(f"duplicate fixture alias: {alias}")
        fixtures[alias] = Path(raw_path).expanduser().resolve()
    return fixtures


def _resolve_fixture_directory(case: Mapping[str, Any], directory: Path) -> dict[str, Path]:
    fixtures: dict[str, Path] = {}
    if not directory.exists():
        raise ValueError(f"fixtures directory does not exist: {directory}")
    for spec in case.get("fixtures") or []:
        alias = str(spec.get("alias") or "")
        exact = directory / alias
        matches = [exact] if exact.exists() else sorted(directory.glob(f"{alias}.*"))
        if len(matches) == 1:
            fixtures[alias] = matches[0].resolve()
        elif len(matches) > 1:
            raise ValueError(f"multiple fixtures match {alias} in {directory}")
    return fixtures


def _load_model_runtime(path: Path | None) -> dict[str, Any]:
    if path is None:
        from app.ai_client import get_ai_api_mode, get_ai_config

        credential, base_url, model = get_ai_config()
        return {
            "provider": "local-config",
            "credential": credential or "",
            "baseUrl": base_url or "",
            "model": model,
            "apiMode": get_ai_api_mode(base_url),
        }
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("model config must be a JSON object")
    return {
        "provider": str(raw.get("provider") or "eval-config"),
        "credential": str(raw.get("credential") or raw.get("apiKey") or ""),
        "baseUrl": str(raw.get("baseUrl") or raw.get("base_url") or ""),
        "model": str(raw.get("model") or ""),
        "apiMode": str(raw.get("apiMode") or raw.get("api_mode") or ""),
    }


def _write_report(output_root: Path, case_id: str, report: Mapping[str, Any]) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = output_root / case_id / f"{stamp}-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=False)
    report_path = run_dir / "report.json"
    report_path.write_text(json.dumps(dict(report), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report_path


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True, choices=EXPECTED_CASE_IDS, help="case id from the committed catalog")
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    parser.add_argument("--fixture", action="append", default=[], metavar="ALIAS=PATH")
    parser.add_argument("--fixtures-dir", type=Path)
    parser.add_argument("--model-config", type=Path, help="optional Runtime model JSON; credentials are redacted in reports")
    parser.add_argument("--workspace-root", type=Path)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_ROOT)
    parser.add_argument("--permission-preset", choices=("read-only", "workspace-write"), default="read-only")
    parser.add_argument("--timeout-seconds", type=float, default=0, help="runner guard only; 0 means no wall timeout")
    parser.add_argument("--dry-run", action="store_true", help="validate inputs and write a manifest without launching Runtime")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        catalog = load_case_catalog(args.catalog)
        case = catalog[args.case]
        fixtures = _resolve_fixture_directory(case, args.fixtures_dir.resolve()) if args.fixtures_dir else {}
        fixtures.update(_parse_fixture_arguments(args.fixture))
        model_runtime = _load_model_runtime(args.model_config.resolve() if args.model_config else None)
        payload = build_runtime_payload(
            case,
            fixtures=fixtures,
            model_runtime=model_runtime,
            workspace_root=args.workspace_root,
            permission_preset=args.permission_preset,
        )
        fixture_aliases = {path.resolve(): alias for alias, path in fixtures.items()}
        if args.dry_run:
            run: dict[str, Any] = {"dryRun": True, "result": {"ok": False, "status": "not-run"}}
            observation = _normalized_observation(None)
        else:
            run = run_mp_runtime(payload, timeout_seconds=max(0, args.timeout_seconds))
            observation = observation_from_runtime(run)
        assessment = assess_observation(case, observation)
        report = sanitize_for_report({
            "recordedAt": datetime.now(timezone.utc).isoformat(),
            "case": case,
            "environment": environment_record(model_runtime),
            "input": {
                "question": payload["question"],
                "fixtureAliases": list(fixtures),
                "permissionPreset": payload["permissionPreset"],
                "workspaceRoot": payload.get("workspaceRoot"),
            },
            "sources": (run.get("result") or {}).get("taskContext", {}).get("sources", [])
                if isinstance(run.get("result"), Mapping) else [],
            "progress": run.get("progress", []),
            "trajectory": (run.get("result") or {}).get("trajectory", [])
                if isinstance(run.get("result"), Mapping) else [],
            "receipts": (run.get("result") or {}).get("receipts", [])
                if isinstance(run.get("result"), Mapping) else [],
            "artifacts": (run.get("result") or {}).get("artifacts", [])
                if isinstance(run.get("result"), Mapping) else [],
            "runtime": run,
            "assessment": assessment,
            "acceptanceStatus": "manual-required" if not args.dry_run else "not-run",
        }, fixture_paths=fixture_aliases)
        report_path = _write_report(args.output_dir.resolve(), args.case, report)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        parser.error(str(error))
        return 2
    print(json.dumps({
        "ok": not args.dry_run and bool((run.get("result") or {}).get("ok")),
        "dryRun": bool(args.dry_run),
        "caseId": args.case,
        "usedBackend": (run.get("result") or {}).get("usedBackend"),
        "timingMs": (run.get("result") or {}).get("timingMs"),
        "deterministicPassed": assessment["deterministicPassed"],
        "manualRequired": assessment["manualRequired"],
        "report": str(report_path),
    }, ensure_ascii=False))
    if args.dry_run:
        return 0
    return 0 if (run.get("result") or {}).get("ok") is True else 3


if __name__ == "__main__":
    raise SystemExit(main())
