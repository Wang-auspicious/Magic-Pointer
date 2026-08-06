# Magic Pointer Observer-first 多视角评审与验证

日期：2026-07-10

## 1. 本轮不可违背的约束

- 不删除项目中的任何文件、素材、克隆项目或历史记录。
- 最近一次产品纠偏优先于更早的实现设想。
- 主模式不是蓝框截图聊天，而是：

```text
真实鼠标继续正常操作
  -> 用户在真实应用里点击、滚动、拖选
  -> Ctrl+Alt+M 打开局部命令面板
  -> 读取宿主应用的真实 selection
  -> 生成短结果或 typed action proposal
  -> 用户确认后写回
  -> 校验并支持只撤回 Magic Pointer 那一步
```

## 2. 已读取的最近对话结论

最近一次关键转折发生在 2026-07-09：

- 用户明确否定全屏 overlay 接管鼠标的方式。
- overlay 必须 click-through，只负责旁观和轻量反馈。
- Word、网页、PDF 等应用应继续使用原生选择、点击和滚动。
- 命令输入必须和真实应用 selection 绑定。
- 撤回不能依赖全局 Ctrl+Z，要恢复 Magic Pointer 自己修改的那一段。

本轮实现没有退回“坐标框选映射 Word Range”的旧方向。

## 3. 本地素材和参考项目结论

### Google / DeepMind 演示素材

已复核本地演示图片联系表、演示分析文档和视频分析产物。

演示真正值得保留的不是单一鼠标造型，而是：

- AI 反馈贴近对象，不把用户带进独立聊天应用。
- 动作入口短、局部、可继续原任务。
- 高亮和发光是短时反馈，不应持续抢注意力。
- 对象和动作的语义关系比截图框本身更重要。

### Microsoft UFO

已由独立架构 agent 阅读本地 `external/ufo-schannel`。

适合借鉴：

- 观测层和动作层分离。
- UIA + vision 混合 grounding 放在 adapter 内部。
- COM/API 能力用 typed wrapper 暴露。
- 动作前验证可见性、可交互性和路径安全。

不应照搬：

- 让模型直接选择宽泛的 click/type/drag 动作面。
- HostAgent/AppAgent 的完整自主 ReAct 外壳。
- Word 全文首个匹配或段落序号式选择。
- 没有本地精确撤回约束的破坏性 Office 动作。

## 4. 多 agent 共识

五个独立视角分别检查了人因体验、视觉语义、UFO 架构、代码风险和测试矩阵。

共识：

- observer-first 是正确主线。
- overlay 不得阻断真实鼠标。
- 大面板、常驻说明条和持续强发光会破坏任务连续性。
- 真实 selection 必须优先于截图/OCR。
- typed proposal、显式确认和本地校验应继续保留。
- 原“全文 Find 第一处后恢复”的撤回逻辑风险过高。
- WPS、浏览器、PDF 和聊天软件不能假装已经具备 Word 级支持。

存在的分歧：

- 部分 agent 建议 `Ctrl+Alt+M` 只显示 observer，不自动打开面板。
- 本轮保留“用户完成真实选择后按 `Ctrl+Alt+M` 打开小面板”，因为这是最近一次对话明确采用的入口；但面板已缩小为局部工具，不再是主工作台。

## 5. 本轮发现并修复的问题

### 5.1 乱码和 Markdown 回归

- 修复 `selection_bridge.py`、`ai_client.py`、`panel.html` 中真实写入源码的 `????`。
- panel 恢复安全的 bold、list、inline code 渲染。
- HTML 仍先转义，不直接信任模型输出。

### 5.2 面板过大

- 从 `760x520` 改为初始 `420x160`。
- 结果出现后按内容自动增高，最高 360；更长内容在内部滚动。
- 去掉说明型副标题和大面积空白。
- 使用明确的关闭和执行图标。

### 5.3 双鼠标和常驻 observer

- click-through 模式不再覆盖一个完整自绘鼠标。
- observer 只绘制围绕真实系统鼠标的轻量光环。
- 启动、晃动和热键反馈均为短时显示。
- panel 关闭时 observer 一并隐藏。
- 光标跨显示器时 overlay 会跟随目标显示器重新定位。

### 5.4 误抓后台 Word

旧逻辑会跳过不支持的前台应用，然后读取后面的第一个 Office 窗口。

现在：

