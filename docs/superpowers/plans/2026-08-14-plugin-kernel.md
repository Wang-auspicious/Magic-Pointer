# 插件内核批(DSh 架构移植)实施计划 — 2026-08-14

> 依据:`docs/2026-08-14-plugin-architecture-review.md`(金标准 DSH 对照审查,问题 P1–P8)。
> 原则:测试先行;每项先有红测试;行为保持(回归钉死);坏插件单行隔离;不复制 DSH 代码。

## 1. 目标

把 MP 从"六套手接线扩展系统 + `_loop_router` 巨函数组合根"迁移到 DSH 风格的
**一切皆插件**:一个 `app/harness` 内核(Context 服务仓库 / inject 依赖激活 /
可逆 effect / 四模式事件 / scope / 分层组合),MP 全部内置能力重写为插件组,
`_loop_router` 瘦身为"boot + 从 ctx 取服务 + 跑 loop"。

## 2. 任务(顺序执行,每项测试先行)

### T1. Context 内核(`app/harness/context.py`)

- `Context.provide(key, service)` / `get` / `has` / `keys`;重复 provide 报错。
- `inject(names, callback)`:全部依赖就位才激活;已就位立即激活;卸载时激活过的
  callback 必须回卷(与 effect 同栈)。
- `effect(disposer)`:返回 `Disposable`;`unload()` LIFO 回卷;回卷异常不打断其余。
- 事件:`declare(kind, mode)` 注册事件模式;`emit/waterfall/parallel/serial` 派发;
  模式不符抛错(事件契约的一部分);waterfall 可短路(不调 next);parallel 用线程池。
- `on(kind, fn, prepend=False)` 返回 disposer,卸载移除。
- `scope()`:子上下文继承父服务(读时上溯),自身注册/事件隔离,子卸载不回卷父。
- 服务就位通知:provide 后立刻激活等它的 inject 回调。

测试:`tests/harness_context_test.py`(红→绿,覆盖上列语义 + 卸载顺序 + 短路 + 模式错配)。

### T2. 插件协议与发现(`app/harness/plugin.py`)

- `Plugin` 协议:`name: str`、`inject: tuple[str, ...]`、`apply(ctx, config)`;
  config 用最小 JSON Schema 子集校验(复用 `tool_registry._matches_json_schema_type`
  的语义,抽到 harness 内独立实现,不引入依赖)。
- 目录发现:`<dir>/<name>/plugin.py`(代码)+ `plugin.json`(name/inject/config_schema/
  default_config/描述)或纯 Python 模块;坏插件(import/apply 异常、schema 错)记
  warning 单行跳过,内核照常启动。
- 加载:`load_plugin_dir(ctx, path, *, patches)` 按声明依赖经 ctx.inject 挂载。

测试:`tests/harness_plugin_test.py`(好/坏/依赖序/缺依赖警告/config 校验)。

### T3. 分层组合(`app/harness/composition.py`)

- 行结构:`{id, plugin, config, disabled}`;`boot(bundle_rows, plugin_dir, patch)`
  执行顺序:bundle 行 → 用户插件目录行 → patch(按 id 替换整行 config / 插新行 /
  disabled 开关)。
- `dump_config()`:返回(或打印)组合后真实启动树(JSON),含每行最终 config 与状态。
- 缺插件名 → 报错;坏行 → warning + 跳过(该行状态 `error`)。
- 旧 env 开关兼容:`MAGIC_POINTER_*` 读为 patch 输入,优先级低于显式 patch。

测试:`tests/harness_composition_test.py`(层序/按 id 替换/坏行隔离/dump 内容)。

### T4. builtin bundle 迁移(`app/harness/builtin_bundle.py` + selection_bridge 瘦身)

把 `_loop_router` 的注册点一一改写为插件 `apply(ctx, config)`:

| 现 `_register_*`/内联块 | 新插件 |
|---|---|
| `_BridgePerceptionBackend` + `PerceptionTools.register_all` | `perception-tools`(provides `ctx.perception` + 注册感知工具) |
| `_register_look_tool`(内联 `_VisionBackend`) | `look-tool`(VisionBackend 从 `ctx.vision` seam 取,默认 provider 保留现行为) |
| `_register_local_action_tools` | `local-action-tools` |
| `_register_harness_tools`(ask_user/todo) | `harness-tools` |
| `register_capability_tools` / `register_find_capability` + propose/execute_plan | `capability-tools` |
| guard_probe + precondition_factory + anchor | `guard`(provides `ctx.guards`) |
| 流式/非流式客户端 + compactor + token_estimator | `model-client`(provides `ctx.model`) |
| system_prompt 五节 | `system-prompt`(五节改为插件注册进 `ctx.prompt`) |
| 权限模式/permission_mode | `policy`(从 config 行读) |
| hooks 管理器 | `hooks`(provides `ctx.hooks`,loop 从 ctx 取) |

- `ctx.tools` 由 harness 内核提供(`ToolRegistry` 原样作服务)。
- `_loop_router` 变为:`boot_default_context(runtime_inputs) -> ctx`,然后
  `run_agent_turn(registry=ctx.get("tools"), hooks=ctx.get("hooks"), ...)`。
- 行为保持钉死:现有 `tests/selection_bridge_test.py`、`tests/harness_wiring_test.py`
  等全部继续绿;新增"注册结果等价"测试:老路径注册清单 == 新路径注册清单
  (工具名/effect/concurrency/数量逐项比对)。

### T5. 外部插件目录 + 配置层接入

- `data/plugins/` 为默认用户插件目录(`MAGIC_POINTER_USER_DATA_DIR` 下);
  `MAGIC_POINTER_PLUGIN_DIR` 可覆盖。
- env 开关(`INLOOP_REVERSIBLE/PERMISSION_MODE/STREAMING/CONTEXT_TOKENS`)映射为
  patch 行,旧 env 继续生效(读值语义不变)。
- 新调试入口 `scripts/harness_dump_config.py`:打印真实启动树(对标
  `dsh --dump-config`)。

### T6. 文档与账本

- 设计文档 §4/§11 增补插件内核架构;§18 进度账本新批次条目。
- STATUS.md 一句话 + 新能力行;交付 sync(version bump + `npm run sync`)。

## 3. 验收门槛

1. `tests/harness_*.py` 全绿(新内核语义钉死)。
2. 全量 Python(现有 ~935 项+新增)/ Node 127 / typecheck / lint 全绿。
3. 注册等价性:新 boot 路径产物与旧 `_loop_router` 逐项一致。
4. 坏插件目录注入:内核启动 + 单行 warning + 其余插件照常(真机级自动化冒烟)。
5. `scripts/harness_dump_config.py` 输出完整且可读。

## 4. 不做(明确边界)

- P8 会话事件日志单一事实源(Phase E/H);WGC;账本数据回路;SurfaceAdapter 深度
  seam 化(只做 perception seam 第一枚);不复制 DSH 代码(Reuse Gate 结论 3)。
