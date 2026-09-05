# UFO² 逐模块拆解 与 Magic Pointer 对位（2026-09-02）

对照源码：`external/ufo`（微软 UFO 仓库当前 HEAD，根目录是 UFO³ Galaxy，UFO² 位于 `ufo/`）。
论文：UFO² arXiv:2504.14603，UFO³ arXiv:2511.11332。
方法：只读通读，所有结论带 `文件:行号`。未运行 UFO²，未跑任何评测。

---

## 0. 结论先行

1. UFO² 的"混合控件检测"不是把两路证据平等融合，而是**以 UIA 为主 ID 空间，视觉只补 UIA 漏掉的那些**，补进来的控件从 UIA 最大编号往后续号。
2. UFO² 真正的结构创新在**动作层**：GUI 动作和应用原生 API（COM）注册进**同一个命令表**，模型只看到命令名，不知道也不需要知道它落在点击还是 COM 调用上。
3. **MP 缺的正是第 2 条。** MP 的 COM 只用在感知（读选区），没有用在动作。`app/adapters/office_adapter.py` 实现的是 `AdapterReadContext`，只读不写。
4. MP 有 UFO² 完全没有的东西：ActionLease、effect sandwich、写后读回验证、FrameLease、证据八态。**UFO² 的 `undo()` 全仓库只有一个抽象声明，零个实现**（`ufo/automator/basic.py:88`，`grep -c "def undo"` = 1）。它没有撤销。
5. 因此"比 UFO² 更深"的路是清楚的：**把 MP 已有的确定性执行契约，套到一个 UFO² 式的 GUI/API 统一命令表上**，而不是再造一遍它的感知。

---

## 1. 感知层：UIA + 视觉的合并方式

### 1.1 UIA 侧

`ufo/automator/ui_control/inspector.py`

- `BackendFactory.create_backend(backend)` → `"uia"` 得 `UIABackendStrategy`，`"win32"` 得 `Win32BackendStrategy`（`inspector.py:38-48`）。
- 依赖栈：`pywinauto` + `uiautomation` + `comtypes.gen.UIAutomationClient`（`inspector.py:15-23`）。
- 抽象接口两件事：`get_desktop_windows(remove_empty)`、`find_control_elements_in_descendants(window, control_type_list, class_name_list, title_list, is_visible, is_enabled, depth)`（`inspector.py:56-90`）。

**对 MP 的意义**：UFO² 走 pywinauto 的高层封装。MP 的 `app/desktop_actions/uia.py` 直接 `CoCreateInstance(CUIAutomation)`（`uia.py:288-305`），比 UFO² 低一层。MP 那张实测表（记事本/Edge/Terminal 能读、微信 4.x 整树 8 节点读不到）UFO² 没有等价物——它假设 UIA 可用，不可用就交给视觉。

### 1.2 视觉侧

`ufo/automator/ui_control/grounding/omniparser.py`

- `OmniparserGrounding` 通过 HTTP 调一个 OmniParser 服务，参数 `box_threshold`、`iou_threshold=0.1`、`use_paddleocr`、`imgsz`（`omniparser.py:36-60`、`202-218`）。
- 服务端点从配置读：`ufo_config.system.omniparser.ENDPOINT`；没配端点就 `grounding_service=None`，退化成纯 UIA（`app_agent_processing_strategy.py:460-470`）。

### 1.3 合并——关键代码

`ufo/agents/processors/strategies/app_agent_processing_strategy.py`

```
:503  api_control_list       = await self._collect_uia_controls(...)
:519  grounding_control_list = await self._collect_grounding_controls(...)
:531  merged_control_list    = await self._collect_merged_control_list(api, grounding, ...)
:541  target_registry.register(merged_control_list)
:544  annotation_dict        = self._create_annotation_dict(merged_control_list)
```

`_collect_merged_control_list`（`:660-706`）内部：

```python
merged = self.photographer.merge_target_info_list(
    api_control_list, grounding_control_list,
    iou_overlap_threshold=ufo_config.system.iou_threshold_for_merge,
)
added = self._find_added_controls(api_control_list, merged)   # 在 merged 里、不在 api 里
max_id = max(int(c.id) for c in api_control_list if c.id.isdigit())
for idx, c in enumerate(added, start=1):
    c.id = str(max_id + idx)        # 视觉新增的控件从 UIA 最大号往后排
```

