from __future__ import annotations

import base64
import json
import os
import re
import time
from io import BytesIO
from pathlib import Path

from app.model_health import (
    record_failure,
    record_success,
    record_unconfigured,
    short_circuit_message,
)

ROOT = Path(__file__).resolve().parents[1]
SECRETS_DIR = ROOT / "secrets"

LabeledImage = tuple[str, Path]


DEFAULT_SYSTEM_PROMPT = """你是 Magic Pointer Open 的屏幕对象助手。
用户刚刚框选了屏幕上的一个局部区域，并用短指令询问它。
请基于截图内容直接回答。若截图信息不足，请明确说缺什么，不要编造。
若识别文本疑似不完整（被截断、缺行缺字），请提示用户重新划线框选，不要输出“这句话被截断了”之类的解释性废话。
输出要短、可执行、中文优先；需要时给出步骤或要点。

指点能力：当你的回答提到屏幕上某个具体元素（按钮、图标、卡片、菜单项、
输入框等）时，可以在提到它的那句话末尾加指点标记，让光标飞过去指给你看：
[POINT x,y] —— x、y 是物理屏幕像素坐标，必须是回答里确实提到的元素，
只能给 1-3 个，坐标不在当前屏幕上就不要加。标记只用于指点，不会被
复制进文档，放心使用。"""



