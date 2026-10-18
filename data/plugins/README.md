# Magic Pointer 用户插件

插件运行于 Magic Pointer 自己的 TypeScript/Node Runtime。目录默认是用户数据目录下的 `data/plugins/`，可用 `MAGIC_POINTER_PLUGIN_DIR` 指定。TypeScript 插件需先编译为 JavaScript。

每个插件一个子目录，包含 `plugin.json` 和代码文件。`plugin.json` 示例：

```json
{"name":"example", "description":"示例工具", "main":"plugin.cjs"}
```

`main` 缺省为 `plugin.js`，也支持 `.mjs`。可选 `name` 与代码导出的名称一致，供界面在不执行代码时识别行级配置；不填写仍可加载。CommonJS 导出对象或 ESM 默认导出对象：

```javascript
module.exports = {
  name: 'example',
  scopes: ['agent'],
  inject: ['tools'],
  defaults: { greeting: 'Hello' },
  config_schema: {
    type: 'object',
    properties: { greeting: { type: 'string' } },
    required: ['greeting']
  },
  apply(ctx, config) {
    ctx.get('tools').register({
      name: 'Example',
      description: 'Return the configured greeting.',
      input_schema: { type: 'object', properties: {}, required: [] },
      effect: 'read',
      execute: () => config.greeting
    });
  }
};
```

`inject` 中的服务都存在后才调用 `apply`。常用服务为 `tools`、`hooks`、`prompt`、`session`、`runtime`、`llm`、`model_client`、`perception`、`vision`；感知域提供 `surface_adapters`。`perception` 是主任务的感知后端，提供 `read_around(anchor, radius, signal)`、`dump_subtree(anchor, depth, signal)`、`find_in_window(pattern, signal)`、`list_windows(signal)`、`get_focused(signal)`，返回感知证据。`vision(images, prompt, signal)` 使用当前所选模型分析图像，`images` 中可带 `dataUrl` 或 `path`。默认运行域为 `agent`，依赖 `surface_adapters` 时默认推断为 `surface`。需要两个域时显式声明 `scopes: ['agent', 'surface']`，依赖应符合各域实际提供的服务。

通过 `tools.register`、`hooks.add`、`prompt.add`、`surface_adapters.register` 注册的内容随插件卸载撤回。其他资源用 `ctx.effect(() => close())` 清理。卸载会等待已进入的工具、hook、提示词渲染、感知解析、事件监听及会话结束回调，之后才释放资源；回调不能卸载自身所在的 scope。依赖缺失为 `waiting`；撤销依赖会卸载消费者，重新提供后再激活。配置或执行失败记录在该行。

提示词扩展通过 `ctx.get('prompt').add({ id: 'guidance', order: 100, render: options => '项目提示词' })` 注册。提示词按会话冻结，插件修改在新会话生效。

## 配置组合

默认配置位于用户数据目录的 `data/harness.patch.json`，可用 `MAGIC_POINTER_HARNESS_CONFIG` 改路径。内置行和目录自动产生的 `user:<name>` 行均接受补丁：

```json
{
  "schemaVersion": 1,
  "patch": {
    "user:example": {"config": {"greeting": "你好"}},
    "web-tools": {"disabled": true}
  }
}
```

支持 `disabled`、`plugin`、`config`；有 `plugin` 的新 id 会插入新行。`config` 替换该行配置，再与插件 `defaults` 合并，并按可选 `config_schema` 校验。

界面启停使用同一配置文件中的 `disabledPluginDirectories` 数组，值为插件子目录名。禁用目录在导入代码前跳过，下一次主任务、子任务或感知任务启动时生效，进行中的任务保持原模块实例。启用具备 `name` 元数据的插件会同时解除对应 `user:<name>` 行的禁用，保留其他配置。缺少名称且存在无法对应的用户行禁用时，界面要求先补全名称，不虚报启用成功。

主任务内置行：`harness-tools`、`coding-tools`、`memory-tools`、`context-tools`、`skill-writer`、`web-tools`、`desktop-action-tools`、`local-action-tools`、`perception-provider`、`vision-provider`、`perception-tools`、`look-tool`、`mcp-provider`、`system-prompt`、`delegate-tool`、`llm-provider`、`model-client`。`perception-tools` 消费 `perception` 服务，`look-tool` 消费 `vision` 服务；可以单独禁用 `look-tool`，保留其余感知工具。编码、技能写入和子任务需要绑定工作区。`mcp-provider.config.config_path` 可覆盖 MCP 文件，默认使用 `MAGIC_POINTER_MCP_CONFIG` 或用户数据目录的 `data/mcp.json`。

感知域内置行：`surface-figma`、`surface-wechat`、`surface-dingtalk`。每次冻结帧感知使用独立注册表，并在感知结束时卸载插件。像素冻结先于这些扩展执行。

## 替换模型

禁用 `llm-provider`，由插件 `await ctx.provideUp('llm', modelRunner)` 提供模型函数。`modelRunner(request)` 接收 `system`、`messages`、`tools`、`signal`、`config`、`maxTokens`、`onEvent`，返回 `{ text, tool_calls, usage?, stop_reason?, usedBackend? }`。工具调用为 `{ id, name, arguments }`。