**三条可直接拿走的设计结论：**

1. **UIA 是主 ID 空间。** 视觉发现的控件是"增补"，编号排在 UIA 之后。模型看到的 Set-of-Marks 里，低号天然是结构化来源。
2. **合并判据是 IoU 阈值**（`iou_threshold_for_merge`），重叠即认为同一个控件，保留 UIA 那份。
3. **失败静默**：`_collect_merged_control_list` 整体裹在 `try/except`，异常时 `return []`（`:706-708`）——控件全丢，只打一条 warning。

第 3 条与 MP 的红线直接冲突（AGENT.md：「不假报成功。读不回来就说读不回来」）。**这是 MP 可以明确做得更对的一处，不是抄的地方。**

---

## 2. 动作层：GUI 与原生 API 的统一命令表（UFO² 的真正创新）

### 2.1 注册机制

`ufo/automator/basic.py`

```python
class ReceiverBasic(ABC):
    _command_registry: Dict[str, Type[CommandBasic]] = {}
    @classmethod
    def register(cls, command_class):          # :55-62 装饰器
        cls._command_registry[command_class.name()] = command_class
        return command_class

class CommandBasic(ABC):
    @abstractmethod
    def execute(self): ...                     # :79-84
    def undo(self): pass                       # :88  ← 全仓库唯一，零实现
```

`ufo/automator/puppeteer.py`

```python
class AppPuppeteer:
    def create_command(self, command_name, params, *a, **kw):   # :41-58
        receiver = self.receiver_manager.get_receiver_from_command_name(command_name)
        command  = receiver.command_registry.get(command_name.lower())
        return command(receiver, params, *a, **kw)
```

**模型只发一个命令名。** 由哪个 receiver 接、落到 pywinauto 点击还是 `win32com` COM 调用，是注册表决定的，不进提示词。

### 2.2 GUI 命令（20 个）

`ufo/automator/ui_control/controller.py`（1237 行），receiver 名 `UIControl`：

```
click_input  click_on_coordinates  drag_on_coordinates  summary  set_edit_text
texts        wheel_mouse_input     annotation           keyboard_input
click        double_click          drag                 keypress  move
scroll       type                  wait                 no_action
control_command  atomic_command
```

### 2.3 原生 API 命令（43 个）

`ufo/automator/app_apis/`，全部经 `WinCOMReceiverBasic`：`win32com.client.Dispatch(clsid)` + `get_object_from_process_name()`（`app_apis/basic.py:21-52`）。
工厂：`COMReceiverFactory(APIReceiverFactory)`，`is_api() → True`，用 `@ReceiverManager.register` 挂进同一个管理器（`app_apis/factory.py:20-50`）。

| 应用 | 命令 |
|---|---|
| Word | `insert_table select_text select_table select_paragraph save_as set_font` |
| Excel | `table2markdown insert_excel_table select_table_range get_range_values reorder_columns save_as` |
| Shell（1278 行） | `shell run_shell execute_command change_directory get_current_directory list_files create_directory remove_file copy_file move_file read_file write_file check_file_exists get_file_info find_files get_environment_variable set_environment_variable get_system_info` |
| Web | `navigate_to_url click_element type_text get_page_content get_page_title scroll_page wait_for_element take_screenshot execute_javascript get_element_text get_element_attribute web_crawler` |
| PowerPoint | `powerpoint/powerpointclient.py` |

**注意这批命令有多浅。** `set_font`、`insert_table`、`get_range_values` —— 是 Office COM 对象模型最表层的一圈包装。UFO² 证明了"原生 API 优先"这条路走得通，但**它自己并没有把这条路挖深**。

### 2.4 MCP

`ufo/client/mcp/local_servers/ui_mcp_server.py`（1005 行）、`http_servers/mobile_mcp_server.py`（1521 行）、`linux_mcp_server.py`。
方向是**UFO² 作为 server 把自己暴露出去**。

---

## 3. 与 Magic Pointer 逐项对位

