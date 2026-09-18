"""Lossless evidence factoring and read deduplication for provider requests.

The session owns the full receipts. This pure projection never edits the log,
and a duplicate only points at a result present in this same request.
"""

import json
from dataclasses import replace

from .types import AgentMessage, Role


def _factor_read_result(result: dict) -> dict:
    fragments = result.get("fragments")
    if not isinstance(fragments, list) or not fragments:
        return result
    if not all(isinstance(f, dict) and isinstance(f.get("locator"), dict) for f in fragments):
        return result
    projected = dict(result)
    projected.pop("latencyMs", None)  # The durable receipt retains actual timing.
    projected["fragments"] = fragments = [dict(f) for f in fragments]
    common_metadata = {}
    for key in ("sourceTitle", "sourceRevision"):
        values = [f.get("metadata", {}).get(key) for f in fragments]
        if values[0] is not None and all(v == values[0] for v in values):
            common_metadata[key] = values[0]
    if common_metadata:
        projected["sharedFragmentMetadata"] = common_metadata
    for fragment in fragments:
        metadata = {k: v for k, v in fragment.get("metadata", {}).items() if k not in common_metadata}
        if metadata:
            fragment["metadata"] = metadata
        else:
            fragment.pop("metadata", None)
        citation = {"sourceId": result.get("sourceId"), "locator": fragment["locator"]}
        if fragment.get("citations") == [citation]:
            fragment.pop("citations")
            projected["citationTemplate"] = {"sourceId": result["sourceId"], "locator": "fragment.locator"}
    coverage = result.get("coverage")
    if isinstance(coverage, dict) and coverage.get("readRanges") == [f["locator"] for f in fragments]:
        projected["coverage"] = {**coverage, "readRanges": "fragments[].locator"}
    return projected


def project_context_messages(messages: list[AgentMessage]) -> list[AgentMessage]:
    seen: dict[tuple[str, str], str] = {}
    projected = []
    for message in messages:
        if (message.role is not Role.TOOL or message.is_error or not message.tool_call_id
                or message.name not in {"Context.read", "Context.search", "Read", "read_file"}):
            projected.append(message)
            continue
        content = message.content or ""
        if message.name in {"Context.read", "Context.search"}:
            try:
                data = json.loads(content)
            except (ValueError, TypeError):
                projected.append(message)
                continue
            if not isinstance(data, dict):
                projected.append(message)
                continue
            rows = data.get("results", [data])
            if not isinstance(rows, list) or any(not isinstance(r, dict) or r.get("evidenceStatus")
                    not in {"ok", "degraded", "empty_confirmed"} for r in rows):
                projected.append(message)
                continue
            factored = ({**data, "results": [_factor_read_result(r) for r in rows]}
                        if "results" in data else _factor_read_result(data))
            content = json.dumps(factored, ensure_ascii=False, separators=(",", ":"))
        if len(content) >= 512:
            key = (message.name, content)
            previous = seen.get(key)
            if previous is not None:
                content = f"Read succeeded again; result identical to tool call {previous}, whose full content is above."
            else:
                seen[key] = message.tool_call_id
        projected.append(replace(message, content=content))
    return projected
