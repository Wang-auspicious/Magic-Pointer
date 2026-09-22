
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

_HEALTH_LOCK = threading.RLock()

COOLDOWN_S = {
    "payment_required": 240.0,
    "unauthorized": 240.0,
    "model_missing": 240.0,
    "rate_limited": 30.0,
    "unreachable": 20.0,
    "server_error": 20.0,
}
DEFAULT_COOLDOWN_S = 30.0

_TRANSIENT_STATES = frozenset({"unreachable", "server_error", "rate_limited"})
_TRANSIENT_STREAK_TO_OPEN = 2

STATE_ERROR_CODES = {
    "payment_required": "model_gateway_payment_required",
    "unauthorized": "model_gateway_unauthorized",
    "model_missing": "model_profile_not_found",
    "unreachable": "model_gateway_unreachable",
    "rate_limited": "model_gateway_unreachable",
    "server_error": "model_gateway_unreachable",
    "unconfigured": "credential_missing",
}

STATE_MESSAGES = {
    "payment_required": "模型端点余额不足（HTTP 402），需要模型的能力都会失败。已跳过模型调用，直接用本地能力回答。请充值或在设置里换一个端点。",
    "unauthorized": "模型端点拒绝了密钥（HTTP 401/403）。已跳过模型调用。请在设置的「模型与网络」里更新密钥。",
    "model_missing": "模型端点里没有这个模型名。已跳过模型调用。请在设置的「模型与网络」里换一个模型。",
    "rate_limited": "模型端点限流中（HTTP 429）。已跳过模型调用，稍后会自动重试。",
    "unreachable": "连不上模型端点。已跳过模型调用，用本地能力尽力回答。",
    "server_error": "模型端点正在报错（5xx）。已跳过模型调用，稍后会自动重试。",
    "unconfigured": "还没有配置模型密钥，所以没有调用模型。可在设置的「模型与网络」里填写。",
}

_QUOTA_HINTS = re.compile(
    r"(usage limit|quota|insufficient|额度|配额|超出限制|resets? in)",
    re.IGNORECASE,
)
_RESET_HINT = re.compile(r"resets? in\s+([0-9]+\s*hr[^.,\"}]*|[0-9]+\s*min[^.,\"}]*)", re.IGNORECASE)


def _quota_detail(detail: str) -> str:
    text = str(detail or "")
    if not text or not _QUOTA_HINTS.search(text):
        return ""
    try:
        payload = json.loads(text)
        message = str(payload.get("error", {}).get("message") or "")
    except (ValueError, AttributeError):
        message = ""
    if not message:
        found = re.search(r'"message"\s*:\s*"([^"]{4,300})"', text)
        message = found.group(1) if found else ""
    if not message:
        return ""
    reset = _RESET_HINT.search(message)
    tail = f"（约 {reset.group(1).strip()} 后恢复）" if reset else ""
    return f"端点原话：{message.strip()[:200]}{tail}"



def _runtime_dir() -> Path:
    return Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or (ROOT / "data" / "runtime"))


def _state_path() -> Path:
    return _runtime_dir() / "model-health.json"


@dataclass
class GatewayHealth:
    state: str = "unknown"
    http_status: int | None = None
    detail: str = ""
    checked_at: float = 0.0
    open_until: float = 0.0
    model: str = ""
    base_url: str = ""
    transient_streak: int = 0

    @property
    def healthy(self) -> bool:
        return self.state == "ok"

    @property
    def circuit_open(self) -> bool:
        return self.state not in ("ok", "unknown") and time.time() < self.open_until

    @property
    def error_code(self) -> str:
        return STATE_ERROR_CODES.get(self.state, "model_gateway_unreachable")

    @property
    def message(self) -> str:
        base = STATE_MESSAGES.get(self.state, "模型端点当前不可用，已跳过模型调用。")
        detail = _quota_detail(self.detail)
        text = f"{base} {detail}" if detail else base
        if self.circuit_open and self.open_until > 0:
            remaining = max(1, math.ceil(self.open_until - time.time()))
            text = f"{text} 约 {remaining} 秒后可重试。"
        return text

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "healthy": self.healthy,
            "circuitOpen": self.circuit_open,
            "httpStatus": self.http_status,
            "detail": self.detail[:300],
            "checkedAt": round(self.checked_at, 3),
            "openUntil": round(self.open_until, 3),
            "model": self.model,
            "baseUrl": _redact_base_url(self.base_url),
            "message": "" if self.healthy else self.message,
            "errorCode": "" if self.healthy else self.error_code,
        }


def _redact_base_url(value: str) -> str:
    text = str(value or "")
    if "?" in text:
        text = text.split("?", 1)[0]
    return text[:120]


def state_for_status(status: int | None, exception_name: str = "") -> str:
    if status is None:
        return "unreachable" if exception_name else "unknown"
    if status == 402:
        return "payment_required"
    if status in (401, 403):
        return "unauthorized"
    if status == 404:
        return "model_missing"
    if status == 429:
        return "rate_limited"
    if status >= 500:
        return "server_error"
    if status >= 400:
        return "server_error"
    return "ok"


def read_health(base_url: str | None = None) -> GatewayHealth:
    entries = _read_entries()
    if base_url is not None:
        raw = entries.get(str(base_url).rstrip("/"))
    else:
        raw = None
        text = _configured_text_base_url()
        if text and text in entries:
            raw = entries[text]
        elif "" in entries:
            raw = entries[""]
    return _health_from_raw(raw) if isinstance(raw, dict) else GatewayHealth()


