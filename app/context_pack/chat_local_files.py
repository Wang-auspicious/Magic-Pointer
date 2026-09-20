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

import json
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
    """这个应用**确实存在**的数据根。

    先看扫描缓存，缓存里没有这个应用就去扫一次再回答。每台电脑的仓库位置都不一样
    ——用户可以在安装时挑任意一个盘——所以候选表只当起点，真正的答案是扫出来的。
    """
    cached = _cached_roots(process_name)
    if cached:
        return cached
    discovered = discover_chat_stores()
    cached = _matching_roots(discovered.get(_store_key(process_name), ()))
    if cached:
        return cached
    return _matching_roots(_app_roots(process_name))


def _matching_roots(candidates: Iterable[Path]) -> tuple[Path, ...]:
    seen: list[Path] = []
    for root in candidates:
        try:
            if root.is_dir() and root not in seen:
                seen.append(root)
        except OSError:
            continue
    return tuple(seen)


# ── 安装时扫描 ────────────────────────────────────────────────────────────────
#
# 每台电脑的仓库位置都不一样：微信安装时就让人挑一个盘，钉钉/飞书各有各的默认。
# 靠一张候选表等于赌对方和你一样。所以在**首次运行**扫一遍，把结果落盘，之后每次
# 直接读缓存；查不到东西时再扫一次（用户可能中途换了位置）。
#
# 扫描范围是每个固定盘的**前两层**目录名。不做全盘遍历：一是慢，二是深挖到别人的
# 目录里翻文件夹这件事本身就不该做。仓库建在更深处的人，用
# `python scripts/discover_chat_stores.py --root <路径>` 手动补一条即可。

_STORE_DIR_NAMES: dict[str, tuple[str, ...]] = {
    "wechat": ("xwechat_files", "WeChat Files"),
    "dingtalk": ("DingTalk", "DingTalk Files"),
    "feishu": ("Feishu", "Lark", ".feishu"),
}

_CACHE_SCHEMA = 1


def _store_key(process_name: str) -> str:
    name = str(process_name or "").casefold()
    if name in WECHAT_PROCESSES:
        return "wechat"
    if name in DINGTALK_PROCESSES:
        return "dingtalk"
    if name in FEISHU_PROCESSES:
        return "feishu"
    return ""


def discovery_cache_path() -> Path:
    root = Path(os.environ.get("MAGIC_POINTER_USER_DATA_DIR") or Path(__file__).resolve().parents[2] / "data" / "runtime")
    return root / "chat-stores.json"


def _fixed_drives() -> tuple[Path, ...]:
    """本机有哪几个固定盘。可移动盘和网络盘不扫：那不是仓库该待的地方。"""
    drives: list[Path] = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        drive = Path(f"{letter}:/")
        try:
            if drive.is_dir():
                drives.append(drive)
        except OSError:
            continue
    return tuple(drives)


def _scan_for_store_names(root: Path) -> list[Path]:
    """在 ``root`` 的前两层里找已知的仓库目录名。"""
    found: list[Path] = []
    try:
        level_one = [item for item in root.iterdir() if item.is_dir()]
    except OSError:
        return found
    for candidate in level_one:
        if candidate.name in _all_store_names():
            found.append(candidate)
            continue
        # 第二层：用户常建一个自己的目录再往里放（Tencent 目录套 xwechat_files
        # 这种）。只到这一层为止——再往下翻别人的目录，收益低而冒犯大。
        try:
            for nested in candidate.iterdir():
                if nested.is_dir() and nested.name in _all_store_names():
                    found.append(nested)
        except OSError:
            continue
    return found


def _all_store_names() -> frozenset[str]:
    return frozenset(name for names in _STORE_DIR_NAMES.values() for name in names)


def discover_chat_stores(*, extra_roots: Iterable[Path] = (), write_cache: bool = True) -> dict[str, tuple[Path, ...]]:
    """扫一遍这台机器，回答「聊天软件的仓库在哪」。

    首次运行时跑一次，结果落盘；之后 :func:`chat_data_roots` 直接读缓存。
    找不到不编：没有的键就是空的，调用方据此说「没找到」而不是给一个不存在的路径。
    """
    discovered: dict[str, list[Path]] = {key: [] for key in _STORE_DIR_NAMES}

    def add(key: str, path: Path) -> None:
        try:
            if path.is_dir() and path not in discovered[key]:
                discovered[key].append(path)
        except OSError:
            pass

    # 一、应用自己记着的位置（最准：用户装的时候就是在这儿选的）。
    for path in wechat_data_roots():
        add("wechat", path)

    # 二、本机各固定盘的前两层目录名。
    for drive in (*_fixed_drives(), *tuple(extra_roots)):
        for path in _scan_for_store_names(drive):
            for key, names in _STORE_DIR_NAMES.items():
                if path.name in names:
                    add(key, path)

    result = {key: tuple(paths) for key, paths in discovered.items()}
    if write_cache:
        _write_cache(result)
    return result


def _write_cache(result: dict[str, tuple[Path, ...]]) -> None:
    try:
        path = discovery_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": _CACHE_SCHEMA,
            "stores": {key: [str(item) for item in paths] for key, paths in result.items()},
        }
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(temporary, path)
    except OSError:
        # 缓存写不下去只影响下次还要再扫一遍，不影响这次的回答。
        pass


def _read_cache() -> dict[str, tuple[Path, ...]]:
    try:
        raw = json.loads(discovery_cache_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict) or raw.get("schemaVersion") != _CACHE_SCHEMA:
        return {}
    stores = raw.get("stores")
    if not isinstance(stores, dict):
        return {}
    result: dict[str, tuple[Path, ...]] = {}
    for key, paths in stores.items():
        if not isinstance(paths, list):
            continue
        result[str(key)] = tuple(Path(str(item)) for item in paths if str(item).strip())
    return result


def _cached_roots(process_name: str) -> tuple[Path, ...]:
    key = _store_key(process_name)
    if not key:
        return ()
    return _matching_roots(_read_cache().get(key, ()))


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
