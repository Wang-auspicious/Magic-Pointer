# Magic Pointer 插件架构审查:对照 DSH(deepseek-harness)金标准

> 日期:2026-08-14
> 金标准源码:`C:\Users\zjz65\Documents\Default Project\deepseek-harness`(本地 clone,HEAD 47f9438)
> 金标准核心文档:`docs/architecture.md`、`docs/cordis-primer.md`、`docs/capability-seams.md`
> 结论落地:实施计划 `docs/superpowers/plans/2026-08-14-plugin-kernel.md`

> **重建更正（同日）**：首批实现只做到了接口外形，没有真正满足 DSH 生命周期语义：
> inject 不会在依赖恢复后重新激活，父 scope 不会级联卸载，工具/提示词/hook/adapter 注册
> 也不会随插件精确回卷。当前开发树已修正这些问题，并新增 `ctx.llm`、SurfaceAdapter seam、
> 用户 patch 文件、动态启动状态和 agent/surface 运行域。P8 事件溯源仍未完成，不能把本审查
> 当作最终交付证明。

## 一、DSH 的"一切皆插件"到底指什么

DSH 在 vendored Cordis 上把产品全部拆成插件。五个核心思想:

1. **插件即 Service 对象**。`export const name/inject/Config` + `apply(ctx, config)`。
   模型适配器、工具注册表、会话日志、agent loop 本身都是插件,任何一部分都能从
   配置里被替换。没有"特权内核"可以打补丁。
2. **上下文是服务仓库**。服务抢占稳定键位 `ctx.<key>`(如 `ctx.tools`、`ctx.llm`、
   `ctx.sessions`);插件按 key 找服务,从不 import 具体实现。加载顺序由服务依赖
   (`inject: ['tools']`)表达,而不是手工启动顺序。
3. **类型化事件是扩展点**。`emit/waterfall/parallel/serial` 四种派发模式是事件公开
   契约的一部分。策略插件监听 `agent/pre-step`、`tools/pre-execute`、`approval/request`
   等瀑布事件来拦截决策;能力事件(`fs/*`、`telemetry/*`)让适配器挂接而不 import loop。
4. **注册是可逆 effect**。`ctx.effect()` / `ctx.on()` 安装的提示节、工具 schema、适配器、
   监听器在插件卸载时按 LIFO 回卷。坏插件只影响自己那一行。
5. **分层组合**。bundle 行 → profile patch → home patch → `--patch` 覆盖;任何一行都能
   按 id 被 patch 替换;`--dump-config` 打印真实启动树。

外加一条纪律:**"model-visible means logged"** —— 任何进入模型请求的内容必须能从会话
事件日志重建,运行时 invariant 断言它。

Seam 三角(Service Definition / Provider / Consumer)是它可替换性的来源:`ctx.fs`、
`ctx.shell`、`ctx.llm`、`ctx.subagents` 每个 seam 背后都有 local/sandbox/e2b 等并行
Provider,换 Provider 只动配置不动消费方。

## 二、MP 现状对照:八个设计问题

### P1. 六套并行的手接线扩展系统,没有统一插件模型

| 子系统 | 注册入口 | 生命周期 |
|---|---|---|
| 工具 | `app/agent_runtime/tool_registry.py` `GLOBAL_REGISTRY` + 每次请求新建的局部实例 | 追加式 dict,不可卸载 |
| SurfaceAdapter | `app/surface_adapter/registry.py` 进程级单例,builtin 硬编码 import | 追加式 list,异常静默吞 |
| Recipe 插件 | `data/recipes/plugins/*.recipes.json` 数据清单 | 只数据,无代码挂载 |
| Hooks | `app/agent_runtime/hooks.py` `HookManager` | 请求级构造,不可卸载 |
| 系统提示词节 | `app/agent_runtime/system_prompt.py` `default_builder()` 硬编码五节 | 不可扩展 |
| 能力工具 | `app/fabric/capability_tools.py` 从 recipe 清单生成 | 与上面四套无关联 |

加一个能力要同时摸四五个注册表 + 改 `_loop_router`。DSH 只有一个 `ctx.tools`。

### P2. 组合根是手工接线巨函数

`scripts/selection_bridge.py::_loop_router`(~300 行)手工构造 registry、PerceptionTools、
LookTool、本地动作工具、harness 工具、能力工具、守卫探针、前置条件工厂、压缩器、
token 估计器、流式后端、系统提示词……每个新插件 = 新 `_register_*` + 改调用点。
DSH 里加工具 = 挂一个插件行,不改任何已有文件。

### P3. 没有依赖序、没有可逆注册、没有卸载/重载

MP 的注册全是"启动期一次性 append",没有 `inject` 语义(服务依赖驱动的激活顺序),
没有 disposer,没有 unload/reload。坏插件要么整体失败要么被静默跳过,无法隔离到一个
可诊断的"行"。Recipe loader 对坏 manifest 的宽容是好的,但工具/适配器注册是代码级
硬失败,两种哲学并存。

### P4. 没有分层配置组合与可检视的启动树

