from __future__ import annotations

import argparse
import math
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path


def configure_tcl_tk_for_scoop_python() -> None:
    """Make Tkinter work when launched from pythonw/Scoop outside a shell."""

    base = Path(sys.executable).resolve().parent
    tcl_dir = base / "tcl"
    tcl_lib = tcl_dir / "tcl8.6"
    tk_lib = tcl_dir / "tk8.6"
    dll_dir = base / "DLLs"
    if tcl_lib.exists():
        os.environ.setdefault("TCL_LIBRARY", str(tcl_lib))
    if tk_lib.exists():
        os.environ.setdefault("TK_LIBRARY", str(tk_lib))
    if dll_dir.exists() and hasattr(os, "add_dll_directory"):
        try:
            os.add_dll_directory(str(dll_dir))
        except OSError:
            pass


configure_tcl_tk_for_scoop_python()

import tkinter as tk
from tkinter import messagebox

from PIL import ImageGrab, ImageTk

try:
    import pyperclip
except Exception:  # pragma: no cover - optional runtime convenience
    pyperclip = None

from app.ai_client import ask_vision_model
from app.object_store import ObjectStore, PointerObject, new_object_id
from app.task_context import TaskContextStore
from app.screen_context import build_screen_context
from app.system_context import (
    acquire_single_instance,
    enable_dpi_awareness,
    get_foreground_window_title,
    get_virtual_screen_bbox,
    get_cursor_position,
    is_hotkey_down,
    apply_modern_window_backdrop,
    trigger_windows_dictation,
)


APP_TITLE = "Magic Pointer Open"
ROOT = Path(__file__).resolve().parents[1]
CAPTURE_DIR = ROOT / "data" / "captures"
OBJECT_DIR = ROOT / "data" / "objects"
RUNTIME_DIR = ROOT / "data" / "runtime"
SHOW_PANEL_SIGNAL = RUNTIME_DIR / "show_panel.signal"


