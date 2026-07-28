from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.adapters.base import AdapterReadContext, AppAdapter
from app.adapters.browser_devtools_adapter import BrowserDevToolsAdapter, ChromeDevToolsProbe
from app.adapters.office_adapter import OfficeAdapter
from app.adapters.uia_text_adapter import UiaTextSelectionAdapter

JsonDict = dict[str, Any]


@dataclass
class AppAdapterRegistry:
    adapters: list[AppAdapter] = field(default_factory=list)

    def matching_adapters(self, window: JsonDict) -> list[AppAdapter]:
        matches: list[AppAdapter] = []
        for adapter in self.adapters:
            try:
                if adapter.match_window(window):
                    matches.append(adapter)
            except Exception:
                continue
        return matches

    def matching_adapter(self, window: JsonDict) -> AppAdapter | None:
        matches = self.matching_adapters(window)
        return matches[0] if matches else None

    def read_first_context(self, windows: list[JsonDict], **kwargs: Any) -> AdapterReadContext | None:
        for window in windows:
            title = str(window.get("title") or "")
            if title == "Magic Pointer Overlay":
                continue
            adapter = self.matching_adapter(window)
            if adapter:
                return adapter.read_context(window, **kwargs)
        return None


def default_adapter_registry(
    *,
    browser_devtools_enabled: bool = True,
    browser_devtools_endpoints: list[str] | tuple[str, ...] | None = None,
) -> AppAdapterRegistry:
    adapters: list[AppAdapter] = [OfficeAdapter()]
    if browser_devtools_enabled:
        adapters.append(BrowserDevToolsAdapter(
            probe=ChromeDevToolsProbe(endpoints=browser_devtools_endpoints).probe,
        ))
    adapters.append(UiaTextSelectionAdapter())
    return AppAdapterRegistry(adapters=adapters)
