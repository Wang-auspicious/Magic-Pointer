# 2026-08-12 审查：39 个 recipe 重定位前后行为逐一对账

审查者：只读对抗审查 agent。未改任何文件（除本篇笔记），未跑 git。
验证方式：用**真实模块**（`IntentRouter.route`、`route_to_trajectory`、`TrajectoryCompiler`，Python 3.12.8，`PYTHONDONTWRITEBYTECODE=1`，零文件写入）对 680 条命令语料做全量对账。语料 = 39 个 recipe 的全部 manifest zh/en 关键词 + 全部 L0 短语 + 全部 RecipeRouter priority 短语 + 6 个测试文件中的字符串字面量 + 程序构造的边界输入（如"整理后复制这段文字""让codex识别文字""翻成中文"）。
旧路径判定 = `IntentRouter.route(command, object_count=1)`（L0→信息问题→L1 keyword(conf≥0.70)→L2）；新路径判定 = `route_to_trajectory(command, lang="zh")` 的 top1。

结论先行：**新路径没有行为回归到"坏"，但有 5 类真实差异；其中 2 类（信息问题守卫丢失、en 关键词覆盖丢失）会在生产切换后改变用户可见行为。** 目前 `run_agent_turn` 无任何生产调用点（见 §6），因此全部结论是"未来切换时"的风险清单，不是当下已上线的故障。

---

## 1. 39 行对账表

约定：旧命中 = 旧路由对"该 recipe 自己的关键词/短语输入"可达；新命中 = 新路径对同样输入可达。`top1 一致` = 相同输入下旧 winner 与新 top1 相同（仅对可达输入判定）。

