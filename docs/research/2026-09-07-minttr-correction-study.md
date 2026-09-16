# Minttr（Zayn Hao）准确核对记录

日期：2026-09-07  
用户提供原帖：[X / Zayn Hao / status 2072297263591051735](https://x.com/ZaynHao/status/2072297263591051735)  
官方产品：[minttr.com](https://www.minttr.com/)  
官方应用入口：[my.minttr.com](https://my.minttr.com/)

## 纠正

此前按项目名猜成了 `Pheem49/Mint`，那是另一个本地 AI assistant 项目，与用户给的 X 原帖不是同一个东西。本记录以用户提供的原帖、X 页面可见正文和 Minttr 官网为准。

## 原帖确认到的产品定位

X 原帖把 Minttr 定义为：

> 面向个人兴趣探索的卡片笔记应用，把笔记、链接、图片保存到同一个地方。

原帖明确提到的能力：

- 保存想法、链接、图片
- 特别适合保存 X 帖子和启发性网页
- 保存链接时同时保存“当下所想”的个人备注
- 图片自动进行 AI 化处理，支持语义搜索
- `Reflect`：对一条笔记提供不同视角／反思输入
- `AI Chat`：把多条笔记作为上下文进行对话
- 卡片视图优先展示原始个人备注

## 官网当前可见能力

官网将 Minttr 描述为“不是 productivity，也不是 knowledge management，而是为 curiosity 设计的 card-based notes app”。当前公开页面列出：

- frictionless idea capture：不要求先设计复杂结构，先把想法记下来
- inspiration library：保存 X、文章和其他网页中的启发
- Reflect：对单张卡片给出反思视角
- Chat：把多张卡片作为 AI 对话上下文
- semantic search：按意义而非只按关键词搜索
- inline `#tags`
- spaces
- Markdown
- keyboard shortcuts
- Markdown、JSON、CSV 导出
- 图片下载到本地文件夹
- Mobile / iOS TestFlight
- Browser Extension，可在 X feed 内保存帖子
- Mac app
- Web app

## 是否开源、能否 clone

截至这次核对，没有找到 Minttr 官方公开 GitHub 源码仓库。公开入口是产品站、Web app、Browser Extension、Mac app 和 iOS TestFlight，而不是 GitHub source repo。

因此：

- 可以访问和试用官方产品；
- 可以下载／安装官方客户端或扩展（具体下载动作需要用户自行决定并按安装确认规则执行）；
- 不能像 Pi 或 `Pheem49/Mint` 那样 clone 一份官方源码到 MP 项目下；
- Chrome Web Store 上能找到 Minttr 扩展，但扩展发布包不是等价的可研读源码仓库。

## 和 Magic Pointer 的相似点

它和 MP 的相似点不在 computer-use，而在“用户的瞬时想法 → 可持续的、有上下文的 Agent 处理”：

| Minttr | Magic Pointer 可对应的方向 |
|---|---|
| 一个想法一张 card | MP 的 DraftArtifact / durable evidence card |
| 保存链接同时保存当下备注 | MP 的 gesture evidence + user-authored context |
| X / 网页 / 图片随手捕获 | MP 的多表面输入、浏览器与桌面 capture |
| Reflect 对单卡给新视角 | MP Agent 对选中对象做 bounded reflection / plan |
| Chat 把多卡作为上下文 | MP 的 durable task context / memory retrieval |
| semantic search | MP 的 memory、knowledge、目标上下文检索 |
| Spaces / tags | MP 的 project、workspace、task scope |
| 原始备注优先 | MP 的用户编辑 DraftArtifact 优先于模型生成文本 |
| Markdown/JSON/CSV export | MP 的 artifact/export 和可移植数据边界 |

## 和 Magic Pointer 的不同点

Minttr 是“思考／记录产品”，不是 sovereign desktop Agent harness。它的核心闭环是：

```text
捕获想法或链接
  → 形成 card
  → 搜索／组织
  → Reflect 或 Chat
  → 把新的理解写回 card
```

Magic Pointer 的核心闭环是：

```text
gesture / task
  → frozen evidence + object graph + RunEnvelope
  → Agent Runtime
  → UI / Office / browser / bridge action
  → Lease + Effect + Receipt + readback
  → durable task / resume / takeover
```

Minttr 没有公开源码证据表明它提供：

- 任意 Windows 原生应用 UIA 控件树
- root/element state refs
- ActionLease / stale snapshot rejection
- 输入所有权锁
- Office/微信/钉钉动作回执
- 多小时任务 Runtime、steer、interrupt、takeover
- MP 级别的 full-surface historical evidence contract

## 对 MP 最有价值的借鉴

Minttr 真正值得吸收的是产品哲学和交互收敛，而不是代码：

1. **先捕获，后组织**：用户不应该先选择项目、标签、数据库结构才能记录一个想法。
2. **原始备注是一等公民**：AI 的总结和反思不能覆盖用户当时的原话。
3. **单卡 Reflect 与多卡 Chat 分层**：单对象洞察和跨对象综合不能混成一种 prompt。
4. **把网页／X／图片作为同一类可检索材料**：来源差异不应破坏统一 card/context 模型。
5. **AI 输出可以回写为新的可编辑材料**：不是一次性聊天气泡。
6. **语义搜索必须服务于再次思考**：搜索不是单纯找文件，而是找能改变当前思路的材料。
7. **导出是产品能力**：用户的数据应该随时可以离开系统。

## 结论

你给的 Minttr 确实和 MP 的“记忆、卡片、证据、AI 上下文、长时间积累”方向有相似之处，但它不是我们前面讨论的 Pi/Kimi computer-use 竞品，也不是一个可以 clone 的开源项目。

更准确地说：

> Minttr 是一个很好的“个人兴趣／灵感卡片 + AI 反思 + 多卡上下文”产品范式；Magic Pointer 应该把它的捕获、原始备注优先、Reflect、跨卡 Chat、语义搜索和可导出数据理念吸收到自己的 DraftArtifact、Memory 和 Agent Runtime 里，但不能把 Minttr 当作可直接复用的开源实现。
