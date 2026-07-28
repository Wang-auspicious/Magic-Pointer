from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit, urlunsplit

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter


JsonDict = dict[str, Any]
_CHROMIUM_CLASS = "Chrome_WidgetWin_1"
_MAGIC_TITLES = {"Magic Pointer Overlay", "Magic Pointer Panel", "Magic Pointer"}
_DEFAULT_ENDPOINTS = tuple(f"http://127.0.0.1:{port}" for port in (9222, 9223, 9224, 9333, 9515))
_NETWORK_ERROR = re.compile(r"(?i)(?:net::ERR_|failed to load resource|networkerror|http error|status (?:4|5)\d\d)")


BROWSER_DOM_PROBE_SCRIPT = r"""
({ point, outerBBox }) => {
  const finite = value => Number.isFinite(Number(value));
  if (!point || !finite(point.x) || !finite(point.y) || !Array.isArray(outerBBox) || outerBBox.length !== 4) {
    return { state: 'invalid_coordinates' };
  }
  const [left, top, right, bottom] = outerBBox.map(Number);
  const physicalWidth = Math.max(1, right - left);
  const physicalHeight = Math.max(1, bottom - top);
  const outerWidth = Math.max(1, Number(window.outerWidth) || physicalWidth);
  const outerHeight = Math.max(1, Number(window.outerHeight) || physicalHeight);
  const scaleX = physicalWidth / outerWidth;
  const scaleY = physicalHeight / outerHeight;
  const sideChromeCss = Math.max(0, (outerWidth - window.innerWidth) / 2);
  const topChromeCss = Math.max(0, outerHeight - window.innerHeight - sideChromeCss);
  const viewportX = ((Number(point.x) - left) / scaleX) - sideChromeCss;
  const viewportY = ((Number(point.y) - top) / scaleY) - topChromeCss;
  const element = document.elementFromPoint(viewportX, viewportY);
  if (!element) {
    return {
      state: 'node_not_found',
      coordinates: {
        pointerScreenPhysical: { x: Number(point.x), y: Number(point.y) },
        pointerViewportCss: { x: viewportX, y: viewportY },
        devicePixelRatio: Number(window.devicePixelRatio) || 1,
      },
    };
  }
  const esc = value => window.CSS && CSS.escape
    ? CSS.escape(String(value))
    : String(value).replace(/[^A-Za-z0-9_-]/g, character => `\\${character}`);
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const stableSelector = node => {
    if (node.id) {
      const selector = `#${esc(node.id)}`;
      if (unique(selector)) return selector;
    }
    for (const key of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
      const value = node.getAttribute(key);
      if (!value) continue;
      const selector = `${node.tagName.toLowerCase()}[${key}=${JSON.stringify(value)}]`;
      if (unique(selector)) return selector;
    }
    const parts = [];
    let current = node;
    for (let depth = 0; current && current.nodeType === 1 && depth < 8; depth += 1) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part = `#${esc(current.id)}`;
        parts.unshift(part);
        break;
      }
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(item => item.tagName === current.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const selector = parts.join(' > ');
      if (unique(selector)) return selector;
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const accessibleName = node => {
    const direct = node.getAttribute('aria-label');
    if (direct) return direct.trim();
    const labelledBy = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (labelledBy.length) {
      const text = labelledBy.map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (text) return text;
    }
    if (node.id) {
      const label = document.querySelector(`label[for=${JSON.stringify(node.id)}]`);
      if (label?.innerText?.trim()) return label.innerText.trim();
    }
    return (node.getAttribute('alt') || node.getAttribute('title') || node.innerText || node.textContent || '').trim();
  };
  const componentHints = node => {
    const owners = [];
    let framework = 'unknown';
    const appendOwner = (name, rawSource) => {
      const cleanName = String(name || '').trim();
      const source = rawSource && typeof rawSource === 'object'
        ? {
            file: String(rawSource.fileName || rawSource.file || rawSource.__file || '').trim(),
            line: Number(rawSource.lineNumber || rawSource.line || 0) || 0,
            column: Number(rawSource.columnNumber || rawSource.column || 0) || 0,
          }
        : (typeof rawSource === 'string' ? { file: rawSource, line: 0, column: 0 } : null);
      if (!cleanName && !(source && source.file)) return;
      const key = `${cleanName}|${source?.file || ''}|${source?.line || 0}`;
      if (owners.some(item => item.key === key)) return;
      owners.push({ key, name: cleanName, source });
    };
    const reactKey = Object.keys(node).find(key => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'));
    if (reactKey) {
      framework = 'react';
      let fiber = node[reactKey];
      for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
        const type = fiber.elementType || fiber.type;
        const name = typeof type === 'function'
          ? (type.displayName || type.name)
          : (type && typeof type === 'object' ? (type.displayName || type.name) : '');
        appendOwner(name, fiber._debugSource || fiber._debugOwner?._debugSource || null);
      }
    }
    if (node.__vueParentComponent) {
      framework = framework === 'unknown' ? 'vue' : framework;
      let component = node.__vueParentComponent;
      for (let depth = 0; component && depth < 12; depth += 1, component = component.parent) {
        const type = component.type || {};
        appendOwner(type.name || type.__name || (component.uid ? `VueComponent${component.uid}` : ''), type.__file || null);
      }
    }
    const declaredName = node.getAttribute('data-component') || node.getAttribute('data-component-name') || '';
    const declaredFile = node.getAttribute('data-source-file') || node.getAttribute('data-component-file') || '';
    if (declaredName || declaredFile) appendOwner(declaredName, declaredFile || null);
    return {
      framework,
      owners: owners.slice(0, 12).map(({ key, ...owner }) => owner),
    };
  };
  const rect = element.getBoundingClientRect();
  const allowedAttributes = ['id', 'name', 'type', 'href', 'src', 'alt', 'title', 'role', 'aria-label', 'aria-labelledby', 'data-testid', 'data-test', 'data-qa'];
  const attributes = {};
  for (const key of allowedAttributes) {
    const value = element.getAttribute(key);
    if (value != null && value !== '') attributes[key] = String(value).slice(0, 1000);
  }
  const resources = performance.getEntriesByType('resource').slice(-100).map(entry => ({
    url: entry.name,
    initiatorType: entry.initiatorType,
    duration: entry.duration,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
    responseStatus: Number(entry.responseStatus) || 0,
  })).filter(entry => entry.responseStatus >= 400);
  return {
    state: 'resolved',
    page: { title: document.title, url: location.href },
    node: {
      tag: element.tagName.toLowerCase(),
      id: element.id || '',
      classes: Array.from(element.classList || []).slice(0, 20),
      role: element.getAttribute('role') || element.tagName.toLowerCase(),
      accessibleName: accessibleName(element).slice(0, 2000),
      text: (element.innerText || element.textContent || '').trim().slice(0, 4000),
      attributes,
    },
    selector: stableSelector(element).slice(0, 2000),
    componentHints: componentHints(element),
    coordinates: {
      pointerScreenPhysical: { x: Number(point.x), y: Number(point.y) },
      pointerViewportCss: { x: viewportX, y: viewportY },
      elementViewportCss: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      elementScreenPhysical: {
        x: left + ((sideChromeCss + rect.x) * scaleX),
        y: top + ((topChromeCss + rect.y) * scaleY),
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      },
      devicePixelRatio: Number(window.devicePixelRatio) || 1,
      mapping: 'window-bounds+outer-inner-metrics',
      hitTestVerified: true,
    },
    resourceFailures: resources,
  };
}
"""