| # | id | 旧命中 | 新命中 | top1 一致? | 备注 |
|---|----|--------|--------|-----------|------|
| 1 | activate.wiggle | 命中但被非目的地过滤→L2 | 命中但被过滤→[] | 一致（双路均不可达） | 非目的地（id 名单） |
| 2 | ground.this | 同上 | 同上 | 一致 | 非目的地；`帮我看看这段写得怎么样`→[] 已被新测试 pin |
| 3 | ground.references | 同上 | 同上 | 一致 | 非目的地；`刚才那个` 被 objects.compare 吸收（共享关键词） |
| 4 | text.ocr_copy | L0，16 短语 | L0 同源 + zh 关键词 | **不一致（3 类）** | (a) L0 双命中破平翻转：`整理后复制这段文字` 旧=ocr_copy→新=ocr_clean（见 P1-3）；`让codex识别文字` 旧=ocr_copy→新=agent.handoff；(b) en `copy text`→新[]；(c) `What is OCR?` 旧=纯模型回答→新=进 OCR 轨迹 |
| 5 | text.ocr_clean | L0，7 短语 | L0 同源 | 基本一致 | 组合输入翻转后新反而更准（id 升序让 ocr_clean 优先于 ocr_copy） |
| 6 | text.rewrite_in_place | L1（zh+en） | zh 关键词 | 不一致（en） | zh 5/5 一致（`把这段改得更正式` 双路同）；en `rewrite`/`make formal`→[] |
| 7 | text.translate_in_place | L1（priority 翻成/翻译成/译成） | zh 关键词 | 不一致（en） | zh 一致；`翻成中文` 双路均回退（旧 conf 0.58<0.70→L2，新[]——语义等价）；en `translate`→[] |
| 8 | text.summarize_route | L1 | zh 关键词 | 不一致（en） | `总结下` 双路一致；en `summarize`/`bullet points`→[] |
| 9 | entity.quick_action | L1（zh+en） | zh 关键词 | 不一致（en） | zh 4/4 一致；en 3→[]；旧 en `call` 是子串误命中（`recall` 也中），新 zh 模式顺带消除 |
| 10 | table.to_spreadsheet | L0，9 短语 | L0 同源 | 一致 | |
| 11 | table.merge | L1 命中但 min_objects=2 且 object_count=1 → 拒→L2 | top1 轨迹 | 不一致（对象数门） | `两个表合并` 旧=L2 模型合成 → 新=直接跑轨迹 |
| 12 | chart.extract_data | L1 | zh 关键词 | 不一致（en） | zh 3/3 一致；en 2→[] |
| 13 | formula.to_latex | L0，5 短语 | L0 同源 | 一致 | |
| 14 | image.edit_object | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 3→[] |
| 15 | image.compose | 同 #11（min_objects=2） | top1 轨迹 | 不一致（对象数门） | `放进这个房间` 等旧=L2 → 新=直接跑 |
| 16 | image.style_transfer | 同 #11 | top1 轨迹 | 不一致（对象数门） | 同 #15 |
| 17 | canvas.transform | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en `make this orange`→[] |
| 18 | calendar.create_from_screen | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 19 | map.route | L1 命中但 min_objects=2 → 拒→L2 | top1 轨迹 | 不一致（对象数门） | `怎么走/路线/导航` 旧=L2 或信息问题判定 → 新=直接跑；en `directions`/`route` 旧亦被 min_objects 门拒→L2，新[]，无差 |
| 20 | video.place_action | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en `book a table`→[] |
| 21 | recipe.scale_and_route | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 22 | task.route | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 23 | research.evidence_card | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 24 | agent.handoff | L0，16 短语 + zh 6 | L0 同源 | 不一致（2 类） | en `agent fix`→[]；`让codex识别文字` 旧=ocr_copy→新=handoff（P1-3 同源） |
| 25 | vision.prompt_bridge | L1 | zh 3/4 | 不一致（2 类） | `图片提示词` 双路均归 image.to_prompt（L0 一致，非差异）；`解释给本地模型` 旧=纯回答→新=轨迹；en 2→[] |
| 26 | objects.compare | L1 命中但 min_objects=2 → 拒→L2 | top1 轨迹 | 不一致（对象数门） | `对比这些/比较这些` 旧=信息问题→纯回答 → 新=直接跑 |
| 27 | voice.short_command | 命中但被非目的地过滤 | 同上 | 一致 | 非目的地（id 名单） |
| 28 | agent.background_task | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 29 | integration.mcp | 被非目的地过滤 | 同上 | 一致 | 非目的地 |
| 30 | governance.dashboard | 被非目的地过滤 | 同上 | 一致 | 非目的地 |
| 31 | image.to_prompt | L0，5 短语 | L0 同源 | 一致 | 含 `生成提示词：…` 前缀命令双路一致不劫持（旧测试 pin 的行为保持） |
| 32 | selection.expand | L1 | zh 关键词 | 不一致（en） | zh 5/5 一致；en 3→[] |
| 33 | selection.condense | L1 | zh 关键词 | 不一致（en） | 同 #32 |
| 34 | element.pick | 被非目的地过滤（output_kind=grounded_object） | 同上 | 一致 | 非目的地（output_kind 名单，覆盖 2026-08-05 的劫持修复） |
| 35 | screen.translate | L1 | zh 关键词 | 不一致（en） | zh 5/5 一致；en `overlay translation`→[]；旧 `translate this area` 误入 translate_in_place，新更安全 |
| 36 | clipboard.history | L1 | zh 关键词 | 不一致（en） | zh 4/4 一致；en 2→[] |
| 37 | screen.recall | L1 | zh 3/5 | 不一致（2 类） | `刚才看的/上午看的/我看过的` 共享关键词 → 新翻转到 memory.recall（新选的 provider=local.memory 可用，旧的不可用）；en 3→[] |
| 38 | pointer.coach | L1（但 `怎么操作` 被信息问题判定截走→纯回答） | zh 5/5 轨迹 | 不一致（2 类） | en 4→[]；`怎么操作` 旧=纯回答→新=教练轨迹 |
| 39 | memory.recall | L1 | zh 6/6 | 不一致（en） | 吸收 #37 的 3 个共享词；en `recall what i saw`→[] |

统计：32 个目的地 recipe 的 zh 关键词自达率 100%（仅 screen.recall 3 个共享词翻转、vision.prompt_bridge `图片提示词` 归 image.to_prompt 属"换 recipe 而非丢失"）；7 个非目的地 recipe 双路一致过滤。en 关键词共 89 个：**旧路径实际可路由 43 个唯一串（44 行，`earlier today` 同属两个 recipe），新 zh 模式全部丢失**；其余 46 个旧路径同样不可达（非目的地 19、min_objects 门、`this` 高频词被 ground.this 吸收后过滤、信息问题判定、L0 一致如 `ocr`/`clean ocr`），无行为差异。

## 2. 关键词覆盖缺口清单

新编译器命中词集合 = L0 短语 + manifest **zh**（`lang="zh"` 默认）。旧 L1 的 `RecipeRouter._score`（`app/fabric/router.py:50-55`）是 **zh+en 无条件并集**打分。因此：

