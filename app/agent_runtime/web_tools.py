"""Web tool surface for the agent loop (Hermes web toolset contract, keyless).

Hermes ships ``web_search`` + ``web_extract``; MP had neither, so the agent
could not look up a doc page or an issue while fixing a repo. This port keeps
the contract but needs zero API keys: search via the DuckDuckGo HTML endpoint,
fetch via httpx with a readable-text extraction (script/style stripped,
head+tail window on oversized pages — same shape as Hermes' char budget).

Honest limits: no JS rendering (a SPA returns its shell), no PDF parsing.
Both tools are READ effects and safe to run concurrently.
"""

from __future__ import annotations

import re
from html import unescape
from typing import Any

import httpx

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

__all__ = ["register_web_tools"]

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
_DEFAULT_FETCH_CHARS = 15_000
_MAX_FETCH_CHARS = 60_000
_SEARCH_TIMEOUT_S = 15.0
_FETCH_TIMEOUT_S = 25.0

_BLOCK_TAGS = re.compile(
    r"<(script|style|noscript|svg|head|nav|footer|iframe|form)\b[^>]*>.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_TAG = re.compile(r"<[^>]+>")
_SPACES = re.compile(r"[ \t\f\v]+")
_BLANKS = re.compile(r"\n{3,}")


def _strip_to_text(html: str) -> str:
    text = _BLOCK_TAGS.sub(" ", html)
    text = re.sub(r"<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = _TAG.sub("", text)
    text = unescape(text)
    text = _SPACES.sub(" ", text)
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


def _head_tail(text: str, budget: int) -> str:
    if len(text) <= budget:
        return text
    head = text[: int(budget * 0.7)]
    tail = text[-int(budget * 0.3) :]
    return (
        f"{head}\n[... middle omitted: {len(text) - budget} chars ...]\n{tail}"
    )


def web_search(query: str, limit: int = 5) -> str:
    text = str(query or "").strip()
    if not text:
        raise ValueError("query is required")
    bounded = max(1, min(int(limit or 5), 20))
    response = httpx.post(
        "https://html.duckduckgo.com/html/",
        data={"q": text},
        headers={"User-Agent": _USER_AGENT},
        timeout=_SEARCH_TIMEOUT_S,
        follow_redirects=True,
    )
    response.raise_for_status()
    html = response.text
    results: list[str] = []
    # DDG HTML layout: result links carry the target in the href itself or in
    # a uddg= redirect parameter; titles live in result__a, snippets in
    # result__snippet.
    blocks = re.split(r'<div class="result\b', html)
    for block in blocks[1:]:
        if len(results) >= bounded:
            break
        title_match = re.search(
            r'class="result__a"[^>]*>(.*?)</a>', block, re.DOTALL
        )
        if not title_match:
            continue
        title = _TAG.sub("", title_match.group(1)).strip()
        href_match = re.search(r'class="result__a"[^>]*href="([^"]+)"', block)
        url = href_match.group(1) if href_match else ""
        if "uddg=" in url:
            from urllib.parse import parse_qs, urlparse

            try:
                url = parse_qs(urlparse(url).query).get("uddg", [url])[0]
            except ValueError:
                pass
        snippet_match = re.search(
            r'class="result__snippet"[^>]*>(.*?)</a>', block, re.DOTALL
        )
        snippet = (
            _TAG.sub("", snippet_match.group(1)).strip() if snippet_match else ""
        )
        results.append(f"{len(results) + 1}. {title}\n   {url}\n   {snippet[:300]}")
    if not results:
        return f"no results for {text!r} (search endpoint returned nothing usable)"
    return "\n".join(results)


def web_fetch(url: str, char_limit: int = _DEFAULT_FETCH_CHARS) -> str:
    target = str(url or "").strip()
    if not target.startswith(("http://", "https://")):
        raise ValueError("url must start with http:// or https://")
    budget = max(2000, min(int(char_limit or _DEFAULT_FETCH_CHARS), _MAX_FETCH_CHARS))
    response = httpx.get(
        target,
        headers={"User-Agent": _USER_AGENT},
        timeout=_FETCH_TIMEOUT_S,
        follow_redirects=True,
    )
    response.raise_for_status()
    content_type = response.headers.get("content-type", "")
    if "html" not in content_type and "text" not in content_type:
        return (
            f"[non-HTML content: {content_type or 'unknown'}, "
            f"{len(response.content)} bytes — download it with run_command instead]"
        )
    body = _strip_to_text(response.text)
    if not body:
        return "[page rendered empty after extraction — likely a JS-only app; fetch its API or repo instead]"
    header = f"{target} ({len(body)} chars)"
    return f"{header}\n{_head_tail(body, budget)}"


def register_web_tools(registry: ToolRegistry) -> None:
    registry.register(ToolSpec(
        name="web_search",
        description=(
            "搜索互联网，返回标题+URL+摘要列表（无需 API key）。"
            "查文档、找 issue、核对库用法时用；把结果里的 URL 传给 web_fetch 读全文。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "description": "默认 5，最多 20"},
            },
            "required": ["query"],
        },
        execute=lambda query, limit=5, **_: web_search(query, limit),
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="duckduckgo_html",
        timeout_ms=30_000,
    ))
    registry.register(ToolSpec(
        name="web_fetch",
        description=(
            "抓取一个网页并抽取正文文本（去脚本/导航，超长页返回头尾窗口）。"
            "不能执行 JS：SPA 页面拿不到内容时会明说。PDF 不支持。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "char_limit": {"type": "integer", "description": "默认 15000"},
            },
            "required": ["url"],
        },
        execute=lambda url, char_limit=_DEFAULT_FETCH_CHARS, **_: web_fetch(url, char_limit),
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="httpx_fetch",
        timeout_ms=40_000,
    ))
