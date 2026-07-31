# Magic Pointer Open — 交接文档

> 更新时间：2026-07-06  
> 工作目录：`D:\Desktop\Magic Pointer`  
> 当前阶段：MVP1-alpha 已完成，准备进入 MVP1-beta。

## 1. 项目目标

做一个开源版 Magic Pointer 式桌面 AI 指针助手。长期目标不是普通截图问答，而是：

```text
指向 / 框选 / 点击
→ 屏幕对象注册
→ this / that / group / destination 指代理解
→ 意图理解
→ 规划
→ 跨应用执行
→ 结果校验
```

当前仍处于早期 MVP，但已经开始建立“屏幕对象底盘”。

---

## 2. 当前能运行的功能

### MVP0 已完成

- 全局后台运行。
- 双击 `MagicPointer.vbs` 无终端启动。
- 双击 `stop_magic_pointer.bat` 停止后台。
- 鼠标左右摇三次触发框选。
- `Ctrl + Alt + M` 也可触发。
- 框选时：
  - 左键拖拽选择区域。
  - 右键取消。
  - `Esc` 取消。
- 选区截图保存到 `data/captures/`。
- 调用 78code OpenAI-compatible 接口，模型为 `gpt-5.4-mini`。
- 问答窗口：左侧截图，右侧上方指令，右侧下方回复。
- `Enter` 发送，`Shift+Enter` 换行。

### Screen Context 底盘已完成

每次框选会构建 `ScreenContext`：

```text
selection_bbox
visible top-level windows
window title / class_name / pid / z_order / bbox
与选区重叠比例
估算可见比例
带编号框的对象标注图
```

核心文件：

```text
app/screen_context.py
app/system_context.py
```

用途不是只解决“几个窗口”的问题，而是为后续所有屏幕对象任务打底：

- 判断当前有哪些窗口/软件。
- 理解“这个窗口 / 后面那个 / 右边那个”。
- 后续跨应用写回时定位目标窗口。
- 后续接 UIA / Accessibility / DOM / OCR。

### MVP1-alpha 已完成

开始支持对象注册与指代：

```text
this  = 当前刚框选的对象
that  = 上一个登记对象
group = 当前对象 + 最近对象集合
```

核心文件：

```text
app/object_store.py
app/main.py
app/ai_client.py
```

新增能力：

- `ObjectStore.recent()`
- `ObjectStore.latest_alias_snapshot()`
- `ObjectStore.build_reference_context()`
- 问答窗口有“继续选择”按钮。
- 当指令包含“比较 / 对比 / 合并 / 这些 / 那个 / 上一个 / that / group”等，会附带上一个对象图片作为参考。

---

## 3. 关键修复记录

### 3.1 78code 调用问题

用户提供 78code：

```text
base_url = https://www.78code.cc/v1
model = gpt-5.4-mini
```

`gpt-4o-mini` 在该站点不可用，返回“模型价格尚未配置”。

OpenAI SDK 会被该站点 WAF 拦截，所以改成了直接 HTTP 调用：

```text
/v1/chat/completions
```

核心文件：

```text
app/ai_client.py
```

为避免 `SSL: UNEXPECTED_EOF_WHILE_READING`：

- 发送前把截图压缩成 bounded JPEG data URL。
- 限制额外参考图数量。
- 对连接错误自动重试。
- 如果多图失败，降级为只发主截图 + 结构化上下文。

### 3.2 鼠标晃动误触

最初太迟钝，后来太敏感。现在改成固定手势：

```text
约 1 秒内左右摇三次
左 → 右 → 左 → 右
或
右 → 左 → 右 → 左
```

约束：

- 小距离可以。
- 但必须有 3 次明确方向反转。
- 普通上下移动不触发。
- 单向横向移动不触发。

测试：

```text
tests/gesture_test.py
```

### 3.3 THIS / THAT 指代反转

曾出现问题：第一次框选 Magic Pointer，第二次框选 Maestro，用户问“和上一个比”，模型把 this/that 反了。

原因：多图输入没有强标签。

已修：

```text
IMAGE A  = THIS = 当前对象
IMAGE A2 = THIS_OBJECT_MAP = 当前对象标注图
IMAGE B  = THAT = 上一个对象
IMAGE B2 = THAT_OBJECT_MAP = 上一个对象标注图
```

并加入强约束：

```text
THIS/current/这个 = 本次刚框选对象
THAT/previous/那个/上一个 = 上一次登记对象
Do not swap THIS and THAT.
```