- **缺口 A（en，P1）**：43 个唯一串、44 行 en 关键词（全部目的地 recipe）旧 L1 可路由、新 zh 模式不可达 → 自由循环。代表性：`copy text`、`rewrite`、`make formal`、`translate`、`summarize`、`add to calendar`、`create event`、`agent fix`、`visual prompt`、`teach me`、`clipboard history`、`what did i copy`、`recall`、`earlier today`、`run in background`、`save evidence` 等。`lang="en"` 可命中（测试已覆盖），但 `run_agent_turn` 默认 zh 且无语言检测。
- **缺口 B（en 短词子串陷阱，P2）**：en 模式下 `recall` → entity.quick_action top1（`call` ⊂ `recall`，旧为 screen.recall）——旧系统同样存在，zh 模式反而消除；若支持 en，需词边界。
- **缺口 C（zh 短语，非缺口——澄清）**：旧 RecipeRouter priority 的 `翻成`（conf=0.58 < 0.70 → 被拒→L2）与 `识别这个屏幕对象中的文字`（priority 命中但非关键词、raw_score=0 → conf=0.58 → 被拒→L2）在旧路径均落 L2，与新路径自由循环语义等价，无行为差异。
- **缺口 D（本地动作，P1）**：LOCAL_ACTION_RULES（`截图`/`复制这个`/`这是哪个窗口` 等 3 组）在新路径无对应分支 → 旧确定性本地动作变成自由循环模型回答。
- 结论：**zh 用户输入快路径退化 = 0**（A/B/C 只伤 en 与长句）；**en 用户输入快路径退化 = 43 个唯一串（44 行）**。若产品面是中文优先，缺口 A 可接受但要记录；若要保 en 表面，不可接受。

## 3. L2 兜底语义变化

- 旧 `IntentRouter.route` 无命中 → `ACT_TOOLS`：模型拿到 40 个上限、非目的地排除的 **recipe 工具表**（`recipe_tool_schemas`，intent_router.py:342-371）自由组合。
- 新 `run_agent_turn` 无命中 → **自由循环**：`trajectory=None`、max_turns=6（`_LOOP_DEFAULT_MAX_TURNS`）、`DEFAULT_BUDGETS`，工具面 = 注册表 + `describe_capabilities`，**没有任何 recipe 工具**。
- 对既有测试输入（`帮我把这段变成小红书文案`、`这图里第三列加起来是多少` 等）：旧 L2/新自由循环都落到"模型作答"，结论等价；但工具面不同——旧路径模型可能自行组合 recipe 工具，新路径只能能力发现。这是产品语义差异（"recipe 即工具"vs"recipe 即缓存"），不是 bug，但切换生产前必须确认循环里是否暴露 recipe 工具。
- 附带修正：生产旧路径 `FabricEngine.plan` 对无命中命令返回 `ok=False, error="ambiguous_command"`（engine.py:434-436，`RecipeRouter` 直查）；新自由循环永远有答案——这部分是**改进**。

## 4. engine 兼容（fabric_bridge 无感声明）

- **声明成立，但前提是"生产从未切换"**：`run_agent_turn`/`route_to_trajectory` 全仓零生产调用点（仅 `engine.py:874` 定义 + 测试）。`scripts/fabric_bridge.py:722`（route op→`RecipeRouter`）、`:732`（plan→`engine.plan`）、`scripts/selection_bridge.py:2200/2586`（`engine.plan`）全部走旧路径，未受影响。
- 注意：生产"旧路径"其实是 **RecipeRouter 直查**（engine.py:434），不是 IntentRouter 的 L0/L1/L2——三套路由并存（IntentRouter.route / RecipeRouter / route_to_trajectory），文档"L0/L1/L2 路由器退役为轨迹编译器"（HARNESS doc:848）描述的是目标而非现状。
- 治理面：新路径完全绕开 `engine.plan` 的 TargetLease、permission_decision、capture_policy、audit（recipe.executed/planned）、workflow-task、provider 解析与 `unavailable:` 诚实反馈。切换生产 = 这批控制全部消失，需先补齐（见 P1-5）。

## 5. max_turns / risk 映射

- 39/39 与派生规则一致，0 个 mismatch：`max_turns = 4 if min_objects>=2 or external_send else 3`（recipe_cache.py:148）。4-turn 的 11 个：table.merge、image.compose、image.style_transfer、map.route、objects.compare（min≥2）+ entity.quick_action、calendar.create_from_screen、task.route、agent.handoff、agent.background_task、video.place_action（external_send，map.route 与前者重叠）。其余 3。
- risk 39/39 直通 manifest，无篡改。
- 注意：manifest **没有** max_turns 字段，规则是纯派生，与 manifest 无字段级可比性；但 external_send 判定 `"external_send" in {risk, provider} or in strategies`（recipe_cache.py:141-143）对 39/39 结果正确。
- 语义间隙（P2）：自由循环上限 6 ≠ 轨迹上限 3/4，无轨迹命中时用户获得更长循环，需在预算文档中说明。