@dataclass(frozen=True)
class DevToolsProbeResult:
    ok: bool
    data: JsonDict
    error: str | None = None


def _bounded(value: object, limit: int) -> str:
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()[:limit]


def _safe_url(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = urlsplit(text)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https", "file", "about"}:
        return ""
    if parsed.scheme in {"file", "about"}:
        return urlunsplit((parsed.scheme, "", parsed.path[:3000], "", ""))
    host = parsed.hostname or ""
    if not host:
        return ""
    port = f":{parsed.port}" if parsed.port is not None else ""
    return urlunsplit((parsed.scheme, f"{host}{port}", parsed.path[:3000], "", ""))


def _number(value: object) -> float | int | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in {float("inf"), float("-inf")}:
        return None
    return int(number) if number.is_integer() else round(number, 3)


def _safe_point(value: Any) -> dict[str, float | int] | None:
    if not isinstance(value, dict):
        return None
    x, y = _number(value.get("x")), _number(value.get("y"))
    return {"x": x, "y": y} if x is not None and y is not None else None


def _safe_rect(value: Any) -> dict[str, float | int] | None:
    if not isinstance(value, dict):
        return None
    result = {key: _number(value.get(key)) for key in ("x", "y", "width", "height")}
    return result if all(item is not None for item in result.values()) else None


def _safe_source_reference(value: object) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()[:3000]
    if not text:
        return ""
    if re.match(r"^[A-Za-z]:[\\/]", text):
        return re.split(r"[?#]", text, maxsplit=1)[0][:2500]
    try:
        parsed = urlsplit(text)
    except ValueError:
        parsed = None
    if parsed is not None and parsed.scheme:
        if parsed.scheme not in {"file", "webpack", "webpack-internal", "vite", "http", "https"}:
            return ""
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path[:2500], "", ""))
    return re.split(r"[?#]", text, maxsplit=1)[0][:2500]


