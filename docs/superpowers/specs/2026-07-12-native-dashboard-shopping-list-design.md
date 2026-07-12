# Magic Pointer 原生 Dashboard 与购物清单 Action 设计

日期：2026-07-12

状态：用户已确定原生 Magic Pointer Dashboard 作为不统一 Windows 动作的可信承载面，等待书面规格复核

## 1. 产品目标

首个 action-first 闭环复刻演示 7 的关键体验，而不是复刻其宿主环境：用户在 Edge/PDF/Word/WPS 等可靠来源中选中一条明确对象，输入 `Add this`、`添加这个` 或 `加入清单`，Magic Pointer 将该对象真实写入自己的原生购物清单 Dashboard。成功的证据是 Dashboard 中出现新条目并被短时高亮；Rail/A 只提供简短回执和撤销入口，不把动作降级为回答文本。

Google 可以把购物清单、画布、日历等动作统一承载在自有系统内；Windows 第三方软件能力、结构与权限不一致。本产品不通过通用鼠标键盘模拟伪造兼容性。可统一且高频的结构化动作优先落在 Magic Pointer 原生 Dashboard，由本地 schema、provider、executor、verify 和 receipt 保证一致性；外部应用写入仍通过单独白名单 adapter 实现。

## 2. 第一版用户流程

1. 用户在已支持应用中选中短文本，例如 `1 lb Spaghetti`。
2. 按 `Ctrl+Alt+M`，输入或选择 `Add this` / `添加这个`。
3. `selection_bridge.py` 在可靠 SelectionSnapshot 上识别严格的购物清单意图，不调用通用问答模型。
4. 系统产生 typed `shopping_list_add` proposal。因为目标是 Magic Pointer 自有数据、动作低风险、命令明确且可逆，命令本身视为授权，不追加第二次确认。
5. Action executor 使用幂等键写入本地 ShoppingListStore，立即回读并验证 item ID、规范化文本和状态。
6. Dashboard 在工作区右侧以非模态正常窗口显示或刷新，新条目淡入并短时高亮。
7. Rail/A 显示 `已加入购物清单` 和 `撤销`，随后自动退场；真实结果留在 Dashboard。
8. 用户可在 Dashboard 勾选/取消勾选条目、撤销刚才新增的条目、关闭 Dashboard，并使用 `Ctrl+Alt+D` 再次打开。

失败时不打开通用 Reader：选区不可靠、文本为空、文本过长、存储失败或写后验证不一致时，Rail/A 显示具体失败原因，不生成假条目，不显示成功勾号。

## 3. Dashboard 范围

Dashboard 是普通 Windows 产品窗口，不是临时 pointer surface：

- 默认 860×640 DIP，可调整大小，显示在任务栏，可最小化和关闭。
- 第一版只有“购物清单”主视图，但导航结构允许以后增加日历草稿、路线、最近动作和设置。
- 顶部显示 `Magic Pointer`、当前清单名称、未完成数量和关闭/最小化系统窗口行为。
- 主区按创建顺序显示条目；每条有 checkbox、文本、来源应用摘要、创建时间和仅针对该条目的撤销/移除入口。
- 新增成功通过 item ID 定位，淡入并高亮 1.2 秒；不是用 toast 假装写入。
- 空状态直接说明操作方式：`在任意受支持应用中选中一项，然后说“Add this”`。
- Dashboard 关闭不删除数据；再次打开必须看到相同清单。
- Dashboard 自身窗口不得被 SelectionSnapshot 当作外部来源；未来允许用户在 Dashboard 内选择条目形成 THIS 时，必须使用专用 Dashboard adapter，而不是误走通用 UIA。

本切片不实现多清单、账号同步、协作分享、拖拽排序、复杂分类和云端服务。

## 4. 数据模型

ShoppingListStore 保存版本化 JSON：

```json
{
  "version": 1,
  "list": {
    "id": "default-shopping-list",
    "name": "购物清单",
    "items": [
      {
        "id": "item-...",
        "text": "1 lb Spaghetti",
        "normalized_text": "1 lb spaghetti",
        "checked": false,
        "idempotency_key": "sha256:...",
        "source": {
          "selection_snapshot_id": "selection-...",
          "app": "pdf",
          "window_title": "Recipe.pdf - Microsoft Edge",
          "content_sha256": "..."
        },
        "created_at": "...",
        "updated_at": "...",
        "removed_at": null
      }
    ]
  }
}
```

默认路径来自 Electron `app.getPath('userData')`，通过 `MAGIC_POINTER_USER_DATA_DIR` 传给 Python bridge；不能把用户清单写进 Git 工作区。测试必须注入临时目录。存储采用同目录临时文件后原子替换，schema/version 不合法时 fail closed 并保留原文件，不静默重建覆盖。

文本规范化只做 Unicode trim、连续空白折叠和大小写 idempotency 比较，不擅自改写数量、单位或语言。第一版接受 1—160 个字符且最多两行；超过限制要求用户重新选择明确条目，不调用模型从长段落猜商品。

## 5. Typed Action 与安全策略

新增 action 类型：

