# Magic Pointer 用户插件目录

> 插件内核批（2026-08-14）：Magic Pointer 向“一切皆插件”转型后的 out-of-tree 插件目录。
> 金标准参考：deepseek-harness（DSH）的 profile/bundle/patch 组合模型；
> 本机实现：`app/harness/`（context / plugin / composition / builtin_bundle）。

## 目录结构

每个插件是一个以插件名命名的子目录：

```text
data/plugins/
  my-plugin/
    plugin.py       # 必需：name / inject / 可选 config_schema、default_config / apply(ctx, config)
    plugin.json     # 可选：展示元数据（description 等）
```

`plugin.py` 最小示例：

```python
name = "my-plugin"
inject = ("tools",)
scopes = ("agent",)  # agent / surface；可同时声明多个

def apply(ctx, config):
    from app.agent_runtime.tool_registry import ToolSpec

    ctx.get("tools").register(ToolSpec(
        name="my_tool",
        description="我的工具的描述（模型按描述选择工具）。",
        input_schema={"type": "object", "properties": {}, "required": []},
        execute=lambda: "done",
    ))
```

- `inject` 声明依赖的 seam 服务键（`tools` / `hooks` / `prompt` / `llm` /
  `surface_adapters` / `perception` / `vision` / `guard_probe` /
  `selection_anchor` / `model_client` 等）；依赖满足后
  `apply` 自动激活，加载顺序由依赖表达。
- `tools.register(...)`、`prompt.add(...)`、`hooks.register_*()` 和
  `surface_adapters.register(...)` 会自动绑定当前插件 scope；插件卸载时精确回卷。
  其他外部资源（线程、文件监听、连接等）用 `ctx.effect(close)` 登记清理。
  坏插件只会让**自己那一行**
  报错（`scripts/harness_dump_config.py` 可见 warning），不会拖垮启动树。
- 依赖缺失的插件保持 `waiting`；依赖被撤销会卸载，重新提供后自动重载。
- 目录中的插件无需再手写 bundle 行，会自动挂为 `user:<插件名>`。
- `scopes` 声明插件运行域，避免一个无依赖插件在 agent 与感知前置阶段重复执行。
  默认是 `("agent",)`；依赖 `surface_adapters` 的旧插件会兼容推断为
  `("surface",)`。

## 运行时的组合层

启动顺序：builtin bundle 行（`app/harness/builtin_bundle.py`，按行序注册）
→ 本目录插件的 `user:<名称>` 行 → patch 层（按行 id 替换整行 config / 禁用 / 插入新行）。
旧 `MAGIC_POINTER_*` 环境变量开关继续生效（它们映射为行 config 的基值，
显式 patch 优先于环境变量）。

用户配置文件默认是 `data/harness.patch.json`（设置了
`MAGIC_POINTER_USER_DATA_DIR` 时位于该目录下的 `data/`；也可用
`MAGIC_POINTER_HARNESS_CONFIG` 指定）：

```json
{
  "schemaVersion": 1,
  "patch": {
    "user:my-plugin": {"config": {"mode": "fast"}},
    "local-action-tools": {"disabled": true}
  }
}
```

`ctx.llm` 是模型 Provider seam。禁用内置 `llm-provider` 行并安装一个提供
`llm` 服务的插件，即可替换为本地、网关或回放 Provider；agent loop 与工具
消费者无需修改。

## 检视

```bash
python scripts/harness_dump_config.py                      # 打印真实启动树
MAGIC_POINTER_PLUGIN_DIR=<别的目录> python scripts/harness_dump_config.py
```

注意：插件代码在 Magic Pointer 进程中执行，与本机用户同权限——只安装你信任的插件。