def _configured_text_base_url() -> str:
    try:
        from app.ai_client import get_ai_config

        _, base_url, _ = get_ai_config()
        return (str(base_url or "") or "").rstrip("/")
    except Exception:  # noqa: BLE001 - config lookup must never break health reads
        return ""


def _health_from_raw(raw: dict[str, Any]) -> GatewayHealth:
    health = GatewayHealth()
    for field in ("state", "detail", "model", "base_url"):
        value = raw.get(field)
        if isinstance(value, str):
            setattr(health, field, value)
    for field in ("checked_at", "open_until"):
        value = raw.get(field)
        if isinstance(value, (int, float)):
            setattr(health, field, float(value))
    streak = raw.get("transient_streak")
    if isinstance(streak, int) and streak > 0:
        health.transient_streak = streak
    status = raw.get("http_status")
    health.http_status = int(status) if isinstance(status, int) else None
    return health


def _read_entries() -> dict[str, Any]:
    try:
        raw = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    entries = raw.get("entries")
    if isinstance(entries, dict):
        return entries
    base = raw.get("base_url")
    key = base.rstrip("/") if isinstance(base, str) and base.strip() else ""
    return {key: raw}


def _write_health(health: GatewayHealth) -> None:
    path = _state_path()
    with _HEALTH_LOCK:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            entries = _read_entries()
            key = (health.base_url or "").rstrip("/")
            entries[key] = asdict(health)
            payload = {"schema": 2, "entries": entries}
            tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:8]}.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            pass


def record_success(*, model: str = "", base_url: str = "") -> GatewayHealth:
    health = GatewayHealth(
        state="ok",
        http_status=200,
        detail="",
        checked_at=time.time(),
        open_until=0.0,
        model=model,
        base_url=base_url,
        transient_streak=0,
    )
    _write_health(health)
    return health


def record_note(
    *,
    detail: str = "",
    model: str = "",
    base_url: str = "",
) -> GatewayHealth:
    health = GatewayHealth(
        state="ok",
        http_status=200,
        detail=str(detail)[:300],
        checked_at=time.time(),
        open_until=0.0,
        model=model,
        base_url=base_url,
    )
    _write_health(health)
    return health


def record_failure(
    *,
    status: int | None,
    detail: str = "",
    exception_name: str = "",
    model: str = "",
    base_url: str = "",
) -> GatewayHealth:
    state = state_for_status(status, exception_name)
    if state == "ok":
        return record_success(model=model, base_url=base_url)
    now = time.time()
    key = (base_url or "").rstrip("/")
    previous = read_health(key if base_url else None)
    if state in _TRANSIENT_STATES:
        streak = int(getattr(previous, "transient_streak", 0) or 0) + 1
        if streak < _TRANSIENT_STREAK_TO_OPEN:
            health = GatewayHealth(
                state=state,
                http_status=status,
                detail=str(detail or exception_name)[:300],
                checked_at=now,
                open_until=0.0,
                model=model,
                base_url=base_url,
                transient_streak=streak,
            )
            _write_health(health)
            return health
    else:
        streak = int(getattr(previous, "transient_streak", 0) or 0)
    health = GatewayHealth(
        state=state,
        http_status=status,
        detail=str(detail or exception_name)[:300],
        checked_at=now,
        open_until=now + COOLDOWN_S.get(state, DEFAULT_COOLDOWN_S),
        model=model,
        base_url=base_url,
        transient_streak=streak,
    )
    _write_health(health)
    return health


def record_unconfigured() -> GatewayHealth:
    now = time.time()
    health = GatewayHealth(
        state="unconfigured",
        http_status=None,
        detail="no api key",
        checked_at=now,
        open_until=now + DEFAULT_COOLDOWN_S,
    )
    _write_health(health)
    return health


def clear_health() -> None:
    try:
        _state_path().unlink()
    except OSError:
        pass


def short_circuit_message(base_url: str | None = None) -> str | None:
    if os.environ.get("MAGIC_POINTER_IGNORE_MODEL_HEALTH") == "1":
        return None
    health = read_health(base_url)
    return health.message if health.circuit_open else None


def probe_gateway(*, timeout_s: float = 6.0) -> GatewayHealth:
    from app.ai_client import (
        _completion_endpoint,
        _completion_headers,
        get_ai_api_mode,
        get_ai_config,
    )

    api_key, base_url, model = get_ai_config()
    if not api_key:
        return record_unconfigured()
    endpoint = (base_url or "https://api.openai.com/v1").rstrip("/")
    try:
        import httpx

        api_mode = get_ai_api_mode(endpoint)
        with httpx.Client(timeout=timeout_s, follow_redirects=False) as client:
            if api_mode == "messages":
                response = client.post(
                    _completion_endpoint(endpoint, api_mode),
                    headers=_completion_headers(str(api_key), api_mode),
                    json={
                        "model": model,
                        "max_tokens": 1,
                        "messages": [{"role": "user", "content": "Reply OK"}],
                    },
                )
            else:
                response = client.get(
                    f"{endpoint}/models",
                    headers={"Authorization": f"Bearer {api_key}", "User-Agent": "curl/8.0"},
                )
        if response.status_code < 400:
            return record_success(model=model, base_url=endpoint)
        return record_failure(
            status=response.status_code,
            detail=response.text[:300],
            model=model,
            base_url=endpoint,
        )
    except Exception as exc:  # noqa: BLE001 - any transport failure is "unreachable"
        return record_failure(
            status=None,
            exception_name=type(exc).__name__,
            detail=str(exc)[:300],
            model=model,
            base_url=endpoint,
        )
