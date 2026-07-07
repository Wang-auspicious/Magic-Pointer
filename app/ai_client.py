from __future__ import annotations

import base64
import os
import time
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECRETS_DIR = ROOT / "secrets"

LabeledImage = tuple[str, Path]


DEFAULT_SYSTEM_PROMPT = """你是 Magic Pointer Open 的屏幕对象助手。
用户刚刚框选了屏幕上的一个局部区域，并用短指令询问它。
请基于截图内容直接回答。若截图信息不足，请明确说缺什么，不要编造。
输出要短、可执行、中文优先；需要时给出步骤或要点。"""


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


def ask_vision_model(
    image_path: Path,
    user_prompt: str,
    context_text: str | None = None,
    extra_image_paths: list[Path] | None = None,
    labeled_extra_images: list[LabeledImage] | None = None,
) -> str:
    """Ask an OpenAI-compatible multimodal model about the screenshot."""

    api_key, base_url, model = get_ai_config()
    if not api_key:
        return (
            "\u5df2\u5b8c\u6210\u622a\u56fe\u4e0e\u5bf9\u8c61\u767b\u8bb0\uff0c\u4f46\u672a\u68c0\u6d4b\u5230 OPENAI_API_KEY \u6216 secrets/openai_key.txt\uff0c\u6240\u4ee5\u6ca1\u6709\u8c03\u7528\u591a\u6a21\u6001\u6a21\u578b\u3002\n\n"
            f"\u622a\u56fe\u5df2\u4fdd\u5b58\uff1a{image_path}\n\n"
            "\u53ef\u901a\u8fc7\u73af\u5883\u53d8\u91cf\u6216 secrets/openai_key.txt \u914d\u7f6e key\u3002"
        )

    try:
        import httpx

        base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "curl/8.0",
        }
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
                {"type": "image_url", "image_url": {"url": _image_data_url(image_path)}},
            ]
            if include_extras:
                for label, extra_path in normalize_labeled_extras()[:3]:
                    if extra_path.exists():
                        user_content.append({"type": "text", "text": f"[{label}]"})
                        user_content.append({"type": "image_url", "image_url": {"url": _image_data_url(extra_path)}})
            return {
                "model": model,
                "messages": [
                    {"role": "system", "content": DEFAULT_SYSTEM_PROMPT},
                    {"role": "user", "content": user_content},
                ],
                "max_tokens": 1200,
            }


        last_exc: Exception | None = None
        # Try full payload twice; if the gateway drops TLS, fall back to primary
        # image only while keeping structured text context.
        attempts = [(True, 0.0), (True, 0.8), (False, 1.2)]
        for include_extras, delay in attempts:
            if delay:
                time.sleep(delay)
            try:
                payload = build_payload(include_extras=include_extras)
                with httpx.Client(timeout=120, follow_redirects=True) as client:
                    response = client.post(f"{base_url}/chat/completions", headers=headers, json=payload)
                if response.status_code >= 400:
                    return f"AI \u8c03\u7528\u5931\u8d25\uff1aHTTP {response.status_code}\n\n{response.text[:1200]}"
                data = response.json()
                answer = data["choices"][0]["message"].get("content") or ""
                if not include_extras and extra_image_paths:
                    answer += "\n\n(Gateway was unstable, so this request fell back to the primary screenshot plus structured context.)"
                return answer
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.TimeoutException) as exc:
                last_exc = exc
                continue
        if last_exc:
            raise last_exc
        raise RuntimeError("unknown API failure")
    except Exception as exc:
        return (
            "AI \u8c03\u7528\u5931\u8d25\uff0c\u4f46\u622a\u56fe\u548c\u5bf9\u8c61\u5df2\u4fdd\u7559\u3002\n\n"
            f"\u9519\u8bef\uff1a{type(exc).__name__}: {exc}\n\n"
            "\u6211\u5df2\u5bf9\u517c\u5bb9\u7f51\u5173\u7684 SSL/\u65ad\u8fde\u95ee\u9898\u505a\u4e86\u91cd\u8bd5\u548c\u964d\u7ea7\u5904\u7406\u3002\u5982\u679c\u4ecd\u7136\u5931\u8d25\uff0c\u901a\u5e38\u662f\u670d\u52a1\u7aef\u6216\u7f51\u7edc\u77ed\u65f6\u4e0d\u7a33\uff0c\u53ef\u7a0d\u540e\u91cd\u8bd5\uff0c\u6216\u68c0\u67e5 secrets/openai_base_url.txt / secrets/model.txt\u3002"
        )
