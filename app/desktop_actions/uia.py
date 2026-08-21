"""UIA tree and native patterns behind the Kimi 13 tools.

Walker and actor are injectable. Production uses COM IUIAutomation
(ctypes, no comtypes). A failed walk is an empty list; a missing pattern
is ``ok: false``. Neither pretends to be a click.
"""

from __future__ import annotations

import ctypes
import os
from collections.abc import Callable
from typing import Any

NODE_BUDGET = 400

_CONTROL_ROLES: dict[int, str] = {
    50000: "button",
    50001: "calendar",
    50002: "checkbox",
    50003: "combobox",
    50004: "edit",
    50005: "hyperlink",
    50006: "image",
    50007: "listitem",
    50008: "list",
    50009: "menu",
    50010: "menubar",
    50011: "menuitem",
    50012: "progressbar",
    50013: "radiobutton",
    50014: "scrollbar",
    50015: "slider",
    50016: "spinner",
    50017: "statusbar",
    50018: "tab",
    50019: "tabitem",
    50020: "text",
    50021: "toolbar",
    50022: "tooltip",
    50023: "tree",
    50024: "treeitem",
    50025: "custom",
    50026: "group",
    50027: "thumb",
    50028: "datagrid",
    50029: "dataitem",
    50030: "document",
    50031: "splitbutton",
    50032: "window",
    50033: "pane",
    50034: "header",
    50035: "headeritem",
    50036: "table",
    50037: "titlebar",
    50038: "separator",
}

# Pattern id -> public name. Order is the dump order.
_PATTERNS: tuple[tuple[int, str], ...] = (
    (10000, "Invoke"),
    (10002, "Value"),
    (10003, "RangeValue"),
    (10004, "Scroll"),
    (10005, "ExpandCollapse"),
    (10010, "SelectionItem"),
    (10014, "Text"),
    (10015, "Toggle"),
)

_CLSID_CUI_AUTOMATION = "{FF48DBA4-60EF-4201-AA87-54103EEF594E}"
_IID_IUI_AUTOMATION = "{30CBE57D-D9D0-452A-AB13-7AC5AC4825EE}"
_COINIT_APARTMENTTHREADED = 0x2
_CLSCTX_INPROC_SERVER = 0x1
_RPC_E_CHANGED_MODE = -2147417850


class UiaBridge:
    """Snapshot tree + native act. Tests inject walker/actor; production uses COM."""

    def __init__(
        self,
        walker: Callable[[int], list[dict[str, Any]]] | None = None,
        actor: Callable[..., dict[str, Any]] | None = None,
    ) -> None:
        self.walker = walk_window if walker is None else walker
        self.actor = act_on_element if actor is None else actor

    def list_elements(self, hwnd: int) -> list[dict[str, Any]]:
        handle = int(hwnd or 0)
        nodes: list[dict[str, Any]] = []
        for item in self.walker(handle) or []:
            row = dict(item)
            row.setdefault("hwnd", handle)
            nodes.append(row)
        return normalize_elements(nodes)

    def act(self, action: str, element: dict[str, Any], value: str | None = None) -> dict[str, Any]:
        return self.actor(action, element, value)


def normalize_elements(
    nodes: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    budget: int = NODE_BUDGET,
) -> list[dict[str, Any]]:
    """Turn a raw dump into Kimi elements: 1-based index, role, name, rect, patterns.

    Silent containers (no name, no patterns) are dropped. The budget is a hard
    cap on indexed elements, matching UFO/WAA's ~400 node ceiling.
    """
    elements: list[dict[str, Any]] = []
    for node in nodes:
        name = str(node.get("name") or "").strip()
        patterns = _string_list(node.get("patterns"))
        if not name and not patterns:
            continue
        rect = _as_rect(node.get("rect"))
        item: dict[str, Any] = {
            "index": len(elements) + 1,
            "role": _role_for(node.get("control_type") or node.get("role")),
            "name": name,
            "rect": rect,
            "patterns": patterns,
        }
        runtime_id = node.get("runtime_id") or node.get("runtimeId")
        if runtime_id:
            item["runtime_id"] = [int(part) for part in runtime_id]
        hwnd = node.get("hwnd")
        if hwnd:
            item["hwnd"] = int(hwnd)
        elements.append(item)
        if len(elements) >= budget:
            break
    return elements


