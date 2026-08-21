# 桌面动作面：Kimi 13 工具进主 loop（Everywhere / Clicky / UFO² 对照）

> 状态：开发树已落地（2026-08-18），未升版本、未 sync。

对照：
- `docs/harness-port-notes/2026-08-12-kimi-cu-tools.md`
- `docs/archive/planning/EVERYWHERE_ANALYSIS_20260803.md`
- `docs/CLICKY.md` / `docs/archive/planning/CLICKY_ANALYSIS_20260731.md`
- UFO²：原生 API 优先、GUI 点击兜底

法律：Everywhere 自 v0.5.4 起 BSL 1.1 禁止竞品抄代码，只读思路。Kimi 13 工具实现在闭源 exe，只吸收文档化契约。

## 已做

1. `app/desktop_actions/`：StateVersion（snapshot_id）、InputOwnershipLock、index XOR 坐标、13 工具。
2. 观察绑定冻结身份（hwnd/pid/bounds）；内容重排不靠 snapshot。
3. mutating 带 `used_backend` + `verification`；busy 时只读放行。
4. UFO²：`set_value` / `perform_secondary_action` 先走 UIA；失败诚实 unsupported。
5. `type_text` verification `matched|unavailable`。
6. `press_key` 拒绝 Win/Meta/Super。
7. `launch_app` 未知名失败，不打开 Explorer。
8. `turn_ended` 释放输入所有权。
9. builtin bundle `desktop-action-tools` + 系统提示第 7 条。
10. MCP/OCR `Popen` 进 Windows JobObject（`app/process/job_object.py`）。

本批不做：不升版本；不把像素 CU 当第一选择；不 fork UFO；不抄 Everywhere 源码。

生产仍空：`elements_probe` / `uia_act` 未接常驻 UIA 宿主。坐标 click 可用；index/set_value 要等下一刀。
