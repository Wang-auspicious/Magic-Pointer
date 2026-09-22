
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
    _wechat_store(tmp_path)
    found = locate_chat_file("Weixin.exe", "报告.pdf", roots=[tmp_path])
    assert len(found) == 2
    assert all(path.endswith("报告.pdf") for path in found)


def test_a_sentence_is_not_a_file_name() -> None:
    where = locate_chat_file("Weixin.exe", "小样本脱敏后给通用人工智能和专项人工智能，判别")
    assert where == ()
    assert looks_like_filename("第3.5节") is False
    assert looks_like_filename("a.pdf") is True
    assert looks_like_filename("") is False


def test_nothing_found_is_an_empty_answer_not_a_guess(tmp_path) -> None:
    _wechat_store(tmp_path)
    assert locate_chat_file("Weixin.exe", "从来没有过的文件.pdf", roots=[tmp_path]) == ()


def test_only_known_chat_apps_have_a_file_store() -> None:
    assert locate_chat_file("notepad.exe", "报告.pdf") == ()
    assert chat_data_roots("notepad.exe") == ()


def test_the_data_drive_is_read_not_assumed(tmp_path, monkeypatch) -> None:
    appdata = tmp_path / "AppData"
    config = appdata / "Tencent" / "xwechat" / "config"
    config.mkdir(parents=True)
    (config / "abc.ini").write_text("E:\\", encoding="utf-8")
    monkeypatch.setenv("APPDATA", str(appdata))
    assert Path("E:/xwechat_files") in wechat_data_roots()
    assert Path("E:/xwechat_files") not in chat_data_roots("Weixin.exe")



def test_the_scan_finds_a_store_on_another_drive(tmp_path, monkeypatch) -> None:
    from app.context_pack.chat_local_files import _scan_for_store_names

    store = tmp_path / "xwechat_files"
    store.mkdir()
    assert store in _scan_for_store_names(tmp_path)


def test_the_scan_also_looks_one_level_down(tmp_path) -> None:
    from app.context_pack.chat_local_files import _scan_for_store_names

    nested = tmp_path / "Tencent" / "xwechat_files"
    nested.mkdir(parents=True)
    assert nested in _scan_for_store_names(tmp_path)


def test_the_scan_stops_at_two_levels(tmp_path) -> None:
    from app.context_pack.chat_local_files import _scan_for_store_names

    deep = tmp_path / "a" / "b" / "xwechat_files"
    deep.mkdir(parents=True)
    assert _scan_for_store_names(tmp_path) == []


def test_the_cache_is_what_answers_afterwards(tmp_path, monkeypatch) -> None:
    from app.context_pack import chat_local_files as module

    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    store = tmp_path / "xwechat_files"
    (store / "wxid_demo_aa11" / "msg" / "file" / "2026-09").mkdir(parents=True)
    (store / "wxid_demo_aa11" / "msg" / "file" / "2026-09" / "b.pdf").write_bytes(b"x")

    found = module.discover_chat_stores(extra_roots=[tmp_path])
    assert store in found["wechat"]
    assert module.discovery_cache_path().is_file()

    monkeypatch.setattr(module, "discover_chat_stores", lambda **kwargs: (_ for _ in ()).throw(AssertionError("不该重扫")))
    roots = module.chat_data_roots("Weixin.exe")
    assert store in roots
    assert all(path.is_dir() for path in roots)


def test_an_empty_scan_is_reported_as_empty(tmp_path, monkeypatch) -> None:
    from app.context_pack import chat_local_files as module

    monkeypatch.setenv("MAGIC_POINTER_USER_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "nobody"))
    found = module.discover_chat_stores()
    assert found["dingtalk"] == ()
    assert found["feishu"] == ()