def walk_window(hwnd: int) -> list[dict[str, Any]]:
    """Live ControlView dump. Empty on non-Windows, hwnd 0, or COM failure."""
    handle = int(hwnd or 0)
    if handle <= 0 or os.name != "nt":
        return []
    try:
        return _com_walk(handle)
    except Exception:
        return []


def act_on_element(
    action: str,
    element: dict[str, Any],
    value: str | None = None,
) -> dict[str, Any]:
    """Native pattern dispatch. Missing pattern or COM failure is not a click."""
    name = str(action or "").strip().casefold()
    backend = f"uia_{name or 'action'}"
    if os.name != "nt":
        return {"ok": False, "backend": backend, "reason": "uia_unavailable"}
    hwnd = int((element or {}).get("hwnd") or 0)
    if hwnd <= 0:
        return {"ok": False, "backend": backend, "reason": "missing_hwnd"}
    try:
        return _com_act(name, element, value)
    except Exception as exc:
        return {"ok": False, "backend": backend, "reason": str(exc) or "uia_act_failed"}


def _role_for(control_type: Any) -> str:
    if isinstance(control_type, int):
        return _CONTROL_ROLES.get(control_type, f"control_{control_type}")
    text = str(control_type or "").strip()
    if text.isdigit():
        return _role_for(int(text))
    lowered = text.replace("ControlType.", "").replace(" ", "").casefold()
    for role in _CONTROL_ROLES.values():
        if role == lowered:
            return role
    return lowered or "unknown"


def _string_list(value: Any) -> list[str]:
    if not value:
        return []
    return [str(item) for item in value if str(item).strip()]


def _as_rect(raw: Any) -> list[int]:
    if isinstance(raw, dict):
        if "left" in raw:
            return [
                int(raw.get("left") or 0),
                int(raw.get("top") or 0),
                int(raw.get("right") or 0),
                int(raw.get("bottom") or 0),
            ]
        return [
            int(raw.get("x") or 0),
            int(raw.get("y") or 0),
            int(raw.get("x") or 0) + int(raw.get("w") or raw.get("width") or 0),
            int(raw.get("y") or 0) + int(raw.get("h") or raw.get("height") or 0),
        ]
    if not raw:
        return [0, 0, 0, 0]
    return [int(raw[0]), int(raw[1]), int(raw[2]), int(raw[3])]


# --- COM (Windows only) -------------------------------------------------------


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _SAFEARRAYBOUND(ctypes.Structure):
    _fields_ = [("cElements", ctypes.c_uint32), ("lLbound", ctypes.c_int32)]


class _SAFEARRAY(ctypes.Structure):
    _fields_ = [
        ("cDims", ctypes.c_uint16),
        ("fFeatures", ctypes.c_uint16),
        ("cbElements", ctypes.c_uint32),
        ("cLocks", ctypes.c_uint32),
        ("pvData", ctypes.c_void_p),
        ("rgsabound", _SAFEARRAYBOUND * 1),
    ]


def _call(obj: int, index: int, restype, *args, argtypes: tuple = ()):
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    proto = ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *argtypes)
    return proto(vtbl[index])(obj, *args)


def _release(obj: int) -> None:
    if obj:
        _call(obj, 2, ctypes.c_ulong)


def _oleaut32():
    dll = ctypes.windll.oleaut32
    dll.SysAllocString.restype = ctypes.c_void_p
    dll.SysAllocString.argtypes = [ctypes.c_wchar_p]
    dll.SysFreeString.argtypes = [ctypes.c_void_p]
    dll.SafeArrayDestroy.argtypes = [ctypes.c_void_p]
    return dll


