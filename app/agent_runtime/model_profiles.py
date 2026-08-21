"""Model profiles: per-model context windows and quirks (Codex model_family port).

Codex keeps a ``model_family`` table so turn budgets, compaction thresholds
and output limits adapt to the model actually configured instead of assuming
one size. MP's equivalent: the compaction budget was a flat 64000 tokens for
every model — too small for 200k+ models (compaction fires far too early,
wasting context) and dangerous for 32k ones. The explicit
``MAGIC_POINTER_CONTEXT_TOKENS`` env always wins; otherwise the profile table
decides, falling back to the historical 64000 for unknown models.
"""

from __future__ import annotations

import re

__all__ = ["context_window_for", "context_budget_for"]

_DEFAULT_CONTEXT_WINDOW = 64_000
"""Historical MP default; also the fallback for unknown models."""

# Longest-prefix match against the configured model id. Numbers are
# conservative public context windows (input tokens) per family.
_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("gemini-2", 1_000_000),
    ("gemini-3", 1_000_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-5", 400_000),
    ("gpt-4o", 128_000),
    ("gpt-4o-mini", 128_000),
    ("o3", 200_000),
    ("o4", 200_000),
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4", 200_000),
    ("claude-3-7", 200_000),
    ("claude-3-5", 200_000),
    ("kimi-k", 256_000),
    ("deepseek-v4", 128_000),
    ("deepseek-v3", 128_000),
    ("deepseek-r", 128_000),
    ("deepseek-chat", 128_000),
    ("deepseek-reasoner", 128_000),
    ("qwen3.7", 128_000),
    ("qwen3-coder", 256_000),
    ("qwen3", 128_000),
    ("qwen4", 256_000),
    ("glm-5", 200_000),
    ("glm-4", 128_000),
    ("mimo", 128_000),
    ("grok-4", 256_000),
    ("llama4", 128_000),
    ("minimax", 200_000),
)

_COMPACTION_SAFETY_MARGIN = 0.7
"""Compact at 70% of the window: headroom for tool schemas + the reply."""


def context_window_for(model_name: str | None) -> int:
    """Best-known context window (tokens) for ``model_name``."""
    name = str(model_name or "").casefold().strip()
    if not name:
        return _DEFAULT_CONTEXT_WINDOW
    for prefix, window in _CONTEXT_WINDOWS:
        if name.startswith(prefix):
            return window
    return _DEFAULT_CONTEXT_WINDOW


def context_budget_for(model_name: str | None, configured: int | None = None) -> int:
    """Compaction budget: explicit config wins, else profile-derived.

    ``configured`` is the raw row value (env override or the historical
    64000 default). Because the env default cannot be distinguished from "no
    override" at this layer, an unset env yields ``None`` from the bundle;
    only an explicit value pins the budget.
    """
    if configured is not None and int(configured) > 0:
        return int(configured)
    window = context_window_for(model_name)
    return max(_DEFAULT_CONTEXT_WINDOW, int(window * _COMPACTION_SAFETY_MARGIN))
