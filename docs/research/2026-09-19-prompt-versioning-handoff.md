# 交接：给系统提示词加「身份」和「冻结快照」

对象：接手这个任务的 AI。读这一份就够，不需要先去读别的文档。

参考实现已 clone 在 `D:\AI_Agents\minimax-code`（MiniMax Code CLI，v0.4.12，MIT）。下面所有路径，除注明外都相对该仓库根目录。

---

## 0. 先看现状，别重复造

**你想做的第一件事很可能是"把提示词拆成分层模板"——MP 已经做了，不要重做。**

`app/agent_runtime/system_prompt.py`（294 行）已经是 section assembler：

- `Section` / `PromptSection` + `SystemPromptBuilder.add/remove`，有 id、按注册顺序渲染
- `_sections` 里静态段在前、动态段在后（文件头注释说是 CC 的 `systemPromptSections` 模式），目的是**缓存稳定**
- `scope_for(context)` 给插件用，加进去的段会自动回退
- `default_sections()` 已有 11 个段：identity / voice / rules / permissions / coding / environment / memory / skills / language / pointing / effort

**"提示词内容有没有被存下来"这件事也已经做了**，两条链：

- `app/harness/builtin_bundle.py:617` 渲染出 `system_prompt`，`:630` 把它塞进 `model_request_header["systemPrompt"]`
- `app/agent_runtime/session.py:1095` 的 `record_model_request()` 把整个 `header` 原样写进 `model/request` 事件

所以**每一轮请求用的系统提示词全文，已经躺在会话日志里了**。不要去加"把 prompt 存起来"。

---

## 1. 真正缺的两件事

### 1.1 缺身份：说不清"这版是哪版"

`record_model_request()` 记了 `messageCount` 和 `messagesHash = sha256(messages)`（`session.py:1101`）——**消息有哈希，系统提示词没有**。请求里唯一没有身份的那部分，正好是决定行为的那部分。

而且 `SystemPromptBuilder.build()`（`system_prompt.py:72`）只返回拼接后的字符串，**丢掉了每个段的 id 和各自的内容**。后果：

- 两次运行结果不同，你只能看出"这一大坨变了"
- 不能回答"改的是 rules 段还是 environment 段"
- 不能回答"这两个会话是不是同一版提示词"

MiniMax 的做法可以照抄形状：`packages/local-runtime-v2/src/service/agent/domain/prompt-snapshot.ts`，全文 18 行，输出 `{ schema_version, mode, package_version?, template_sha256, system_prompt_sha256 }`。**两个哈希**：模板源文件的哈希（回答"代码是哪版"）和渲染成品的哈希（回答"实际发出去的是哪份"）。

### 1.2 缺冻结：恢复会话时静默换了提示词

`builtin_bundle.py:617` 每次跑都 `fork.get("prompt").build(context)` 重新渲染。会话恢复、进程重启、或者中间改了一行提示词，**同一个会话的下一轮会拿到新提示词，没有任何信号**。跑出来的结果和上一轮不是同一套输入，但日志上看不出来。

MiniMax 把这个钉死了：`packages/local-runtime-v2/src/service/agent/application/agent-profile.ts:194-201` 的 `assertFrozenPromptSelection()` —— 会话里存的快照 mode 和本次请求的 mode 不一致就报错，错误原文是：

```
The saved Task Prompt does not match --prompt-mode. Start a new Session for this benchmark.
```

---

## 2. 做什么

按这个顺序，两步都有独立的可验证结果：

### 第一步：给提示词加身份（小，先做这个）

1. `SystemPromptBuilder.build()` 改成能同时返回**分段账目**：`[(section_id, sha256(section_text)), ...]` 加上拼好的全文。改动要小，不要改渲染逻辑本身。
2. `record_model_request()` 的 `model/request` 事件里，在 `messagesHash` 旁边加 `systemPromptHash`，以及分段账目。**跟着现有的写法走**（同一个 `hashlib.sha256` + `_canonical_bytes` 的用法），不要新造一套序列化。
3. 效果：拿两个会话的日志一 diff，能说出"rules 段哈希不同、其余相同"。

### 第二步：冻结

4. 会话建立起把渲染结果（全文 + 哈希 + 分段账目）作为这个会话的 prompt 存下来。
5. `loop.py` / `builtin_bundle.py` 每轮只读这份存的，**不再重新渲染**。
6. 恢复会话时如果当前模板渲染出来和存的不一样 → **明确说出来**（沿用 MiniMax 那种"要么用存的、要么报错"的立场），不要静默替换。

### 明确不做

- 不引入 Handlebars/Jinja2 之类的模板引擎。MP 的 section + context 结构已经够用，加模板引擎是换一种写法，不是解决问题。
- 不建 `assets/prompts/*.md` 目录。那是 MiniMax 的选择，MP 的段是 Python 函数，硬搬过去只会多一层。
- **不改任何提示词文案**。这一步只动"怎么标识和固定"，不动"写什么"。

---

## 3. 守住 AGENTS.md 的约束

- **只存不拒**：哈希的用途是"回答下次要不要重新渲染 / 能不能对上"，不是防御性校验和。除了第 6 条那个会让结果不同的场景，不要拿哈希去拒绝执行。
- 不要为"以后可能有的第三种 profile"预留扩展点。
- 不要加 feature flag / 迁移框架。老会话没有记录就是没有，如实标注，不要写兼容层。
- 该判断的地方判断，不要换成检查清单。

---

## 4. 验证要求

- `python -m pytest tests/ -q` 全绿。例外：当前工作树里
  `tests/selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`
  本来就红——它断言 OCR 有文字时要回退成整屏 capture rect，而未提交的
  `app/perception/pixel_ocr.py` 已经改成「无 rect 的 OCR 文本保留为未定位文本」并返回
  `limitations: ['ocr_geometry_unavailable']`（该字符串在文件里出现两次）。这是感知层在途改动
  和它自己的测试之间的不一致，**与本次任务无关，不要顺手去"修"它，也不要改它来让套件变绿**。
- 新增测试放 `tests/`，命名跟现有风格（`prompt_snapshot_test.py` 之类）。必须覆盖的核心行为：
  **改一次提示词内容，恢复旧会话，断言它用的仍是旧快照**——这条要有先失败后通过的见证。
- `python -m ruff check <你改的文件>` 不要新增告警（这几个文件本来各有一两条历史 `PLC0415`，保持原样即可）。
- 不要跑 `npm run sync`，不要 bump 版本。

---

## 5. 交付时说明白

- 哪些文件新增、哪些被改。
- 新事件字段长什么样——贴一段**真实**的 `model/request` JSON。
- 冻结那条测试的失败见证和通过输出，两段都留。
- 没做到的部分直说。