默认 `model-client` 依赖此服务，主任务与独立子任务均消费它。子任务在自己的进程重新加载插件，并继续受只读模式和继承权限限制；不要依赖主进程临时变量传递子任务状态。

## 替换感知或视觉后端

在 `harness.patch.json` 中禁用对应默认提供行，再由用户插件调用 `await ctx.provideUp('perception', backend)` 或 `await ctx.provideUp('vision', vision)`。只替换一个后端时，只需禁用它的提供行。例如同时替换：

```json
{"schemaVersion":1,"patch":{"perception-provider":{"disabled":true},"vision-provider":{"disabled":true}}}
```

`perception` 的五个方法返回 `{ value, status, confidence, source }` 感知证据；`vision` 返回 `{ text, usedBackend }`。`look-tool` 仍负责冻结帧裁切、调用次数和截图上传许可。

## 检视

主任务 `/help` 返回实际插件行、状态、配置、依赖和加载警告。普通任务结果的 `pluginReport` 同样携带诊断信息。应用插件页通过 `extensions.inventory` 只读检查入口文件、配置禁用项和 MCP 配置；`configured` 仅表示已配置，不代表运行时已激活。`extensions.set-enabled` 接收目录 `id` 与布尔 `enabled`，保存成功返回 `appliesTo: next_task`；配置损坏或保存失败不会返回成功。

插件与本机用户同权限，请只安装可信代码。旧 Python `plugin.py` 需要改写为上述 JS/TS 插件；运行时不再启动 Python。

## 模块命令、面板与请求上下文

插件可声明 `inject: ['modules', 'session']`，在 `apply` 中调用 `ctx.get('modules').register(definition)`。定义使用 `electron/runtime/runtime_modules.ts` 的 `RuntimeModule`：稳定的 kebab-case `id`、标题、可选 commands/panels/requestContext。注册返回可等待的卸载函数；整个插件卸载时，同样撤回该模块的命令、面板与回调，并等待在途操作结束。

- `commands` 每项包含 id、label 和 `tool`。省略 ToolSpec.name 时，例如模块 `release-note` 的命令 `read` 进入真实注册表为 `Modules.release_note.read`；已有一方能力可提供完整 ToolSpec 保留原名。模型按现有 Tools 发现机制加载。输入 schema、effect、access_for、权限、pre/post hook、操作账本及验证都沿用普通 Agent 工具链。可选 `present(value)` 只将真实命令结果投影为界面 `{text,panelId}`，不改变工具返回、权限或日志，也不向模型伪造第二份结果。
- `panels` 每项包含 id、`render()` 和 `actions` 映射。render 只返回 `module_contract.ts` 中的结构化标题、状态、分节、行与按钮；不会给渲染器注入 HTML/JavaScript。actions 把按钮 id 绑定到本模块的 commandId 和固定参数，界面只能提交已展示的三项身份，不能构造任意工具调用。目录类面板可在 render 时根据真实当前条目更新 actions；调用前先重新 render，再验证该按钮仍存在并可用。
- 界面直接调用只接受 `read` 命令，并重新检查原权限、来源访问和当前按钮状态。写操作必须进入普通 Agent 回合及其权限流程。命令的真实返回、后端和耗时写入会话事件；失败不伪装成功。
- `requestContext({sessionId,turn,signal})` 返回当前请求需要的文本证据。每个普通 Agent 模型请求前重新调用，按 `origin:data` 追加，不改变模型参数、权限、工具集合或用户原指令；完整文本存入 `module/request_context`，与实际请求投影和 token 估算一致。压缩后仍重新投影，不把旧模块证据变成持久用户指令。一个回调失败只记录该模块错误，其他模块仍可工作；恢复成功会清除保存的错误状态。

内置 `task-context-module` 使用同一机制提供 Task context 面板及 `Modules.task_context.inspect`：直接读取当前 EventSession 的来源、活动引用、计划和未核对结果，不打开其他会话或原始文件。其 `refresh`、`summary` 按钮调用真正的读命令。主进程 `modules.list` 与 `modules.invoke` 从当前会话身份打开该工作区，后台子任务也注册同一模块服务。

已有 `dashboard-tools` 已迁为一方 `dashboards` 模块，由同一插件 scope 拥有原六个 `Dashboard.list/inspect_source/create/open/update/trace` 工具；原名字、数据存储、来源授权、修改 revision 与查询快照语义保持。Dashboards 面板读取真实保存目录，Query/Refresh values 才按当前会话来源范围重查文件；最近查询的值、公式和来源行数从当前会话中的实际命令结果恢复，列表刷新不会静默替换已显示的查询。Inspect 显示当前文件的物理行号与列值，并单独注明预览读取时间，不能当成较早图表快照的溯源。精确 `Dashboard.trace` 继续在当前 Agent 的原查询快照中工作；界面不伪造跨 worker 的 trace。禁用或卸载 `dashboard-tools` 同时撤回该模块与六个工具，不另存一份面板数据库。

界面查询会重新加载模块，因此面板与请求回调的跨任务状态应来自现有 EventSession 或插件自己的明确存储，不能依赖前一 worker 的临时变量。MP 当前并不实现 Claude Mods 的接口兼容、任意界面替换或独立远端模块市场。
