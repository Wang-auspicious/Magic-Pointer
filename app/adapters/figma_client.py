"""Task/document-bound client for the local Electron Figma bridge."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

FIGMA_OPERATIONS = frozenset({
    "read_selection",
    "read_nodes",
    "read_parent",
    "export_preview",
    "apply_patch",
    "readback",
})


class FigmaClientError(RuntimeError):
    pass


class FigmaConnectionUnavailable(FigmaClientError):
    pass


@dataclass(frozen=True, slots=True)
class FigmaClientConfig:
    base_url: str
    task_id: str
    document_session_id: str
    control_token: str = field(repr=False)
    request_timeout_s: float = 5.0
    result_timeout_s: float = 30.0
    poll_interval_s: float = 0.1
    document_name: str = ""
    page_id: str = ""
    page_name: str = ""
    selection_ids: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> FigmaClientConfig:
        data = dict(value)
        required = {"baseUrl", "controlToken", "taskId", "documentSessionId"}
        if set(data) - (required | {
            "requestTimeoutS", "resultTimeoutS", "pollIntervalS",
            "documentName", "pageId", "pageName", "selectionIds",
        }):
            raise ValueError("figma runtime config contains unknown fields")
        missing = required - set(data)
        if missing:
            raise ValueError(f"figma runtime config missing fields: {sorted(missing)}")
        base_url = str(data["baseUrl"] or "").strip().rstrip("/")
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.port is None:
            raise ValueError("figma bridge must be an explicit http://127.0.0.1:<port> URL")
        task_id = str(data["taskId"] or "").strip()
        document_session_id = str(data["documentSessionId"] or "").strip()
        token = str(data["controlToken"] or "").strip()
        if not task_id or not document_session_id or len(token) < 24:
            raise ValueError("figma runtime identity or control credential is incomplete")
        raw_selection = data.get("selectionIds", [])
        if not isinstance(raw_selection, list):
            raise ValueError("figma runtime selectionIds must be an array")
        return cls(
            base_url=base_url,
            control_token=token,
            task_id=task_id,
            document_session_id=document_session_id,
            request_timeout_s=float(data.get("requestTimeoutS", 5.0)),
            result_timeout_s=float(data.get("resultTimeoutS", 30.0)),
            poll_interval_s=float(data.get("pollIntervalS", 0.1)),
            document_name=str(data.get("documentName") or "").strip(),
            page_id=str(data.get("pageId") or "").strip(),
            page_name=str(data.get("pageName") or "").strip(),
            selection_ids=tuple(
                str(item).strip() for item in raw_selection
                if str(item).strip()
            ),
        )


class FigmaClient:
    def __init__(
        self,
        config: FigmaClientConfig,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
        sleep: Callable[[float], None] = time.sleep,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._opener = opener
        self._sleep = sleep
        self._monotonic = monotonic

    @property
    def task_id(self) -> str:
        return self._config.task_id

    @property
    def document_session_id(self) -> str:
        return self._config.document_session_id

    def _json(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self._config.base_url}{path}",
            data=payload,
            method=method,
            headers={
                "Authorization": f"Bearer {self._config.control_token}",
                **({"Content-Type": "application/json"} if payload is not None else {}),
            },
        )
        try:
            with self._opener(request, timeout=self._config.request_timeout_s) as response:
                decoded = json.loads(response.read().decode("utf-8") or "{}")
        except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise FigmaConnectionUnavailable(
                f"figma bridge unavailable:{type(exc).__name__}"
            ) from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FigmaClientError("figma bridge returned invalid JSON") from exc
        if not isinstance(decoded, dict):
            raise FigmaClientError("figma bridge response must be an object")
        return decoded

    def request(self, operation: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        normalized = str(operation).strip()
        if normalized not in FIGMA_OPERATIONS:
            raise ValueError(f"unsupported Figma operation: {normalized}")
        queued = self._json("POST", "/requests", {
            "taskId": self.task_id,
            "documentSessionId": self.document_session_id,
            "operation": normalized,
            "arguments": dict(arguments),
        })
        command_id = str(queued.get("commandId") or "").strip()
        if not command_id:
            raise FigmaClientError(str(queued.get("error") or "figma command was not queued"))
        deadline = self._monotonic() + max(0.1, self._config.result_timeout_s)
        while self._monotonic() < deadline:
            result = self._json(
                "GET",
                f"/results/{urllib.parse.quote(command_id, safe='')}",
            )
            status = str(result.get("status") or "")
            if status == "completed":
                value = result.get("result")
                if not isinstance(value, dict):
                    raise FigmaClientError("figma command result must be an object")
                return dict(value)
            if status in {"failed", "cancelled"}:
                raise FigmaClientError(
                    str(result.get("error") or f"figma command {status}")
                )
            self._sleep(max(0.01, self._config.poll_interval_s))
        raise FigmaClientError(f"figma command timed out:{command_id}")


__all__ = [
    "FIGMA_OPERATIONS",
    "FigmaClient",
    "FigmaClientConfig",
    "FigmaClientError",
    "FigmaConnectionUnavailable",
]