def _ensure_com() -> None:
    ole32 = ctypes.windll.ole32
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole32.CoInitializeEx.restype = ctypes.HRESULT
    hr = int(ole32.CoInitializeEx(None, _COINIT_APARTMENTTHREADED))
    # S_OK / S_FALSE: this thread is in an apartment. RPC_E_CHANGED_MODE
    # means it is already MTA; UIA still works for a one-shot walk.
    if hr < 0 and hr != _RPC_E_CHANGED_MODE:
        raise OSError(f"CoInitializeEx failed: {hr:#x}")


def _guid(text: str) -> _GUID:
    value = _GUID()
    ole32 = ctypes.windll.ole32
    ole32.CLSIDFromString.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(_GUID)]
    ole32.CLSIDFromString.restype = ctypes.HRESULT
    hr = int(ole32.CLSIDFromString(text, ctypes.byref(value)))
    if hr < 0:
        raise OSError(f"CLSIDFromString failed: {hr:#x}")
    return value


def _create_automation() -> int:
    _ensure_com()
    ole32 = ctypes.windll.ole32
    ole32.CoCreateInstance.argtypes = [
        ctypes.POINTER(_GUID),
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(_GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    ole32.CoCreateInstance.restype = ctypes.HRESULT
    punk = ctypes.c_void_p()
    hr = int(ole32.CoCreateInstance(
        ctypes.byref(_guid(_CLSID_CUI_AUTOMATION)),
        None,
        _CLSCTX_INPROC_SERVER,
        ctypes.byref(_guid(_IID_IUI_AUTOMATION)),
        ctypes.byref(punk),
    ))
    if hr < 0 or not punk.value:
        raise OSError(f"CoCreateInstance CUIAutomation failed: {hr:#x}")
    return int(punk.value)


def _ptr_out(obj: int, index: int, *prefix_args, prefix_types: tuple = ()) -> int:
    out = ctypes.c_void_p()
    hr = int(_call(
        obj,
        index,
        ctypes.HRESULT,
        *prefix_args,
        ctypes.byref(out),
        argtypes=(*prefix_types, ctypes.POINTER(ctypes.c_void_p)),
    ))
    if hr < 0:
        return 0
    return int(out.value or 0)


def _bstr(obj: int, index: int) -> str:
    handle = ctypes.c_void_p()
    hr = int(_call(
        obj,
        index,
        ctypes.HRESULT,
        ctypes.byref(handle),
        argtypes=(ctypes.POINTER(ctypes.c_void_p),),
    ))
    if hr < 0 or not handle.value:
        return ""
    try:
        return ctypes.wstring_at(handle.value)
    finally:
        _oleaut32().SysFreeString(handle)


def _control_type(obj: int) -> int:
    value = ctypes.c_int()
    hr = int(_call(
        obj,
        21,
        ctypes.HRESULT,
        ctypes.byref(value),
        argtypes=(ctypes.POINTER(ctypes.c_int),),
    ))
    return int(value.value) if hr >= 0 else 0


def _rect_of(obj: int) -> list[int]:
    box = _RECT()
    hr = int(_call(
        obj,
        43,
        ctypes.HRESULT,
        ctypes.byref(box),
        argtypes=(ctypes.POINTER(_RECT),),
    ))
    if hr < 0:
        return [0, 0, 0, 0]
    return [int(box.left), int(box.top), int(box.right), int(box.bottom)]


def _runtime_id(obj: int) -> list[int]:
    array = ctypes.c_void_p()
    hr = int(_call(
        obj,
        4,
        ctypes.HRESULT,
        ctypes.byref(array),
        argtypes=(ctypes.POINTER(ctypes.c_void_p),),
    ))
    if hr < 0 or not array.value:
        return []
    try:
        sa = ctypes.cast(array.value, ctypes.POINTER(_SAFEARRAY)).contents
        count = int(sa.rgsabound[0].cElements)
        if sa.cDims != 1 or sa.cbElements != 4 or not sa.pvData or count <= 0:
            return []
        ints = ctypes.cast(sa.pvData, ctypes.POINTER(ctypes.c_int * count)).contents
        return [int(item) for item in ints]
    finally:
        _oleaut32().SafeArrayDestroy(array)


def _has_pattern(element: int, pattern_id: int) -> bool:
    punk = _ptr_out(
        element,
        16,
        ctypes.c_int(pattern_id),
        prefix_types=(ctypes.c_int,),
    )
    if not punk:
        return False
    _release(punk)
    return True


def _pattern(element: int, pattern_id: int) -> int:
    return _ptr_out(
        element,
        16,
        ctypes.c_int(pattern_id),
        prefix_types=(ctypes.c_int,),
    )


def _dump_element(element: int, hwnd: int) -> dict[str, Any]:
    patterns = [name for pattern_id, name in _PATTERNS if _has_pattern(element, pattern_id)]
    runtime = _runtime_id(element)
    node: dict[str, Any] = {
        "name": _bstr(element, 23),
        "control_type": _control_type(element),
        "rect": _rect_of(element),
        "patterns": patterns,
        "hwnd": hwnd,
    }
    if runtime:
        node["runtime_id"] = runtime
    return node


def _com_walk(hwnd: int) -> list[dict[str, Any]]:
    auto = _create_automation()
    held: list[int] = [auto]
    try:
        root = _ptr_out(
            auto,
            6,
            ctypes.c_void_p(hwnd),
            prefix_types=(ctypes.c_void_p,),
        )
        if not root:
            return []
        held.append(root)
        walker = _ptr_out(auto, 14)
        if not walker:
            return [_dump_element(root, hwnd)]
        held.append(walker)
        nodes: list[dict[str, Any]] = []
        queue = [root]
        while queue and len(nodes) < NODE_BUDGET:
            current = queue.pop(0)
            nodes.append(_dump_element(current, hwnd))
            child = _ptr_out(walker, 4, ctypes.c_void_p(current), prefix_types=(ctypes.c_void_p,))
            while child:
                held.append(child)
                if len(nodes) + len(queue) < NODE_BUDGET:
                    queue.append(child)
                    child = _ptr_out(
                        walker,
                        6,
                        ctypes.c_void_p(child),
                        prefix_types=(ctypes.c_void_p,),
                    )
                else:
                    break
        return nodes
    finally:
        for item in reversed(held):
            _release(item)


def _same_element(node: dict[str, Any], wanted: dict[str, Any]) -> bool:
    left = list(node.get("runtime_id") or ())
    right = list(wanted.get("runtime_id") or ())
    if left and right:
        return left == right
    return (
        str(node.get("name") or "") == str(wanted.get("name") or "")
        and _as_rect(node.get("rect")) == _as_rect(wanted.get("rect"))
        and _role_for(node.get("control_type") or node.get("role"))
        == _role_for(wanted.get("role") or wanted.get("control_type"))
    )


def _com_act(action: str, element: dict[str, Any], value: str | None) -> dict[str, Any]:
    hwnd = int(element.get("hwnd") or 0)
    backend = f"uia_{action}"
    auto = _create_automation()
    held: list[int] = [auto]
    try:
        root = _ptr_out(
            auto,
            6,
            ctypes.c_void_p(hwnd),
            prefix_types=(ctypes.c_void_p,),
        )
        if not root:
            return {"ok": False, "backend": backend, "reason": "window_unavailable"}
        held.append(root)
        walker = _ptr_out(auto, 14)
        if walker:
            held.append(walker)
        target = 0
        queue = [root]
        while queue:
            current = queue.pop(0)
            if _same_element(_dump_element(current, hwnd), element):
                target = current
                break
            if not walker:
                break
            child = _ptr_out(walker, 4, ctypes.c_void_p(current), prefix_types=(ctypes.c_void_p,))
            while child:
                held.append(child)
                if len(queue) < NODE_BUDGET:
                    queue.append(child)
                    child = _ptr_out(
                        walker,
                        6,
                        ctypes.c_void_p(child),
                        prefix_types=(ctypes.c_void_p,),
                    )
                else:
                    break
        if not target:
            return {"ok": False, "backend": backend, "reason": "element_not_found"}
        ok, reason, extra = _dispatch(target, action, value, held)
        payload = {"ok": ok, "backend": backend, **extra}
        if not ok:
            payload["reason"] = reason
        return payload
    finally:
        for item in reversed(held):
            _release(item)


def _dispatch(
    element: int,
    action: str,
    value: str | None,
    held: list[int],
) -> tuple[bool, str, dict[str, Any]]:
    if action in {"read_value", "get_value"}:
        ok, reason, text = _read_value(element, held)
        return ok, reason, {"value": text} if ok else {}
    if action in {"value", "set_value"}:
        ok, reason = _set_value(element, value, held)
        return ok, reason, {}
    if action in {"invoke"}:
        ok, reason = _invoke(element, 10000, 3, held, "no_pattern")
        return ok, reason, {}
    if action in {"toggle"}:
        ok, reason = _invoke(element, 10015, 3, held, "no_pattern")
        return ok, reason, {}
    if action in {"expand"}:
        ok, reason = _invoke(element, 10005, 3, held, "no_pattern")
        return ok, reason, {}
    if action in {"collapse"}:
        ok, reason = _invoke(element, 10005, 4, held, "no_pattern")
        return ok, reason, {}
    if action in {"select"}:
        ok, reason = _invoke(element, 10010, 3, held, "no_pattern")
        if ok:
            return ok, reason, {}
        ok, reason = _select_text(element, held)
        return ok, reason, {}
    return False, "unsupported_action", {}


def _read_value(element: int, held: list[int]) -> tuple[bool, str, str]:
    punk = _pattern(element, 10002)
    if not punk:
        return False, "no_pattern", ""
    held.append(punk)
    out = ctypes.c_void_p()
    hr = int(_call(
        punk,
        4,
        ctypes.HRESULT,
        ctypes.byref(out),
        argtypes=(ctypes.POINTER(ctypes.c_void_p),),
    ))
    if hr < 0:
        return False, "pattern_failed", ""
    if not out.value:
        return True, "", ""
    oleaut = _oleaut32()
    try:
        return True, "", ctypes.wstring_at(out.value)
    finally:
        oleaut.SysFreeString(out.value)


def _invoke(
    element: int,
    pattern_id: int,
    method_index: int,
    held: list[int],
    missing: str,
) -> tuple[bool, str]:
    punk = _pattern(element, pattern_id)
    if not punk:
        return False, missing
    held.append(punk)
    hr = int(_call(punk, method_index, ctypes.HRESULT))
    return (hr >= 0, "pattern_failed" if hr < 0 else "")


def _set_value(element: int, value: str | None, held: list[int]) -> tuple[bool, str]:
    text = "" if value is None else str(value)
    punk = _pattern(element, 10002)
    if punk:
        held.append(punk)
        oleaut = _oleaut32()
        bstr = oleaut.SysAllocString(text)
        try:
            hr = int(_call(
                punk,
                3,
                ctypes.HRESULT,
                bstr,
                argtypes=(ctypes.c_void_p,),
            ))
        finally:
            if bstr:
                oleaut.SysFreeString(bstr)
        return (hr >= 0, "pattern_failed" if hr < 0 else "")
    ranged = _pattern(element, 10003)
    if not ranged:
        return False, "no_pattern"
    held.append(ranged)
    try:
        number = float(text)
    except (TypeError, ValueError):
        return False, "no_pattern"
    hr = int(_call(
        ranged,
        3,
        ctypes.HRESULT,
        ctypes.c_double(number),
        argtypes=(ctypes.c_double,),
    ))
    return (hr >= 0, "pattern_failed" if hr < 0 else "")


def _select_text(element: int, held: list[int]) -> tuple[bool, str]:
    pattern = _pattern(element, 10014)
    if not pattern:
        return False, "no_pattern"
    held.append(pattern)
    rng = _ptr_out(pattern, 7)
    if not rng:
        return False, "no_pattern"
    held.append(rng)
    hr = int(_call(rng, 16, ctypes.HRESULT))
    return (hr >= 0, "pattern_failed" if hr < 0 else "")
