"""聊天卡片上的文件名 → 本机的真实路径。

圈的是**卡片**，不是文件。模型手里只有一个名字，而它的下一步通常是「读它」。位置
是查出来的，不是猜出来的：不同人的存储盘符、账号目录、月份目录都不一样，猜出来的
路径看起来总是很像真的。

实测（本机，2026-09-19）：微信 4.x 的数据盘记在
`%APPDATA%\\Tencent\\xwechat\\config\\*.ini`（本机内容是 `D:\\`），文件本体在

    <数据盘>\\xwechat_files\\<wxid>_<四位>\\msg\\file\\<YYYY-MM>\\<原始文件名>

圈里那张 `cvpr2027-verified-top5.html` 就在 `D:\\xwechat_files\\...\\msg\\file\\2026-09\\`。
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.context_pack.chat_local_files import (  # noqa: E402
    chat_data_roots,
    locate_chat_file,
    looks_like_filename,
    wechat_data_roots,
)


def _wechat_store(root: Path) -> Path:
    """造一份和实测一致的目录结构。"""
    bucket = root / "wxid_demo_aa11" / "msg" / "file" / "2026-09"
    bucket.mkdir(parents=True)
    (bucket / "报告.pdf").write_bytes(b"pdf")
    older = root / "wxid_demo_aa11" / "msg" / "file" / "2026-08"
    older.mkdir(parents=True)
    (older / "报告.pdf").write_bytes(b"old")
    return bucket


def test_a_file_card_resolves_to_its_real_path(tmp_path) -> None:
    bucket = _wechat_store(tmp_path)
    found = locate_chat_file("Weixin.exe", "报告.pdf", roots=[tmp_path])
    assert str((bucket / "报告.pdf").resolve()) in found


def test_both_months_come_back_and_that_is_the_point(tmp_path) -> None:
    """同名文件在两个月目录下都有——两个都给，让调用方用时间区分。"""
    _wechat_store(tmp_path)
    found = locate_chat_file("Weixin.exe", "报告.pdf", roots=[tmp_path])
    assert len(found) == 2
    assert all(path.endswith("报告.pdf") for path in found)


def test_a_sentence_is_not_a_file_name() -> None:
    """圈一段正文时最后一个词常常带着句号——那不该触发一次全盘查找。"""
    where = locate_chat_file("Weixin.exe", "小样本脱敏后给通用人工智能和专项人工智能，判别")
    assert where == ()
    assert looks_like_filename("第3.5节") is False
    assert looks_like_filename("a.pdf") is True
    assert looks_like_filename("") is False


def test_nothing_found_is_an_empty_answer_not_a_guess(tmp_path) -> None:
    _wechat_store(tmp_path)
    assert locate_chat_file("Weixin.exe", "从来没有过的文件.pdf", roots=[tmp_path]) == ()


def test_only_known_chat_apps_have_a_file_store() -> None:
    """别的应用没有这回事，问它也是白问。"""
    assert locate_chat_file("notepad.exe", "报告.pdf") == ()
    assert chat_data_roots("notepad.exe") == ()


def test_the_data_drive_is_read_not_assumed(tmp_path, monkeypatch) -> None:
    """微信 4.x 的数据盘是用户选的，记在 APPDATA 的 ini 里。

    写死 `Documents\\WeChat Files` 就会在每个把数据挪到别的盘的人身上失效——
    本机就是挪到 D: 的。
    """
    appdata = tmp_path / "AppData"
    config = appdata / "Tencent" / "xwechat" / "config"
    config.mkdir(parents=True)
    (config / "abc.ini").write_text("E:\\", encoding="utf-8")
    monkeypatch.setenv("APPDATA", str(appdata))
    assert Path("E:/xwechat_files") in wechat_data_roots()
    # 只报真的存在的根：不存在的不该出现在「查过哪里」那句话里。
    assert Path("E:/xwechat_files") not in chat_data_roots("Weixin.exe")
