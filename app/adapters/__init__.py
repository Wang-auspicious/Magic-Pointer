from .base import AdapterCapability, AdapterReadContext, AppAdapter, format_adapter_context
from .office_adapter import OfficeAdapter, office_app_from_window
from .registry import AppAdapterRegistry, default_adapter_registry
from .uia_text_adapter import UiaTextSelectionAdapter, uia_app_from_window

__all__ = [
    "AdapterCapability",
    "AdapterReadContext",
    "AppAdapter",
    "format_adapter_context",
    "OfficeAdapter",
    "office_app_from_window",
    "UiaTextSelectionAdapter",
    "uia_app_from_window",
    "AppAdapterRegistry",
    "default_adapter_registry",
]