比较任务现在默认只附带最近一个历史对象，不再塞多个历史图，避免模型混乱。

验证结果：

用户测试后模型正确识别：

```text
THIS / 这个：Maestro 文件夹内容
THAT / 上一个：Magic Pointer 文件夹内容
```

---

## 4. 当前重要文件

```text
README.md                  运行说明
AGI_DISTANCE.md            每阶段距离桌面 AGI 的差距记录
CHANGELOG.md               变更记录
HANDOFF.md                 本交接文档

app/main.py                主 UI、后台、框选、问答窗口、对象连续选择
app/ai_client.py           78code/OpenAI-compatible 调用、图片压缩、重试、图像标签
app/screen_context.py      屏幕对象上下文、窗口重叠、标注图
app/system_context.py      Windows API、鼠标、窗口枚举、Mica/Acrylic 尝试
app/object_store.py        对象注册、recent、this/that/group 上下文

tests/smoke_test.py        基础测试
tests/gesture_test.py      鼠标手势测试
tests/object_store_test.py 对象注册测试

MagicPointer.vbs           无终端后台启动
stop_magic_pointer.bat     停止后台
```

---

## 5. 运行方式

启动：

```text
双击 MagicPointer.vbs
```

停止：

```text
双击 stop_magic_pointer.bat
```

调试运行：

```powershell
python -m app.main
```

测试：

```powershell
python tests\smoke_test.py
python tests\gesture_test.py
python tests\object_store_test.py
```

---

## 6. 当前已知不足

### 产品层

- Tkinter UI 仍不够现代，最多是 MVP 级。
- 后续产品化建议迁移到：
  - `Tauri + React/Svelte + Rust`，或
  - Windows-only 走 `WinUI 3 / WPF + C#`。
- Tkinter 适合当前验证底盘，不适合作为最终产品 UI。

### 对象层

- `group` 现在只是最近对象集合，不能手动 pin / unpin / 删除。
- `destination` 还没实现，所以“放到那里”还不能做。
- 还没有对象面板。
- 还没有 DOM、UIA、OCR、Accessibility 控件树。

### 执行层

- 目前只问答，不写回。
- 还不能自动粘贴到输入框。
- 还不能执行日历、地图、打开网页等动作卡片。
- 没有执行后校验。

### 模型层

- 仍依赖 78code 网关稳定性。
- 比较任务虽然修了 this/that，但复杂 group 仍需要显式对象面板控制。
- 对“哪个更像完整软件项目”这种判断，后续应加 rubric，而不是让模型随意判断。

---

## 7. 下一阶段建议：MVP1-beta 对象面板

下一步不要急着做写回，建议先把对象层做扎实：

```text
MVP1-beta：对象面板与显式 group 管理
```

目标：

- 显示最近对象缩略图。
- 明确标出：
  - this
  - that
  - group
  - destination（预留）
- 支持：
  - pin / unpin
  - 删除对象
  - 清空 group
  - 将对象加入 group
  - 设置 destination
- 比较 this 和 that。
- 合并 group。

推荐第一切片：

```text
右侧/底部对象栏
显示最近 5 个对象缩略图
当前对象高亮为 THIS
上一个对象高亮为 THAT
用户可以点击 pin 到 group
```

这样后续“比较这些”“合并这些”“放到那里”就不靠隐式历史，而是可控对象集合。

---

## 8. 新对话承接提示词

新对话开始可以直接复制下面这段：

```text
我们继续做 D:\Desktop\Magic Pointer 这个项目。请先阅读 HANDOFF.md、AGI_DISTANCE.md、README.md，然后继续实现 MVP1-beta：对象面板与显式 group 管理。当前状态：MVP0 已完成，ScreenContext 底盘已完成，MVP1-alpha 对象注册已完成，this/that 反转已修复。下一步目标：在 UI 中显示最近对象缩略图，标注 THIS/THAT，支持 pin 到 group、清空 group，并让比较/合并任务基于显式 group，而不是隐式历史。请先检查代码和测试，再给出实现计划并开始修改。
```

---

## 9. 2026-07-06 ?????MVP1-beta ???????

????

