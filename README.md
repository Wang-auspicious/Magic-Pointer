# Magic Pointer Open MVP

开源版全局 AI 指针助手。当前版本是 **MVP0 / v0.0.1**，目标不是一次性做完整桌面 AGI，而是先跑通最小闭环：

```text
Ctrl + Alt + M 全局唤起
  -> 鼠标框选屏幕区域
  -> 保存截图为对象
  -> 输入短指令，例如“解释这个”
  -> 调用多模态模型
  -> 悬浮窗显示结果
  -> 写入本地对象日志
```

## 当前功能

- 全局热键：`Ctrl + Alt + M`
- 任意屏幕区域框选截图
- 截图预览和指令输入
- OpenAI 多模态模型调用
- 无 API Key 时仍可测试截图、UI 和对象登记流程
- 本地对象日志：`data/objects/objects.jsonl`
- 本地截图：`data/captures/`

## 运行方式

### 1. 直接运行

```powershell
python -m app.main
```

或双击：

```text
run.bat
```

### 2. 配置 AI 模型

PowerShell 示例：

```powershell
$env:OPENAI_API_KEY="你的 OpenAI API Key"
$env:MAGIC_POINTER_MODEL="gpt-4o-mini"
python -m app.main
```

如果不设置 `OPENAI_API_KEY`，程序会返回本地提示，不会真正调用模型。

## 使用方法

1. 启动程序。
2. 按 `Ctrl + Alt + M`，或点击“开始框选”。
3. 拖拽鼠标选择屏幕区域。
4. 在弹窗中输入短指令，例如：
   - 解释这个
   - 总结这段
   - 这个图表说明什么
   - 这段代码哪里有问题
5. 点击“发送给 AI”。
6. 结果显示后可复制。

## 隐私说明

- MVP0 只会读取你主动框选的屏幕区域。
- 截图默认保存在本机 `data/captures/`。
- 设置 API Key 后，截图会被发送给配置的多模态模型服务。
- 不要把 `data/captures/` 和 `data/objects/` 中的私人内容提交到公开仓库。

## 当前架构

```text
app/main.py             Tkinter 桌面 UI、热键轮询、框选截图、结果窗
app/ai_client.py        多模态模型调用；无 key 时 fallback
app/object_store.py     对象日志，当前记录 screen_region 对象
app/system_context.py   Windows 热键状态、DPI、前台窗口标题、虚拟屏幕尺寸
```

## MVP0 的边界

当前还不是完整 Magic Pointer：

- 不能自动识别 DOM 元素。
- 不能写回 Word、浏览器输入框或聊天窗口。
- 不能稳定处理“这个/那个/这些/那里”的多对象指代。
- 不能执行日历、地图、商品比较等动作卡片。
- 不能做完整跨应用任务规划和执行校验。

这些差距会记录在 `AGI_DISTANCE.md`，每一版迭代后更新。


## ?? txt ????

??????????????????????? `secrets/openai_key.txt`?`secrets/openai_base_url.txt`?`secrets/model.txt`?`secrets/` ?? `.gitignore` ????? 78code ?????base_url `https://www.78code.cc/v1`?model `gpt-5.4-mini`?

## ??????? / ??????

?????????????

```text
?? MagicPointer.vbs
```

??? `pythonw` ????????????????????????

- `Ctrl + Alt + M`
- ????????

??????????????????? `MagicPointer.vbs` ????????????

???????????????

```text
run_background_debug.bat
```

??????????????????

```powershell
python -m app.main --background --no-shake
```

????????? `stop_magic_pointer.bat`?

## MVP1-beta task context

The prompt window now uses a lightweight current-task context instead of showing historical thumbnails by default:

- Full screenshot/object history is still saved locally as a log.
- AI context is scoped to the current task/session, not global history.
- `THIS` = the current selection.
- `THAT` = the previous object in the current task.
- `GROUP` = current task objects plus `THIS`, not all recent history.
- After 30 minutes of inactivity, a new task starts automatically.
- The previous task can be restored explicitly from the context bar.
- The context drawer is hidden by default and can be expanded only when needed.

Task state is stored locally at `data/objects/task_state.json`.

## No-terminal launchers

Use the `.vbs` launchers for normal use; terminal commands are only for development.

- `MagicPointer.vbs`: start hidden in the background.
- `MagicPointerPanel.vbs`: stop any existing Magic Pointer process, then open the visible control panel without a terminal.
- `stop_magic_pointer.bat`: stop the background process.

The visible panel has a `?????` button; after hiding, hotkey and mouse-shake triggers continue to work.

## MVP1-gamma destination

The current task context now supports a lightweight `DESTINATION` alias:

- In the prompt window, click `?????` to mark the current selection as the destination.
- Click `?????` to remove it from the current task.
- The context bar shows `DEST=...` when a destination exists.
- Prompts such as `????`, `????`, `target`, or `there` resolve to the explicit destination in the current task.
- Destination is task-scoped; old task history is not used unless the user restores that task.

This is still a context/understanding layer only. The app does not yet write back into the destination automatically.

## MVP1-delta command bar

After selecting a screen region, Magic Pointer now opens a compact command bar near the selection instead of a large AI chat window.

Default flow:

```text
point/select -> small command bar -> short action card -> optional details
```

Quick actions:

- `??`: explain the current selection.
- `??`: compare THIS with THAT in the current task.
- `?????`: mark the current selection as DESTINATION.
- `?????`: clear DESTINATION.
- `??`: run the typed short command.
- `??`: open a larger detail view only when needed.
- `????`: select another object in the same task.

This moves the product away from a screenshot-chatbot UI and closer to a pointer-native interaction model.

## MVP1-epsilon voice and suggestions

The command bar now includes a low-friction voice entry path:

- Click `??` to focus the command input and open Windows dictation (`Win + H`).
- Speak a short command, then press Enter or click `??`.
- No new microphone or speech-recognition dependency is required.
- If Windows dictation is unavailable, typed commands and quick actions still work.

The command bar also suggests a default command based on current task context:

- No previous object: `????`.
- Previous object exists: `????????`.
- Destination exists: prepare content that can be placed there.

A `???` quick action was added for destination-oriented tasks.

