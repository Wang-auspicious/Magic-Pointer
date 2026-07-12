from __future__ import annotations

import csv
import io
import re
from typing import Any

_ENGLISH = (re.compile(r"^merge\s+these\s+tables$", re.IGNORECASE),)
_CHINESE = {"合并这些表格", "把这些合成一张表", "把这些表格合并", "合并这几张表"}


def wants_table_merge(command: str) -> bool:
    normalized = " ".join(str(command or "").strip().split())
    return normalized in _CHINESE or any(pattern.fullmatch(normalized) for pattern in _ENGLISH)


def _markdown_rows(text: str) -> list[list[str]] | None:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 3 or not all("|" in line for line in lines[:3]):
        return None
    rows = [[cell.strip() for cell in line.strip("|").split("|")] for line in lines]
    if not all(re.fullmatch(r":?-{3,}:?", cell.replace(" ", "")) for cell in rows[1]):
        return None
    return [rows[0], *rows[2:]]


def parse_table(text: str, *, source_id: str) -> dict[str, Any]:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    markdown = _markdown_rows(raw)
    if markdown is not None:
        parsed = markdown
    else:
        sample = raw[:4096]
        delimiter = "\t" if "\t" in sample else "," if "," in sample else None
        if delimiter is None:
            return {"columns": [], "rows": [], "source_id": source_id, "error": "no supported table delimiter"}
        try:
            parsed = list(csv.reader(io.StringIO(raw), delimiter=delimiter))
        except csv.Error as exc:
            return {"columns": [], "rows": [], "source_id": source_id, "error": str(exc)}
    if len(parsed) < 2:
        return {"columns": [], "rows": [], "source_id": source_id, "error": "table needs a header and at least one row"}
    columns = [" ".join(cell.split()) for cell in parsed[0]]
    normalized = [column.casefold() for column in columns]
    if any(not column for column in columns) or len(set(normalized)) != len(columns):
        return {"columns": [], "rows": [], "source_id": source_id, "error": "table headers must be non-empty and unique"}
    if len(columns) > 80 or len(parsed) - 1 > 5000:
        return {"columns": [], "rows": [], "source_id": source_id, "error": "table exceeds local preview limits"}
    rows = []
    for values in parsed[1:]:
        if len(values) != len(columns):
            return {"columns": [], "rows": [], "source_id": source_id, "error": "ragged table row"}
        rows.append({column: str(value).strip() for column, value in zip(columns, values)})
    return {"columns": columns, "rows": rows, "source_id": source_id, "error": None}


def merge_episode_tables(interaction_episode: Any) -> dict[str, Any]:
    slots = interaction_episode.get("slots") if isinstance(interaction_episode, dict) else {}
    objects = slots.get("these") if isinstance(slots, dict) and isinstance(slots.get("these"), list) else []
    tables = [
        parse_table(obj.get("content") or "", source_id=str(obj.get("objectId") or f"source-{index}"))
        for index, obj in enumerate(objects)
        if isinstance(obj, dict)
    ]
    valid = [table for table in tables if not table["error"]]
    if len(valid) < 2:
        return {"columns": [], "rows": [], "sources": tables, "warnings": [table["error"] for table in tables if table["error"]], "missing_fields": ["tables"]}
    canonical: dict[str, str] = {}
    columns: list[str] = []
    for table in valid:
        for column in table["columns"]:
            key = column.casefold()
            if key not in canonical:
                canonical[key] = column
                columns.append(column)
    rows = []
    for table in valid:
        mapping = {column.casefold(): column for column in table["columns"]}
        for row in table["rows"]:
            merged = {column: row.get(mapping.get(column.casefold(), ""), "") for column in columns}
            merged["_source_id"] = table["source_id"]
            rows.append(merged)
    return {"columns": columns, "rows": rows, "sources": valid, "warnings": [], "missing_fields": []}


def _safe_cell(value: Any) -> str:
    text = str(value or "")
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def to_safe_csv(merged: dict[str, Any]) -> str:
    columns = [str(column) for column in merged.get("columns") or []]
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(columns)
    for row in merged.get("rows") or []:
        writer.writerow([_safe_cell(row.get(column, "")) for column in columns])
    return output.getvalue()
