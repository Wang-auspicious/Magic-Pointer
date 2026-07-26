from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class ContextIntentKind(str, Enum):
    COLLECT = "collect"
    COMPILE = "compile"
    DELIVER = "deliver"
    CLEAR = "clear"


@dataclass(frozen=True)
class ContextIntent:
    kind: ContextIntentKind
    instruction: str
    raw_command: str


_PREFIXES: tuple[tuple[ContextIntentKind, tuple[str, ...]], ...] = (
    (ContextIntentKind.COLLECT, ("加入上下文", "收集", "记住", "context")),
    (ContextIntentKind.COMPILE, ("生成完整提示词", "生成提示词", "整理上下文", "compile context")),
    (ContextIntentKind.DELIVER, ("交给这个 agent", "发送到这里", "填入这里", "deliver here")),
    (ContextIntentKind.CLEAR, ("清空上下文", "clear context")),
)


def _match_prefix(command: str, prefix: str) -> str | None:
    folded = command.casefold()
    expected = prefix.casefold()
    if not folded.startswith(expected):
        return None
    remainder = command[len(prefix) :]
    if not remainder:
        return ""
    if remainder[0] not in {":", "："}:
        return None
    return remainder[1:].strip()


def parse_context_intent(command: str | None) -> ContextIntent | None:
    raw = str(command or "").strip()
    if not raw:
        return None
    for kind, prefixes in _PREFIXES:
        for prefix in prefixes:
            instruction = _match_prefix(raw, prefix)
            if instruction is not None:
                return ContextIntent(kind=kind, instruction=instruction, raw_command=raw)
    return None