- ?????????????
- ?????? `THIS`?
- ???? 5 ?????????
- ??????????? `THAT`?
- ??????? `pin / unpin` ??? `GROUP`?
- ?? `?? group`?
- ?? `pin THIS`??????????????????? `GROUP`?
- ?? group ??????`data/objects/object_state.json`?
- `group / merge / ?? / ??` ????????? pinned group??????????? group?
- `compare / ?? / ??? / that` ??????? `THAT`???? IMAGE A/IMAGE B ?????? this/that ???
- `ObjectStore` ?? group ?? API?`pin_object`?`unpin_object`?`clear_group`?`group_ids`?`group_objects`?`build_explicit_group_context`?
- `tests/object_store_test.py` ????? group?
- README / AGI_DISTANCE / CHANGELOG ??????

???

```powershell
python tests\smoke_test.py          # smoke test ok
python tests\gesture_test.py        # gesture smoke ok
python tests\object_store_test.py   # object store test ok
```

?????

- `python -m py_compile ...` ???????? `__pycache__` ??? `[WinError 5] ????`??????? pyc ? `compile()` ??????????`syntax compile ok`?
- ????????? Git ??????? git diff/status?

??????

1. ???? `python -m app.main --no-shake`?????????????????????pin/unpin??? group ????
2. ?? UI ????????????????????????????????
3. ?? destination????????? `Set destination`????????? `DESTINATION`?
4. ? `group` ?????????? prompt rubric??????????

---

## 10. 2026-07-06 update: MVP1-beta switched to hidden task context

Product correction: the previous always-visible historical thumbnail panel plus manual pin group felt too heavy and confusing. It has been replaced by a lightweight current-task context layer.

Implemented:

- Historical screenshots are still saved as object logs, but they do not enter AI context by default.
- Added `app/task_context.py`.
- Current task state is stored at `data/objects/task_state.json`.
- `THIS` = current selected object.
- `THAT` = previous object in the current task, not global history.
- `GROUP` = current task objects + THIS, not all recent history.
- After 30 minutes of inactivity, a new task starts automatically.
- UI now shows only a lightweight context bar by default: task object count, THIS, THAT.
- Users can click `??` to inspect current task objects; thumbnails are hidden by default.
- Users can click `???` to cut context explicitly.
- Users can click `????` to restore the previous task explicitly.
- Model reference images now come only from the current task: compare uses THAT, group/merge uses current task objects.
- `ObjectStore` is back to being a durable log only; it no longer owns active group state.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py          # smoke test ok
python tests\gesture_test.py        # gesture smoke ok
python tests\object_store_test.py   # object store test ok
python tests\task_context_test.py   # task context test ok
```

Next recommended steps:

1. Manually run `python -m app.main --no-shake` and verify the lightweight context bar, expand drawer, new task, and restore previous task.
2. Implement `destination`, but keep it hidden/default-light unless the user says something like "put it there".
3. If long tasks such as paper editing become important, add a task browser/history UI later. For now, keep task context mostly invisible.

---

## 11. 2026-07-06 UX fix: no-terminal launch and larger home panel

User feedback: visible debug launch via terminal is unacceptable, and the home window was too small/clipped.

Fixed:

- Home/control window changed from fixed `420x170` to resizable `560x300` with min size `520x260`.
- `APP_TITLE` shortened to `Magic Pointer Open`.
- Home panel now has clearer MVP1-beta copy.
- Added `?????` button.
- Added `MagicPointerPanel.vbs`: double-click opens the visible panel with no terminal. It first runs `stop_magic_pointer.ps1` to stop an existing single-instance background process, then launches `pythonw -m app.main`.

User-facing launch model:

- Double-click `MagicPointer.vbs` for hidden background mode.
- Double-click `MagicPointerPanel.vbs` for visible control panel.
- Double-click `stop_magic_pointer.bat` to stop.
- Do not ask the user to manually run `python -m app.main` unless explicitly doing developer debugging.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py # smoke test ok
```

---

## 12. 2026-07-06 launcher fix: PATH-independent VBS

User reported double-clicking `MagicPointer.vbs` no longer woke screenshot. Investigation found no running Python process. `pythonw` is not on PATH for Windows Script Host; the installed Python is at `C:\Users\zjz65\scoop\apps\python\current\pythonw.exe`.

Fixed:

- `MagicPointer.vbs` and `MagicPointerPanel.vbs` now call the Scoop `pythonw.exe` path first.
- They still fall back to common local Python paths and finally `pythonw.exe`.
- VBS writes launch attempts to `data/runtime/launcher.log`.
- `app/main.py` writes fatal GUI startup errors to `data/runtime/app_error.log` before re-raising.

Note:

