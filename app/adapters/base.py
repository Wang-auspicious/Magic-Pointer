from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

JsonDict = dict[str, Any]


@dataclass(frozen=True)
class AdapterCapability:
    name: str
    description: str
    safety_level: str = "read_only"
    requires_confirmation: bool = False
    enabled: bool = True

    def to_dict(self) -> JsonDict:
        return {
            "name": self.name,
            "description": self.description,
            "safety_level": self.safety_level,
            "requires_confirmation": self.requires_confirmation,
            "enabled": self.enabled,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "AdapterCapability":
        return cls(
            name=str(data.get("name") or ""),
            description=str(data.get("description") or ""),
            safety_level=str(data.get("safety_level") or "read_only"),
            requires_confirmation=bool(data.get("requires_confirmation", False)),
            enabled=bool(data.get("enabled", True)),
        )


@dataclass(frozen=True)
class AdapterReadContext:
    adapter: str
    app: str
    window: JsonDict = field(default_factory=dict)
    content: str | None = None
    label: str | None = None
    method: str | None = None
    capabilities: list[AdapterCapability] = field(default_factory=list)
    artifacts: JsonDict = field(default_factory=dict)
    error: str | None = None

    @property
    def has_content(self) -> bool:
        return bool((self.content or "").strip()) or bool(self.artifacts)

    def to_dict(self) -> JsonDict:
        return {
            "adapter": self.adapter,
            "app": self.app,
            "window": dict(self.window),
            "content": self.content,
            "label": self.label,
            "method": self.method,
            "capabilities": [cap.to_dict() for cap in self.capabilities],
            "artifacts": dict(self.artifacts),
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: JsonDict) -> "AdapterReadContext":
        return cls(
            adapter=str(data.get("adapter") or ""),
            app=str(data.get("app") or ""),
            window=dict(data.get("window") or {}),
            content=data.get("content"),
            label=data.get("label"),
            method=data.get("method"),
            capabilities=[
                AdapterCapability.from_dict(item)
                for item in list(data.get("capabilities") or [])
                if isinstance(item, dict)
            ],
            artifacts=dict(data.get("artifacts") or {}),
            error=data.get("error"),
        )


class AppAdapter(ABC):
    name = "base"

    @abstractmethod
    def match_window(self, window: JsonDict) -> bool:
        raise NotImplementedError

    @abstractmethod
    def read_context(self, window: JsonDict, **kwargs: Any) -> AdapterReadContext:
        raise NotImplementedError


def format_adapter_context(ctx: AdapterReadContext | None) -> str:
    if ctx is None:
        return ""
    # No hedging instruction here, deliberately. This used to tell the model that
    # OCR text was "an approximate visual observation, not native app truth", and
    # the model dutifully opened every answer by apologising for its own
    # perception stack. The user asked what the sentence on screen means; how we
    # came to read it is our problem, and it is recorded in the receipt and the
    # diagnostics page where someone debugging can find it.
    lines = [
        "Native app adapter context v1:",
        "Answer the user's question about this content directly. Do not describe how this text was obtained, "
        "which layer produced it, or how confident that layer is — that is diagnostic information the user did not ask for.",
        f"adapter={ctx.adapter!r}, app={ctx.app!r}, method={ctx.method!r}, label={ctx.label!r}",
    ]
    if ctx.window:
        lines.append(f"window_title={ctx.window.get('title')!r}, class={ctx.window.get('class_name')!r}, hwnd={ctx.window.get('hwnd')!r}")
    # A read error only matters to the answer when it left us with nothing. With
    # content in hand it is a detail of a path that ended up working.
    if ctx.error and not str(ctx.content or "").strip():
        lines.append(f"read_error={ctx.error!r}")
    if ctx.artifacts:
        safe_artifacts = {
            k: v
            for k, v in ctx.artifacts.items()
            if k not in {"raw", "selection_context"}
        }
        lines.append(f"artifacts={safe_artifacts!r}")
    if ctx.capabilities:
        lines.append("capabilities:")
        for cap in ctx.capabilities:
            lines.append(f"- {cap.name}: {cap.description} safety={cap.safety_level} confirm={cap.requires_confirmation} enabled={cap.enabled}")
    if ctx.content:
        lines.append("selected_text_exact:")
        lines.append("```text")
        lines.append(ctx.content[:16000])
        lines.append("```")
    selection_context = str(ctx.artifacts.get("selection_context") or "").strip()
    if selection_context:
        lines.append("surrounding_context_from_same_document:")
        lines.append("```text")
        lines.append(selection_context[:16000])
        lines.append("```")
    return "\n".join(lines)