def _plain_error_excerpt(text: str, limit: int = 220) -> str:
    """Turn gateway HTML/error pages into a compact user-facing message."""

    text = re.sub(r"<script[\s\S]*?</script>", " ", text or "", flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return "\u670d\u52a1\u7aef\u6ca1\u6709\u8fd4\u56de\u53ef\u8bfb\u9519\u8bef\u4fe1\u606f\u3002"
    return text[:limit]

def read_local_secret(name: str) -> str | None:
    if os.getenv("MAGIC_POINTER_DISABLE_LOCAL_SECRETS") == "1":
        return None
    path = SECRETS_DIR / name
    try:
        value = path.read_text(encoding="utf-8").strip()
        return value or None
    except FileNotFoundError:
        return None


def get_ai_config() -> tuple[str | None, str | None, str]:
    api_key = os.getenv("OPENAI_API_KEY") or read_local_secret("openai_key.txt")
    base_url = os.getenv("OPENAI_BASE_URL") or read_local_secret("openai_base_url.txt")
    model = os.getenv("MAGIC_POINTER_MODEL") or read_local_secret("model.txt") or "gpt-4o-mini"
    return api_key, base_url, model


def get_ai_api_mode(base_url: str | None = None) -> str:
    """Protocol for the configured gateway; legacy installs stay OpenAI-compatible."""
    explicit = os.getenv("MAGIC_POINTER_API_MODE") or read_local_secret("model_api_mode.txt")
    mode = str(explicit or "").strip().casefold()
    if mode in {"messages", "anthropic"}:
        return "messages"
    if mode in {"chat-completions", "openai"}:
        return "chat-completions"
    return "messages" if "/anthropic" in str(base_url or "").casefold() else "chat-completions"


def get_vision_model(text_model: str) -> str:
    """Vision calls may use a different model than the text path.

    The default text model is often text-only; a separate vision model is
    configured via MAGIC_POINTER_VISION_MODEL or secrets/vision_model.txt.
    """
    return os.getenv("MAGIC_POINTER_VISION_MODEL") or read_local_secret("vision_model.txt") or text_model


def get_vision_base_url(text_base_url: str | None) -> str | None:
    """Vision may live on a different gateway than the text model.

    Configured via MAGIC_POINTER_VISION_BASE_URL or secrets/vision_base_url.txt;
    falls back to the text-path gateway.
    """
    return os.getenv("MAGIC_POINTER_VISION_BASE_URL") or read_local_secret("vision_base_url.txt") or text_base_url


def get_vision_key(text_api_key: str | None) -> str | None:
    """Vision may use its own credential (e.g. a Google AI Studio key).

    Configured via MAGIC_POINTER_VISION_KEY or secrets/vision_key.txt;
    falls back to the text-path key.
    """
    return os.getenv("MAGIC_POINTER_VISION_KEY") or read_local_secret("vision_key.txt") or text_api_key


# ── vision capability classification ─────────────────────────────────
# Adapted from external/claude-code-vision-skill/vision/vision.py
# (TEXT_ONLY_MODEL_PATTERNS). A text-only model that receives an image
# usually returns HTTP 200 with empty content: one wasted request plus a
# confusing empty answer. Classifying upfront lets the vision path refuse
# honestly instead of guessing. Unknown models are never refused.
# Measured on OpenCode Go 2026-08-07 (data/runtime/probe_go_vision.py):
#   vision OK: kimi-k3, qwen3.7-plus   |   text-only: deepseek-*, glm-5.1/5.2,
#   hy3, mimo-v2-omni (unserved)       |   glm-5v / glm-4.6v are the vision lines.
_TEXT_ONLY_MODEL_PATTERNS = (
    re.compile(r"deepseek"),
    re.compile(r"glm-4\.[56](?!v)"),
    re.compile(r"glm-5(?!v)"),
    re.compile(r"kimi-k2-"),
    re.compile(r"qwen3-coder"),
    re.compile(r"devstral"),
    re.compile(r"hy3"),
)

_VISION_MODEL_PATTERNS = (
    re.compile(r"kimi-k3"),
    re.compile(r"kimi-k2\.[5-9]"),
    re.compile(r"qwen3\.[5-9]-plus"),
    re.compile(r"qwen3\.8-max"),
)


def classify_vision_capability(model: str) -> bool | None:
    """True = known vision model; False = known text-only; None = unknown.

    Only an explicit False refuses the call; None and True both proceed
    (unknown may still see images — a mislabeled model is cheaper than a
    blocked call).
    """
    m = str(model or "").casefold()
    for pattern in _TEXT_ONLY_MODEL_PATTERNS:
        if pattern.search(m):
            return False
    for pattern in _VISION_MODEL_PATTERNS:
        if pattern.search(m):
            return True
    return None


def get_vision_api_mode(base_url: str | None = None) -> str:
    """Protocol for the vision model; falls back to the text-path detection."""
    explicit = os.getenv("MAGIC_POINTER_VISION_API_MODE") or read_local_secret("vision_api_mode.txt")
    mode = str(explicit or "").strip().casefold()
    if mode in {"messages", "anthropic"}:
        return "messages"
    if mode in {"chat-completions", "openai"}:
        return "chat-completions"
    return get_ai_api_mode(base_url)


def _completion_endpoint(base_url: str | None, api_mode: str) -> str:
    base = (base_url or "https://api.openai.com/v1").rstrip("/")
    if api_mode == "messages":
        return f"{base}/messages" if base.endswith("/v1") else f"{base}/v1/messages"
    return f"{base}/chat/completions"


def _completion_headers(api_key: str, api_mode: str) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "User-Agent": "curl/8.0"}
    if api_mode == "messages":
        headers.update({"x-api-key": api_key, "anthropic-version": "2023-06-01"})
    else:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _text_completion_payload(
    *,
    model: str,
    content: str,
    system_prompt: str,
    max_tokens: int,
    api_mode: str,
) -> dict:
    if api_mode == "messages":
        return {
            "model": model,
            "system": system_prompt,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max(1, int(max_tokens)),
            "thinking": {"type": "disabled"},
        }
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "max_tokens": max(1, int(max_tokens)),
        # Reasoning models (deepseek-v4-flash on Go etc.) would spend the whole
        # max_tokens budget on thinking and return empty content. Same
        # contract as the messages branch: thinking off by default. Gateways
        # that reject the param get a stripped retry (see ask_text_model).
        "thinking": {"type": "disabled"},
    }