class MagicPointerApp:
    def __init__(self, background: bool = False, mouse_shake: bool = True) -> None:
        enable_dpi_awareness()
        CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
        OBJECT_DIR.mkdir(parents=True, exist_ok=True)
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        self.store = ObjectStore(OBJECT_DIR)
        self.tasks = TaskContextStore(OBJECT_DIR)

        self.root = tk.Tk()
        self.root.title(APP_TITLE)
        self.root.geometry("760x460")
        self.root.minsize(700, 420)
        self.root.resizable(True, True)
        self.root.protocol("WM_DELETE_WINDOW", self.quit)

        self.background = background
        self.mouse_shake = mouse_shake
        self._mouse_points: deque[tuple[float, int, int]] = deque(maxlen=24)
        self._last_shake_trigger = 0.0
        self._last_show_signal_mtime = get_signal_mtime(SHOW_PANEL_SIGNAL)
        self._hotkey_was_down = False
        self._selection_window: tk.Toplevel | None = None
        self._source_app_title = ""
        self._status = tk.StringVar(value="\u6309 Ctrl + Alt + M \u6846\u9009\u4efb\u610f\u5c4f\u5e55\u533a\u57df\u3002")

        self._build_home()
        if self.background:
            self.root.withdraw()
        self.root.after(80, self._poll_hotkey)
        self.root.after(35, self._poll_mouse_shake)
        self.root.after(250, self._poll_show_panel_signal)

    def _build_home(self) -> None:
        frame = tk.Frame(self.root, padx=28, pady=24)
        frame.pack(fill="both", expand=True)
        tk.Label(frame, text=APP_TITLE, font=("Segoe UI", 24, "bold")).pack(anchor="w")
        tk.Label(
            frame,
            text="MVP1-beta\uff1a\u6846\u9009\u622a\u56fe \u2192 \u5f53\u524d\u4efb\u52a1\u4e0a\u4e0b\u6587 \u2192 AI \u7406\u89e3 \u2192 \u7ed3\u679c",
            justify="left",
            font=("Microsoft YaHei UI", 12),
            wraplength=680,
        ).pack(anchor="w", pady=(14, 8))
        tk.Label(
            frame,
            text="\u53cc\u51fb MagicPointer.vbs \u53ef\u6253\u5f00/\u5524\u51fa\u63a7\u5236\u9762\u677f\uff1b\u9690\u85cf\u540e\u70ed\u952e\u548c\u9f20\u6807\u624b\u52bf\u4ecd\u4f1a\u76d1\u542c\u3002",
            justify="left",
            fg="#6b7280",
            font=("Microsoft YaHei UI", 10),
            wraplength=680,
        ).pack(anchor="w", pady=(0, 16))
        tk.Label(
            frame,
            textvariable=self._status,
            fg="#374151",
            font=("Microsoft YaHei UI", 11),
            wraplength=680,
            justify="left",
        ).pack(anchor="w", fill="x", pady=(4, 22))
        buttons = tk.Frame(frame)
        buttons.pack(anchor="w")
        tk.Button(buttons, text="\u5f00\u59cb\u6846\u9009", command=self.start_selection, padx=18, pady=8).pack(side="left", padx=(0, 10))
        tk.Button(buttons, text="\u9690\u85cf\u5230\u540e\u53f0", command=self.hide_to_background, padx=18, pady=8).pack(side="left", padx=(0, 10))
        tk.Button(buttons, text="\u5bf9\u8c61\u65e5\u5fd7\u4f4d\u7f6e", command=self.open_log_hint, padx=18, pady=8).pack(side="left", padx=(0, 10))
        tk.Button(buttons, text="\u9000\u51fa", command=self.quit, padx=18, pady=8).pack(side="left")

    def _poll_hotkey(self) -> None:
        try:
            down = is_hotkey_down()
            if down and not self._hotkey_was_down:
                self.start_selection()
            self._hotkey_was_down = down
        finally:
            self.root.after(80, self._poll_hotkey)

    def _show_home_if_needed(self) -> None:
        if not self.background:
            self.root.deiconify()

    def show_control_panel(self) -> None:
        self.background = False
        self.root.deiconify()
        self.root.lift()
        self.root.attributes("-topmost", True)
        self.root.after(250, lambda: self.root.attributes("-topmost", False))
        self._status.set("\u63a7\u5236\u9762\u677f\u5df2\u5524\u51fa\uff1b\u4e3b\u4ea4\u4e92\u8bf7\u7528\u70ed\u952e\u6216\u9f20\u6807\u624b\u52bf\u3002")

    def _poll_show_panel_signal(self) -> None:
        try:
            mtime = get_signal_mtime(SHOW_PANEL_SIGNAL)
            if mtime and mtime != self._last_show_signal_mtime:
                self._last_show_signal_mtime = mtime
                self.show_control_panel()
        finally:
            self.root.after(250, self._poll_show_panel_signal)

    def _poll_mouse_shake(self) -> None:
        try:
            if self.mouse_shake and self._selection_window is None:
                now = time.monotonic()
                x, y = get_cursor_position()
                self._mouse_points.append((now, x, y))
                if now - self._last_shake_trigger > 0.9 and self._looks_like_mouse_shake(now):
                    self._last_shake_trigger = now
                    self._mouse_points.clear()
                    self.start_selection(trigger="shake")
        finally:
            self.root.after(35, self._poll_mouse_shake)

    def _looks_like_mouse_shake(self, now: float) -> bool:
        """Detect a deliberate left-right-left-right wiggle.

        Requires three clear horizontal direction reversals in about one second.
        This keeps latency low while avoiding accidental triggers from ordinary
        vertical, diagonal, or one-way movement.
        """

        recent = [(t, x, y) for t, x, y in self._mouse_points if now - t <= 1.15]
        if len(recent) < 8:
            return False

        xs = [x for _t, x, _y in recent]
        ys = [y for _t, _x, y in recent]
        x_range = max(xs) - min(xs)
        y_range = max(ys) - min(ys)
        if x_range < 55:
            return False
        if y_range > max(90, x_range * 0.75):
            return False

        # Build signed horizontal movement chunks, ignoring jitter.
        chunks: list[tuple[int, int]] = []
        min_step = 10
        current_dir = 0
        current_dist = 0
        prev_x = xs[0]
        for x in xs[1:]:
            dx = x - prev_x
            prev_x = x
            if abs(dx) < min_step:
                continue
            direction = 1 if dx > 0 else -1
            if current_dir == 0:
                current_dir = direction
                current_dist = abs(dx)
            elif direction == current_dir:
                current_dist += abs(dx)
            else:
                chunks.append((current_dir, current_dist))
                current_dir = direction
                current_dist = abs(dx)
        if current_dir:
            chunks.append((current_dir, current_dist))

        # Keep only meaningful strokes and merge accidental same-direction pieces.
        meaningful: list[tuple[int, int]] = []
        min_stroke = 24
        for direction, dist in chunks:
            if dist < min_stroke:
                continue
            if meaningful and meaningful[-1][0] == direction:
                meaningful[-1] = (direction, meaningful[-1][1] + dist)
            else:
                meaningful.append((direction, dist))

        if len(meaningful) < 4:
            return False
        turns = sum(1 for a, b in zip(meaningful, meaningful[1:]) if a[0] != b[0])
        if turns < 3:
            return False

        total = sum(d for _dir, d in meaningful)
        net = abs(xs[-1] - xs[0])
        if total < 140:
            return False
        if net > total * 0.65 and net > 110:
            return False
        return True


    def hide_to_background(self) -> None:
        self.background = True
        self.root.withdraw()
        self._status.set("\u5df2\u9690\u85cf\u5230\u540e\u53f0\uff1b\u70ed\u952e\u548c\u624b\u52bf\u4ecd\u5728\u76d1\u542c\u3002")

    def open_log_hint(self) -> None:
        messagebox.showinfo("对象日志", f"对象日志位置：\n{self.store.log_path}")

    def start_selection(self, trigger: str = "manual") -> None:
        if self._selection_window is not None:
            return
        self._source_app_title = get_foreground_window_title()
        self._status.set("拖拽鼠标框选区域；按 Esc 取消。")
        self.root.withdraw()

        left, top, right, bottom = get_virtual_screen_bbox()
        width, height = right - left, bottom - top
        win = tk.Toplevel(self.root)
        self._selection_window = win
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        transparent = "#010203"
        win.configure(bg=transparent)
        try:
            win.attributes("-transparentcolor", transparent)
        except tk.TclError:
            # Very old Tk fallback. Keep almost invisible; selection stroke remains visible.
            win.attributes("-alpha", 0.10)
        win.geometry(f"{width}x{height}+{left}+{top}")

        canvas = tk.Canvas(win, cursor="crosshair", bg=transparent, highlightthickness=0, bd=0)
        canvas.pack(fill="both", expand=True)

        state: dict[str, object] = {"points": [], "items": []}

        def to_screen(event: tk.Event) -> tuple[int, int]:
            return int(event.x_root), int(event.y_root)

        def add_point(x: int, y: int) -> None:
            points = state["points"]
            items = state["items"]
            assert isinstance(points, list)
            assert isinstance(items, list)
            if points:
                px, py = points[-1]
                if abs(x - px) + abs(y - py) < 5:
                    return
                lx1, ly1 = int(px) - left, int(py) - top
                lx2, ly2 = x - left, y - top
                # Match Gemini's sweep: broad soft blue glow, narrower blue body,
                # and a tiny white-hot core following the pointer.
                glow = canvas.create_line(lx1, ly1, lx2, ly2, fill="#bfdbfe", width=32, capstyle="round", smooth=True)
                body = canvas.create_line(lx1, ly1, lx2, ly2, fill="#60a5fa", width=15, capstyle="round", smooth=True)
                core = canvas.create_line(lx1, ly1, lx2, ly2, fill="#f8fbff", width=3, capstyle="round", smooth=True)
                items.extend([glow, body, core])
                # Keep a short live tail during dragging; bbox still uses all points.
                if len(items) > 120:
                    for item in items[:9]:
                        canvas.delete(int(item))
                    del items[:9]
            points.append((x, y))

        def on_press(event: tk.Event) -> None:
            x, y = to_screen(event)
            state["points"] = []
            state["items"] = []
            add_point(x, y)

        def on_drag(event: tk.Event) -> None:
            x, y = to_screen(event)
            add_point(x, y)

        def on_release(event: tk.Event) -> None:
            x, y = to_screen(event)
            add_point(x, y)
            points = state["points"]
            if not isinstance(points, list) or len(points) < 2:
                self.cancel_selection()
                return
            xs = [int(p[0]) for p in points]
            ys = [int(p[1]) for p in points]
            pad = 52
            bbox = normalize_bbox((min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad))
            self._destroy_selection_window()
            if bbox[2] - bbox[0] < 24 or bbox[3] - bbox[1] < 24:
                self._show_home_if_needed()
                self._status.set("???????????")
                return
            stroke = [(int(px), int(py)) for px, py in points]
            self.root.after(90, lambda: self.capture_and_prompt(bbox, stroke_points=stroke))

        canvas.bind("<ButtonPress-1>", on_press)
        canvas.bind("<B1-Motion>", on_drag)
        canvas.bind("<ButtonRelease-1>", on_release)
        canvas.bind("<ButtonPress-3>", lambda _e: self.cancel_selection())
        win.bind("<ButtonPress-3>", lambda _e: self.cancel_selection())
        win.bind("<Escape>", lambda _e: self.cancel_selection())
        win.focus_force()

    def cancel_selection(self) -> None:
        self._destroy_selection_window()
        self._show_home_if_needed()
        self._status.set("已取消。按 Ctrl + Alt + M 可重新框选。")

    def _destroy_selection_window(self) -> None:
        if self._selection_window is not None:
            try:
                self._selection_window.destroy()
            finally:
                self._selection_window = None

    def capture_and_prompt(self, bbox: tuple[int, int, int, int], stroke_points: list[tuple[int, int]] | None = None) -> None:
        obj_id = new_object_id()
        image_path = CAPTURE_DIR / f"{obj_id}.png"
        try:
            image = ImageGrab.grab(bbox=bbox, all_screens=True)
            image.save(image_path)
        except Exception as exc:
            self._show_home_if_needed()
            messagebox.showerror("截图失败", f"{type(exc).__name__}: {exc}")
            return

        self.show_prompt_window(bbox, image_path, stroke_points=stroke_points)

    def show_prompt_window(self, bbox: tuple[int, int, int, int], image_path: Path, stroke_points: list[tuple[int, int]] | None = None) -> None:
        """Show a lightweight pointer command bar instead of a chat window."""

        screen_ctx = build_screen_context(bbox, image_path)
        task_result = self.tasks.active_task(auto_rollover=True)
        task_state: dict[str, object] = {"task": task_result.task, "rolled_over": task_result.rolled_over}
        current_object_state: dict[str, PointerObject | None] = {"object": None}
        last_answer: dict[str, str] = {"text": ""}

        win = tk.Toplevel(self.root)
        win.title("Magic Pointer Overlay")
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        transparent = "#010203"
        win.configure(bg=transparent)
        try:
            win.attributes("-transparentcolor", transparent)
        except tk.TclError:
            # Fallback: keep the overlay subtle if transparentcolor is not available.
            win.attributes("-alpha", 0.96)
        apply_modern_window_backdrop(win)

        vw_left, vw_top, vw_right, vw_bottom = get_virtual_screen_bbox()
        screen_w, screen_h = vw_right - vw_left, vw_bottom - vw_top
        win.geometry(f"{screen_w}x{screen_h}+{vw_left}+{vw_top}")

        canvas = tk.Canvas(win, bg=transparent, highlightthickness=0, bd=0)
        canvas.pack(fill="both", expand=True)

        bx1, by1, bx2, by2 = [int(v) for v in bbox]
        rx1, ry1, rx2, ry2 = bx1 - vw_left, by1 - vw_top, bx2 - vw_left, by2 - vw_top
        cx, cy = (rx1 + rx2) / 2, (ry1 + ry2) / 2

        # Gemini-like object attention: preserve the user's sweep/circle stroke.
        # The blue mark is intentionally broad: in the reference it is roughly
        # 1.7-2.2x one text-line height including the soft glow, with no center target circle.
        attention_items: list[int] = []

        def draw_attention_stroke() -> None:
            points = stroke_points or []
            local: list[tuple[int, int]] = []
            if len(points) >= 2:
                local = [(int(x - vw_left), int(y - vw_top)) for x, y in points]
            else:
                y = int((ry1 + ry2) / 2)
                local = [(int(rx1 + 16), y), (int(rx2 - 16), y)]
            if len(local) < 2:
                return
            flat = [coord for pt in local for coord in pt]
            attention_items.append(canvas.create_line(*flat, fill="#bfdbfe", width=34, capstyle="round", smooth=True, splinesteps=24))
            attention_items.append(canvas.create_line(*flat, fill="#60a5fa", width=16, capstyle="round", smooth=True, splinesteps=24))
            attention_items.append(canvas.create_line(*flat, fill="#f8fbff", width=3, capstyle="round", smooth=True, splinesteps=24))
            # Arrow-like pointer head at the final point. This is a drawn visual only;
            # the OS cursor remains unchanged.
            ex, ey = local[-1]
            pointer = [ex, ey, ex + 30, ey + 13, ex + 14, ey + 19, ex + 21, ey + 38, ex + 8, ey + 42, ex + 1, ey + 22]
            attention_items.append(canvas.create_polygon(pointer, fill="#ffffff", outline="#2563eb", width=3))

        draw_attention_stroke()
        relation_items: list[int] = []
        path_dot: dict[str, int | None] = {"id": None}

        def clear_relation_path() -> None:
            for item in relation_items:
                canvas.delete(item)
            relation_items.clear()
            if path_dot.get("id") is not None:
                canvas.delete(int(path_dot["id"]))
                path_dot["id"] = None

        def bbox_center(raw_bbox: object) -> tuple[float, float] | None:
            if not isinstance(raw_bbox, (list, tuple)) or len(raw_bbox) != 4:
                return None
            try:
                x1, y1, x2, y2 = [float(v) for v in raw_bbox]
            except Exception:
                return None
            return ((x1 + x2) / 2 - vw_left, (y1 + y2) / 2 - vw_top)

        def draw_relation_path(raw_bbox: object) -> None:
            clear_relation_path()
            target = bbox_center(raw_bbox)
            if target is None:
                return
            tx, ty = target
            sx, sy = cx, cy
            mx, my = (sx + tx) / 2, min(sy, ty) - 90
            line = canvas.create_line(sx, sy, mx, my, tx, ty, smooth=True, splinesteps=28, fill="#60a5fa", width=3, arrow="last")
            relation_items.append(line)
            dot = canvas.create_oval(sx - 5, sy - 5, sx + 5, sy + 5, fill="#ffffff", outline="#38bdf8", width=2)
            path_dot["id"] = dot
            start_t = time.monotonic()

            def tick() -> None:
                if path_dot.get("id") is None:
                    return
                t = min(1.0, (time.monotonic() - start_t) / 0.55)
                # Quadratic Bezier ease-out.
                e = 1 - (1 - t) * (1 - t)
                x = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * mx + e * e * tx
                y = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * my + e * e * ty
                canvas.coords(int(path_dot["id"]), x - 5, y - 5, x + 5, y + 5)
                if t < 1.0:
                    win.after(16, tick)
            tick()

        def animate_pointer_layer() -> None:
            try:
                phase = (math.sin(time.monotonic() * math.tau / 1.25) + 1) / 2
                # Breathe the sweep itself, not a fake target circle.
                if attention_items:
                    canvas.itemconfigure(attention_items[0], fill="#dbeafe" if phase > 0.5 else "#93c5fd")
                    canvas.itemconfigure(attention_items[1], fill="#60a5fa" if phase > 0.5 else "#3b82f6")
            except tk.TclError:
                return
            win.after(70, animate_pointer_layer)
        animate_pointer_layer()

        panel_w = 430
        panel_x = min(max(rx1, 16), max(16, screen_w - panel_w - 16))
        panel_y = ry2 + 14
        if panel_y > screen_h - 188:
            panel_y = max(16, ry1 - 188)

        shell = tk.Frame(canvas, bg="#111827", padx=10, pady=9, highlightthickness=1, highlightbackground="#38bdf8")
        shell_window = canvas.create_window(panel_x, panel_y, anchor="nw", window=shell, width=panel_w)
        shell.columnconfigure(0, weight=1)

        top = tk.Frame(shell, bg="#111827")
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(0, weight=1)
        context_text = tk.StringVar()
        tk.Label(top, text="Magic Pointer  ?  listening layer", bg="#111827", fg="#bae6fd", font=("Segoe UI", 9, "bold")).grid(row=0, column=0, sticky="w")
        tk.Button(top, text="x", relief="flat", bg="#111827", fg="#e5e7eb", activebackground="#374151", borderwidth=0, command=win.destroy).grid(row=0, column=1, sticky="e")

        command_row = tk.Frame(shell, bg="#111827")
        command_row.grid(row=1, column=0, sticky="ew", pady=(8, 8))
        command_row.columnconfigure(0, weight=1)
        command_var = tk.StringVar()
        command = tk.Entry(
            command_row,
            textvariable=command_var,
            font=("Microsoft YaHei UI", 11),
            bg="#0b1120",
            fg="#f9fafb",
            insertbackground="#f9fafb",
            relief="flat",
            highlightthickness=1,
            highlightbackground="#1e40af",
            highlightcolor="#38bdf8",
        )
        command.grid(row=0, column=0, sticky="ew", ipady=7)
        voice_btn = tk.Button(
            command_row,
            text="\u8bed\u97f3",
            relief="flat",
            bg="#075985",
            fg="#e0f2fe",
            activebackground="#0ea5e9",
            borderwidth=0,
            padx=12,
            pady=7,
        )
        voice_btn.grid(row=0, column=1, sticky="e", padx=(8, 0))

        result_card = tk.Frame(shell, bg="#0b1120", padx=10, pady=8, highlightthickness=1, highlightbackground="#1e3a8a")
        result_card.grid(row=2, column=0, sticky="ew")
        result_card.grid_remove()
        result_card.columnconfigure(0, weight=1)
        result_title = tk.StringVar(value="\u542c\u8bed\u97f3")
        tk.Label(result_card, textvariable=result_title, bg="#0b1120", fg="#e0f2fe", font=("Segoe UI", 10, "bold")).grid(row=0, column=0, sticky="w")
        result = tk.Text(
            result_card,
            height=3,
            wrap="word",
            state="disabled",
            borderwidth=0,
            bg="#0b1120",
            fg="#f9fafb",
            font=("Microsoft YaHei UI", 9),
        )
        result.grid(row=1, column=0, sticky="ew", pady=(4, 0))

        actions = tk.Frame(shell, bg="#111827")
        actions.grid(row=3, column=0, sticky="ew", pady=(9, 0))
        actions.columnconfigure(8, weight=1)

        def current_task() -> dict:
            return task_state["task"]  # type: ignore[return-value]

        def current_task_id() -> str:
            return str(current_task().get("id"))

        def short_id(object_id: str) -> str:
            return object_id[-8:] if len(object_id) > 8 else object_id

        def task_objects() -> list[dict]:
            return self.tasks.task_objects(self.store, current_task_id())

        def suggested_prompt() -> str:
            objs = task_objects()
            dest = self.tasks.destination_object(self.store, current_task_id())
            if dest and objs:
                return "\u628a\u8fd9\u4e2a\u6574\u7406\u6210\u53ef\u653e\u5230\u90a3\u91cc\u7684\u5185\u5bb9"
            if objs:
                return "\u6bd4\u8f83\u8fd9\u4e2a\u548c\u4e0a\u4e00\u4e2a"
            return "\u89e3\u91ca\u8fd9\u4e2a"

        def refresh_context() -> None:
            objs = task_objects()
            that = objs[-1] if objs else None
            dest = self.tasks.destination_object(self.store, current_task_id())
            that_label = short_id(str(that.get("id"))) if that else "\u7a7a"
            dest_label = short_id(str(dest.get("id"))) if dest else "\u7a7a"
            if dest:
                draw_relation_path(dest.get("bbox"))
            else:
                clear_relation_path()
            context_text.set(f"THIS=\u5f53\u524d  \u00b7  THAT={that_label}  \u00b7  GROUP={len(objs)}  \u00b7  DEST={dest_label}")
            if not command_var.get().strip():
                command_var.set(suggested_prompt())

        def start_voice_input() -> None:
            command.focus_set()
            command.select_range(0, "end")
            write_result("\u4e3a\u907f\u514d\u518d\u5f39\u51fa Windows \u53f3\u4e0b\u89d2\u542c\u5199\u9762\u677f\uff0c\u9ed8\u8ba4\u4e0d\u518d\u8c03\u7528 Win+H\u3002\n\u6682\u65f6\u8bf7\u5728\u8fd9\u4e00\u884c\u8f93\u5165\u77ed\u6307\u4ee4\uff0c\u6216\u70b9\u51fb\u201c\u7cfb\u7edf\u542c\u5199\u201d\u624b\u52a8\u542f\u7528\u3002", "\u8bed\u97f3\u5f85\u63a5\u5165")

        def write_result(value: str, title: str = "\u7ed3\u679c\u5361\u7247") -> None:
            result_card.grid()
            last_answer["text"] = value
            result_title.set(title)
            result.configure(state="normal")
            result.delete("1.0", "end")
            result.insert("1.0", value)
            result.see("1.0")
            result.configure(state="disabled")

        def save_current_object(prompt_text: str, answer_text: str, alias: str = "this") -> PointerObject:
            existing = current_object_state.get("object")
            if existing is not None:
                return existing
            obj = PointerObject(
                id=image_path.stem,
                alias=alias,
                kind="screen_region",
                bbox=bbox,
                image_path=str(image_path.relative_to(ROOT)),
                app_title=self._source_app_title,
                prompt=prompt_text,
                answer=answer_text,
                created_at=datetime.now().isoformat(timespec="seconds"),
                screen_context={
                    "selection_bbox": screen_ctx.selection_bbox,
                    "annotated_image_path": str(screen_ctx.annotated_image_path.relative_to(ROOT)) if screen_ctx.annotated_image_path else None,
                    "windows": [w.__dict__ for w in screen_ctx.windows],
                },
            )
            self.store.append(obj)
            current_object_state["object"] = obj
            return obj

        def is_group_prompt(user_prompt: str) -> bool:
            lowered = user_prompt.lower()
            keywords = ["group", "merge", "these", "them", "\u5408\u5e76", "\u8fd9\u4e9b", "\u5b83\u4eec", "\u5b83\u4fe9", "\u4ed6\u4eec", "\u8fd9\u4e00\u7ec4", "\u8fd9\u7ec4"]
            return any(k in lowered or k in user_prompt for k in keywords)

        def is_destination_prompt(user_prompt: str) -> bool:
            lowered = user_prompt.lower()
            keywords = ["destination", "there", "target", "put", "place", "write there", "paste there", "\u90a3\u91cc", "\u76ee\u6807", "\u76ee\u7684\u5730", "\u653e\u5230\u90a3", "\u653e\u90a3", "\u5199\u5230\u90a3", "\u7c98\u8d34\u5230\u90a3"]
            return any(k in lowered or k in user_prompt for k in keywords)

        def should_attach_that(user_prompt: str) -> bool:
            if is_group_prompt(user_prompt):
                return False
            lowered = user_prompt.lower()
            keywords = ["that", "previous", "last", "compare", "\u90a3\u4e2a", "\u4e0a\u4e00\u4e2a", "\u4e0a\u4e00\u5f20", "\u521a\u624d", "\u4e4b\u524d", "\u6bd4\u8f83", "\u5bf9\u6bd4"]
            return any(k in lowered or k in user_prompt for k in keywords)

        def add_object_reference(refs: list[tuple[str, Path]], label: str, obj: dict) -> None:
            raw = obj.get("image_path")
            if isinstance(raw, str):
                path = ROOT / raw
                if path.exists():
                    refs.append((label, path))

        def reference_image_labels(user_prompt: str) -> list[tuple[str, Path]]:
            refs: list[tuple[str, Path]] = []
            if screen_ctx.annotated_image_path:
                refs.append(("IMAGE A2 / THIS_OBJECT_MAP / current annotated map", screen_ctx.annotated_image_path))
            objs = task_objects()
            if is_group_prompt(user_prompt):
                for i, obj in enumerate(objs[-3:], 1):
                    add_object_reference(refs, f"IMAGE G{i} / CURRENT_TASK_GROUP_{i} / session object", obj)
            if is_destination_prompt(user_prompt):
                destination = self.tasks.destination_object(self.store, current_task_id())
                if destination:
                    add_object_reference(refs, "IMAGE D / DESTINATION / explicit target object", destination)
            if refs and is_group_prompt(user_prompt):
                return refs
            if should_attach_that(user_prompt) and objs:
                add_object_reference(refs, "IMAGE B / THAT / previous object in current task", objs[-1])
            return refs

        def make_context() -> str:
            guard = (
                "Coreference guard: THIS/current/Chinese '\u8fd9\u4e2a/\u5f53\u524d' means the object selected in this turn. "
                "THAT/previous/Chinese '\u90a3\u4e2a/\u4e0a\u4e00\u4e2a' means the previous object in the current task only. "
                "GROUP/these/Chinese '\u8fd9\u4e9b/\u5b83\u4eec' means current task objects plus THIS, not global history. "
                "DESTINATION/there/Chinese '\u90a3\u91cc/\u76ee\u6807\u4f4d\u7f6e' means the explicit destination object in this current task. "
                "Reply as a concise action card first. Do not behave like a long chat unless asked for details."
            )
            registry_context = self.tasks.build_reference_context(self.store, current_task_id(), image_path.stem, bbox)
            return guard + "\n\n" + screen_ctx.to_prompt_context() + "\n\n" + registry_context

        def set_busy(is_busy: bool) -> None:
            state = "disabled" if is_busy else "normal"
            for btn in [explain_btn, compare_btn, put_there_btn, dest_btn, clear_dest_btn, send_btn, detail_btn, continue_btn, voice_btn]:
                btn.configure(state=state)
            command.configure(state=state)
            self._status.set("\u6b63\u5728\u8c03\u7528 AI..." if is_busy else "\u6309 Ctrl + Alt + M \u53ef\u7ee7\u7eed\u6846\u9009\u3002")

        def ask(user_prompt: str | None = None) -> None:
            prompt_text = (user_prompt or command_var.get()).strip() or "\u89e3\u91ca\u8fd9\u4e2a"
            command_var.set(prompt_text)
            task_id_for_answer = current_task_id()
            write_result("\u6b63\u5728\u5206\u6790...", "\u5904\u7406\u4e2d")
            set_busy(True)

            def worker() -> None:
                answer = ask_vision_model(
                    image_path,
                    prompt_text,
                    context_text=make_context(),
                    labeled_extra_images=reference_image_labels(prompt_text),
                )
                obj = save_current_object(prompt_text, answer, alias="this")
                updated_task = self.tasks.add_interaction(task_id_for_answer, obj.id, prompt_text, answer)
                self.root.after(0, lambda: finish(answer, updated_task))

            def finish(answer: str, updated_task: dict) -> None:
                task_state["task"] = updated_task
                task_state["rolled_over"] = False
                write_result(answer, "\u7ed3\u679c\u5361\u7247")
                refresh_context()
                set_busy(False)

            threading.Thread(target=worker, daemon=True).start()

        def set_destination() -> None:
            obj = save_current_object("[set destination]", "destination set", alias="destination")
            task_state["task"] = self.tasks.set_destination(current_task_id(), obj.id)
            write_result("\u5df2\u8bbe\u4e3a DESTINATION\uff08\u76ee\u7684\u5730\uff09\u3002\n\u4e4b\u540e\u53ef\u4ee5\u6307\u5411\u5176\u4ed6\u5185\u5bb9\uff0c\u8bf4\u201c\u653e\u5230\u90a3\u91cc\u201d\u6216\u201c\u5199\u5230\u90a3\u91cc\u201d\u3002", "DESTINATION")
            refresh_context()

        def clear_destination() -> None:
            updated = self.tasks.clear_destination(current_task_id())
            if updated:
                task_state["task"] = updated
            write_result("\u5df2\u6e05\u9664 DESTINATION\u3002", "DESTINATION")
            refresh_context()

        def put_there() -> None:
            ask("\u628a\u8fd9\u4e2a\u6574\u7406\u6210\u53ef\u653e\u5230\u90a3\u91cc\u7684\u5185\u5bb9")

        def show_details() -> None:
            detail = tk.Toplevel(win)
            detail.title("Magic Pointer - Details")
            detail.geometry("900x620")
            detail.minsize(760, 520)
            detail.configure(bg="#eef1f6")
            apply_modern_window_backdrop(detail)
            detail.columnconfigure(1, weight=1)
            detail.rowconfigure(0, weight=1)
            left = tk.Frame(detail, bg="#ffffff", padx=12, pady=12, highlightthickness=1, highlightbackground="#dfe5ef")
            left.grid(row=0, column=0, sticky="nsew", padx=14, pady=14)
            try:
                from PIL import Image

                img = Image.open(screen_ctx.annotated_image_path or image_path)
                img.thumbnail((320, 500))
                tk_img = ImageTk.PhotoImage(img)
                lbl = tk.Label(left, image=tk_img, bg="#111318")
                lbl.image = tk_img
                lbl.pack(fill="both", expand=True)
            except Exception:
                tk.Label(left, text=str(image_path), bg="#ffffff").pack()
            right = tk.Frame(detail, bg="#ffffff", padx=12, pady=12, highlightthickness=1, highlightbackground="#dfe5ef")
            right.grid(row=0, column=1, sticky="nsew", padx=(0, 14), pady=14)
            right.rowconfigure(1, weight=1)
            right.columnconfigure(0, weight=1)
            tk.Label(right, text="\u8be6\u60c5", bg="#ffffff", fg="#111827", font=("Segoe UI", 12, "bold")).grid(row=0, column=0, sticky="w")
            txt = tk.Text(right, wrap="word", bg="#fbfcff", fg="#111827", font=("Microsoft YaHei UI", 10))
            txt.grid(row=1, column=0, sticky="nsew", pady=(8, 8))
            txt.insert("1.0", last_answer.get("text") or "\u8fd8\u6ca1\u6709\u7ed3\u679c\u3002")
            tk.Button(right, text="\u5173\u95ed", command=detail.destroy).grid(row=2, column=0, sticky="e")

        chip_style = {"relief": "flat", "bg": "#1f2937", "fg": "#f9fafb", "activebackground": "#374151", "activeforeground": "#ffffff", "borderwidth": 0, "padx": 10, "pady": 5}
        explain_btn = tk.Button(actions, text="\u89e3\u91ca", command=lambda: ask("\u89e3\u91ca\u8fd9\u4e2a"), **chip_style)
        compare_btn = tk.Button(actions, text="\u6bd4\u8f83", command=lambda: ask("\u6bd4\u8f83\u8fd9\u4e2a\u548c\u4e0a\u4e00\u4e2a"), **chip_style)
        put_there_btn = tk.Button(actions, text="\u653e\u90a3\u91cc", command=put_there, **chip_style)
        dest_btn = tk.Button(actions, text="\u8bbeDEST", command=set_destination, **{**chip_style, "bg": "#064e3b", "activebackground": "#047857"})
        clear_dest_btn = tk.Button(actions, text="\u6e05DEST", command=clear_destination, **chip_style)
        send_btn = tk.Button(actions, text="\u6267\u884c", command=lambda: ask(), **{**chip_style, "bg": "#2563eb", "activebackground": "#1d4ed8"})
        detail_btn = tk.Button(actions, text="\u8be6\u60c5", command=show_details, **chip_style)
        continue_btn = tk.Button(actions, text="+\u9009", command=lambda: (win.destroy(), self.root.after(120, lambda: self.start_selection(trigger="continue"))), **chip_style)
        close_btn = tk.Button(actions, text="\u5173", command=win.destroy, **chip_style)
        voice_btn.configure(command=start_voice_input, text="\u8bed\u97f3*", bg="#075985", fg="#e0f2fe")
        chip_buttons = [explain_btn, compare_btn, put_there_btn, dest_btn, send_btn, continue_btn, detail_btn, close_btn]
        for i, btn in enumerate(chip_buttons):
            btn.grid(row=i // 4, column=i % 4, sticky="w", padx=(0, 7), pady=(0, 6))

        command.bind("<Return>", lambda _e: ask())
        win.bind("<Escape>", lambda _e: win.destroy())
        win.protocol("WM_DELETE_WINDOW", win.destroy)
        refresh_context()
        command.focus_set()
        # Do not auto-trigger Windows dictation: its native floating panel breaks the pointer illusion.
    def quit(self) -> None:
        self._destroy_selection_window()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def normalize_bbox(bbox: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bbox
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    return (left, top, right, bottom)


def get_signal_mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def request_show_panel() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    SHOW_PANEL_SIGNAL.write_text(datetime.now().isoformat(timespec="microseconds"), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Magic Pointer Open MVP")
    parser.add_argument("--background", action="store_true", help="start hidden and listen for hotkey/mouse shake")
    parser.add_argument("--no-shake", action="store_true", help="disable mouse shake trigger")
    parser.add_argument("--toggle-panel", action="store_true", help="show existing panel, or start a visible panel if not running")
    args = parser.parse_args()
    if not acquire_single_instance():
        if args.toggle_panel:
            request_show_panel()
        return
    if args.toggle_panel:
        request_show_panel()
    MagicPointerApp(background=args.background and not args.toggle_panel, mouse_shake=not args.no_shake).run()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            (RUNTIME_DIR / "app_error.log").write_text(
                f"{datetime.now().isoformat(timespec='seconds')} {type(exc).__name__}: {exc}\n",
                encoding="utf-8",
            )
        finally:
            raise


