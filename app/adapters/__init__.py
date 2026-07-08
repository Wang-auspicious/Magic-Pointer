from .base import AdapterCapability, AdapterReadContext, AppAdapter, format_adapter_context
from .office_adapter import OfficeAdapter, office_app_from_window
from .registry import AppAdapterRegistry, default_adapter_registry

__all__ = [
    "AdapterCapability",
    "AdapterReadContext",
    "AppAdapter",
    "format_adapter_context",
    "OfficeAdapter",
    "office_app_from_window",
    "AppAdapterRegistry",
    "default_adapter_registry",
]