def _text_completion_response(data: dict, api_mode: str) -> str:
    if api_mode == "messages":
        return "\n".join(
            str(block.get("text") or "")
            for block in list(data.get("content") or [])
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
    return str(data["choices"][0]["message"].get("content") or "")


def _empty_answer_evidence(data: dict, api_mode: str) -> str:
    """Diagnostics for an HTTP-200-but-empty-answer response.

    The common failure is a reasoning model spending its whole max_tokens
    budget on thinking (deepseek-v4-flash measured on Go 2026-08-07:
    finish=length, content='', reasoning_content=4960 chars). Surfacing
    finish_reason and the reasoning-token split makes the next fix obvious.
    """
    if api_mode == "messages":
        return f"finish={data.get('stop_reason') or 'unknown'}"
    choice = (data.get("choices") or [{}])[0]
    finish = choice.get("finish_reason") or "unknown"
    usage = data.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    reasoning_tokens = details.get("reasoning_tokens")
    parts = [f"finish={finish}"]
    if reasoning_tokens is not None:
        parts.append(f"reasoning_tokens={reasoning_tokens}")
    if usage.get("completion_tokens") is not None:
        parts.append(f"completion_tokens={usage['completion_tokens']}")
    return ", ".join(parts)


def _anthropic_tools(tools: list[dict] | None) -> list[dict]:
    converted: list[dict] = []
    for raw in tools or []:
        function = raw.get("function") if isinstance(raw, dict) else None
        if not isinstance(function, dict) or not function.get("name"):
            continue
        converted.append({
            "name": str(function["name"]),
            "description": str(function.get("description") or ""),
            "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
        })
    return converted


def _tool_completion_payload(
    *,
    model: str,
    content: str,
    system_prompt: str,
    tools: list[dict] | None,
    max_tokens: int,
    api_mode: str,
) -> dict:
    if api_mode == "messages":
        payload: dict = {
            "model": model,
            "system": system_prompt,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max(1, int(max_tokens)),
            "thinking": {"type": "disabled"},
        }
        converted = _anthropic_tools(tools)
        if converted:
            payload["tools"] = converted
        return payload
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "max_tokens": max(1, int(max_tokens)),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    return payload


def _tool_completion_response(data: dict, api_mode: str) -> dict:
    if api_mode == "messages":
        blocks = [block for block in list(data.get("content") or []) if isinstance(block, dict)]
        text = "\n".join(
            str(block.get("text") or "") for block in blocks if block.get("type") == "text"
        ).strip()
        calls = []
        for block in blocks:
            if block.get("type") != "tool_use" or not block.get("name"):
                continue
            arguments = block.get("input")
            calls.append({
                "name": str(block["name"]),
                "arguments": arguments if isinstance(arguments, dict) else {},
            })
        return {"text": text, "toolCalls": calls}

    message = data["choices"][0]["message"]
    calls = []
    for raw_call in message.get("tool_calls") or []:
        function = (raw_call or {}).get("function") or {}
        name = str(function.get("name") or "")
        if not name:
            continue
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except ValueError:
            arguments = {}
        calls.append({
            "name": name,
            "arguments": arguments if isinstance(arguments, dict) else {},
        })
    return {"text": str(message.get("content") or ""), "toolCalls": calls}


def _vision_content_block(data_url: str, api_mode: str) -> dict:
    if api_mode != "messages":
        return {"type": "image_url", "image_url": {"url": data_url}}
    match = re.fullmatch(r"data:([^;,]+);base64,(.+)", data_url, flags=re.DOTALL)
    if not match:
        raise ValueError("vision input must be a base64 data URL")
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": match.group(1),
            "data": match.group(2),
        },
    }


def _httpx_client(httpx_module, *, timeout: int = 120):
    """Use environment proxies when valid, but survive malformed proxy variables."""

    try:
        return httpx_module.Client(timeout=timeout, follow_redirects=True)
    except httpx_module.InvalidURL:
        return httpx_module.Client(timeout=timeout, follow_redirects=True, trust_env=False)


def _image_data_url(image_path: Path, max_edge: int = 1600, jpeg_quality: int = 82) -> str:
    """Return an optimized image data URL for model input.

    Screenshots can be large, and OpenAI-compatible gateways may close TLS
    connections on bigger multimodal payloads. Keep the saved local screenshot
    untouched, but send a downscaled JPEG copy to the model.
    """

    try:
        from PIL import Image

        with Image.open(image_path) as img:
            img = img.convert("RGB")
            w, h = img.size
            scale = min(1.0, max_edge / max(w, h))
            if scale < 1.0:
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
            buf = BytesIO()
            img.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
            encoded = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        return f"data:image/png;base64,{encoded}"


