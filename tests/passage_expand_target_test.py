"""就地展开的长度目标。

这里钉的是截图里那个真实的失败：一句 47 字、没有换行的中文回答，用户拉一下
想看得细一点，回来的是「目标长度是原文的四倍以上，多出来的部分只能靠编造」。

原因不是护栏太严，是**比值算错了**。手势说的「6 行」是 540px 面板里折行后的
视觉行，引擎数的 source_lines 是文本里的换行符——那句话一个换行都没有，所以
分母是 1，6/1 = 6 > 4，护栏必响。护栏本身是对的，它只是被喂了两个不同单位的数。

所以这里同时钉两件事：
  1. auto_expand_target 用字数，比值恒为 2.4，那条护栏永远不会误伤；
  2. 它给出的方向永远是 expand——按钮上写着「展开讲讲」，回来的东西不能更短。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.text_actions.length_target import (  # noqa: E402
    AUTO_EXPAND_MAX_CHARS,
    auto_expand_target,
    target_from_command,
    warning_for,
)

SCREENSHOT_ANSWER = "根据屏幕区域识别，你选中的内容是 CHANGELOG.md，这通常是一个软件的变更日志文件名。"


def test_screenshot_case_no_longer_trips_the_guard() -> None:
    """截图里那一句，走新路不再报「只能靠编造」。"""
    target = auto_expand_target(SCREENSHOT_ANSWER)
    assert target.direction == "expand"
    assert warning_for(target, SCREENSHOT_ANSWER) is None


def test_old_line_path_is_why_it_tripped() -> None:
    """同一句话走旧的「扩写到 6 行」，护栏确实会响——护栏没坏，单位错了。"""
    old = target_from_command("把这个回答扩写到 6 行", SCREENSHOT_ANSWER)
    assert old is not None
    assert old.source_lines == 1          # 一个换行符都没有
    assert old.ratio == 6.0               # 而手势说的 6 是折行后的视觉行
    assert warning_for(old, SCREENSHOT_ANSWER) is not None


def test_char_target_measures_what_the_gesture_meant() -> None:
    """改说字数之后，同一个手势的比值落在护栏之内。"""
    chars = target_from_command("把选中的这段扩写到 110 字", SCREENSHOT_ANSWER)
    assert chars is not None
    assert chars.target_chars == 110
    assert chars.direction == "expand"
    assert warning_for(chars, SCREENSHOT_ANSWER) is None


def test_too_short_still_refuses() -> None:
    """短到没有结构的东西，展开它就是重写。这条护栏要留着。"""
    tiny = "太短了"
    assert warning_for(auto_expand_target(tiny), tiny) is not None


def test_long_passage_stays_longer_than_the_source() -> None:
    """已经很长的段落撞上限之后，方向必须还是「更长」，不能悄悄变成压缩。"""
    long_source = "细节。" * 900          # 2700 字，2.4 倍会被 1600 的上限压回去
    target = auto_expand_target(long_source)
    assert target.direction == "expand"
    assert target.target_chars > target.source_chars
    assert target.target_chars > AUTO_EXPAND_MAX_CHARS


def test_ratio_is_bounded_for_every_ordinary_length() -> None:
    """任何正常长度进去，比值都待在 4.0 以内——护栏永远不会误伤自动目标。"""
    for chars in (10, 30, 47, 120, 400, 1200):
        source = "字" * chars
        target = auto_expand_target(source)
        assert target.direction == "expand"
        assert target.ratio <= 4.0, f"{chars} 字的自动目标比值 {target.ratio} 会撞护栏"


def _run() -> int:
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
    if failures:
        print(f"passage expand target test: {failures} failed")
        return 1
    print("passage expand target test ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(_run())