- `shopping_list_add`：参数包含 `item_text`、`idempotency_key`、source receipt；SafetyLevel.LOW，只有严格内部目标 `magic-pointer://dashboard/shopping-list/default` 可免二次确认。
- `shopping_list_undo_add`：参数包含 `history_id` 和 `item_id`；只把对应 item 标记为 removed，不删除其他条目。
- `shopping_list_set_checked`：参数包含 `item_id`、`checked` 和期望 `updated_at`；Dashboard 用户点击即授权，写前检查版本，写后回读。

自动执行不是模型权限。只有本地 intent parser 识别明确 `Add this` 词组、SelectionSnapshot 可靠、proposal action type 在内部 allowlist、target URI 完全匹配、policy 判定无需确认时，main 才自动执行。模型返回同名 action 或任意外部 target 一律不能触发免确认。

幂等键由 list ID、snapshot ID、规范化文本和 intent 组成。同一请求重试只返回原有 item receipt，不产生重复条目。用户在不同 SelectionSnapshot 中再次明确添加相同文本时允许新增，因为这可能代表真实数量；后续数量合并属于独立功能。

## 6. 执行、验证、回执与撤销

`SafeActionExecutor` 调用 ShoppingListStore 后必须回读：

- item ID 存在；
- `removed_at` 为空；
- 文本和 hash 与 proposal 一致；
- idempotency key 唯一；
- store version 仍为 1。

只有上述条件全部满足才返回 `ExecutionStatus.SUCCEEDED`。输出包含 `receipt_id`、`item`、`list_id`、`verified=true` 和 typed undo proposal。`action_bridge.py` 将成功结果翻译为简短回执，并把 undo proposal继续注册为一次性 action token。

撤销通过 history/receipt 精确定位 item。若条目已被用户修改、已移除或版本发生冲突，撤销 fail closed，并保留用户当前状态。实现不物理删除历史记录；Dashboard 默认隐藏 `removed_at` 非空条目。

## 7. Electron 窗口与 IPC

新增独立 DashboardWindow 和 context-isolated renderer：

- `dashboard:open` / `dashboard:close` / `dashboard:refresh`
- `dashboard:list-request` → main 调用只读 shopping list bridge
- `dashboard:list-updated` → renderer 接收完整脱敏列表与 highlight item ID
- `dashboard:set-checked` → main 校验 item ID、布尔值和 expected version，再走 typed action executor
- `dashboard:undo-item` → main 使用 receipt/history 生成或取得 typed undo proposal

Renderer 没有 Node 文件权限，不能直接读写 JSON；所有 DOM 文本使用 `textContent`，不执行模型 HTML。Dashboard window 是正常可聚焦窗口；打开时可以 `showInactive()` 展示新增结果，用户点击后再获得焦点。`Ctrl+Alt+D` 只切换 Dashboard，不影响当前 SelectionSession。

## 8. 与现有结果表面的关系

购物清单 action 的主要结果是 Dashboard item，不是 A 卡正文。执行期间 Rail 依次显示：

```text
Add this → 正在加入购物清单… → ✓ 已加入 · 撤销
```

若 Dashboard 已打开，直接刷新并高亮；若未打开，新增成功后在右侧 `showInactive()`。A 结果表面只在需要展示错误、冲突或明确撤销入口时出现，不自动打开 B Reader。Dashboard 关闭后，最近动作仍可从 Rail receipt 或未来“最近动作”页撤销。

## 9. 测试与真实验收

### 自动测试

- intent parser 只接受明确添加词组，不把普通“解释这个”或模型文本当成 action。
- 空文本、161 字、三行文本被拒绝。
- add 写入并回读验证；相同幂等请求不重复。
- 相同文本、不同 snapshot 可以分别添加。
- check/uncheck 使用 expected version；冲突不覆盖。
- undo 只移除目标 item；修改后冲突不强制撤销。
- 损坏 JSON、未知 schema version、原子替换失败均 fail closed。
- Dashboard renderer 无 Node integration、无任意 HTML、具有 checkbox/空态/高亮/关闭与键盘路径。
- 自动执行严格检查内部 allowlist、target URI、policy 和本地 parser 标记。

### 真实桌面验收

1. Edge 食谱中选中 `1 lb Spaghetti`，输入 `Add this`；Dashboard 出现该条目并高亮，Rail 显示已加入。
2. 再次发送同一请求的重试 payload，不新增第二条。
3. 在新的选区会话再次明确添加相同文本，新增第二条。
4. Dashboard 勾选后重启 Magic Pointer，勾选状态仍在。
5. 点击撤销新增，只隐藏对应 item，其他项目不变。
6. 强制制造版本冲突，撤销失败并说明冲突，不损坏清单。
7. 不支持的 Obsidian PDF 仍在 action 生成前 fail closed，不允许把猜测文本加入清单。

## 10. 非目标与后续承接

- 不在本切片实现任意网页购物清单写入。
- 不使用剪贴板、Ctrl+V 或屏幕坐标点击冒充 action。
- 不用 LLM 从长段落自动猜商品。
- 不实现云同步、多清单或完整 Dashboard 设置页。
- 下一步复用 Dashboard provider/executor/receipt 结构实现 CalendarEventCard 和 RouteCard；之后再实现表格 merge 与 reservation sandbox。
