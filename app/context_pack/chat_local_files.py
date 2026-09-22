
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Iterable

WECHAT_PROCESSES = ("weixin.exe", "wechat.exe")
DINGTALK_PROCESSES = ("dingtalk.exe",)
FEISHU_PROCESSES = ("feishu.exe", "lark.exe")

_FILENAME = re.compile(r"^[^\\/:*?\"<>|\r\n]{1,120}\.[A-Za-z0-9]{1,12}$")

_SEARCH_MAX_MONTHS = 18


def looks_like_filename(value: str) -> bool:
    candidate = str(value or "").strip()
    if not candidate or not _FILENAME.match(candidate):
        return False
    return bool(re.search(r"\.[A-Za-z][A-Za-z0-9]{0,11}$", candidate))


def _home() -> Path:
    return Path(os.environ.get("USERPROFILE") or Path.home())


def wechat_data_roots() -> list[Path]:
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
            drive = raw.rstrip("\\/").strip()
            if re.fullmatch(r"[A-Za-z]:", drive):
                roots.append(Path(f"{drive}/xwechat_files"))
    roots.append(_home() / "Documents" / "xwechat_files")
    roots.append(_home() / "Documents" / "WeChat Files")
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
    found: list[Path] = []
    try:
        level_one = [item for item in root.iterdir() if item.is_dir()]
    except OSError:
        return found
    for candidate in level_one:
        if candidate.name in _all_store_names():
            found.append(candidate)
            continue
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
    discovered: dict[str, list[Path]] = {key: [] for key in _STORE_DIR_NAMES}

    def add(key: str, path: Path) -> None:
        try:
            if path.is_dir() and path not in discovered[key]:
                discovered[key].append(path)
        except OSError:
            pass

    for path in wechat_data_roots():
        add("wechat", path)

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
    months = 0
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
