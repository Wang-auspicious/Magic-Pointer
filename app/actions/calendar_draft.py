from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.adapters.base import AdapterReadContext

_ENGLISH_INTENTS = (
    re.compile(r"^add\s+(?:this|it)\s+to\s+(?:(?:my|the)\s+)?calendar$", re.IGNORECASE),
    re.compile(r"^create\s+(?:a\s+)?calendar\s+event\s+from\s+(?:this|it)$", re.IGNORECASE),
)
_CHINESE_INTENTS = {
    "添加到日历",
    "加到日历",
    "加入日历",
    "把这个加入日历",
    "把它加入日历",
    "创建日程",
    "添加为日程",
}
_DATE_FULL = re.compile(r"(?P<year>20\d{2})\s*(?:年|[-/.])\s*(?P<month>\d{1,2})\s*(?:月|[-/.])\s*(?P<day>\d{1,2})\s*日?")
_DATE_MONTH_DAY = re.compile(r"(?<!\d)(?P<month>\d{1,2})\s*月\s*(?P<day>\d{1,2})\s*日")
_TIME_RANGE = re.compile(
    r"(?P<h1>[01]?\d|2[0-3])\s*[:：]\s*(?P<m1>[0-5]\d)\s*(?:-|—|–|~|～|至|到)\s*"
    r"(?P<h2>[01]?\d|2[0-3])\s*[:：]\s*(?P<m2>[0-5]\d)"
)
_TIME_24 = re.compile(r"(?<!\d)(?P<h>[01]?\d|2[0-3])\s*[:：]\s*(?P<m>[0-5]\d)(?!\d)")
_TIME_CHINESE = re.compile(r"(?P<period>上午|下午|晚上)?\s*(?P<h>\d{1,2})\s*点(?:\s*(?P<m>\d{1,2})\s*分?)?")
_LOCATION = re.compile(r"(?:地点|地址|会场|Location)\s*[:：]\s*(?P<value>.+)", re.IGNORECASE)


def wants_calendar_draft(command: str) -> bool:
    normalized = " ".join(str(command or "").strip().split())
    if normalized in _CHINESE_INTENTS:
        return True
    return any(pattern.fullmatch(normalized) for pattern in _ENGLISH_INTENTS)


def _date_from_text(text: str, current_year: int) -> tuple[str | None, list[str]]:
    warnings: list[str] = []
    match = _DATE_FULL.search(text)
    if match:
        values = (int(match["year"]), int(match["month"]), int(match["day"]))
    else:
        match = _DATE_MONTH_DAY.search(text)
        values = (current_year, int(match["month"]), int(match["day"])) if match else None
    if values:
        try:
            return datetime(*values).date().isoformat(), warnings
        except ValueError:
            warnings.append("识别到的日期无效，请重新选择日期。")
    if re.search(r"(?:今天|明天|后天|下周|本周|周[一二三四五六日天])", text):
        warnings.append("相对日期不会被自动猜测，请在日历卡片中确认具体日期。")
    return None, warnings


def _time_fields(text: str) -> tuple[str | None, str | None]:
    match = _TIME_RANGE.search(text)
    if match:
        start = time(int(match["h1"]), int(match["m1"]))
        end = time(int(match["h2"]), int(match["m2"]))
        return start.strftime("%H:%M"), end.strftime("%H:%M")
    match = _TIME_CHINESE.search(text)
    if match:
        hour = int(match["h"])
        minute = int(match["m"] or 0)
        period = match["period"]
        if period in {"下午", "晚上"} and hour < 12:
            hour += 12
        if period == "上午" and hour == 12:
            hour = 0
        if hour <= 23 and minute <= 59:
            start = datetime(2000, 1, 1, hour, minute)
            return start.strftime("%H:%M"), (start + timedelta(hours=1)).strftime("%H:%M")
    match = _TIME_24.search(text)
    if match:
        start = datetime(2000, 1, 1, int(match["h"]), int(match["m"]))
        return start.strftime("%H:%M"), (start + timedelta(hours=1)).strftime("%H:%M")
    return None, None


def _title(lines: list[str]) -> str:
    for line in lines:
        if _LOCATION.search(line):
            continue
        if _DATE_FULL.search(line) or _DATE_MONTH_DAY.search(line) or _TIME_RANGE.search(line):
            continue
        if _TIME_CHINESE.fullmatch(line) or _TIME_24.fullmatch(line):
            continue
        candidate = " ".join(line.split())
        if candidate:
            return candidate[:160]
    return ""


def parse_calendar_draft(
    ctx: AdapterReadContext,
    *,
    selection_snapshot_id: str,
    current_year: int | None = None,
) -> dict[str, Any]:
    timezone_name = os.environ.get("MAGIC_POINTER_TIMEZONE", "Asia/Shanghai")
    zone = ZoneInfo(timezone_name)
    if current_year is None:
        current_year = datetime.now(zone).year
    raw = str(ctx.content or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.strip() for line in raw.split("\n") if line.strip()]
    date_value, warnings = _date_from_text(raw, current_year)
    start_time, end_time = _time_fields(raw)
    location_match = _LOCATION.search(raw)
    location = " ".join(location_match["value"].split())[:240] if location_match else ""
    title = _title(lines)
    missing = [
        field
        for field, value in (("title", title), ("date", date_value), ("start_time", start_time), ("end_time", end_time))
        if not value
    ]
    event = None
    if not missing:
        start = datetime.fromisoformat(f"{date_value}T{start_time}:00").replace(tzinfo=zone)
        end = datetime.fromisoformat(f"{date_value}T{end_time}:00").replace(tzinfo=zone)
        if end <= start:
            end += timedelta(days=1)
        event = {
            "title": title,
            "start_at": start.isoformat(timespec="seconds"),
            "end_at": end.isoformat(timespec="seconds"),
            "timezone": timezone_name,
            "location": location,
            "notes": "",
            "all_day": False,
        }
    source = {
        "selection_snapshot_id": selection_snapshot_id,
        "app": ctx.app,
        "window_title": str((ctx.window or {}).get("title") or ""),
        "content_sha256": hashlib.sha256(raw.encode("utf-8", errors="surrogatepass")).hexdigest(),
    }
    identity = json.dumps({"snapshot": selection_snapshot_id, "event": event, "title": title}, ensure_ascii=False, sort_keys=True)
    return {
        "title": title,
        "date": date_value,
        "start_time": start_time,
        "end_time": end_time,
        "timezone": timezone_name,
        "location": location,
        "notes": "",
        "all_day": False,
        "missing_fields": missing,
        "warnings": warnings,
        "event": event,
        "source": source,
        "idempotency_key": "sha256:" + hashlib.sha256(identity.encode("utf-8")).hexdigest(),
    }
