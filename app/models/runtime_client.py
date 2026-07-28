from __future__ import annotations

from typing import Any, Callable

from app.models.profiles import ModelProfile


Transport = Callable[[dict[str, Any]], dict[str, Any]]
_ONE_PIXEL_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII="
)


class ModelRuntimeClient:
    """Calls a selected profile with a credential supplied for this request only."""

    def __init__(self, *, transport: Transport | None = None) -> None:
        self.transport = transport or self._http_transport

    @staticmethod
    def _http_transport(request: dict[str, Any]) -> dict[str, Any]:
        import httpx

        with httpx.Client(timeout=120, follow_redirects=True) as client:
            response = client.post(str(request["url"]), headers=dict(request["headers"]), json=dict(request["json"]))
        return {"status": response.status_code, "json": response.json() if response.content else {}, "text": response.text[:500]}

    @staticmethod
    def _endpoint(profile: ModelProfile) -> str:
        base_url = profile.base_url.rstrip("/")
        if profile.api_mode == "responses":
            suffix = "/responses"
        elif profile.api_mode == "messages":
            suffix = "/messages"
        else:
            suffix = "/chat/completions"
        return base_url + suffix

    def complete_text(self, profile: ModelProfile, *, credential: str | None, user_text: str, system_text: str = "") -> dict[str, Any]:
        if not profile.enabled:
            return {"ok": False, "state": "failed", "error": "model_profile_disabled", "evidence": {"apiMode": profile.api_mode}}
        if profile.api_mode != "local" and not str(credential or "").strip():
            return {"ok": False, "state": "failed", "error": "credential_missing", "evidence": {"apiMode": profile.api_mode}}
        text = str(user_text or "").strip()
        if profile.api_mode == "responses":
            body: dict[str, Any] = {
                "model": profile.model,
                "input": [{"role": "user", "content": [{"type": "input_text", "text": text}]}],
            }
            if system_text.strip():
                body["instructions"] = system_text.strip()
            headers = {"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}
        elif profile.api_mode == "messages":
            body = {
                "model": profile.model,
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": text}],
            }
            if system_text.strip():
                body["system"] = system_text.strip()
            headers = {
                "x-api-key": str(credential or ""),
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
        else:
            messages = []
            if system_text.strip():
                messages.append({"role": "system", "content": system_text.strip()})
            messages.append({"role": "user", "content": text})
            body = {"model": profile.model, "messages": messages}
            headers = {"Content-Type": "application/json"}
            if profile.api_mode != "local":
                headers["Authorization"] = f"Bearer {credential}"
        request = {"url": self._endpoint(profile), "headers": headers, "json": body}
        try:
            response = self.transport(request)
        except Exception as exc:
            return {"ok": False, "state": "failed", "error": f"runtime_transport_failed:{type(exc).__name__}", "evidence": {"apiMode": profile.api_mode}}
        status = int(response.get("status") or 0)
        body = response.get("json") if isinstance(response.get("json"), dict) else {}
        if status < 200 or status >= 300:
            return {"ok": False, "state": "failed", "error": f"runtime_http_{status or 'unknown'}", "evidence": {"apiMode": profile.api_mode}}
        text = self._response_text(profile.api_mode, body)
        if not text:
            return {"ok": False, "state": "failed", "error": "runtime_empty_response", "evidence": {"apiMode": profile.api_mode}}
        return {"ok": True, "state": "completed", "text": text, "evidence": {"apiMode": profile.api_mode}}

    def probe_vision(
        self,
        profile: ModelProfile,
        *,
        credential: str | None,
    ) -> dict[str, Any]:
        """User-triggered 1x1 image probe. Network or auth failures remain unknown."""
        evidence = {"apiMode": profile.api_mode, "probe": "user_requested_1x1_image"}
        if not profile.enabled:
            return {
                "ok": False,
                "state": "failed",
                "visionInput": "unknown",
                "error": "model_profile_disabled",
                "evidence": evidence,
            }
        if profile.api_mode != "local" and not str(credential or "").strip():
            return {
                "ok": False,
                "state": "failed",
                "visionInput": "unknown",
                "error": "credential_missing",
                "evidence": evidence,
            }
        data_url = f"data:image/png;base64,{_ONE_PIXEL_PNG}"
        if profile.api_mode == "responses":
            body: dict[str, Any] = {
                "model": profile.model,
                "input": [{
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "Reply with exactly OK."},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }],
            }
            headers = {"Authorization": f"Bearer {credential}", "Content-Type": "application/json"}
        elif profile.api_mode == "messages":
            body = {
                "model": profile.model,
                "max_tokens": 8,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Reply with exactly OK."},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _ONE_PIXEL_PNG}},
                    ],
                }],
            }
            headers = {
                "x-api-key": str(credential or ""),
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            }
        else:
            body = {
                "model": profile.model,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Reply with exactly OK."},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }],
                "max_tokens": 8,
            }
            headers = {"Content-Type": "application/json"}
            if profile.api_mode != "local":
                headers["Authorization"] = f"Bearer {credential}"
        request = {"url": self._endpoint(profile), "headers": headers, "json": body}
        try:
            response = self.transport(request)
        except Exception as exc:
            return {
                "ok": False,
                "state": "failed",
                "visionInput": "unknown",
                "error": f"vision_probe_transport_failed:{type(exc).__name__}",
                "evidence": evidence,
            }
        status = int(response.get("status") or 0)
        if 200 <= status < 300:
            return {
                "ok": True,
                "state": "completed",
                "visionInput": "yes",
                "evidence": evidence,
            }
        diagnostic = " ".join((
            str(response.get("text") or ""),
            str(response.get("json") or ""),
        )).casefold()[:2000]
        names_image = any(token in diagnostic for token in ("image", "vision", "multimodal"))
        says_unsupported = any(token in diagnostic for token in (
            "not support", "unsupported", "does not support", "text-only", "text only",
        ))
        if status in {400, 404, 415, 422} and names_image and says_unsupported:
            return {
                "ok": True,
                "state": "completed",
                "visionInput": "no",
                "evidence": evidence,
            }
        return {
            "ok": False,
            "state": "failed",
            "visionInput": "unknown",
            "error": f"vision_probe_inconclusive_http_{status or 'unknown'}",
            "evidence": evidence,
        }

    @staticmethod
    def _response_text(api_mode: str, body: dict[str, Any]) -> str:
        if api_mode == "responses":
            values = []
            for output in body.get("output") or []:
                if not isinstance(output, dict):
                    continue
                for content in output.get("content") or []:
                    if isinstance(content, dict) and content.get("type") == "output_text":
                        values.append(str(content.get("text") or ""))
            return "\n".join(item for item in values if item).strip()
        if api_mode == "messages":
            values = [
                str(content.get("text") or "")
                for content in body.get("content") or []
                if isinstance(content, dict) and content.get("type") == "text"
            ]
            return "\n".join(item for item in values if item).strip()
        choices = body.get("choices") if isinstance(body, dict) else []
        message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        return str(message.get("content") or "").strip() if isinstance(message, dict) else ""