def _safe_component_hints(value: Any) -> dict[str, Any]:
    raw = dict(value or {}) if isinstance(value, dict) else {}
    framework = _bounded(raw.get("framework"), 80).casefold() or "unknown"
    if framework not in {"react", "vue", "svelte", "angular", "unknown"}:
        framework = "unknown"
    owners: list[dict[str, Any]] = []
    for item in list(raw.get("owners") or [])[:12]:
        if not isinstance(item, dict):
            continue
        source = dict(item.get("source") or {}) if isinstance(item.get("source"), dict) else {}
        file_name = _safe_source_reference(source.get("file") or source.get("fileName"))
        line = _number(source.get("line") or source.get("lineNumber"))
        column = _number(source.get("column") or source.get("columnNumber"))
        owner = {
            "name": _bounded(item.get("name"), 240),
            "source": {
                "file": file_name,
                "line": line if isinstance(line, int) and line > 0 else None,
                "column": column if isinstance(column, int) and column > 0 else None,
            },
        }
        if owner["name"] or file_name:
            owners.append(owner)
    return {"framework": framework, "owners": owners}


def sanitize_browser_context(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict) or int(value.get("schemaVersion") or 0) != 1:
        return None
    page = dict(value.get("page") or {})
    node = dict(value.get("node") or {})
    coordinates = dict(value.get("coordinates") or {})
    provenance = dict(value.get("provenance") or {})
    attributes = dict(node.get("attributes") or {})
    safe_attributes = {
        str(key)[:80]: _bounded(item, 1000)
        for key, item in list(attributes.items())[:20]
        if str(key) in {"id", "name", "type", "href", "src", "alt", "title", "role", "aria-label", "aria-labelledby", "data-testid", "data-test", "data-qa"}
    }
    if "href" in safe_attributes:
        safe_attributes["href"] = _safe_url(safe_attributes["href"])
    if "src" in safe_attributes:
        safe_attributes["src"] = _safe_url(safe_attributes["src"])
    failures: list[dict[str, Any]] = []
    for raw in list(value.get("networkFailures") or [])[:20]:
        if not isinstance(raw, dict):
            continue
        safe = {
            "url": _safe_url(raw.get("url")),
            "errorText": _bounded(raw.get("errorText"), 300),
            "source": _bounded(raw.get("source"), 80),
            "timestamp": _bounded(raw.get("timestamp"), 80),
            "requestId": _bounded(raw.get("requestId"), 160),
            "status": _number(raw.get("status")),
        }
        failures.append({key: item for key, item in safe.items() if item not in (None, "")})
    classes = [
        _bounded(item, 160)
        for item in list(node.get("classes") or [])[:20]
        if str(item or "").strip()
    ]
    state = str(value.get("state") or "unavailable")
    if state not in {"resolved", "partial", "unavailable"}:
        state = "unavailable"
    return {
        "schemaVersion": 1,
        "state": state,
        "method": _bounded(value.get("method"), 120),
        "page": {"title": _bounded(page.get("title"), 1000), "url": _safe_url(page.get("url"))},
        "node": {
            "tag": _bounded(node.get("tag"), 80),
            "id": _bounded(node.get("id"), 300),
            "classes": classes,
            "role": _bounded(node.get("role"), 120),
            "accessibleName": _bounded(node.get("accessibleName"), 2000),
            "text": _bounded(node.get("text"), 4000),
            "attributes": safe_attributes,
        },
        "selector": _bounded(value.get("selector"), 2000),
        "coordinates": {
            "pointerScreenPhysical": _safe_point(coordinates.get("pointerScreenPhysical")),
            "pointerViewportCss": _safe_point(coordinates.get("pointerViewportCss")),
            "elementViewportCss": _safe_rect(coordinates.get("elementViewportCss")),
            "elementScreenPhysical": _safe_rect(coordinates.get("elementScreenPhysical")),
            "devicePixelRatio": _number(coordinates.get("devicePixelRatio")),
            "mapping": _bounded(coordinates.get("mapping"), 120),
            "hitTestVerified": coordinates.get("hitTestVerified") is True,
        },
        "networkFailures": failures,
        "componentHints": _safe_component_hints(value.get("componentHints")),
        "provenance": {
            "endpoint": _safe_url(provenance.get("endpoint")),
            "targetId": _bounded(provenance.get("targetId"), 200),
            "structural": provenance.get("structural") is True,
            "networkSources": [
                _bounded(item, 80)
                for item in list(provenance.get("networkSources") or [])[:8]
                if str(item or "").strip()
            ],
        },
        "uncertainty": [
            _bounded(item, 200)
            for item in list(value.get("uncertainty") or [])[:12]
            if str(item or "").strip()
        ],
    }


