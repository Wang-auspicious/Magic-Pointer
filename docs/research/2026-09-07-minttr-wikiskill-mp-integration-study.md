# Minttr 剪贴板卡片链路、WikiSkill 与 Hermes 自进化：MP 集成设计

日期：2026-09-07  
范围：Magic Pointer 现有 `stash`／clipboard image pipeline、用户指定的 Minttr、Google Research WikiSkill 论文，以及 Hermes Agent 社区对 self-improvement 的实际反馈。

## 一、先纠正判断：Minttr 与 MP 的重合点在这里

用户指出的重合是对的：MP 不是只有 computer-use。源码里已经有一个“剪贴板图片 → 本地收藏材料 → 自动简介 → 可搜索 → 可作为后续上下文”的设计，这正好和 Minttr 的核心产品闭环相交。

关键实现位于：

- `electron/stash_runtime.ts`
- `electron/stash_store.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `electron/studio_shell.ts`
- `app/context_pack/knowledge.py`
- `app/context_pack/tools.py`
- `PRD.md` 的 Spark 知识材料、context pack、task sources 和 DraftArtifact 章节

### MP 当前实际链路

```text
Electron clipboard.poll（700ms）
  → availableFormats 检查 image/*
  → nativeImage.readImage()
  → 16×16 sample fingerprint + 5s dedupe
  → focusProbe 记录前台 app / window / element / selection
  → stash_store.buildEntry()
  → userData/stash/YYYY-MM/*.png + index.json
  → onEntry 推给 dashboard / proactive event
  → image 进入串行 describeQueue
  → stash_describe_bridge.py 生成 bounded summary
  → stash:list / stash:search / stash:open / stash:describe
  → context_pack knowledge / Agent source binding（目前还没有完全打通）
```

MP 还有一个重要的双向细节：图片入库后可以把“本地图片路径 + 原始图片”写回剪贴板；终端拿路径，图片编辑器仍可粘图。这不是 Minttr 的重点，但说明 MP 的 clipboard runtime 已经不是一个简单 watcher。

### 这个链路已经做对的地方

- 图片和文本分开处理，默认文字采集关闭。
- 图片采集是显式 setting 控制，不默认监控。
- 采集前做小样本指纹去重，避免重复入库。
- 不用全图哈希做无意义成本；样本只用于决定“是否是新内容”。
- 保存原始 PNG，不只保存模型摘要。
- `focusProbe` 尝试记录来源 app/window/element，但没有猜测时会留空。
- 入库和图片描述解耦：描述失败不阻塞原图入库。
- 描述请求串行化，避免一次粘贴多张图时同时打爆模型。
- stash 条目有分类、burst、sourceId、locator、summary、原始路径和可移除能力。

### 当前真正的缺口

MP 当前已经完成了“材料收藏箱”，但还没有完全完成 Minttr 式的“思想博物馆 → Agent 思考空间”：

1. **图片进入 stash 后，Agent 不会自动获得一个结构化可检索 source。** 目前可以 `stash:search`，但 Agent 的 task context 需要显式 source registration 和 reference binding 才能可靠读取。
2. **原始用户备注与图片没有形成同一个 card revision。** `add-note` 可以写文本，但“这张图 + 我当下想法 + 来源 + 后续反思”还需要一个明确的 Card/Material Artifact 关系。
3. **自动简介是描述，不是 Reflect。** 摘要回答“这是什么”；Reflect 要回答“它和我正在想的事情有什么关系、遗漏了什么、可以提出什么不同视角”。
4. **搜索目前主要是 bounded linear/index lookup。** 还没有把图片 summary、用户备注、来源页面、task references 和 Agent 生成的反思统一到一个可解释的语义检索结果里。
5. **Agent 读取材料还缺少“继续读取原文／原图／局部上下文”的明确 cursor。** 不能让摘要代替原文。
6. **用户没有在当前任务中明确授权的 stash 材料，不应该自动变成任务上下文。** 这是 PRD 中“显式加入材料，不默认采集全天剪贴板”的边界，必须保留。

## 二、Minttr 应该怎样接进 MP，而不是复制 Minttr

不需要引入一个新的 Minttr clone。应该把 MP 现有 stash 升级成三层对象：

```text
StashEntry（原始落盘材料）
        ↓ 用户显式加入／绑定
MaterialCard（用户思想卡片，带 revision）
        ↓ Agent 读取／Reflect／Chat
TaskSource + ReferenceBinding + DraftArtifact
```

### 推荐的数据分层

#### 1. `StashEntry`：不变的原始材料

继续保留现有 `index.json + 原图/原文文件`。它是事实层，不被模型“优化”覆盖：

- 原始图片／文本／链接
- capturedAt、来源 app/window/locator
- 原始 fingerprint（仅去重用途）
- sourceId
- 自动 summary（可重算，但不覆盖原文）

#### 2. `MaterialCard`：用户拥有的思考层

由用户显式点“加入材料／建卡／写备注”产生，版本化：

- cardId、revision
- 原始 stash sourceIds
- 用户备注（最高优先级）
- tags、space、category
- 用户指定的关系：inspiration / target / reference / exclude
- Agent 生成的 Reflect artifact（独立 revision，不覆盖备注）
- card history 和撤销

#### 3. `TaskSource/ReferenceBinding`：任务上下文层

只有用户显式选择或当前 gesture 明确指向的 card 才进入 task：

- sourceId / cardId
- role：`target|source|reference|exclude|unresolved`
- locator：原图路径、网页 URL、截图坐标、原文范围
- coverage：摘要覆盖哪些内容，原文如何继续读取
- referenceRevision

这样既得到 Minttr 的“想法卡片”，又不违反 MP 的“显式加入，不默认把剪贴板变成长驻上下文”的约束。

### 推荐的用户体验

```text
用户复制图片
  → MP 静默落入收藏箱（若用户已开启 clipboard stash）
  → 卡片出现“已保存：来自微信／浏览器／某窗口”
  → 用户点「加一句想法」或直接拖入当前任务
  → 卡片显示原图、自动简介、用户备注、来源
  → 用户点「Reflect」：只针对这张卡，生成可编辑 DraftArtifact
  → 用户点「带入当前任务」：建立 TaskSource + ReferenceBinding
  → Agent 读取“原图 + summary + 用户备注 + 可继续读取入口”
  → 任务结果可回写为新的 card revision 或 artifact，不覆盖原卡
```

这里的关键不是让 Agent 自动读用户所有剪贴板，而是让用户用最低摩擦把“这个东西”和“我为什么保存它”绑定起来。

## 三、WikiSkill 论文到底带来了什么

论文：[WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution](https://arxiv.org/abs/2608.27454)

论文提出的核心不是“让 Agent 直接改自己的 SKILL.md”，而是把三个层次分开：

```text
Raw Layer       不可变执行轨迹
    ↓
Wiki Layer      持久、累积、可追溯的结构化知识
    ↓
Skill Layer     当前实际供 Agent 执行的程序性 skill
```

论文摘要报告：持久 wiki 在多个 benchmark 和模型上优于没有持久知识或只从优化历史重新推导的 skill evolution；skill 还能跨模型转移。最重要的设计判断是：

- raw experience 不应被压成最后一版 skill 后丢掉；
- wiki 知识应该持续累积，即使某一次 skill patch 被拒绝或回滚；
- skill 是可替换的执行层，不是唯一真相；
- 发现 skill 的模型和执行 skill 的模型可以不同；
- wiki 不应在执行阶段直接替代 skill，否则执行轨迹不再能说明 skill 是否真正有效。

## 四、WikiSkill 与 MP 的自然对应

| WikiSkill 层 | MP 现有／应新增对象 |
|---|---|
| Raw execution traces | EventSession、turn events、tool calls、tool outputs、FrameLease、Evidence、Receipt、artifact revision |
| Wiki | `knowledge ledger`：失败根因、成功策略、用户偏好、应用行为、被拒绝的 skill proposal、验证结果 |
| Skill | `.agents/skills/` 或 MP 受治理的 skill bundle |
| Evolution loop | 后台只读分析 → proposal → sandbox evaluation → user approval / auto-accept policy → staged skill revision |
| Validation | 任务 replay、真实应用 acceptance、契约测试、用户反馈、回归样例 |

MP 最适合把 WikiSkill 的 wiki 层实现成**事件投影**，而不是又创建一个自由写入的 `wiki.json`：

```text
EventSession raw events
  → KnowledgeCandidate（不可直接执行）
  → KnowledgePage / Pattern / FailureCase / UserPreference
  → SkillProposal（差异 + 理由 + 证据 + 预期收益）
  → evaluator / replay / human review
  → staged skill revision
```

这可以直接复用 MP 已有的：

- EventSession durable log
- compaction handoff
- `context_pack` source/reference model
- DraftArtifact revision
- ActionBroker / undo
- Progress / approval card
- task resume and takeover

## 五、Hermes 自进化为什么遭到诟病

这里不能只引用“有人觉得不好用”，社区反馈已经指出了具体工程问题。

### 1. 一次性调查被误判成长期 skill

Hermes issue [#75423](https://github.com/NousResearch/hermes-agent/issues/75423) 描述了：一次版本相关的代码调查被后台 review 误判为可复用技能，生成了一个宽泛的 `hermes-codebase-investigation` skill，并把本次调查报告塞入 reference 文件。

根因：review prompt 偏向“做点持久化改动”，把研究材料、知识库和可执行程序混淆。

### 2. 自动编辑默认过于激进，审批和回溯体验不足

Issue [#70128](https://github.com/NousResearch/hermes-agent/issues/70128) 指出：后台 review 默认可以直接改用户 skill，写审批开关默认关闭；用户只看到发生了变更，却未必能看到清楚的 diff，回滚和解释不够可靠。

### 3. 后台 fork 的成本和行为不可见

Issue [#87250](https://github.com/NousResearch/hermes-agent/issues/87250) 指出：每轮之后可能启动 background review fork，但 token 使用量、迭代预算和具体 prompt 不透明，也没有清晰的 session transcript/usage attribution；禁用路径和配置粒度不足。

这会让用户感觉“我只问了一句话，系统却在后台花钱并改文件”。

### 4. Skill 会变成日志和旧事故的垃圾场

社区反馈（例如 [Hermes Reddit 讨论](https://www.reddit.com/r/hermesagent/comments/1uvqym/hermes_should_review_its_own_skillimprovement/)）描述了高频 skill 被数百次自动编辑、膨胀到数百 KB、重复且混入临时事故背景。结果是：

- token 成本增加
- skill 加载变慢
- 规则互相矛盾
- 旧版本／特定事故的 workaround 污染通用流程
- Agent 选择 skill 变差

### 5. “有 skill”不等于“skill 有效”

社区对 self-generated skills 的另一类批评是：skill 只是被写出来，并没有经过稳定的任务回归验证；同一个 agent 反思自己的输出，很容易把解释性文字误当成性能提升。

相关外部研究也提示 skill 的收益高度依赖任务和质量控制：例如 SWE-Skills-Bench 报告中多数公开 skill 对 pass rate 没有提升或提升很小。[SWE-Skills-Bench](https://arxiv.org/abs/2603.15401)

### 6. 维护和进化耦合在同一个后台 agent

Hermes 的 background review 同时承担发现、写入、合并、维护和部分清理，导致：

- 发现失败时仍可能写入
- 写入失败与验证失败难以区分
- skill proposal 与最终 skill revision 没有足够清晰的中间态
- 用户很难知道“这次是新知识、候选修改还是已生效规则”

Hermes 后续增加 curator，说明项目本身也承认 skill 会积累重复项，需要 active → stale → archived 的维护路径；但“能修剪”不等于“每次写入都应自动生效”。[Hermes Curator 文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/curator.md)

## 六、MP 应该怎样吸收 WikiSkill，而不是复制 Hermes 的缺陷

### 原则一：Raw、Knowledge、Skill 三层永不混写

- Raw：只追加，不由模型修改。
- Knowledge：允许修订，但每一条必须保留来源 event IDs、任务、时间、置信度和被拒绝历史。
- Skill：是可执行建议，必须有 diff、版本、适用范围、验证任务和状态。

### 原则二：把“学习”变成候选，不是后台偷偷改用户

推荐状态机：

```text
observed
  → candidate
  → synthesized
  → evaluated
  → staged
  → accepted | rejected | expired | superseded
```

只有 `accepted` 才进入默认 skill surface；`candidate/synthesized/evaluated` 都可以让用户查看，但不能悄悄改变 Agent 的行为。

### 原则三：用 MP 的可验证动作闭环判断 skill 是否有效

一个 skill proposal 至少需要：

- 适用 task kind / app / surface
- 它试图修复的具体 failure type
- 原始 evidence / receipt / artifact revision IDs
- 最小成功案例
- 已知不适用案例
- 预期减少的轮次、错误或用户纠正次数
- replay / contract test 结果
- 反例和回滚条件

不能因为“模型写得很像一篇好文章”就接受。

### 原则四：用户反馈优先于模型自评

MP 已经有用户纠正、steer、approval、undo、readback 和真实应用 acceptance。WikiSkill 的 maintainer 应把这些作为高权重信号：

- 用户明确纠正 > 模型推测
- verified receipt > 工具调用成功
- 连续重复成功 > 单次成功
- 用户拒绝 proposal 应留下 rejection knowledge，避免下轮重新提出
- 用户手动编辑 DraftArtifact 不应自动变成 skill，除非用户明确表达“以后都这样做”或经过重复行为确认

### 原则五：Skill 变小，Wiki 变厚

Hermes 的问题之一是把所有经验都塞进 SKILL.md。MP 应反过来：

- skill 只保留执行时必须知道的短流程和 guard
- 长解释、失败案例、版本差异、历史 workaround 放在 wiki/reference pages
- skill 通过 source IDs 指向 wiki，而不是复制全文
- 加载时只取当前 task 相关的 bounded knowledge slice

### 原则六：背景学习必须可见、可暂停、可计费

每次后台学习都应该生成一个普通的可查看 task/progress item：

- `learning_started`
- 使用哪个模型
- 读取了多少 raw events
- 预计 token/时间预算
- 产生了几个 knowledge candidates
- 产生了几个 skill proposals
- 哪些被拒绝／跳过
- 是否需要用户审批

用户可以暂停 background evolution；暂停不影响前台任务。

## 七、结合 Minttr 的最终 MP 方案

### A. 剪贴板图片成为 Agent 可理解的“思想材料”

新增的不是“自动把所有图片塞进 prompt”，而是：

1. Clipboard watcher 将图片保存为 `StashEntry`。
2. 自动描述生成 bounded summary。
3. 用户补充一句备注，形成 `MaterialCard` revision 1。
4. 用户可点 `Reflect`，生成独立 `DraftArtifact`。
5. 用户可把一个或多个 card 绑定到当前 task。
6. Agent 获得 `sourceId + cardId + userNote + summary + continuation locator`。
7. Agent 可请求读取原图、原文或局部材料，但不能把 summary 当作完整事实。
8. 任务产出可以另存为新卡或 artifact，不覆盖原始卡。

### B. WikiSkill 让 Agent 学“怎么处理这些思想材料”

例如用户反复把设计截图复制进 MP，并在备注中写“这个交互值得借鉴”：

- Raw：记录每次复制的图、备注、来源、用户如何分类、Agent 如何反思。
- Wiki：累积“用户在 UI 设计材料上偏好的观察维度：层级、动效、密度、证据”等知识。
- Skill proposal：提出一个 `design-reference-reflection` skill。
- Evaluator：用历史几次真实卡片做离线 replay，检查是否更贴近用户备注、是否减少用户纠正。
- Accepted skill：只保留执行时的短流程；详细案例和反例留在 wiki。

### C. Hermes 的自进化改成“受控学习流水线”

MP 不应采用“每 N 轮后台 agent 自由编辑 SKILL.md”的默认模式，而应采用：

```text
前台任务完成
  → 只读 learning digest
  → wiki maintainer 提炼知识
  → proposal builder 生成候选 skill diff
  → replay / real-application acceptance / regression gate
  → staged card 展示给用户
  → 用户接受，或按明确策略自动接受低风险小改
  → 新 skill revision + receipt + rollback pointer
```

低风险自动接受只应覆盖：

- 纯文本描述修正
- 不改变动作权限的检索关键词补充
- 已被多次真实任务验证的非破坏性步骤顺序

必须人工接受的包括：

- 新增写动作
- 改变目标选择／引用角色
- 改变外部发送、删除、权限、上传行为
- 改变 Office/微信等真实应用的动作顺序
- 修改用户偏好或长期 memory

## 八、当前实施优先级

### 第一批：把 Minttr 的核心体验打通 MP 现有 stash

1. `stash_entry → MaterialCard` 的显式加入动作。
2. 图片 + 用户备注的同卡版本模型。
3. `Reflect` 作为独立 DraftArtifact，不覆盖原卡。
4. 当前 task 绑定 card/source/reference。
5. Agent 侧 `knowledge_search/read_source/read_around` 使用真实 source IDs。
6. 卡片原图、摘要、用户备注、来源和 Agent 反思的统一 inspector。

### 第二批：Wiki 层

1. 从 EventSession 投影 `KnowledgeCandidate`。
2. 保存 failure case、success pattern、rejected proposal。
3. 建立 proposal/diff/evaluation/staged 状态。
4. 做离线 replay 和任务级回归，不直接改 skill。

### 第三批：受控自进化

1. background learning 可见、可暂停、有预算。
2. skill 变更必须有 diff、来源、验证和回滚。
3. 低风险自动接受，高风险人工审批。
4. wiki 保留所有历史，skill 只保留当前短流程。
5. 用户明确纠正和用户编辑作为最高权重信号。

## 结论

你的判断是对的：Minttr 和 MP 的交集不是泛泛的“都有 AI”，而是 MP 已经有一条非常接近 Minttr 的剪贴板图片收藏链路，只差把它从“收藏箱”真正升级成“用户思想材料 → Agent 上下文 → Reflect/Chat → 可回写 Artifact”的完整闭环。

WikiSkill 提供了 Hermes 自进化缺陷的关键修正方向：把不可变 raw experience、持久 wiki knowledge 和当前 executable skill 分开。Hermes 社区反馈说明，不能直接复制“后台自动写 skill”这一步；必须加入 proposal、验证、可见性、预算、回滚和用户控制。

MP 最终应形成：

```text
Minttr 的低摩擦思想捕获
  + MP 的 Stash / FrameLease / Evidence / DraftArtifact
  + WikiSkill 的 Raw → Wiki → Skill 三层
  + MP 的 ActionLease / Effect / Receipt / Evaluation Gate
  = 可理解用户思想、但不会偷偷污染自身行为的 sovereign Agent
```