- 只检查最前台的非 Magic Pointer 窗口。
- 前台应用无 adapter 时明确返回“不支持真实选区读取”。
- 不把该屏幕内容发送给模型，也不修改任何内容。

### 5.5 WPS 被误识别为 Word

- WPS Writer 继续使用 `word` 语义能力，但 COM 改走 `KWPS.Application`。
- Microsoft Word 使用 `Word.Application`。
- WPS 折叠光标 `start == end` 时，即使 COM 返回一个字符，也按“没有真实文本选区”处理。
- WPS 本轮只做了实机只读探测，尚未对用户现有 WPS 文档执行写入测试。

### 5.6 精确恢复

当前恢复顺序：

1. 活动文档必须与历史记录一致。
2. 记录 range 内文本仍与 AI 写入结果一致时，直接恢复。
3. range 因用户在前文继续编辑而偏移时，用替换文本 + 左右上下文哈希共同定位。
4. 找不到唯一锚定位置或出现多个同样锚定位置时拒绝执行。
5. 成功恢复后清除历史中的完整 before/after 文本，只保留摘要、哈希和审计信息。

已删除的是错误行为，不是文件：不再对全文第一个文本匹配直接写回。

### 5.7 AI 网络客户端

- 本机 `NO_PROXY=::1` 会让 `httpx` 在创建客户端时抛 `InvalidURL`。
- 现在优先使用正常环境代理；仅当代理环境格式损坏时退回 `trust_env=False`。
- 文本和合成图片测试均已返回 HTTP 200。

### 5.8 测试入口

- 新增 `pytest.ini`，全量 pytest 不再导入即执行 `scripts/test_http_api.py`。
- 诊断脚本增加 main guard，并复用稳健的 HTTP client。
- 更新精确恢复测试，不再假设 Word native undo。

## 6. 验证证据

自动测试：

```text
python -m pytest -q
36 passed

npm test
overlay static test ok
panel static test ok
```

API：

```text
text HTTP 200 -> 连接成功
vision HTTP 200 -> Magic Pointer Test
```

真实 Microsoft Word 未保存沙盒文档：

```text
读取 selection: beta
替换: succeeded
直接恢复: recorded_range
最终正文: alpha beta gamma
```

位置偏移后恢复：

```text
用户在前文插入内容
恢复: anchored_text_match
最终正文: ZZ alpha beta gamma
```

歧义保护：

```text
构造两个替换文本和左右锚点都相同的位置
恢复: failed
文档保持不变
```

## 7. 当前真实完成度

已经形成可靠闭环：

- 真实鼠标不被阻断。
- Word 真实文本 selection 读取。
- 文本模型生成替换。
- typed proposal + provenance token。
- 明确 preview 和确认。
- 写前文档、range、hash 校验。
- 写后实际 range 校验。
- 延迟精确恢复和歧义拒绝。
- WPS 原生 selection 只读入口。

仍未完成：

- 浏览器 live DOM / selected text adapter。
- PDF 原生选择读取。
- 微信和普通输入框的安全 selection fallback。
- 默认语音输入。
- WPS 写回的隔离集成测试。
- 一等的 `NativeSelectionSnapshot/session token`。
- UIA/DOM/OCR 的统一对象能力层。
- 写入历史的用户可见隐私策略和保留期限设置。
- 多显示器混合 DPI 的真实双屏测试。

## 8. 下一阶段最小切片

建议按普通用户收益排序：

1. `NativeSelectionSnapshot`
   - 热键时固定前台窗口、文档、range、hash 和短 TTL token。
   - panel 提交命令时消费该 token，不再重新推断目标。

2. 通用文本 selection fallback
   - 先支持浏览器、PDF 和普通文本框。
   - 临时复制必须完整保留并恢复多格式剪贴板。
   - 无法证明恢复成功时不启用默认 fallback。

3. Browser adapter
   - 先读页面标题、URL、selected text。
   - 再做 DOM 元素和输入框 writeback。

4. WPS 隔离写回测试
   - 只在新建未保存文档中验证。
   - 通过后再在 UI 中将 WPS replace 标记为正式支持。

5. 语音
   - 复用同一个 selection session 和命令入口。
   - 不新建独立聊天流。

## 9. 产品决策

主体验保持：

```text
真实应用是主角
Magic Pointer 在旁边
真实选择优先
截图只是明确的低置信 fallback
写入必须确认
撤回必须宁可失败，也不能改错
```
