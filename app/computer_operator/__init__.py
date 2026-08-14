"""Scoped computer operator seam for optional GUI-control providers."""

from .agent import (
    UiTarsActionModel,
    UiTarsComputerAgent,
    UiTarsPrediction,
    UiTarsRunResult,
)
from .configured_model import ConfiguredUiTarsModel
from .protocol import ComputerOperatorBackend, GuardedComputerOperator
from .registry import ComputerOperatorRegistry
from .schema import (
    ComputerAction,
    ComputerActionKind,
    OperatorActionReceipt,
    OperatorBackendResult,
    OperatorObservation,
    SurfaceGrant,
)
from .service import ComputerTaskService
from .ui_tars import UiTarsActionIntent, compile_ui_tars_intent, parse_ui_tars_response
from .windows import Win32InputDriver, WindowsComputerOperatorBackend

__all__ = [
    "ComputerAction",
    "ComputerActionKind",
    "ConfiguredUiTarsModel",
    "ComputerOperatorBackend",
    "ComputerOperatorRegistry",
    "ComputerTaskService",
    "GuardedComputerOperator",
    "OperatorActionReceipt",
    "OperatorBackendResult",
    "OperatorObservation",
    "SurfaceGrant",
    "UiTarsActionIntent",
    "UiTarsActionModel",
    "UiTarsComputerAgent",
    "UiTarsPrediction",
    "UiTarsRunResult",
    "Win32InputDriver",
    "WindowsComputerOperatorBackend",
    "compile_ui_tars_intent",
    "parse_ui_tars_response",
]