| UFO² | MP 对应 | 判定 |
|---|---|---|
| `inspector.py` UIA 后端策略 | `app/desktop_actions/uia.py`（ctypes 直调 CUIAutomation）+ `app/adapters/uia_text_adapter.py` | MP **更底层**；且 MP 有 UFO² 没有的"哪些应用读不到"的实测表 |
| `grounding/omniparser.py` | `app/perception/pixel_ocr.py`、`app/vision/`、`external/omniparser` | 双方都有 |
| `_collect_merged_control_list` IoU 静默合并 | `app/perception/fusion.py`、`app/grounding/perception_cascade.py` | **机制不同**。MP 是"冲突显式呈现给模型，不静默择一"（README「感知」节）；UFO² 是阈值合并 + 异常吞掉返回 `[]` |
| 视觉控件从 UIA 最大号续号 | 无等价 | **可借鉴**：一个天然表达"这条来自结构化 / 这条来自像素"的编号约定 |
| `automator/basic.py` 命令注册表 | `app/agent_runtime/tool_registry.py` | 双方都有 |
| `controller.py` 20 个 GUI 命令 | Observe/Click/Type/Key/Scroll/SetValue/Act/Select/Drag/Wait | MP 有，且**每个都带 effect sandwich、ActionLease、写后读回验证**——UFO² 三样都没有 |
| **`app_apis/` COM 原生动作层（43 命令）** | **无** | **缺口** |
| **`COMReceiverFactory` GUI/API 同名空间** | **无** | **缺口** |
| MCP server | `app/agent_runtime/mcp_provider.py` 是 **client** | **方向相反** |
| `CommandBasic.undo()` | MP 有精确 undo receipt | **MP 完胜**：UFO² 零实现 |

### 3.1 MP 的 COM 只在感知侧，这是核心缺口

`grep -rln "win32com\|CoCreateInstance\|Dispatch(" app/ scripts/` 全仓库只命中两个文件：

- `app/desktop_actions/uia.py` —— `CoCreateInstance(CUIAutomation)`，是 UIA 的 COM 接口，不是应用原生 COM。
- `app/grounding/explorer_adapter.py` —— Explorer 读文件对象。

`app/adapters/office_adapter.py` 确实持有 `Word.Application` / `KWPS.Application` ProgID（`:21-23`），但它实现的是 `AppAdapter` + `AdapterReadContext`（`:1-11`），走 `scripts/office_selection_probe.vbs` **只读选区**。

**结论：MP 目前"用原生接口读"，但"用像素/UIA 写"。UFO² 是"用原生接口读，也用原生接口写"。**

---

## 4. 要比 UFO² 深，具体做什么

按"能不能被它抄回去"排序：

1. **建 MP 的 `app/app_apis/` 动作层，但接进 MP 已有的执行契约。**
   UFO² 的 COM 命令是裸调用：没有 lease、没有幂等键、没有 undo、没有读回验证。MP 把同一批 COM 命令挂到 ActionLease + effect sandwich + `verified=False` 不过成功门之下，得到的是**可撤销、可验证的原生动作**——这是 UFO² 结构上没有的东西，不是速度差距，是语义差距。

2. **挖深，而不是复制那 43 个。**
   UFO² 的 Word 命令只到 `set_font`。真正值钱的是 UFO² 没碰的：`Range.Find/Replace`、`Revisions`、`ContentControls`、Excel 的 `ListObjects`/`PivotTable`/`Range.Value2` 批量读写、Outlook 的 `MailItem`、以及 Windows 侧的 `IFileOperation`、`Shell.Application`、Task Scheduler、WinRT。这批是"结构化能做完、像素做不了或做很慢"的部分。

3. **把"来源"编进控件 ID。** 借 UFO² 的续号约定，但反过来用：MP 的原则是不静默择一，所以编号应当**同时暴露两路**并标注来源，让模型自己看见冲突。

4. **不要抄的两处**：`try/except → return []` 的静默吞控件；`undo()` 空实现。两条都直接违反 MP 的红线。

---

## 5. 诚实边界

- 本文只读源码，未运行 UFO²，未复现论文数字（WAA 27.9%、OSWorld-W 28.6%/32.7%、混合检测挽回 >25% 失败交互，均引自论文与官方文档，非本仓库实测）。
- `photographer.merge_target_info_list` 的 IoU 实现体在 `ufo/automator/ui_control/screenshot.py`（1492 行）内，本轮未逐行读，只确认了调用点与参数。
- MP 侧的"缺口"判定基于全仓库 grep 与 `office_adapter.py` 的类型签名；若存在未被 grep 命中的写路径，结论需修正。
