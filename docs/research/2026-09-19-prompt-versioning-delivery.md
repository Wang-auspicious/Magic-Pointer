# 系统提示词身份与会话冻结交付记录

本批只改变提示词的标识和选择方式，不修改任何提示词文案。保留接手时已有的感知、Runtime、Studio 等未提交改动。开发树版本仍为 **1.0.49**，按用户要求不执行 `npm run sync`、不制作安装器、不更新安装版。

## 实现

- `app/agent_runtime/system_prompt.py`：`build()` 返回不可变 `BuiltSystemPrompt(text, sections)`。每个非空段只渲染一次，保持原来的标题、去空白、段序及双换行拼接；账目为有序 `(section_id, sha256)`，哈希覆盖实际发送的完整段（含标题）。
- `app/agent_runtime/session.py`：沿用 `hashlib.sha256(_canonical_bytes(...)).hexdigest()`；`model/request.data` 的 `messagesHash` 旁新增 `systemPromptHash` 和 `systemPromptSections`。整篇哈希由实际 header 文本计算，不因传入哈希不一致拒绝请求。没有系统提示词或没有分段账目时相应字段为 `null`。
- 会话首次选择在同一 EventSession 追加一次 `prompt/frozen`，不是新增存储体系。它先于模型客户端创建和首个请求落盘；之后客户端、请求 header、token 估算共用选定文本。loop 内各轮不再参与提示词选择。
- 恢复时渲染当前候选用于比较；存在差异则追加 `prompt/drift`，记录 `savedHash`、`currentHash`、`changedSections`、`currentSections`，同时输出明确日志：`Using the saved system prompt; start a new session to use the current render.` 执行继续使用旧快照，哈希不作拒绝执行的门槛。
- 已有旧日志没有冻结事件时，沿用**最近一次实际 model/request** 中的 prompt 全文；没有记录的分段账目保持 `null`，不从当前模板反推。历史会话连 prompt 全文都没有时才冻结当前渲染结果；两种缺失均通过 `prompt/missing` 与日志明确报告。
- `app/harness/builtin_bundle.py`、`scripts/conversation_bridge.py`、`scripts/selection_bridge.py`：在创建 provider client 前使用确定的 durable session ID 选择快照，覆盖普通对话、冷启动选择桥及常驻宿主。现有后续 session 打开/修复逻辑保留。

冻结包含动态段：日期、记忆、技能、权限说明等也是这次保存的模型输入。恢复后的当前候选差异会被报告；当前工具权限等确定性约束继续由既有 Runtime 执行。没有引入模板引擎、assets、feature flag、迁移框架或提示词模式。

## 核心失败与通过见证

新增 `tests/prompt_snapshot_test.py` 共 7 项，真实调用 assembler、builtin bundle、EventSession 和 Runtime loop，仅将网络模型传输替换为确定性 backend。它检验 backend 实际收到的文本，不仅比较日志字段。

实现前运行 `python -m pytest tests/prompt_snapshot_test.py -q --tb=short`：

```text
test_resume_after_prompt_edit_uses_old_snapshot[cold]
E   AssertionError: assert '# Identity\n... saved prompt' == '# Identity\n...em\nold rules'
E     - old rules
E     + new rules that must not replace the saved prompt

test_resume_after_prompt_edit_uses_old_snapshot[resident]
E   AssertionError: assert '# Identity\n... saved prompt' == '# Identity\n...em\nold rules'
E     - old rules
E     + new rules that must not replace the saved prompt

7 failed in 7.23s
```

实现后相同命令：

```text
.......                                                                  [100%]
7 passed in 3.86s
```

完整输出保存在 `data/runtime/prompt-snapshot-red-20260919.log` 和 `data/runtime/prompt-snapshot-green-20260919.log`。另外三个既有测试文件只将 `build()` 的文本读取改为 `.text`，保留原语义断言：`harness_builtin_bundle_test.py`、`harness_completion_test.py`、`harness_extensions_test.py`。

## 检查结果

`python -m pytest tests/ -q`：**2310 passed / 1 failed / 1 个既有 Pillow warning / 359.63s**。唯一失败是用户提前指定的 `tests/selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`；未改动该测试或相关感知实现。按允许的例外，本批没有引入新的套件失败。

TypeScript 全配置检查通过；Node **232 个测试文件通过**。Ruff 对五个生产修改文件及新增测试的诊断由 176 条变为 175 条，只减少 `system_prompt.py` 的既有未使用 `re` 导入；无新增告警。修改文件的 `git diff --check` 通过。

日志：`data/runtime/prompt-snapshot-full-20260919.log`、`prompt-snapshot-node-20260919.log`、`prompt-snapshot-typecheck-20260919.log`、`prompt-snapshot-ruff-before-20260919.log`、`prompt-snapshot-ruff-after-20260919.log`。

## 实际落盘请求

以下为完整套件中恢复测试第三次请求的真实字段摘录；原始 JSONL 已复制到 `data/runtime/prompt-snapshot-witness-20260919.jsonl`。文本为测试专用段，网络传输由 fixture backend 代替，header 的 builtin `usedBackend` 标签不构成真实供应商调用证据。

```json
{
  "type": "model/request",
  "sessionId": "prompt-resume",
  "seq": 24,
  "data": {
    "turn": 3,
    "step": 1,
    "messageCount": 5,
    "messagesHash": "11ea76d3ca738d3053a96991906a15e7d0344071544ba424f2990806c920d54a",
    "systemPromptHash": "f5a59e9d4a81be7bfbedc4b997af6e45e0cac7ee1c506eb236f9663cb075eca5",
    "systemPromptSections": [
      ["identity", "790dc8221349737d5038136acd16aca41c2bc3ce7a5edfc9f130a93023c3560d"],
      ["rules", "113f6506cb848ae0343c5995ca08771dd5c624f61ee18f2f20f1c6acc0409b64"]
    ]
  }
}
```

同一日志的 `prompt/drift` 记录 `changedSections=["rules"]`；`savedHash` 为上述 `f5a59e…`，`currentHash` 为 `62ca1936705afaf934b3514b1b19206ef9aa6596642f68f76a511c8eddefea71`。恢复请求的实际 header 全文仍为 `# Identity\nstable\n\n# System\nold rules`。

本批没有访问真实模型供应商或启动 Electron 做真机验收；测试验证的是实际 Runtime 调用路径中的快照选择、持久化与恢复语义，不声称真实应用或供应商验收。
