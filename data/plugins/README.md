# Magic Pointer 用户插件

插件运行于 Magic Pointer 自己的 TypeScript/Node Runtime。目录默认是用户数据目录下的 `data/plugins/`，可用 `MAGIC_POINTER_PLUGIN_DIR` 指定。TypeScript 插件需先编译为 JavaScript。

每个插件一个子目录，包含 `plugin.json` 和代码文件。`plugin.json` 示例：

```json
{"description":"示例工具", "main":"plugin.cjs"}
```

`main` 缺省为 `plugin.js`，也支持 `.mjs`。CommonJS 导出对象或 ESM 默认导出对象：

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

通过 `tools.register`、`hooks.add`、`prompt.add`、`surface_adapters.register` 注册的内容随插件卸载撤回。其他资源用 `ctx.effect(() => close())` 清理。卸载会等待已进入的工具调用。依赖缺失为 `waiting`；撤销依赖会卸载消费者，重新提供后再激活。配置或执行失败记录在该行。

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

主任务 `/help` 返回实际插件行、状态、配置、依赖和加载警告。普通任务结果的 `pluginReport` 同样携带诊断信息。应用插件页通过 `extensions.inventory` 检查入口文件和 MCP 配置。

插件与本机用户同权限，请只安装可信代码。旧 Python `plugin.py` 需要改写为上述 JS/TS 插件；运行时不再启动 Python。
