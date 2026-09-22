
import re
from pathlib import Path

from app.adapters.uia_text_adapter import is_cold_tree

FIXTURES = Path(__file__).parent / "fixtures"


def _parse_dump(name: str) -> dict[str, object]:
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
    tree = _parse_dump(COLD_EDGE)
    assert tree["document_count"] == 0
    assert is_cold_tree(**tree) is True


def test_same_window_200ms_later_is_not_cold() -> None:
    tree = _parse_dump(WARM_EDGE)
    assert tree["document_count"] == 1
    assert is_cold_tree(**tree) is False


def test_loaded_page_is_not_cold() -> None:
    tree = _parse_dump(HOT_EDGE)
    assert is_cold_tree(**tree) is False


def test_warm_tauri_webview_is_not_cold() -> None:
    tree = _parse_dump(WARM_TAURI)
    assert "WRY_WEBVIEW" in tree["class_chain"]
    assert is_cold_tree(**tree) is False


def test_wechat_is_never_cold() -> None:
    tree = _parse_dump(WECHAT_QT)
    assert tree["document_count"] == 0
    assert tree["named_count"] < 30
    assert is_cold_tree(**tree) is False


def test_terminal_shell_is_never_cold() -> None:
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
    tree = _parse_dump(COLD_EDGE)
    assert tree["max_depth"] > 8
    assert is_cold_tree(**tree) is True


def test_spec_named_threshold_cannot_separate_cold_from_warm() -> None:
    cold = _parse_dump(COLD_EDGE)
    warm = _parse_dump(WARM_EDGE)
    assert cold["named_count"] < 30
    assert warm["named_count"] < 30
    assert is_cold_tree(**cold) is True
    assert is_cold_tree(**warm) is False



import app.adapters.uia_text_adapter as uia_module
from app.adapters.uia_text_adapter import UiaProbeResult, UiaTextSelectionAdapter

NO_SELECTION = "No non-empty UI Automation text selection was exposed."


def _window(class_name: str, title: str = "Untitled") -> dict[str, object]:
    return {"hwnd": 1234, "pid": 5678, "class_name": class_name, "title": title}


def _cold_payload() -> dict[str, object]:
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
    calls = _stub_probe(monkeypatch, [
        UiaProbeResult(False, _cold_payload(), NO_SELECTION),
        UiaProbeResult(True, _warm_payload()),
    ])
    ctx = UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1", "冷启动的 Edge"))
    assert len(calls) == 2, "冷树必须重读一次"
    assert ctx.content == "正文读到了"


def test_cold_tree_retry_does_not_recurse(monkeypatch) -> None:
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, _cold_payload(), NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 2


def test_warm_browser_read_is_not_reprobed(monkeypatch) -> None:
    calls = _stub_probe(monkeypatch, [UiaProbeResult(True, _warm_payload())])
    ctx = UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 1
    assert ctx.content == "正文读到了"


def test_browser_with_document_but_no_selection_is_not_reprobed(monkeypatch) -> None:
    payload = _cold_payload()
    payload["document_count"] = 1
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Chrome_WidgetWin_1"))
    assert len(calls) == 1


def test_wechat_is_never_reprobed(monkeypatch) -> None:
    payload = _cold_payload()
    payload["class_name"] = "MMUIRenderSubWindowHW"
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Qt51514QWindowIcon", "微信"))
    assert len(calls) == 1


def test_notepad_is_never_reprobed(monkeypatch) -> None:
    payload = _cold_payload()
    payload["class_name"] = "Edit"
    calls = _stub_probe(monkeypatch, [UiaProbeResult(False, payload, NO_SELECTION)])
    UiaTextSelectionAdapter().read_context(_window("Notepad", "mp_probe.txt - Notepad"))
    assert len(calls) == 1
