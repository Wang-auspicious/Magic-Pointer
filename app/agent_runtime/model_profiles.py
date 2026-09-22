
from __future__ import annotations

__all__ = ["context_window_for", "context_budget_for"]

_DEFAULT_CONTEXT_WINDOW = 64_000

_CONTEXT_WINDOWS: tuple[tuple[str, int], ...] = (
    ("gemini-2", 1_000_000),
    ("gemini-3", 1_000_000),
    ("gpt-4.1", 1_000_000),
    ("gpt-5.6", 1_050_000),
    ("gpt-5.5", 1_050_000),
    ("gpt-5.4-mini", 400_000),
    ("gpt-5.4-nano", 400_000),
    ("gpt-5.4", 1_050_000),
    ("gpt-5.1", 400_000),
    ("gpt-5", 400_000),
    ("gpt-4o", 128_000),
    ("gpt-4o-mini", 128_000),
    ("o3", 200_000),
    ("o4", 200_000),
    ("claude-opus-5", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-fable-5", 1_000_000),
    ("claude-mythos-5", 1_000_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-sonnet-4-6", 1_000_000),
    ("claude-opus-4", 200_000),
    ("claude-sonnet-4", 200_000),
    ("claude-haiku-4-5", 200_000),
    ("claude-haiku-4", 200_000),
    ("claude-3-7", 200_000),
    ("claude-3-5", 200_000),
    ("kimi-k2", 256_000),
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
    ("glm-4.6", 200_000),
    ("glm-4", 128_000),
    ("mimo", 128_000),
    ("grok-4", 256_000),
    ("llama4", 128_000),
    ("minimax", 200_000),
)

def context_window_for(model_name: str | None, default: int = _DEFAULT_CONTEXT_WINDOW) -> int:
    name = str(model_name or "").casefold().strip()
    if not name:
        return default
    candidates = (name, name.rsplit("/", 1)[-1]) if "/" in name else (name,)
    best: tuple[int, int] | None = None
    for prefix, window in _CONTEXT_WINDOWS:
        if any(candidate.startswith(prefix) for candidate in candidates) and (
            best is None or len(prefix) > best[0]
        ):
            best = (len(prefix), window)
    return best[1] if best is not None else default


def context_budget_for(model_name: str | None, configured: int | None = None) -> int:
    if configured is not None and int(configured) > 0:
        return int(configured)
    window = context_window_for(model_name)
    return max(_DEFAULT_CONTEXT_WINDOW, int(window))
