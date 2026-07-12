# Magic Pointer 原生 Calendar 动作设计

日期：2026-07-12
状态：已批准的 Action-first 路线之 A2 实施规格

## 1. 用户结果

用户在网页、PDF 或文档中选中一段活动信息，例如“产品发布会 / 7 月 18 日 14:00—16:00 / 上海徐汇”，输入“添加到日历”。Magic Pointer 不回答如何手工创建日程，也不立刻向外部日历写入。它先把可靠选区转换成受约束的 `CalendarEventDraft`，打开原生 Dashboard 的日历动作卡，标出已识别字段、缺失字段、时区与潜在冲突。用户可以修正标题、日期、开始、结束和地点；只有点击“创建事件”才生成 typed proposal 并执行。本地 CalendarProvider 持久化事件、回读验证并返回 event ID 和 receipt。成功后事件出现在 Dashboard 日程列表并高亮；撤销只删除该 receipt 创建且之后未被编辑的事件。

首版明确是 Magic Pointer 本地日历沙盒，不声称已经同步 Outlook、Google Calendar 或 Windows 日历。Dashboard 必须写明“本地日历”。后续 connector 接入时仍复用同一 schema、preview、commit、verify、receipt、undo 契约；凭据和外部 event ID 由 provider 自己管理，renderer 不直接拥有写权限。

## 2. 数据模型

`CalendarEventDraft` 包含 `title`、`date`、`start_time`、`end_time`、`timezone`、`location`、`notes`、`all_day`、`source` 和每字段置信度。草稿允许缺字段，用于渲染和修正，但不能被执行器直接持久化。第一版只支持单次事件，不实现 recurrence。解析器仅接受明确模式：ISO 日期、`YYYY年M月D日`、当前年内的 `M月D日`；时间接受 24 小时 `HH:mm`、中文“上午/下午/晚上 H 点”及明确时间范围。相对词“明天/下周五”暂不自动提交，解析为需要用户确认或留空。若没有日期或标题，Dashboard 保持创建按钮禁用并把缺失字段放在最前。

可执行 `CalendarEvent` 使用带时区偏移的 `start_at`、`end_at`，同时保存 IANA `timezone`。默认时区由环境 `MAGIC_POINTER_TIMEZONE` 提供，未配置时使用 `Asia/Shanghai`。时间必须满足开始早于结束；普通事件最长 7 天；标题 1—160 字符；地点 0—240 字符；备注最多 4000 字符。跨午夜只有在结束日期被明确给出或用户在卡片中确认时允许。DST 歧义或不存在的本地时间不得猜测，首版非 Asia/Shanghai 时区若不能由标准库可靠验证就阻止创建并说明原因。

持久状态使用版本化 `calendar_events.json`，保存 revision、events 和 receipts。每个事件含 `id`、规范字段、`idempotency_key`、source、created_at、updated_at、removed_at、create_receipt_id。持久化沿用购物清单的原子替换与跨线程/跨进程锁策略，但锁文件独立。相同来源 snapshot、规范化事件字段和 action type 生成稳定幂等键；重复请求返回原事件且 `created=false`。

## 3. 冲突、确认和撤销

冲突按半开区间 `[start_at, end_at)` 判断：同一时区归一到 UTC 后，两个未移除事件有交集即为冲突；相邻结束/开始不冲突。草稿进入 Dashboard 时先 preview conflicts，用户编辑任意时间字段后重新 preview。默认有冲突时创建按钮文案改为“仍然创建”，第一次点击只展开冲突确认，不执行；第二次明确确认才把 `allow_conflict=true` 写入 proposal。无冲突也必须点击创建，因为日历创建属于中风险动作，不能像本地购物清单追加那样自动执行。

执行前再次读取事件库并重新检测冲突，不能信任 renderer 的 preview。typed action 为 `calendar_event_create`，目标固定 `magic-pointer://dashboard/calendar/local`，policy 要求 `confirmed=true`。执行后重新读取 event ID，逐字段核验并返回 receipt。撤销动作 `calendar_event_undo_create` 同时验证 event ID、create receipt ID、expected_updated_at；如果用户之后编辑过事件，拒绝自动撤销并显示冲突。第一版不提供通用删除按钮，避免把“撤销本次创建”偷换成任意删除。

## 4. Dashboard 体验

侧栏新增“日历”，购物清单保持可切换。日历页面顶部显示“本地日历”与未来 7 天事件数；主体左侧是事件草稿卡，右侧是按日期分组的近期日程。草稿卡字段由可信本地 HTML 组件渲染，不允许模型生成 HTML。开始/结束采用原生 date/time 控件，时区首版显示固定值；地点和备注是文本输入。来源摘要显示来自哪个 app/window，但正文不重复泄露。字段错误就地显示，创建按钮保持禁用或进入冲突确认态。

从选区触发时 Dashboard 使用 `showInactive()` 打开日历页并填入草稿，让用户决定是否离开原文；用户点击 Dashboard 后再编辑。成功后表单清空，新事件在右侧高亮 1.6 秒，并显示可撤销入口。`Ctrl+Alt+D` 打开 Dashboard 时保留最后选择的页面；Esc 只隐藏窗口，不丢弃尚未提交的草稿。页面刷新从持久 store 读取，不能只依赖前端内存。

## 5. 实施与验收顺序

第一切片实现纯 Python schema/store：正常创建、跨午夜校验、冲突、相邻非冲突、幂等、损坏 schema fail closed、回读和精确撤销，并加入并发写测试。第二切片接 typed action、permission policy 和 Calendar bridge。第三切片把日历导航、表单、事件列表、preview/commit/undo 接入 Dashboard。第四切片让 selection bridge 在严格“添加到日历”意图下产生本地草稿，主进程打开日历卡；不匹配的解释命令仍走原路径。

端到端 fixture 必须覆盖中文活动文本 → 草稿 → 用户确认 proposal → 持久事件 → Dashboard 回读 → receipt 撤销；另覆盖缺日期、结束早于开始、同一事件重放、重叠冲突、相邻事件、过期草稿、旧 expected_updated_at、损坏数据文件和两个进程并发创建。任何无法证明具体时间的输入只能打开待补草稿，不能生成假日程。
