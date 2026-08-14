"""Model gateway health: know it is down before burning the user's time on it.

The 2026-08-04 acceptance run failed on a gateway that answered HTTP 402
(balance exhausted) to every request. Nothing knew that, so every single bubble
command paid a full model timeout first and only then fell back — the user saw
slow failures instead of fast honest ones, four scenarios in a row.

This module is the circuit breaker. A hard gateway verdict (auth, payment,
model-not-found) opens the circuit; while it is open, model calls return
immediately with a sentence a person can act on, and every non-model capability
keeps working. A success closes it again.

State lives in one small JSON file so the Electron side, the bridges, and any
worker process all see the same verdict without an IPC round trip.
"""

from __future__ import annotations

import json
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

# A balance problem does not fix itself in ten seconds; a 500 might. The cooldown
# is how long we trust a bad verdict before probing again.
COOLDOWN_S = {
    "payment_required": 240.0,
    "unauthorized": 240.0,
    "model_missing": 240.0,
    "rate_limited": 30.0,
    "unreachable": 20.0,
    "server_error": 20.0,
}
DEFAULT_COOLDOWN_S = 30.0

# Codes stage_contract.js knows how to say out loud.
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

# 限流有两种，对用户是完全不同的两件事：
#
#   短时突发限流 —— 等几十秒就好，「稍后自动重试」是对的。
#   套餐额度用完 —— 要等几个小时，或者去充值。这时候还说「稍后自动重试」，
#                   用户会以为是配置坏了，然后去改本来是对的配置。
#
# 网关自己在响应体里说清了恢复时间和解决办法（OpenCode Go 的 GoUsageLimitError
# 就带着「Resets in 3hr 45min」）。那句话原样带出来，比我们复述一遍准确。
_QUOTA_HINTS = re.compile(
    r"(usage limit|quota|insufficient|额度|配额|超出限制|resets? in)",
    re.IGNORECASE,
)
_RESET_HINT = re.compile(r"resets? in\s+([0-9]+\s*hr[^.,\"}]*|[0-9]+\s*min[^.,\"}]*)", re.IGNORECASE)


def _quota_detail(detail: str) -> str:
    """从网关的原始报错里摘出「什么时候恢复」这一句。

    只在确实是额度类报错时才摘——普通的突发限流没有恢复时间可说，
    硬编一个出来就是在撒谎。
    """
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
    state: str = "unknown"          # ok | unknown | one of COOLDOWN_S keys | unconfigured
    http_status: int | None = None
    detail: str = ""
    checked_at: float = 0.0
    open_until: float = 0.0
    model: str = ""
    base_url: str = ""

    @property
    def healthy(self) -> bool:
        return self.state == "ok"

    @property
    def circuit_open(self) -> bool:
        """True while we already know a model call cannot succeed."""
        return self.state not in ("ok", "unknown") and time.time() < self.open_until

    @property
    def error_code(self) -> str:
        return STATE_ERROR_CODES.get(self.state, "model_gateway_unreachable")

    @property
    def message(self) -> str:
        base = STATE_MESSAGES.get(self.state, "模型端点当前不可用，已跳过模型调用。")
        detail = _quota_detail(self.detail)
        return f"{base} {detail}" if detail else base

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
    """Show the host so a person can recognise it; never the query or key."""
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
    """Read the health entry for ``base_url`` (or the text endpoint when None).

    Health is stored per endpoint: a vision-endpoint failure must never open
    the circuit for the text endpoint and vice versa. With ``base_url=None``
    the currently configured text endpoint's entry is returned (lazy
    ``ai_client.get_ai_config``); if that endpoint has no entry, a legacy
    single-entry file or the ``""`` key is used as fallback. An unknown
    endpoint returns a blank :class:`GatewayHealth` (state ``unknown``).
    """
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
        # No single-entry fallback: one lone entry belongs to whichever
        # endpoint recorded it — using it for an unknown base_url made a
        # vision endpoint's circuit breaker short-circuit the text path
        # (fabric audit P2, per-endpoint isolation).
    return _health_from_raw(raw) if isinstance(raw, dict) else GatewayHealth()


def _configured_text_base_url() -> str:
    """The currently configured text endpoint, normalized; "" when unknown."""
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
    # Legacy v1 single-object file: adopt it under its own base_url (or "").
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
            # Unique temp name: two processes recording two endpoints at once
            # used to collide on one ".tmp" handle and one entry was lost
            # (fabric audit P2), silently reopening/covering a circuit.
            tmp = path.with_name(path.name + f".{uuid.uuid4().hex[:8]}.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except OSError:
            # Health tracking must never be the reason a command fails.
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
    )
    _write_health(health)
    return health


def record_note(
    *,
    detail: str = "",
    model: str = "",
    base_url: str = "",
) -> GatewayHealth:
    """Non-poisoning audit note: the endpoint stays healthy (state ok), the
    detail records a soft event like a streaming fallback."""
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
    health = GatewayHealth(
        state=state,
        http_status=status,
        detail=str(detail or exception_name)[:300],
        checked_at=now,
        open_until=now + COOLDOWN_S.get(state, DEFAULT_COOLDOWN_S),
        model=model,
        base_url=base_url,
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
    """The sentence to return instead of calling the model, or None to go ahead.

    The verdict is read per endpoint (``base_url``), so a downed vision
    gateway never suppresses text answers and vice versa. ``None`` reads the
    configured text endpoint's entry.
    """
    if os.environ.get("MAGIC_POINTER_IGNORE_MODEL_HEALTH") == "1":
        return None
    health = read_health(base_url)
    return health.message if health.circuit_open else None


def probe_gateway(*, timeout_s: float = 6.0) -> GatewayHealth:
    """Ask the gateway one cheap question and record the verdict.

    Called at startup and from the settings page. It uses /models rather than a
    completion so it costs nothing and still surfaces 401/402/404.
    """
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
        with httpx.Client(timeout=timeout_s, follow_redirects=True) as client:
            if api_mode == "messages":
                # Anthropic-compatible relays commonly have no /models route.
                # A one-token message verifies auth, model routing and actual
                # completion availability instead of declaring a healthy GET
                # endpoint while every user question times out.
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
