"""Typed Receipt projections over the Agent Runtime session log."""

from .projection import compose_receipt, project_receipts
from .schema import Receipt, ReceiptProjectionError, ReceiptStatus

__all__ = [
    "Receipt",
    "ReceiptProjectionError",
    "ReceiptStatus",
    "compose_receipt",
    "project_receipts",
]
