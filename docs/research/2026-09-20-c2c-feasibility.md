# C2C：论文、官方实现与 Magic Pointer 的落地边界

核验日期：2026-09-20。本文只完成原始资料与源码核验；没有下载模型权重、安装 Rosetta、训练 fuser 或声称复现论文性能。生产代码未在本调研中修改。

**结论：C2C 值得纳入 MP 的自托管模型后端研究，但当前这台电脑与正在使用的远程 DS4.1 接口无法执行真正的 C2C。现在可以、也应当交付子 Agent 的真实事件流、推理文本、工具步骤和产物的实时界面；这些属于可观测的 Agent 协作，不能标记成已实现的 KV 通信。**

本轮用户已明确回复“目前只有现有云模型 API”。据此不安装 CUDA / Rosetta、不下载本机无法运行的权重，也不加入没有服务端实现的 C2C 开关。实时协作界面独立交付；C2C 真正执行仍需可读写 KV 的自托管后端与匹配模型对，不能由普通聊天 API 代替。

## 1. 资料版本与宣传数字

| 项目 | 核验结果 |
| --- | --- |
| 论文 | 《Cache-to-Cache: Direct Semantic Communication Between Large Language Models》，arXiv:2510.03215，v1 为 2025-10-03，当前 v2 为 2026-03-02；arXiv 标记 Published in ICLR'26，官方仓库也记录 2026-01 接收。它不是 2026-09 刚发表的论文。来源：[arXiv 记录](https://arxiv.org/abs/2510.03215)。 |
| 代码 | `thu-nics/C2C`，本次匿名浅克隆核验的 commit 为 `9fa85d35a20e20469af3e282926491222f4f11e0`，提交日期 2026-09-19，标题 `[update] news`。来源：[固定提交](https://github.com/thu-nics/C2C/tree/9fa85d35a20e20469af3e282926491222f4f11e0)。 |
| 已发表版本的收益 | 摘要报告相对单模型平均准确率提高 6.4–14.2%，相对文本通信提高 3.1–5.4%，平均延迟加速 2.5×。主表用准确率百分数相减报告增益，不能直接解释为 MP 成功率相对增长 14.2%。来源：[论文 v2](https://arxiv.org/html/2510.03215v2#S4)。 |
| 2.0× 与 2.5× | 当前 README 仍保留旧的 8.5–10.5%、3–5%、2.0×，与新论文摘要不同；不能把两版数字拼成统一工业承诺。来源：[README](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/README.md)。 |
| 实验适用范围 | 主实验是 OpenBookQA、MMLU-Redux、ARC-C、C-Eval；零样本、温度 0、单张 A100、batch 1，选择题回答最长 64 token。T2T 基线先生成分析再交给接收者。不是 MP 的跨小时编程、Office 或桌面操作验收。来源：[实验设置](https://arxiv.org/html/2510.03215v2#S4.SS1)。 |
| 实际速度边界 | 论文 Table 3 的同一例子：T2T 1596 ms、C2C 445 ms、Receiver 单独 308 ms，融合本身 90 ms。证明该配置比文本协作快，不能证明比单模型更快、更便宜。来源：[Table 3](https://arxiv.org/html/2510.03215v2#S4.T3)。 |

论文确实探索了 Agent 工作流：GSM8K 上 T2T 61.18、C2C 62.55，混合文本与缓存的 T-C2C 78.01。这个结果也不支持“所有中间文字都应消灭”。工程结论是按任务测量通信方案，不把研究结论外推成全场景保证。[论文 Appendix A.5.3](https://arxiv.org/html/2510.03215v2#A1.SS5.SSS3)

OpenReview 页面本次遭遇浏览器校验；搜索索引能读取其正式论文首页，未读取到完整评审讨论。接收状态由 arXiv 与作者仓库交叉核实，不虚构审稿分数。

## 2. 官方实现实际做了什么

### 2.1 模型对专用的训练模块

`RosettaModel` 持有接收者模型、一个或多个分享者模型，以及逐层 projector。`C2CProjector` 把双方同位置的 K/V 展平、拼接，经 MLP 投影与输入相关的 head 权重，残差加回接收者缓存。它不是把一个模型的原始 KV 文件直接塞进任意模型，也不是只有空间旋转。[wrapper.py](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/wrapper.py#L46)、[projector.py](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/projector.py#L862)

默认 `C2CProjector` 的 key/value gate 是训练得到的标量参数；训练时采用 Gumbel-sigmoid，推理时用 `logit > 0` 决定开关。每次输入动态变化的是另一路 head 权重。宣传中的“模型毫秒级自行重新选择任意层”混淆了这两个机制。[gate 与权重实现](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/projector.py#L931)

官方最小公开配置固定为 Qwen3-0.6B Receiver + Qwen2.5-0.5B-Instruct Sharer，冻结双方，只训练 fuser；配方含 500,000 条 OpenHermes 样本、2048 序列长度、CUDA、8 个训练进程及温度退火。已有 checkpoint 可省去该模型对的重新训练；换模型权重、维度、tokenizer 或角色，不能沿用一个“通用 fuser”并假设正确。[训练配方](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/recipe/train_recipe/C2C_0.6%2B0.5.json)、[已发布模型对](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/README.md#supported-model-pairs)

### 2.2 对齐共同上下文，不是任意子任务记忆合并

代码用相同的 `start:end` 片段切出双方缓存，按层映射融合。不同 tokenizer 由 `TokenAligner` 对同一文本做 token 映射；一对多时选取一个候选 token。项目的支持路径要求双方缓存对应同一段输入语义，而 MP 的独立子 Agent 会拥有不同系统提示、文件读取结果、工具历史及压缩记录。后者不能直接按位置融合；把它们重新序列化成共同输入再 prefill，本身仍有计算与上下文成本。[片段融合](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/wrapper.py#L513)、[TokenAligner](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/aligner.py#L19)

这是从实际接口推导的适用边界，不是说缓存协作永远无法覆盖不同上下文；后者需要另外的研究、训练与实现证据。也不能由“高维表示”推导出“全部语义完整保真”。

### 2.3 KV 生命周期与开销

当前 `generate()` 每次开始会清空内部 `kv_cache_dict`；先 prefill 和融合，然后接收者逐 token 解码。函数接受 `past_key_values`，但这不等于完整的持久多 Agent KV 服务。`live_chat_example.py` 每次为当前输入构造一个 user message，示例没有实现 MP 所需的跨会话 checkpoint、缓存淘汰或任意子 Agent 记忆恢复。[generate](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/wrapper.py#L587)、[聊天示例](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/script/playground/live_chat_example.py#L100)

官方最新 News 明确把 **agent-managed KV-Cache 与配套 serving system** 列为即将发布的后续工作，多分享者支持仍标为初步阶段。本次检查到的开放代码不能当作这些后续交付已存在。[2026-09 News](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/README.md#news)

分享者的中间文本 decode 可以消失，但仍要支付双方模型权重、双方 prefill、fuser 运算与参数、KV 和临时副本的成本。跨设备/跨主机还要测量 KV 传输；论文的同 GPU 测量不能代表网络 RTT 与张量传输延迟。当前源码还有缓存 clone，以及 fuser 内每层分析属性的 `.detach().cpu()`；后者会引入设备到主机的数据搬运，生产性能验收时需要明确测量。以上为源码可见的性能条件，未在本机做 GPU 性能复现。[缓存复制](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/wrapper.py#L22)、[分析数据回传](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/rosetta/model/projector.py#L1012)

最小公开 pair 的 fuser 也并非几 KB：对 Hugging Face 固定 revision `f01fc3258b305e280e04c7238f4f2cf31b7dc70d` 的目录元数据求和，28 个 `.pt` 文件共 **956,066,910 bytes（约 956 MB）**，尚未包含两个模型权重。这里只读取文件元数据，没有下载这些权重。[官方 checkpoint 目录](https://huggingface.co/nics-efc/C2C_Fuser/tree/f01fc3258b305e280e04c7238f4f2cf31b7dc70d/qwen3_0.6b%2Bqwen2.5_0.5b_Fuser/final)

可以用 `2 × 层数 × KV头数 × head_dim × token数 × 每元素字节数` 估算单模型完整 KV 的裸张量大小，但不能把它当进程显存峰值。以官方 Qwen3-0.6B 配置的 28 层、8 个 KV 头、128 head_dim、BF16 为例，4096 tokens 约 **448 MiB**；还需加上分享者 KV、模型/fuser 权重、激活和实现副本。模型最大上下文也不等于这套 fuser 已验证的有效上下文。[Qwen3 配置](https://huggingface.co/Qwen/Qwen3-0.6B/blob/main/config.json)

## 3. 当前 MP 与本机是否可以直接用

| 路径 | 当前结论 | 对应证据与下一步 |
| --- | --- | --- |
| 现用 OpenCode `deepseek-v4.1-flash` | 不能据此实现 C2C | MP 收发 messages、responses 或 chat completions JSON；没有读取/写入该远端模型 KV 的合同，也没有这一 pair 的已训练 fuser。换 UI 标签、缓存 JSON 或压缩摘要不会改变这一点。 |
| 普通 OpenAI/Anthropic 兼容 API | 当前适配不能执行 C2C | `app/ai_client.py:220` 路由标准文本/消息协议；`app/agent_runtime/model_client.py:192` 的 `ModelBackend.generate` 处理消息、工具和流事件，未提供 tensor/cache handle。服务商自身 prompt caching 也不等于把缓存导出给另一个模型。 |
| 本机运行官方示例 | 不满足已验证环境 | 同任务只读硬件检查仅见 Intel Iris Xe Graphics 与 OrayIddDriver，`nvidia-smi` 不存在；没有观察到 NVIDIA/CUDA 设备。Win32 的 AdapterRAM 字段不能当作全部共享显存。官方示例默认 CUDA/BF16，同设备加载双方模型；没有证据支持本机 Iris Xe 的可用性能。 |
| 自托管 GPU 后端 | 可做真正实验，尚未部署 | 要有实际可用的 GPU 主机、模型权重、匹配 fuser，以及允许访问和替换 KV 的模型运行时。先从公开小 pair 验证，不把用户 DS4.1 直接替换成小模型。 |
| 子 Agent 实时 GUI | 现在可以实现 | 当前子 Agent 已有 parent/child session、工具事件和结果摘要；应转发已有模型推理/文本增量并增量渲染。这不依赖 C2C 或 GPU。 |

MP 的现成接入点是 `app/harness/services.py:16` 的 `LlmProvider` 和 `app/harness/builtin_bundle.py:573` 的 provider 工厂，而不是在 Electron 启动时载入 PyTorch。真正的自托管 C2C 推理若准备完成，可作为一个提供者接入 MP 自己的 Runtime；MP 继续负责工具执行、权限、任务状态、恢复和结果验证。接入模型推理服务不等于把 MP 的任务执行交给别的 Agent Harness。

本次读取时 `app/agent_runtime/subagent.py:148` 的 `child_event` 只处理工具开始/完成，`app/agent_runtime/model_client.py:139` 已定义可展示的 `ReasoningDelta`。这个事件转发缺口能解释“子 Agent 在工作，GUI 却看不到思考/输出”的一部分；主任务负责修复与验收。这里记录的是改动前的定位证据，行号可能随本批修复变化。

官方依赖锁定 Python ≥3.10、PyTorch 2.6.0、Transformers 4.52.4。将 MP 外壳或调度层改为 TS，既不会产生远端 KV 接口，也不会消除模型推理的 GPU 成本。若以后接 C2C，保持独立、显式启动的模型服务可以避免把重型模型带进桌面启动路径。[依赖文件](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/pyproject.toml)

## 4. 具体可落地路径

当前应把 GUI 做成真实协作工作的呈现：子任务名称、运行/思考/调用工具/完成/失败状态、elapsed time、工具输入输出、模型实际返回的推理文本与正文、产物及跳转入口。只在 provider 发来推理内容时显示相应文本；仅有状态时显示状态，不能补造“脑内推理”。流更新保留展开状态与滚动位置，只更新发生变化的节点。

真正 C2C 的最小可行实验从 **同 GPU、同上下文、固定公开 pair** 开始：以官方 Qwen3-0.6B + Qwen2.5-0.5B-Instruct checkpoint，比较 Receiver 单独、Sharer 单独、T2T、C2C 四组，输入相同材料和问题，记录质量、首 token/总时延、GPU 峰值、冷启动与热启动。达到这一真实证据后，再把 GPU 服务接入 `LlmProvider`。不为尚不存在的服务添加可点击的 C2C 开关或模拟进度。

用于 MP 的验证还需覆盖项目真实任务：同一材料的交叉理解、对子任务结果的正确消费、工具调用参数有效性、取消后不再执行动作。即使基础 QA 更快，也要看完整任务是否减少错误和等待，不能用选择题准确率替代桌面/编程验收。

若 GPU 服务确实执行了缓存融合，GUI 才可展示来自该服务的事实：参与模型和方向、参与上下文范围、融合状态/耗时、失败原因、最终输出。张量可不渲染为文字，但任务、工具、产物与结果仍可审查；“无需中间文字”并不等于“人类无法监督系统”。

**依赖用户提供的必要外部条件仅有：可使用的自托管 GPU 主机/服务，以及要验证的实际模型 pair。** 若采用公开小 pair，可使用已发布 checkpoint；若坚持远程 DS4.1 参与缓存融合，则还必须由运行该模型的一方提供 KV 读写执行能力和对应 fuser，单有 API key 不够。当前 GUI 修复不需要等待这些条件。

## 5. 许可与交付状态

仓库根目录 `LICENSE` 是 Apache-2.0；Hugging Face fuser model card 也标 Apache-2.0。但是 `pyproject.toml` 的 license/classifier 写 MIT，存在元数据不一致。作为源码复用审查，应保留实际附带的许可证与来源，并在打包该依赖前核实冲突；不能只看 pip metadata 就宣称 MIT。基础模型许可证需分别保留，不由 fuser 的许可证替代。[LICENSE](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/LICENSE)、[pyproject](https://github.com/thu-nics/C2C/blob/9fa85d35a20e20469af3e282926491222f4f11e0/pyproject.toml)、[fuser model card](https://huggingface.co/nics-efc/C2C_Fuser)

本次完成：论文版本/实验口径核验，固定提交源码与 checkpoint 元数据核验，现有 MP provider/subagent 合同对照，最小真实实验边界。未完成且未声称完成：C2C GPU 实验、模型对训练、远端 KV 服务、跨会话 KV 持久化与实际 MP C2C 任务验收。
