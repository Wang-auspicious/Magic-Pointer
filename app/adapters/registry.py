from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.adapters.base import AdapterReadContext, AppAdapter
from app.adapters.office_adapter import OfficeAdapter

JsonDict = dict[str, Any]


@dataclass
class AppAdapterRegistry:
    adapters: list[AppAdapter] = field(default_factory=list)

    def matching_adapter(self, window: JsonDict) -> AppAdapter | None:
        for adapter in self.adapters:
            try:
                if adapter.match_window(window):
                    return adapter
            except Exception:
                continue
        return None

    def read_first_context(self, windows: list[JsonDict], **kwargs: Any) -> AdapterReadContext | None:
        for window in windows:
            title = str(window.get("title") or "")
            if title == "Magic Pointer Overlay":
                continue
            adapter = self.matching_adapter(window)
            if adapter:
                return adapter.read_context(window, **kwargs)
        return None


def default_adapter_registry() -> AppAdapterRegistry:
    return AppAdapterRegistry(adapters=[OfficeAdapter()])
