"""聊天软件里那个文件卡片，在本机的哪个位置。

用户圈的是**卡片**，不是文件。卡片上只有文件名，文件本身在应用自己的仓库里。模型的
下一步十次有九次是「读它」或「打开它」，而它手里只有一个名字——于是它要么来问用户，
要么去猜路径。这两件事都不该发生：位置是可以查出来的。

实测（本机，2026-09-19），微信 4.x 的布局是：

    <数据盘>\\xwechat_files\\<wxid>_<四位>\\msg\\file\\<YYYY-MM>\\<原始文件名>

圈里那张 `cvpr2027-verified-top5.html` 就躺在
`D:\\xwechat_files\\wxid_rw6biyoelit722_fa64\\msg\\file\\2026-09\\` 下面，文件名没改过。

**数据盘不能写死。** 同一个 config 目录下的 ini 里写着用户自己选的那个盘符
（本机就是 `D:\\`），换台机器、换个用户就不同——这正是「猜路径」每次都猜错的原因。

**图片是另一回事，而且做不到。** 聊天里的图片存在 `msg/attach/<hash>/<YYYY-MM>/`，
5 万多条 `.dat`：文件名是哈希、内容是加密的（本机实测 50875 个 .dat）。那不属于这里，
也不需要——图片的像素本来就在冻结帧里，视觉那条路直接看得到。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterable

# 只有这几个应用有「卡片 → 本地文件」这回事，而且各自有各自的仓库。
WECHAT_PROCESSES = ("weixin.exe", "wechat.exe")
DINGTALK_PROCESSES = ("dingtalk.exe",)
FEISHU_PROCESSES = ("feishu.exe", "lark.exe")

# 文件名得长成一个文件名的样子才值得去查：有扩展名、没有路径分隔符、不是一整句话。
# 圈一段正文时，最后一个词常常以「。」结尾，或者整段里有个 "3.5" ——都不该触发一次
# 全盘 glob。
_FILENAME = re.compile(r"^[^\\/:*?\"<>|\r\n]{1,120}\.[A-Za-z0-9]{1,12}$")

# 一次搜索最多看多少个文件。仓库里按月分目录，找最近几个月就够了。
_SEARCH_MAX_MONTHS = 18


def looks_like_filename(value: str) -> bool:
    candidate = str(value or "").strip()
    if not candidate or not _FILENAME.match(candidate):
        return False
    # 纯数字扩展名前后的东西容易误判（"第3.5节"），要求扩展名有字母。
    return bool(re.search(r"\.[A-Za-z][A-Za-z0-9]{0,11}$", candidate))


def _home() -> Path:
    return Path(os.environ.get("USERPROFILE") or Path.home())


def wechat_data_roots() -> list[Path]:
    r"""微信的数据根**候选**：4.x 的盘符从 APPDATA 的 ini 里读，3.x 在 Documents。

    读不读得到是两回事——这个函数只回答「可能在哪」，存不存在由
    :func:`chat_data_roots` 判。分开是为了让「数据盘是从配置里读出来的」这件事
    本身可测：写死 `Documents\WeChat Files` 会在每个把数据挪到别的盘的人身上
    失效（本机就是挪到 D: 的）。
    """
    roots: list[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        config_dir = Path(appdata) / "Tencent" / "xwechat" / "config"
        try:
            entries = sorted(config_dir.glob("*.ini"))
        except OSError:
            entries = []
        for entry in entries:
            try:
                raw = entry.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                continue
            # 里面就一个盘符加冒号，例如 "D:\"。
            drive = raw.rstrip("\\/").strip()
            if re.fullmatch(r"[A-Za-z]:", drive):
                roots.append(Path(f"{drive}/xwechat_files"))
    roots.append(_home() / "Documents" / "xwechat_files")   # 4.x 默认位置
    roots.append(_home() / "Documents" / "WeChat Files")    # 3.x
    return roots


def _app_roots(process_name: str) -> list[Path]:
    name = str(process_name or "").casefold()
    if name in WECHAT_PROCESSES:
        return wechat_data_roots()
    if name in DINGTALK_PROCESSES:
        return [
            _home() / "Documents" / "DingTalk",
            _home() / "DingTalk",
        ]
    if name in FEISHU_PROCESSES:
        return [
            _home() / ".feishu",
            _home() / "Documents" / "Feishu",
            Path(os.environ.get("LOCALAPPDATA") or _home()) / "Feishu",
        ]
    return []


def chat_data_roots(process_name: str) -> tuple[Path, ...]:
    """这个应用**确实存在**的数据根，按上面那张表找出来的。"""
    seen: list[Path] = []
    for root in _app_roots(process_name):
        try:
            if root.is_dir() and root not in seen:
                seen.append(root)
        except OSError:
            continue
    return tuple(seen)


def _candidate_files(root: Path) -> Iterable[Path]:
    """文件名可能落在哪些地方，从新到旧。"""
    months = 0
    # 微信 4.x / 3.x：每个账号一个目录，文件按月分。
    for account in sorted(root.iterdir(), key=lambda item: item.name, reverse=True):
        if not account.is_dir():
            continue
        for pattern in ("msg/file", "FileStorage/File"):
            base = account / pattern
            if not base.is_dir():
                continue
            try:
                buckets = sorted(base.iterdir(), key=lambda item: item.name, reverse=True)
            except OSError:
                continue
            for bucket in buckets[:_SEARCH_MAX_MONTHS]:
                if bucket.is_dir():
                    months += 1
                    yield bucket
    return None


def locate_chat_file(
    process_name: str,
    filename: str,
    *,
    roots: Iterable[Path] | None = None,
) -> tuple[str, ...]:
    """这个文件名在本地对应的真实路径，可能不止一个（同名文件很常见）。

    只按**确切文件名**查，不做模糊匹配：猜错一个字符就是把另一个文件交给模型去读。
    查不到就返回空——「没找到」是可以说的，「大概是这个」不可以。
    """
    name = str(filename or "").strip()
    if not looks_like_filename(name):
        return ()
    search_roots = tuple(roots) if roots is not None else chat_data_roots(process_name)
    found: list[str] = []
    for root in search_roots:
        for bucket in _candidate_files(root):
            try:
                candidate = bucket / name
                if candidate.is_file():
                    resolved = str(candidate.resolve())
                    if resolved not in found:
                        found.append(resolved)
            except OSError:
                continue
    return tuple(found)
