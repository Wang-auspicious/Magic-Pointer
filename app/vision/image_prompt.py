"""Turn an image into words a text-only model can act on.

This is "give a blind model eyes". The user points at a picture — a chart, a UI
screenshot, an error dialog, a photo — and gets a description they can paste
into DeepSeek, a local Llama, or any chat box that cannot see. Projects that do
this exist as one-offs; here it is a capability over anything on screen.

Three layers, cheapest first, and every one of them is optional:

  text      OCR — the words in the image, with their layout
  elements  detected UI components (OmniParser when installed) — what kind of
            thing is where
  caption   a vision model's own description — only when one is configured and
            the user has allowed the image to leave the machine

The layers that are available get composed; the ones that are not get *named* as
missing. A description that quietly omits the visual layer would let a user
believe a text-only model was told what the picture looks like, which is exactly
the lie this feature exists to avoid.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# A prompt longer than this stops being useful context and starts crowding out
# the user's own question in the target model's window.
MAX_PROMPT_CHARS = 6000
MAX_TEXT_CHARS = 3000
MAX_ELEMENTS = 40


@dataclass
class ImagePromptLayers:
    """What we actually managed to read. Absent layers stay absent."""

    text: str = ""
    text_engine: str = ""
    elements: list[dict[str, Any]] = field(default_factory=list)
    element_engine: str = ""
    caption: str = ""
    caption_model: str = ""
    width: int = 0
    height: int = 0
    # Why a layer is missing, keyed by layer name. Reported, never hidden.
    missing: dict[str, str] = field(default_factory=dict)

    @property
    def available_layers(self) -> list[str]:
        layers = []
        if self.text.strip():
            layers.append("text")
        if self.elements:
            layers.append("elements")
        if self.caption.strip():
            layers.append("caption")
        return layers

    @property
    def has_anything(self) -> bool:
        return bool(self.available_layers)


def _element_line(element: dict[str, Any]) -> str:
    kind = str(element.get("kind") or element.get("type") or element.get("control_type") or "元件").strip()
    label = str(element.get("label") or element.get("text") or element.get("name") or "").strip()
    rect = element.get("rect") or element.get("bbox")
    where = ""
    if isinstance(rect, (list, tuple)) and len(rect) == 4:
        try:
            x, y, width, height = (int(round(float(value))) for value in rect)
            where = f" 位置 {x},{y} 尺寸 {width}×{height}"
        except (TypeError, ValueError):
            where = ""
    return f"- {kind}{f'：{label}' if label else ''}{where}"


def compose_prompt(
    layers: ImagePromptLayers,
    *,
    question: str = "",
) -> str:
    """Compose the paste-ready description.

    Written for a model that cannot see: it says what is known, where it came
    from, and — critically — what is NOT known, so the receiving model does not
    confidently answer a question about pixels nobody described to it.
    """
    if not layers.has_anything:
        return ""

    sections: list[str] = ["[图像描述 · 由 Magic Pointer 从屏幕生成]"]
    if layers.width and layers.height:
        sections.append(f"图像尺寸：{layers.width}×{layers.height} 像素")

    if layers.caption.strip():
        sections.append(f"\n整体内容（视觉模型 {layers.caption_model or '未命名'}）：\n{layers.caption.strip()}")

    if layers.text.strip():
        text = layers.text.strip()[:MAX_TEXT_CHARS]
        truncated = "（文字过多，已截断）" if len(layers.text.strip()) > MAX_TEXT_CHARS else ""
        sections.append(f"\n图中文字（OCR {layers.text_engine or '本地'}）{truncated}：\n{text}")

    if layers.elements:
        lines = [_element_line(element) for element in layers.elements[:MAX_ELEMENTS]]
        more = f"\n（还有 {len(layers.elements) - MAX_ELEMENTS} 个元件未列出）" if len(layers.elements) > MAX_ELEMENTS else ""
        sections.append(
            f"\n界面元件（{layers.element_engine or '结构化读取'}，共 {len(layers.elements)} 个）：\n"
            + "\n".join(lines)
            + more
        )

    # The honest part. A receiving model told "here is a description of an image"
    # will answer questions about colour, style and composition unless it is told
    # nobody described those.
    if "caption" not in layers.available_layers:
        reason = layers.missing.get("caption", "没有可用的视觉模型")
        sections.append(
            f"\n未提供的信息：图像的视觉外观（颜色、风格、构图、非文字内容）没有被描述——{reason}。"
            "回答时不要推测这些内容；如果问题依赖它们，请说明需要能看图的模型。"
        )
    if "text" not in layers.available_layers:
        sections.append(f"\n未提供的信息：图中文字未能识别——{layers.missing.get('text', 'OCR 没有返回结果')}。")

    if question.strip():
        sections.append(f"\n用户的问题：{question.strip()}")

    prompt = "\n".join(sections).strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS].rstrip() + "\n（描述过长，已截断）"
    return prompt


def describe_coverage(layers: ImagePromptLayers) -> str:
    """One line for the bubble: what the description is actually based on."""
    names = {"text": "文字", "elements": "界面元件", "caption": "视觉描述"}
    available = [names[layer] for layer in layers.available_layers]
    if not available:
        return "没有从这张图里读到任何可用信息。"
    line = "已包含：" + "、".join(available)
    if layers.missing:
        line += "；缺少：" + "、".join(names.get(key, key) for key in layers.missing if key not in layers.available_layers)
    return line