def ask_text_model(
    user_prompt: str,
    context_text: str | None = None,
    system_prompt: str | None = None,
    *,
    timeout_s: float = 120.0,
    attempts: int = 2,
    max_tokens: int = 1200,
) -> str:
    """Ask the configured OpenAI-compatible model with text-only context.

    `timeout_s` is the budget for a single attempt and `attempts` caps the
    retries. Interactive callers must pass a short budget: a surface the user
    is staring at cannot afford the batch default, and every caller of this
    function already has a non-model fallback to fall back to.

    `max_tokens` is a latency control as much as a size one. Measured against
    the nghimmo gateway on 2026-08-04: a cap of 1200 produced 1198 tokens and
    took 26.9s for a one-line question, while a cap of 120 answered the same
    question in 12.1s. A relay that writes to whatever ceiling it is given makes
    the ceiling the wait, so interactive callers should set one they can afford.
    """
    api_key, base_url, model = get_ai_config()
    if not api_key:
        record_unconfigured()
        excerpt = (context_text or user_prompt or "").strip()[:900]
        return (
            "未检测到 OPENAI_API_KEY 或 secrets/openai_key.txt，因此没有调用文本模型。\n\n"
            f"当前读取到的上下文：{excerpt}"
        )

    # A gateway we already know is refusing (402 balance, 401 key, 404 model)
    # gets skipped instead of waited on. Every caller has a local fallback, and
    # burning a full timeout per command is what made the acceptance run feel
    # broken rather than merely unconfigured.
    blocked = short_circuit_message()
    if blocked:
        return f"AI 调用失败：{blocked}"

    try:
        import httpx

        base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = get_ai_api_mode(base_url)
        endpoint = _completion_endpoint(base_url, api_mode)
        headers = _completion_headers(api_key, api_mode)
        content = user_prompt.strip() or "解释当前选中的内容"
        if context_text:
            content += "\n\n" + context_text
        payload = _text_completion_payload(
            model=model,
            content=content,
            system_prompt=system_prompt or "你是 Magic Pointer 的本地选区助手。只基于提供的真实应用上下文回答，不要编造。",
            max_tokens=max_tokens,
            api_mode=api_mode,
        )
        last_exc: Exception | None = None
        request_timed_out = False
        last_http_error: tuple[int, str] | None = None
        budget = max(1.0, float(timeout_s))
        delays = (0.0, 0.8)[: max(1, int(attempts))]
        for delay in delays:
            if delay:
                time.sleep(delay)
            try:
                with _httpx_client(httpx, timeout=budget) as client:
                    response = client.post(endpoint, headers=headers, json=payload)
                if response.status_code >= 500:
                    last_http_error = (response.status_code, _plain_error_excerpt(response.text))
                    record_failure(status=response.status_code, detail=response.text[:300], model=model, base_url=base_url)
                    continue
                if response.status_code >= 400:
                    # A gateway that rejects the thinking param must still
                    # work: strip it and retry once before giving up.
                    if "thinking" in payload:
                        stripped = dict(payload)
                        del stripped["thinking"]
                        try:
                            with _httpx_client(httpx, timeout=budget) as client:
                                response = client.post(endpoint, headers=headers, json=stripped)
                        except httpx.TimeoutException:
                            request_timed_out = True
                            continue
                    if response.status_code >= 400:
                        health = record_failure(
                            status=response.status_code,
                            detail=response.text[:300],
                            model=model,
                            base_url=base_url,
                        )
                        return f"AI 调用失败：{health.message}"
                data = response.json()
                record_success(model=model, base_url=base_url)
                answer = _text_completion_response(data, api_mode)
                if not answer:
                    detail = _empty_answer_evidence(data, api_mode)
                    record_failure(
                        status=None,
                        exception_name="empty_answer",
                        detail=detail,
                        model=model,
                        base_url=base_url,
                    )
                    return (
                        "AI 调用失败：模型在本次预算内没有返回可见答案"
                        + (f"（{detail}）。" if detail else "。")
                        + "\n\n截图和对象已保存在本地，稍后可以直接重试。"
                    )
                return answer
            except httpx.ConnectTimeout as exc:
                last_exc = exc
                record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=base_url,
                )
                continue
            except httpx.TimeoutException:
                # A read/write/pool timeout means this individual request used
                # up the caller's latency budget. It does not prove that the
                # endpoint is offline. Marking it globally unreachable opens
                # the circuit and causes the *next* answer to be skipped even
                # while the cheap health probe succeeds.
                request_timed_out = True
                continue
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
                last_exc = exc
                record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=base_url,
                )
                continue
        if last_http_error:
            code, detail = last_http_error
            return f"AI 调用失败：HTTP {code}。\n{detail}"
        if request_timed_out:
            seconds = f"{budget:g}"
            return f"AI 调用失败：模型回答超过 {seconds} 秒，本次已停止等待；端点没有因此被判为离线。"
        if last_exc:
            raise last_exc
        raise RuntimeError("unknown API failure")
    except Exception as exc:
        return f"AI 调用失败：{type(exc).__name__}: {exc}"


