
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Direction = Literal["expand", "condense", "keep"]

MIN_MEANINGFUL_CHARS = 8

LINE_TOLERANCE = 0.34
CHAR_TOLERANCE = 0.30


@dataclass(frozen=True)
class LengthTarget:

    direction: Direction
    target_lines: int | None = None
    target_chars: int | None = None
    source_lines: int = 0
    source_chars: int = 0

    @property
    def ratio(self) -> float:
        if self.target_lines is not None and self.source_lines > 0:
            return self.target_lines / self.source_lines
        if self.target_chars is not None and self.source_chars > 0:
            return self.target_chars / self.source_chars
        return 1.0

    @property
    def recipe_id(self) -> str:
        return "selection.condense" if self.direction == "condense" else "selection.expand"

    def to_dict(self) -> dict[str, object]:
        return {
            "direction": self.direction,
            "targetLines": self.target_lines,
            "targetChars": self.target_chars,
            "sourceLines": self.source_lines,
            "sourceChars": self.source_chars,
            "ratio": round(self.ratio, 3),
        }


def count_lines(text: str) -> int:
    stripped = str(text or "").strip()
    if not stripped:
        return 0
    return len([line for line in stripped.splitlines() if line.strip()])


def measure(text: str) -> tuple[int, int]:
    value = str(text or "")
    return count_lines(value), len(value.strip())


def target_from_handle(
    source_text: str,
    *,
    delta_lines: int | None = None,
    target_lines: int | None = None,
    target_chars: int | None = None,
) -> LengthTarget:
    source_lines, source_chars = measure(source_text)

    if target_lines is None and delta_lines is not None:
        target_lines = max(1, source_lines + int(delta_lines))

    if target_lines is not None:
        direction: Direction = (
            "keep" if target_lines == source_lines
            else "expand" if target_lines > source_lines
            else "condense"
        )
        return LengthTarget(
            direction=direction,
            target_lines=max(1, int(target_lines)),
            source_lines=source_lines,
            source_chars=source_chars,
        )

    if target_chars is not None:
        direction = (
            "keep" if target_chars == source_chars
            else "expand" if target_chars > source_chars
            else "condense"
        )
        return LengthTarget(
            direction=direction,
            target_chars=max(1, int(target_chars)),
            source_lines=source_lines,
            source_chars=source_chars,
        )

    return LengthTarget(direction="keep", source_lines=source_lines, source_chars=source_chars)


AUTO_EXPAND_RATIO = 2.4

AUTO_EXPAND_MAX_CHARS = 1600


def auto_expand_target(source_text: str) -> LengthTarget:
    source_lines, source_chars = measure(source_text)
    wanted = min(AUTO_EXPAND_MAX_CHARS, max(1, round(source_chars * AUTO_EXPAND_RATIO)))
    if wanted <= source_chars:
        wanted = source_chars + max(60, source_chars // 5)
    return LengthTarget(
        direction="expand",
        target_chars=wanted,
        source_lines=source_lines,
        source_chars=source_chars,
    )


def describe_target(target: LengthTarget) -> str:
    if target.direction == "keep":
        return "长度不变"
    verb = "扩写到" if target.direction == "expand" else "压缩到"
    if target.target_lines is not None:
        return f"{verb} {target.target_lines} 行（当前 {target.source_lines} 行）"
    if target.target_chars is not None:
        return f"{verb} {target.target_chars} 字（当前 {target.source_chars} 字）"
    return verb.rstrip("到")


def warning_for(target: LengthTarget, source_text: str) -> str | None:
    _, source_chars = measure(source_text)
    if source_chars < MIN_MEANINGFUL_CHARS:
        return "选中的内容太短了，扩写或压缩都只会变成重写。请多选一些再拉。"
    if target.direction == "expand" and target.ratio > 4.0:
        return "目标长度是原文的四倍以上，多出来的部分只能靠编造。建议分几次拉，或者先补充要点。"
    if target.direction == "condense" and target.ratio < 0.15:
        return "目标长度不到原文的六分之一，会丢掉大部分信息。确认要压到这么短吗？"
    return None


def build_instruction(target: LengthTarget, *, user_note: str = "") -> str:
    if target.target_lines is not None:
        size = f"{target.target_lines} 行"
    elif target.target_chars is not None:
        size = f"{target.target_chars} 个字"
    else:
        size = "原来的长度"

    if target.direction == "expand":
        head = (
            f"把下面这段文字扩写到大约 {size}。"
            "补充的内容必须来自原文已有的意思——展开论证、补足省略的步骤、把概括写具体，"
            "不要引入原文没有的事实、数字、人名或来源。"
        )
    elif target.direction == "condense":
        head = (
            f"把下面这段文字压缩到大约 {size}。"
            "保留结论、关键数字和专有名词，删掉重复与铺垫，不要因为要变短就改变原意。"
        )
    else:
        head = "在保持长度基本不变的前提下润色下面这段文字。"

    tail = (
        "只输出替换后的文字本身。不要前言，不要“好的”“以下是”，"
        "不要标题、引号、markdown 或任何解释。保持原文的语言和段落结构。"
    )
    note = f"\n额外要求：{user_note.strip()}" if user_note.strip() else ""
    return f"{head}{note}\n{tail}"


def hit_target(result_text: str, target: LengthTarget) -> tuple[bool, str]:
    result_lines, result_chars = measure(result_text)
    if target.target_lines is not None:
        wanted = target.target_lines
        got = result_lines
        hit = abs(got - wanted) <= max(1, round(wanted * LINE_TOLERANCE))
        return hit, f"目标 {wanted} 行，实际 {got} 行"
    if target.target_chars is not None:
        wanted = target.target_chars
        got = result_chars
        hit = abs(got - wanted) <= max(8, round(wanted * CHAR_TOLERANCE))
        return hit, f"目标 {wanted} 字，实际 {got} 字"
    return True, f"实际 {result_lines} 行 / {result_chars} 字"


_COMMAND_LINES_RE = re.compile(r"(?:扩写|压缩|精简|缩)(?:到|成)?\s*(\d{1,3})\s*行")
_COMMAND_CHARS_RE = re.compile(r"(?:扩写|压缩|精简|缩)(?:到|成)?\s*(\d{1,5})\s*(?:字|个字)")


def target_from_command(command: str, source_text: str) -> LengthTarget | None:
    value = str(command or "")
    match = _COMMAND_LINES_RE.search(value)
    if match:
        return target_from_handle(source_text, target_lines=int(match.group(1)))
    match = _COMMAND_CHARS_RE.search(value)
    if match:
        return target_from_handle(source_text, target_chars=int(match.group(1)))
    return None