def _timestamp(value: object) -> str:
    try:
        stamp = float(value)
    except (TypeError, ValueError):
        return ""
    if stamp > 10_000_000_000:
        stamp /= 1000
    try:
        return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat(timespec="milliseconds")
    except (OverflowError, OSError, ValueError):
        return ""


class ChromeDevToolsProbe:
    def __init__(
        self,
        *,
        endpoints: Iterable[str] | None = None,
        timeout_ms: int = 2200,
        event_drain_ms: int = 180,
    ) -> None:
        explicit = endpoints is not None
        configured = list(endpoints or ())
        if not explicit:
            configured = [item.strip() for item in os.environ.get("MAGIC_POINTER_CDP_ENDPOINTS", "").split(",") if item.strip()]
        if not configured and not explicit:
            configured = list(_DEFAULT_ENDPOINTS)
        self.endpoints = tuple(dict.fromkeys(str(item).strip().rstrip("/") for item in configured if str(item).strip()))[:8]
        self.timeout_ms = max(500, min(int(timeout_ms), 5000))
        self.event_drain_ms = max(50, min(int(event_drain_ms), 500))

    @staticmethod
    def _json(endpoint: str, path: str) -> Any:
        with urllib.request.urlopen(f"{endpoint.rstrip('/')}{path}", timeout=0.4) as response:
            return json.loads(response.read(500_000).decode("utf-8", errors="replace"))

    def _inventory(self) -> tuple[list[str], list[tuple[str, dict[str, Any]]]]:
        reachable: list[str] = []
        results: list[tuple[str, dict[str, Any]]] = []
        for endpoint in self.endpoints:
            base = endpoint.rstrip("/")
            try:
                version = self._json(base, "/json/version")
                targets = self._json(base, "/json/list")
            except (OSError, ValueError, urllib.error.URLError):
                continue
            if not isinstance(version, dict) or not version.get("webSocketDebuggerUrl") or not isinstance(targets, list):
                continue
            reachable.append(base)
            results.extend(
                (base, dict(target))
                for target in targets[:64]
                if isinstance(target, dict)
                and target.get("type") == "page"
                and str(target.get("webSocketDebuggerUrl") or "").startswith("ws")
            )
        return reachable, results

    def _available_targets(self) -> list[tuple[str, dict[str, Any]]]:
        return self._inventory()[1]

    def status(self) -> dict[str, Any]:
        reachable, targets = self._inventory()
        state = "available" if reachable else "unavailable"
        reason = "" if reachable else "cdp_endpoint_unavailable"
        if reachable and not targets:
            reason = "no_page_targets"
        return {
            "state": state,
            "configuredEndpointCount": len(self.endpoints),
            "reachableEndpointCount": len(set(reachable)),
            "pageCount": len(targets),
            "endpoints": list(self.endpoints),
            "reason": reason,
        }

    @staticmethod
    def _title_key(value: object) -> str:
        text = str(value or "").casefold().strip()
        for suffix in (" - microsoft edge", " - google chrome", " - brave", " - vivaldi"):
            if text.endswith(suffix):
                text = text[:-len(suffix)].strip()
        return text

    def _select_target(
        self,
        targets: list[tuple[str, dict[str, Any]]],
        window_title: str,
    ) -> tuple[str, dict[str, Any]] | None:
        expected = self._title_key(window_title)
        matches: list[tuple[str, dict[str, Any]]] = []
        for endpoint, target in targets:
            title = self._title_key(target.get("title"))
            if title and (title == expected or title in expected or expected in title):
                matches.append((endpoint, target))
        if len(matches) == 1:
            return matches[0]
        return targets[0] if len(targets) == 1 else None

    def probe(self, window: JsonDict, target_point: JsonDict) -> DevToolsProbeResult:
        targets = self._available_targets()
        if not targets:
            return DevToolsProbeResult(False, {}, "cdp_endpoint_unavailable")
        selected = self._select_target(targets, str(window.get("title") or ""))
        if selected is None:
            return DevToolsProbeResult(False, {}, "target_page_unmatched")
        endpoint, target = selected
        try:
            return self._probe_target(target, endpoint, window, target_point)
        except Exception as exc:
            return DevToolsProbeResult(False, {}, f"cdp_probe_failed:{type(exc).__name__}:{str(exc)[:160]}")

    def _probe_target(
        self,
        target: dict[str, Any],
        endpoint: str,
        window: JsonDict,
        target_point: JsonDict,
    ) -> DevToolsProbeResult:
        try:
            import websocket
        except Exception as exc:
            return DevToolsProbeResult(False, {}, f"websocket_client_unavailable:{type(exc).__name__}")
        socket = websocket.create_connection(
            str(target.get("webSocketDebuggerUrl") or ""),
            timeout=self.timeout_ms / 1000,
            suppress_origin=True,
        )
        failures: list[dict[str, Any]] = []
        request_urls: dict[str, str] = {}
        request_id = 0

        def collect(message: dict[str, Any]) -> None:
            method = str(message.get("method") or "")
            payload = dict(message.get("params") or {})
            if method == "Network.requestWillBeSent":
                request = dict(payload.get("request") or {})
                key = str(payload.get("requestId") or "")
                if key:
                    request_urls[key] = str(request.get("url") or "")
            elif method == "Network.loadingFailed":
                key = str(payload.get("requestId") or "")
                failures.append({
                    "url": request_urls.get(key, ""),
                    "errorText": str(payload.get("errorText") or ""),
                    "source": "network.loadingFailed",
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                    "requestId": key,
                })
            elif method == "Log.entryAdded":
                entry = dict(payload.get("entry") or {})
                text = str(entry.get("text") or "")
                source = str(entry.get("source") or "")
                if source.casefold() == "network" or _NETWORK_ERROR.search(text):
                    failures.append({
                        "url": str(entry.get("url") or ""),
                        "errorText": text,
                        "source": "devtools_log",
                        "timestamp": _timestamp(entry.get("timestamp")),
                    })

        def call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
            nonlocal request_id
            request_id += 1
            expected_id = request_id
            socket.send(json.dumps({"id": expected_id, "method": method, "params": dict(params or {})}))
            while True:
                message = json.loads(socket.recv())
                if not isinstance(message, dict):
                    continue
                if message.get("id") == expected_id:
                    if message.get("error"):
                        raise RuntimeError(str(message["error"])[:500])
                    return dict(message.get("result") or {})
                collect(message)

        try:
            call("Network.enable")
            call("Log.enable")
            deadline = time.monotonic() + (self.event_drain_ms / 1000)
            socket.settimeout(0.05)
            while time.monotonic() < deadline:
                try:
                    message = json.loads(socket.recv())
                except websocket.WebSocketTimeoutException:
                    continue
                if isinstance(message, dict):
                    collect(message)
            argument = {
                "point": {"x": int(target_point["x"]), "y": int(target_point["y"])},
                "outerBBox": list(window.get("bbox") or []),
            }
            expression = f"({BROWSER_DOM_PROBE_SCRIPT})({json.dumps(argument, ensure_ascii=False)})"
            evaluated = call("Runtime.evaluate", {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
            })
            remote = dict(evaluated.get("result") or {})
            raw = remote.get("value")
            if not isinstance(raw, dict) or raw.get("state") != "resolved":
                return DevToolsProbeResult(False, dict(raw or {}), str((raw or {}).get("state") or remote.get("description") or "dom_hit_test_failed"))
            for resource in list(raw.pop("resourceFailures", []) or [])[:20]:
                if isinstance(resource, dict):
                    failures.append({
                        "url": resource.get("url"),
                        "errorText": f"HTTP {int(resource.get('responseStatus') or 0)}",
                        "status": resource.get("responseStatus"),
                        "source": "resource_timing",
                        "timestamp": "",
                    })
            deduped: list[dict[str, Any]] = []
            seen: set[tuple[str, str, str]] = set()
            for failure in failures[-40:]:
                key = (str(failure.get("url") or ""), str(failure.get("errorText") or ""), str(failure.get("source") or ""))
                if key in seen:
                    continue
                seen.add(key)
                deduped.append(failure)
            raw.update({
                "schemaVersion": 1,
                "state": "resolved",
                "method": "cdp:dom-point",
                "networkFailures": deduped[-20:],
                "provenance": {
                    "endpoint": endpoint,
                    "targetId": str(target.get("id") or ""),
                    "structural": True,
                    "networkSources": sorted({str(item.get("source") or "") for item in deduped if item.get("source")}),
                },
                "uncertainty": [] if deduped else ["no_network_failure_observed_in_devtools_log_or_resource_timing"],
            })
            safe = sanitize_browser_context(raw)
            return DevToolsProbeResult(True, safe or {})
        finally:
            socket.close()


