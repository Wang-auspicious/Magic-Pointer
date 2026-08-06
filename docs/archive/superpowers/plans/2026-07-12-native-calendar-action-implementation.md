# Native Calendar Action Implementation Plan

1. RED：为 `CalendarEventStore` 写创建、幂等、时间校验、冲突、回读、精确撤销、损坏状态与并发测试。
2. GREEN：实现版本化本地 CalendarProvider，复用原子写、文件锁和 fail-closed 规则。
3. RED：为 `calendar_event_create`、`calendar_event_undo_create`、固定目标 URI、中风险确认与 bridge 写测试。
4. GREEN：接入 `SafeActionExecutor`、`LocalPermissionPolicy` 和 `scripts/calendar_bridge.py`。
5. RED：为严格日历意图和确定性活动文本解析器写中英文 fixture；缺字段只能生成草稿。
6. GREEN：selection bridge 返回 `calendar_event_draft`，Electron 只打开 Dashboard 卡片，不自动创建。
7. RED/GREEN：增加 Dashboard 日历导航、表单验证、冲突确认、事件分组、高亮和 receipt 撤销。
8. 验证：Python/Node 全量、中文端到端、实际 Electron 热键注册与 Dashboard 打开；更新进度总账并白名单提交。