## 6. 非目的地 recipe 过滤

- `route_to_trajectory` 在候选生成后执行 `is_non_destination_recipe` 过滤（intent_router.py:462），**仍然生效**：7 个 id 名单（activate.wiggle/ground.this/ground.references/governance.dashboard/integration.mcp/voice.short_command）+ 3 个 output_kind（grounded_object→element.pick/activation_intent/interaction_episode）全部实测被滤（含共享关键词场景：`这个`→[]、`晃动`→[]）。
- 编译器 `match_keywords` 本身**不过滤**（测试断言 `("ground.this", 0.5) in results`），过滤在 router 层——两个模块的职责边界清晰，无漏过滤路径。
- 唯一语义转移：被滤关键词若同时属于目的地 recipe（`刚才那个`→objects.compare），会"换主"而非消失——不是漏过滤，是共享词竞争，已记录（P2-2）。

## 7. P0 / P1 / P2 结论

**P0：无。** 新路径零生产调用点，无已上线回归；本清单全部为"切换生产前必须处理"。

**P1（切换生产前必修）：**
1. 信息问题守卫丢失（最危险）：`What is OCR?`/`解释给本地模型`/`对比这些`/`怎么走`/`怎么操作` 旧=纯模型回答，新=进 OCR/视觉桥/比较/地图/教练**轨迹**（OCR 会把"这是问题"当成"复制这段文字"去动剪贴板）。旧代码注释明确防止此病理（intent_router.py:536-540）。修复：`route_to_trajectory`/`run_agent_turn` 前复用 `_is_information_question` 短路。
2. en 关键词覆盖丢失：43 个唯一串（44 行）旧 L1 可路由的 en 关键词在 zh 模式 → 自由循环。修复：`match_keywords` 默认 zh+en 并集打分（或调用侧语言检测后传 lang）。
3. L0 双命中破平翻转：旧按 `DETERMINISTIC_RULES` tuple 序，新按 recipe_id 升序 → `整理后复制这段文字`（ocr_copy→ocr_clean）、`让codex识别文字`（ocr_copy→agent.handoff）等快路径 winner 改变；`intent_router_trajectory_test.py:56-63` 已把新行为 pin 住，旧行为被静默替换。修复：破平先按 DETERMINISTIC_RULES 顺序，再按 id。
4. LOCAL_ACTION_RULES 无对应：`截图`/`复制这个`/`这是哪个窗口` 旧确定性本地动作 → 新自由循环。修复：`run_agent_turn` 前置 local-action 分支。
5. 开关与学习门丢失：`recipe_enabled`（含 settings 层）与 `InstructionLibrary.lookup` 在新路径完全不参与——禁用 recipe 仍会被选为 top1 执行，学习到的快路径失效。修复：新路径接入两处 + 补 plan 层的 lease/permission/audit 等价物。

**P2（记录/择期）：**
1. min_objects 对象数门丢失：5 个 min_objects=2 recipe 在 1 个对象时旧=L2、新=直接跑轨迹。修复：候选过滤读 objects 数量，或轨迹内声明对象数校验。
2. 共享关键词翻转：`刚才看的` 等 3 词 screen.recall→memory.recall（新选的 provider 可用，可接受）；`图片提示词` 双路均归 image.to_prompt（一致，无行为差）。修复：需要旧语义时建关键词优先级表。
3. L2 工具面差异：旧 ACT_TOOLS 暴露 recipe 工具表 vs 新自由循环无 recipe 工具。修复：决策是否在循环注册 recipe 工具（保持"recipe 即缓存"就明确废弃旧 L2 工具表）。
4. en 短词子串陷阱在 en 模式仍存（`call`/`recall`→entity.quick_action）。修复：en 匹配加词边界。
5. 自由循环 6 turn 与轨迹 3/4 turn 并存的上限语义需文档化。

验证诚实性：以上全部来自真实模块实测（680 语料、75 条"旧命中→新空"、8 条"旧命中→新换 recipe"、21 条"旧无→新命中"；75 条中约 32 条为测试文件长字面量经 `call`/`translate`/`text` 子串伪命中造成的噪声，真实退化 43 条全部是 en 关键词；21 条 = 信息问题守卫丢失 6 / 本地动作 1（`copy this text`）/ min_objects 对象数门 14）。en 关键词逐串复核过（44 行清单见 §2）。未抽样，逐 recipe 全部过表。