class BrowserDevToolsAdapter(AppAdapter):
    name = "browser_devtools"
    perception_layer = "dom"
    perception_priority = 20

    def __init__(
        self,
        *,
        probe: Callable[[JsonDict, JsonDict], DevToolsProbeResult | None] | None = None,
    ) -> None:
        self._probe = probe or ChromeDevToolsProbe().probe

    def match_window(self, window: JsonDict) -> bool:
        title = str(window.get("title") or "").strip()
        return str(window.get("class_name") or "") == _CHROMIUM_CLASS and title not in _MAGIC_TITLES

    def read_context(self, window: JsonDict, **kwargs: Any) -> AdapterReadContext:
        capabilities = [AdapterCapability(
            "read_dom_node",
            "Read the DOM node, stable selector, accessible name, network failure, and mapped coordinates through DevTools",
            "read_only",
        )]
        raw_point = kwargs.get("target_point")
        if not isinstance(raw_point, dict):
            return AdapterReadContext(
                adapter=self.name,
                app="browser",
                window=window,
                method="cdp:dom-point",
                capabilities=capabilities,
                error="A physical pointer coordinate is required for DOM hit-testing.",
            )
        try:
            target_point = {"x": int(raw_point.get("x")), "y": int(raw_point.get("y"))}
        except (TypeError, ValueError):
            return AdapterReadContext(
                adapter=self.name,
                app="browser",
                window=window,
                method="cdp:dom-point",
                capabilities=capabilities,
                error="A physical pointer coordinate is required for DOM hit-testing.",
            )
        result = self._probe(dict(window), target_point)
        if result is None or not result.ok:
            return AdapterReadContext(
                adapter=self.name,
                app="browser",
                window=window,
                method="cdp:dom-point",
                capabilities=capabilities,
                artifacts={"devtools_state": "unavailable"},
                error=str((result.error if result is not None else "cdp_probe_unavailable") or "cdp_probe_unavailable"),
            )
        browser_context = sanitize_browser_context(result.data)
        if browser_context is None or browser_context.get("state") != "resolved":
            return AdapterReadContext(
                adapter=self.name,
                app="browser",
                window=window,
                method="cdp:dom-point",
                capabilities=capabilities,
                error="cdp_dom_context_invalid",
            )
        node = dict(browser_context.get("node") or {})
        content = str(node.get("text") or node.get("accessibleName") or "")
        label = str(node.get("accessibleName") or browser_context.get("selector") or "DOM node")
        return AdapterReadContext(
            adapter=self.name,
            app="browser",
            window=window,
            content=content,
            label=label,
            method="cdp:dom-point",
            capabilities=capabilities,
            artifacts={
                "browser_context": browser_context,
                "url": str((browser_context.get("page") or {}).get("url") or ""),
                "dom_selector": str(browser_context.get("selector") or ""),
                "accessible_name": str(node.get("accessibleName") or ""),
                "network_failure_count": len(browser_context.get("networkFailures") or []),
                "selection_rectangles": [
                    browser_context["coordinates"]["elementScreenPhysical"]
                ] if (browser_context.get("coordinates") or {}).get("elementScreenPhysical") else [],
            },
        )