def ask_text_model_with_tools(
    user_prompt: str,
    *,
    tools: list[dict] | None = None,
    context_text: str | None = None,
    system_prompt: str | None = None,
    timeout_s: float = 20.0,
    attempts: int = 1,
    max_tokens: int = 240,
) -> dict:
    """Ask the model, offering it tools it may call instead of answering in prose.

    This is the L2 tier of the intent router: every enabled recipe is offered as
    a tool, so a command nobody wrote a rule for can still resolve to real work.
    When the model would rather just answer, that is a valid outcome too — the
    contract is that the user always gets something.

    Returns {"text": str, "toolCalls": [{"name": str, "arguments": dict}],
    "error": str}. Never raises: a failure comes back as `error` with empty
    text so the caller can fall back to its local path.
    """
    api_key, base_url, model = get_ai_config()
    if not api_key:
        record_unconfigured()
        return {"text": "", "toolCalls": [], "error": "credential_missing"}

    blocked = short_circuit_message()
    if blocked:
        return {"text": "", "toolCalls": [], "error": blocked}

    try:
        import httpx

        endpoint = (base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = get_ai_api_mode(endpoint)
        completion_endpoint = _completion_endpoint(endpoint, api_mode)
        headers = _completion_headers(api_key, api_mode)
        content = (user_prompt or "").strip() or "解释当前选中的内容"
        if context_text:
            content += "\n\n" + context_text
        payload = _tool_completion_payload(
            model=model,
            content=content,
            system_prompt=system_prompt or (
                "你是 Magic Pointer 的屏幕助手。用户指着屏幕上的一个对象并下达了指令。"
                "如果有工具能更好地完成它，就调用工具；否则基于提供的真实上下文直接回答。"
                "不要编造上下文里没有的内容，不要声称已经执行了你没有执行的动作。"
            ),
            tools=tools,
            max_tokens=max_tokens,
            api_mode=api_mode,
        )

        last_error = ""
        request_timed_out = False
        for attempt in range(max(1, int(attempts))):
            if attempt:
                time.sleep(0.8)
            try:
                with _httpx_client(httpx, timeout=max(1.0, float(timeout_s))) as client:
                    response = client.post(completion_endpoint, headers=headers, json=payload)
            except httpx.ConnectTimeout as exc:
                health = record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=endpoint,
                )
                last_error = health.message
                continue
            except httpx.TimeoutException:
                request_timed_out = True
                last_error = "model_request_timeout"
                continue
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
                health = record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=endpoint,
                )
                last_error = health.message
                continue
            if response.status_code >= 400:
                health = record_failure(
                    status=response.status_code,
                    detail=response.text[:300],
                    model=model,
                    base_url=endpoint,
                )
                if response.status_code >= 500:
                    last_error = health.message
                    continue
                return {"text": "", "toolCalls": [], "error": health.message}

            record_success(model=model, base_url=endpoint)
            try:
                parsed = _tool_completion_response(response.json(), api_mode)
            except (KeyError, IndexError, TypeError, ValueError):
                return {"text": "", "toolCalls": [], "error": "runtime_empty_response"}
            if not parsed["text"] and not parsed["toolCalls"]:
                return {"text": "", "toolCalls": [], "error": "model_empty_response"}
            return {
                "text": parsed["text"],
                "toolCalls": parsed["toolCalls"],
                "error": "",
            }
        if request_timed_out and last_error == "model_request_timeout":
            return {"text": "", "toolCalls": [], "error": "model_request_timeout"}
        return {"text": "", "toolCalls": [], "error": last_error or "model_gateway_unreachable"}
    except Exception as exc:  # noqa: BLE001 - the caller must always get a dict
        return {"text": "", "toolCalls": [], "error": f"{type(exc).__name__}: {exc}"}


