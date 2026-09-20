"""Published-rate cost estimates, kept distinct from provider invoice amounts.

Source: https://api-docs.deepseek.com/quick_start/pricing/ (2026-09-19).
Rates are USD per million tokens. Unknown models/providers stay unknown.
"""
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal

PRICING_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/"
PRICING_DATE = "2026-09-19"


def estimate_cost_usd(usage: Mapping[str, int], model: str, host: str, at: float) -> float | None:
    if host != "api.deepseek.com":
        return None
    if model in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"}:
        hit, miss, output = (Decimal(value) for value in ("0.003", "0.15", "0.6"))
    elif model == "deepseek-v4-pro":
        hit, miss, output = (Decimal(value) for value in ("0.022", "0.66", "1.98"))
    else:
        return None
    if not all(key in usage for key in ("contextTokens", "lastCacheReadTokens", "lastOutputTokens")):
        return None
    when = datetime.fromtimestamp(at, UTC)
    peak = when.weekday() < 5 and (1 <= when.hour < 4 or 6 <= when.hour < 10)
    cached = min(usage["contextTokens"], usage["lastCacheReadTokens"])
    amount = (cached * hit + (usage["contextTokens"] - cached) * miss + usage["lastOutputTokens"] * output)
    return float(amount * (2 if peak else 1) / 1_000_000)
