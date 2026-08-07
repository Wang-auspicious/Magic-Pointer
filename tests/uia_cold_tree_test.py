"""冷树判据：区分「壳起来了但正文还没挂上」和「这个窗口本来就没有正文」。

现在每个用户**第一次**在 Electron/Tauri/WebView2 应用里划线，我们都静默返回
「读不到」。`uia_text_adapter` 里已经有一个针对 Chromium 的重试，但它写成了
`if not probe.data` —— 而冷树恰恰是**有** data 的：实测冷启动的 Edge 返回 48 个
节点、21 个有名字的节点，只是里面一个 `Document` 都没有。非空不等于读到了，
所以那条重试从来没有触发过。

判据的输入取自 `%TEMP%\\vida_verify\\` 里的真实 dump（已拷进 tests/fixtures/，
临时目录会被系统清掉）。每个 case 下面标的数字都是从 dump 里数出来的，不是编的。

一并钉住 Vida.md §7.3 原方案里两个**被真实数据证伪**的阈值，防止有人照着文档改回去：

    fixture              max_depth  named  Document   真实情况
    cold_edge (0ms)          11       21      0       冷 —— 正文没挂上
    warm_edge (200ms)        13       27      1       热 —— 同一个窗口，正文在了
    hot_edge  (GitHub)       20      467      1       热
    warm_tauri(Clash)        17      101      1       热 —— WRY_WEBVIEW
    wechat_qt (微信)          2        8      0       自绘，永远没有 Document

    · `max_depth <= 8` 判冷：冷树实测 11 层就已经不成立了。浏览器**外壳自己**
      就有十来层，冷的不是层数少，是层里没东西。
    · `named_count < 30` 判冷：冷 21、热 27，只差 6 个节点。拿这个当判据，
      窗口多开一个书签栏就翻面。
"""

import re
from pathlib import Path

from app.adapters.uia_text_adapter import is_cold_tree

FIXTURES = Path(__file__).parent / "fixtures"