def ask_vision_model(
    image_path: Path,
    user_prompt: str,
    context_text: str | None = None,
    extra_image_paths: list[Path] | None = None,
    labeled_extra_images: list[LabeledImage] | None = None,
) -> str:
    """Ask an OpenAI-compatible multimodal model about the screenshot."""

    api_key, base_url, model = get_ai_config()
    model = get_vision_model(model)
    api_key = get_vision_key(api_key)
    if classify_vision_capability(model) is False:
        record_failure(
            status=None,
            exception_name="vision_model_text_only",
            detail=f"model {model} is classified text-only; refusing image call",
            model=model,
            base_url=base_url or "",
        )
        return (
            f"AI 视觉调用失败：当前模型 {model} 是纯文本模型，无法读图。\n\n"
            f"截图已保存在本地：{image_path}\n\n"
            "配置视觉模型：secrets/vision_model.txt（如 qwen3.7-plus）+ "
            "secrets/vision_api_mode.txt（messages），或用环境变量 "
            "MAGIC_POINTER_VISION_MODEL / MAGIC_POINTER_VISION_API_MODE。"
        )
    if not api_key:
        record_unconfigured()
        return (
            "已完成截图与对象登记，但未检测到 OPENAI_API_KEY 或 secrets/openai_key.txt，所以没有调用多模态模型。\n\n"
            f"截图已保存：{image_path}\n\n"
            "可通过环境变量或 secrets/openai_key.txt 配置 key。"
        )

    blocked = short_circuit_message()
    if blocked:
        return (
            f"AI 调用失败：{blocked}\n\n"
            f"截图已保存在本地：{image_path}\n端点恢复后可以直接重试。"
        )

    try:
        import httpx

        base_url = get_vision_base_url(base_url)
        base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        api_mode = get_vision_api_mode(base_url)
        endpoint = _completion_endpoint(base_url, api_mode)
        headers = _completion_headers(api_key, api_mode)
        def normalize_labeled_extras() -> list[LabeledImage]:
            labeled: list[LabeledImage] = []
            for item in labeled_extra_images or []:
                label, path = item
                labeled.append((label, path))
            # Backward compatibility for old callers: still label them instead
            # of appending unlabeled images, because unlabeled multimodal input
            # is exactly what caused this/that reversal.
            for i, path in enumerate(extra_image_paths or [], 1):
                labeled.append((f"EXTRA_REFERENCE_{i}", path))
            return labeled

        def build_payload(include_extras: bool) -> dict:
            base_text = (user_prompt.strip() or "\u89e3\u91ca\u8fd9\u4e2a")
            if context_text:
                base_text += "\n\n" + context_text
            base_text += (
                "\n\nImage order contract:"
                "\n- IMAGE A = THIS = the current object selected in this turn. Chinese '\u8fd9\u4e2a/\u5f53\u524d' maps only to IMAGE A."
                "\n- IMAGE B = THAT = the previous registered object. Chinese '\u90a3\u4e2a/\u4e0a\u4e00\u4e2a/\u521a\u624d' maps only to IMAGE B."
                "\n- Do not swap THIS and THAT. In comparisons, state which side is THIS and which side is THAT before giving conclusions."
            )
            user_content = [
                {"type": "text", "text": base_text + "\n\n[IMAGE A / THIS / current object / original screenshot]"},
                _vision_content_block(_image_data_url(image_path), api_mode),
            ]
            if include_extras:
                for label, extra_path in normalize_labeled_extras()[:3]:
                    if extra_path.exists():
                        user_content.append({"type": "text", "text": f"[{label}]"})
                        user_content.append(_vision_content_block(_image_data_url(extra_path), api_mode))
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": user_content}],
                "max_tokens": 1200,
            }
            if api_mode == "messages":
                payload["system"] = DEFAULT_SYSTEM_PROMPT
                payload["thinking"] = {"type": "disabled"}
            else:
                payload["messages"].insert(0, {"role": "system", "content": DEFAULT_SYSTEM_PROMPT})
            return payload


        last_exc: Exception | None = None
        last_http_error: tuple[int, str] | None = None
        # Try full payload twice; if the gateway is unstable or dislikes the
        # multimodal payload, fall back to primary image only while keeping text
        # context. 5xx must not dump gateway HTML into the UI.
        attempts = [(True, 0.0), (True, 0.9), (False, 1.3)]
        for include_extras, delay in attempts:
            if delay:
                time.sleep(delay)
            try:
                payload = build_payload(include_extras=include_extras)
                with _httpx_client(httpx, timeout=120) as client:
                    response = client.post(endpoint, headers=headers, json=payload)
                if response.status_code >= 500:
                    last_http_error = (response.status_code, _plain_error_excerpt(response.text))
                    record_failure(status=response.status_code, detail=response.text[:300], model=model, base_url=base_url)
                    continue
                if response.status_code >= 400:
                    health = record_failure(
                        status=response.status_code,
                        detail=response.text[:300],
                        model=model,
                        base_url=base_url,
                    )
                    return f"AI \u8c03\u7528\u5931\u8d25\uff1a{health.message}\n\n\u622a\u56fe\u548c\u5bf9\u8c61\u5df2\u4fdd\u5b58\u5728\u672c\u5730\u3002"
                data = response.json()
                record_success(model=model, base_url=base_url)
                answer = _text_completion_response(data, api_mode)
                if not include_extras and (extra_image_paths or labeled_extra_images):
                    answer += "\n\n\uff08\u7f51\u5173\u4e0d\u7a33\u5b9a\uff0c\u672c\u6b21\u5df2\u964d\u7ea7\u4e3a\u4e3b\u622a\u56fe + \u7ed3\u6784\u5316\u4e0a\u4e0b\u6587\u3002\uff09"
                return answer
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.TimeoutException) as exc:
                last_exc = exc
                record_failure(
                    status=None,
                    exception_name=type(exc).__name__,
                    detail=str(exc)[:300],
                    model=model,
                    base_url=base_url,
                )
                continue
        if last_http_error:
            code, detail = last_http_error
            return f"AI \u8c03\u7528\u5931\u8d25\uff1aHTTP {code}\uff08\u670d\u52a1\u7aef/\u4ee3\u7406\u7f51\u5173\u4e34\u65f6\u9519\u8bef\uff09\u3002\n{detail}\n\n\u622a\u56fe\u548c\u5bf9\u8c61\u5df2\u4fdd\u5b58\uff1b\u8fd9\u901a\u5e38\u4e0d\u662f\u4f60\u753b\u5f97\u592a\u5927\uff0c\u800c\u662f\u4e0a\u6e38\u7f51\u5173\u77ed\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"
        if last_exc:
            raise last_exc
        raise RuntimeError("unknown API failure")
    except Exception as exc:
        return (
            "AI \u8c03\u7528\u5931\u8d25\uff0c\u4f46\u622a\u56fe\u548c\u5bf9\u8c61\u5df2\u4fdd\u7559\u3002\n\n"
            f"\u9519\u8bef\uff1a{type(exc).__name__}: {exc}\n\n"
            "\u6211\u5df2\u5bf9\u517c\u5bb9\u7f51\u5173\u7684 SSL/\u65ad\u8fde\u95ee\u9898\u505a\u4e86\u91cd\u8bd5\u548c\u964d\u7ea7\u5904\u7406\u3002\u5982\u679c\u4ecd\u7136\u5931\u8d25\uff0c\u901a\u5e38\u662f\u670d\u52a1\u7aef\u6216\u7f51\u7edc\u77ed\u65f6\u4e0d\u7a33\uff0c\u53ef\u7a0d\u540e\u91cd\u8bd5\uff0c\u6216\u68c0\u67e5 secrets/openai_base_url.txt / secrets/model.txt\u3002"
        )