- In the sandbox, launching Tk through Scoop Python may report a Tcl/Tk lookup issue; this may be sandbox-specific. If the user's direct double-click still fails, inspect `data/runtime/app_error.log`.

---

## 13. 2026-07-06 UI encoding and size fix

User reported the control panel was still too small and Chinese text displayed as `????`.

Fixed:

- Home/control panel size increased to `760x460`, min size `700x420`.
- Home/control panel Chinese strings are now written as Python Unicode escape literals in `app/main.py`, avoiding accidental corruption by PowerShell/VBS encoding paths.
- Buttons restored: `????`, `?????`, `??????`, `??`.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py          # smoke test ok
python tests\gesture_test.py        # gesture smoke ok
python tests\object_store_test.py   # object store test ok
python tests\task_context_test.py   # task context test ok
```

---

## 14. 2026-07-06 MVP1-gamma: task-scoped destination

Implemented the next MVP slice: lightweight `DESTINATION` inside the current task context.

Code changes:

- `app/task_context.py`
  - Added `destination_id` to task state.
  - Added `add_object()`, `set_destination()`, `clear_destination()`, and `destination_object()`.
  - `build_reference_context()` now includes `destination: ...` and an alias definition for destination.
- `app/main.py`
  - Prompt window action row now has `?????` and `?????`.
  - Context bar now shows `DEST=...`.
  - Expanded context drawer marks destination objects with `DEST`.
  - Destination-like prompts attach `IMAGE D / DESTINATION` only when relevant.
  - Current selection can be saved as a destination without calling AI.
- `tests/task_context_test.py`
  - Added destination state tests.
  - Added direct task object registration test.

Semantics:

- `THIS` = current selection.
- `THAT` = previous object in the current task.
- `GROUP` = current task objects + THIS.
- `DESTINATION` = explicit destination object in the current task.
- Global object history remains log-only.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py          # smoke test ok
python tests\object_store_test.py   # object store test ok
python tests	ask_context_test.py   # task context test ok
```

Next recommended MVP:

- MVP2-alpha: first safe write-back primitive, probably clipboard/paste-only with explicit confirmation, using DESTINATION as target context but not yet fully automating arbitrary apps.

---

## 15. 2026-07-06 MVP1-delta: command bar instead of chat window

User pointed out the product was drifting into a screenshot AI chat window, unlike Google/DeepMind Magic Pointer demos that emphasize pointer motion, terse intent, and action cards.

Implemented:

- `app/main.py` `show_prompt_window()` was replaced with a compact command bar.
- After selection, a small window opens near the selected region, not a large central chat UI.
- Includes a small thumbnail, hidden task context summary, one-line command input, and short result card.
- Quick actions:
  - `??`
  - `??`
  - `?????`
  - `?????`
  - `??`
  - `??`
  - `????`
- `??` opens a larger on-demand view with image preview and full result.
- Existing task context and destination logic are preserved.
- Model prompt now asks for concise action-card style output first.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py          # smoke test ok
python tests\gesture_test.py        # gesture smoke ok
python tests\object_store_test.py   # object store test ok
python tests	ask_context_test.py   # task context test ok
```

Next recommended MVP:

- MVP1-epsilon: voice/press-to-talk or low-friction command capture, plus proactive suggestions. Avoid returning to a default chat window.

---

## 16. 2026-07-06 MVP1-epsilon: voice entry and suggestions

Implemented a conservative low-risk voice/suggestion slice without changing the core capture/task pipeline.

Code changes:

- `app/system_context.py`
  - Added `trigger_windows_dictation()` which sends Win+H to open Windows dictation for the focused field.
- `app/main.py`
  - Command bar width increased to 760.
  - Added `??` button next to the one-line command input.
  - Added context-aware default command suggestions:
    - first object: `????`
    - has THAT: `????????`
    - has DESTINATION: prepare content for `??`
  - Added `???` quick action.

Safety/UX notes:

- No new dependency was added.
- If Windows dictation fails or is disabled, normal typing and quick actions still work.
- This keeps the product pointer-native and avoids returning to a large default chat window.

Verification:

```powershell
syntax compile ok
python tests\smoke_test.py          # smoke test ok
python tests\gesture_test.py        # gesture smoke ok
python tests\object_store_test.py   # object store test ok
python tests	ask_context_test.py   # task context test ok
```

Next recommended MVP:

- MVP2-alpha: safe write-back primitive, likely clipboard-first / confirmation-first. Do not auto-control arbitrary apps yet.