def _parse_dump(name: str) -> dict[str, object]:
    """把 uia_tree_dump.cs 的文本 dump 还原成判据的三个入参。

    走真实 dump 而不是手敲常量：手敲的数字过两个月就没人知道是从哪来的了，
    而且判据一旦跑偏，测试还是绿的。
    """
    lines = (FIXTURES / name).read_text(encoding="utf-8", errors="replace").splitlines()
    start = 0
    for index, line in enumerate(lines):
        if line.strip() and set(line.strip()) == {"-"}:
            start = index + 1
            break

    max_depth = 0
    class_chain: list[str] = []
    named_count = 0
    for line in lines[start:]:
        if not line.strip() or line.startswith(("visited=", "types ")):
            continue
        indent = len(line) - len(line.lstrip(" "))
        max_depth = max(max_depth, (indent - 1) // 2)
        match = re.search(r"cls=(.*?)\s{2,}", line) or re.search(r"cls=(.*)$", line)
        if match and match.group(1).strip():
            class_chain.append(match.group(1).strip())
        if line.rstrip().endswith('"'):
            named_count += 1

    document_count = 0
    for line in lines:
        if line.startswith("types "):
            found = re.search(r"Document=(\d+)", line)
            document_count = int(found.group(1)) if found else 0
            break

    return {
        "max_depth": max_depth,
        "class_chain": class_chain,
        "named_count": named_count,
        "document_count": document_count,
    }


COLD_EDGE = "uia_tree_cold_edge.txt"
WARM_EDGE = "uia_tree_warm_edge.txt"
HOT_EDGE = "uia_tree_hot_edge.txt"
WARM_TAURI = "uia_tree_warm_tauri.txt"
WECHAT_QT = "uia_tree_wechat_qt.txt"


def test_cold_chromium_shell_is_cold() -> None:
    """E4 的受控实验：同一个 Edge 窗口，0ms 时正文还没挂上。"""
    tree = _parse_dump(COLD_EDGE)
    assert tree["document_count"] == 0
    assert is_cold_tree(**tree) is True


def test_same_window_200ms_later_is_not_cold() -> None:
    """同一个窗口 200ms 后就该判热 —— 否则重试永远停不下来。"""
    tree = _parse_dump(WARM_EDGE)
    assert tree["document_count"] == 1
    assert is_cold_tree(**tree) is False


def test_loaded_page_is_not_cold() -> None:
    tree = _parse_dump(HOT_EDGE)
    assert is_cold_tree(**tree) is False


def test_warm_tauri_webview_is_not_cold() -> None:
    """WRY_WEBVIEW 也是 web 宿主，但这一棵已经热了，不该再等 60ms。"""
    tree = _parse_dump(WARM_TAURI)
    assert "WRY_WEBVIEW" in tree["class_chain"]
    assert is_cold_tree(**tree) is False


def test_wechat_is_never_cold() -> None:
    """微信自绘：8 个节点、0 个 Document，而且**永远**是这样。

    这一条是排除表存在的唯一理由。少了它，每次点微信都白等 60ms，
    换来的还是那 8 个节点。
    """
    tree = _parse_dump(WECHAT_QT)
    assert tree["document_count"] == 0
    assert tree["named_count"] < 30
    assert is_cold_tree(**tree) is False


def test_terminal_shell_is_never_cold() -> None:
    """Windows Terminal（CASCADIA_HOSTING_WINDOW_CLASS）同理：不是 web 宿主。

    实测 dump：23 个节点、17 个有名字的、0 个 Document —— 三项都长得像冷树，
    唯独类名不是 web 宿主。判据必须先看类名，否则终端每次读都多 60ms。
    """
    assert (
        is_cold_tree(
            max_depth=6,
            class_chain=["CASCADIA_HOSTING_WINDOW_CLASS"],
            named_count=17,
            document_count=0,
        )
        is False
    )


def test_unknown_native_app_is_not_cold() -> None:
    """记事本这类普通 Win32 窗口没有 Document，也不该被当成冷树重试。"""
    assert (
        is_cold_tree(
            max_depth=4,
            class_chain=["Notepad", "Edit"],
            named_count=3,
            document_count=0,
        )
        is False
    )


def test_electron_app_shell_is_cold() -> None:
    """我们自己也中招：e3 抓到的 Magic Pointer 窗口就是 Chrome_WidgetWin_1 + 0 Document。"""
    assert (
        is_cold_tree(
            max_depth=5,
            class_chain=["Chrome_WidgetWin_1", "Intermediate D3D Window"],
            named_count=5,
            document_count=0,
        )
        is True
    )


def test_cold_tauri_shell_is_cold() -> None:
    """Tauri 冷启动：外壳类名在，WebView 里还是空的。"""
    assert (
        is_cold_tree(
            max_depth=3,
            class_chain=["Tauri Window", "WRY_WEBVIEW"],
            named_count=2,
            document_count=0,
        )
        is True
    )


def test_document_count_unknown_is_not_cold() -> None:
    """探针没跑文档扫描时给 -1。不知道就不算冷 —— 「拿不到就留空绝不猜」。"""
    assert (
        is_cold_tree(
            max_depth=11,
            class_chain=["Chrome_WidgetWin_1"],
            named_count=21,
            document_count=-1,
        )
        is False
    )


def test_deny_list_wins_over_web_host_class() -> None:
    """自绘窗口里嵌了个 WebView 也不重试：排除表优先于宿主表。"""
    assert (
        is_cold_tree(
            max_depth=4,
            class_chain=["Qt51514QWindowIcon", "MMUIRenderSubWindowHW", "Chrome_WidgetWin_1"],
            named_count=8,
            document_count=0,
        )
        is False
    )


def test_spec_depth_threshold_would_have_missed_the_real_cold_tree() -> None:
    """回归钉子：Vida.md §7.3 原写的 `max_depth <= 8` 会漏掉唯一那棵真冷树。

    冷树实测 11 层。谁要是照着文档把这个阈值加回去，这条会红。
    """
    tree = _parse_dump(COLD_EDGE)
    assert tree["max_depth"] > 8
    assert is_cold_tree(**tree) is True


def test_spec_named_threshold_cannot_separate_cold_from_warm() -> None:
    """回归钉子：`named_count < 30` 判冷 —— 冷 21、热 27，判据落在噪声里。"""
    cold = _parse_dump(COLD_EDGE)
    warm = _parse_dump(WARM_EDGE)
    assert cold["named_count"] < 30
    assert warm["named_count"] < 30  # 热的也 < 30，所以这个阈值分不开两者
    assert is_cold_tree(**cold) is True
    assert is_cold_tree(**warm) is False


# ---------------------------------------------------------------------------
# 接线：纯函数判对了，不代表那条重试真的会跑。这条从前就是断的——
# 判据没错，是 `if not probe.data` 把它挡在门外，冷树有 data，一次都没触发过。
# ---------------------------------------------------------------------------

import app.adapters.uia_text_adapter as uia_module
from app.adapters.uia_text_adapter import UiaProbeResult, UiaTextSelectionAdapter

NO_SELECTION = "No non-empty UI Automation text selection was exposed."


def _window(class_name: str, title: str = "Untitled") -> dict[str, object]:
    return {"hwnd": 1234, "pid": 5678, "class_name": class_name, "title": title}


def _cold_payload() -> dict[str, object]:
    """冷树探针返回的样子：identity 对得上、有 data、但一个 Document 都没有。"""
    return {
        "ok": False,
        "hwnd": 1234,
        "process_id": 5678,
        "root_hwnd": 1234,
        "class_name": "Chrome_WidgetWin_1",
        "document_count": 0,
        "error": NO_SELECTION,
        "elapsed_ms": 31,
    }


def _warm_payload(text: str = "正文读到了") -> dict[str, object]:
    return {
        "ok": True,
        "hwnd": 1234,
        "process_id": 5678,
        "root_hwnd": 1234,
        "class_name": "Chrome_WidgetWin_1",
        "document_count": 1,
        "text": text,
        "range_count": 1,
        "rectangle_count_total": 1,
        "rectangles": [[10, 20, 300, 40]],
        "control_type": "ControlType.Document",
        "elapsed_ms": 28,
    }


def _stub_probe(monkeypatch, payloads: list[UiaProbeResult]) -> list[int]:
    calls: list[int] = []

    def probe(hwnd, **kwargs):  # noqa: ANN001, ANN003
        calls.append(hwnd)
        return payloads[min(len(calls) - 1, len(payloads) - 1)]

    monkeypatch.setattr(uia_module, "_run_uia_selection_probe", probe)
    return calls


def test_cold_tree_triggers_exactly_one_reprobe_and_reads_the_page(monkeypatch) -> None:
    """第一次划线就该拿到正文——这是整个补丁存在的理由。"""
    calls = _stub_probe(monkeypatch, [
        UiaProbeResult(False, _cold_payload(), NO_SELECTION),
        UiaProbeResult(True, _warm_payload()),
    ])
    ctx = UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1", "冷启动的 Edge"))
    assert len(calls) == 2, "冷树必须重读一次"
    assert ctx.content == "正文读到了"


def test_cold_tree_retry_does_not_recurse(monkeypatch) -> None:
    """一直冷也只重试一次。递归会把一次读拖成无底洞。"""
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, _cold_payload(), NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 2


def test_warm_browser_read_is_not_reprobed(monkeypatch) -> None:
    """读到了就不重试——否则每次浏览器划线都白加一趟探针。"""
    calls = _stub_probe(monkeypatch, [UiaProbeResult(True, _warm_payload())])
    ctx = UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 1
    assert ctx.content == "正文读到了"


def test_browser_with_document_but_no_selection_is_not_reprobed(monkeypatch) -> None:
    """树是热的、只是用户没选中东西：不该重试，那 60ms 是纯浪费。"""
    payload = _cold_payload()
    payload["document_count"] = 1
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 1


def test_wechat_is_never_reprobed(monkeypatch) -> None:
    """微信自绘：等多久都还是那 8 个节点。排除表就是为了省下这一趟。"""
    payload = _cold_payload()
    payload["class_name"] = "MMUIRenderSubWindowHW"
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Qt51514QWindowIcon", "微信"))
    assert len(calls) == 1


def test_notepad_is_never_reprobed(monkeypatch) -> None:
    """普通 Win32 窗口没有「正文迟到」这回事。"""
    payload = _cold_payload()
    payload["class_name"] = "Edit"
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Notepad", "mp_probe.txt - Notepad"))
    assert len(calls) == 1