DSH: bundle 行 → patch 层 → `--dump-config` 看真实树,任何行可按 id patch。
MP: `MAGIC_POINTER_*` 环境变量 + 散落 settings JSON + Python 代码硬编码注册混在一起;
没有 dump、没有按 id patch、没有可检视的组合结果。settings 深合并(评审 Q6)修的是
settings 文档的合并,不是启动树的组合。

### P5. 事件语义三套并存,没有统一派发模式契约

- loop 内部 yield 事件流(`LoopStart/TurnStarted/...`),消费者只能被动收;
- `app/events/subscription.py` 是窗口变更事件的节流订阅,与 loop 无关;
- `hooks.py` 是 CC 风格 hook 列表。
守卫、权限门、预算续期全是 loop.py 里的硬编码分支,而不是事件监听器。DSH 把
`tools/pre-execute`、`agent/pre-step`、`approval/request` 做成带派发模式的公开事件,
策略插件监听即可介入。

### P6. Seam 三角缺失,Provider 不可配置替换

`_register_look_tool` 内联构造 `_VisionBackend`;模型客户端在 `_loop_router` 里按
环境变量 if/else;感知后端 `_BridgePerceptionBackend` 内联。换 Provider = 改组合根
代码。DSH 的 `ctx.llm`/`ctx.fs`/`ctx.shell` 是 Service Definition + Provider 注册 +
Consumer,替换只在配置层。

### P7. 注册表按功能重复造轮子

`ToolRegistry`、`SurfaceAdapterRegistry`、recipe 清单、能力工具生成器四套"注册"语义
互相平行,能力工具→工具注册表只是半个桥。DSH 只有一套 `ctx.tools`(模型可见注册表)
+ 各 capability 自己的 provider 注册表,但后者统一挂在 ctx 服务上。

### P8. 没有"模型可见即可重建"的单一事实源纪律

(Phase E/H 级问题,本次只记录不实施。)MP 的 loop 状态、事件流、ledger、observability
是四个平行记录;DSH 的 session event log 是唯一事实源,UI/回放/持久化全部从它投影。

## 三、目标架构(MP 版插件内核)

Python 语言版 Cordis 核心思想,规模适配 MP(单进程 + 短任务,不引入 npm/TS 依赖):

```text
app/harness/
  context.py      Context:provide/get/inject/effect/on/emit|waterfall|parallel|serial/scope
  plugin.py       Plugin 协议(name/inject/apply(ctx, config)) + 目录发现 + 坏插件隔离
  composition.py  分层组合:builtin bundle 行 → data/plugins 用户插件 → patch 覆盖 + dump_config
  builtin_bundle.py  (迁移产物)MP 全部内置能力 = 插件组,不再手接线
```

内核语义(与 DSH 对齐):

1. `ctx.provide(key, service)` 抢占服务键位;`ctx.inject(names, cb)` 声明依赖,全部
   就位时激活(激活顺序由依赖表达,不是调用顺序)。
2. `ctx.effect(disposer)` 返回撤销句柄,`ctx.unload()` LIFO 回卷;`ctx.on(event, fn)`
   是 effect 的封装。
3. 四种派发模式是事件契约的一部分:emit(观察)、waterfall(可短路决策)、
   parallel(并行扇出)、serial(有序归并)。
4. `ctx.scope()` 派生 per-agent 子上下文:继承服务、隔离注册、随 agent 结束回卷。
5. 组合层:bundle 行(id + plugin + config)→ 用户插件目录 → patch(按 id 替换整行
   config / 插入新行);`dump_config()` 打印真实启动树;坏插件单行隔离并报告。
6. 迁移后 `_loop_router` 瘦身为:`boot(ctx, overrides)` → 从 ctx 取 tools/hooks/
   prompt/perception/guard → `run_agent_turn`。现有行为(注册的工具集、权限门、
   流式、压缩、guard 工厂)一一保留,环境变量开关映射为配置行覆盖,旧 env 继续生效。

Seam 三角第一枚落地:`ctx.perception`(感知 Provider 注册表:Service Definition =
EvidenceProvider 协议;Providers = UIA/OCR/视觉/SurfaceAdapter;Consumer = loop 的
perception tools),后续 `ctx.llm`/`ctx.fs`/`ctx.actions` 同法推进。

## 四、实施边界(本次批)

- 内核三模块 + 测试先行;
- builtin bundle 迁移 `_loop_router` 全部注册点,行为保持(回归钉死);
- `data/plugins/` 外部插件目录(代码挂载 + 坏插件隔离);
- `MAGIC_POINTER_PLUGIN_DIR` 覆盖;env 开关经 patch 层映射,旧值语义不变;
- 不做:P8 会话事件日志单一事实源(Phase E/H)、WGC、账本数据回路。

## 五、Reuse Gate 结论

- DSH 源码(MIT):只提取架构思想与契约形态,**不复制任何代码**(语言不同且本项目
  遵守"不得直接复制受限制代码"的既有纪律,这里虽无许可证障碍,仍只学思想)。
- Cordis 五思想 → 重写为 Python 实现(结论 3:只提取应用知识,重写实现)。
- MP 现有 `ToolRegistry`/`HookManager`/`SystemPromptBuilder`/`PerceptionTools`:
  重构后复用(结论 2),作为 ctx 服务保留全部现有验证语义。
