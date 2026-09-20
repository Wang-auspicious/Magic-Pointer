# 模型菜单与兼容目录交付

开发树保持 **1.0.49**。按用户要求只构建、启动开发版，不运行 sync、不制作或替换安装器。保留接手时的其他未提交工作。

## 最终界面

- 主菜单 **244 × 139 CSS px**：四个固定模型、分隔线、More models；24px 行高，13px/19px 字体，4px 外内边距，12px 面板圆角，蓝色选中勾。没有 Fast mode 或 usage credits 文案。
- 每个模型名后都有灰色来源标签，主菜单和 More 一致。来源来自配置/目录，OpenCode `/go` 与 `/zen` 区分显示；本机实际目录是 `opencode-zen`，不能把用户举例的 `opencode-go` 写成虚假的固定标签。
- More **320 × 最多 216 CSS px**，约八行，内部上下滚动。窗口变小时继续限制在可用区域内，并避开标题栏。第一项和最后一项都做了命中验证。
- 固定项用四个有序位置保存，取消第三项留下第三个空位，再选其他模型填入第三位；不会自动把取消项补回，也不会强制固定当前调用模型。满四项时先取消再替换，刷新目录与重开菜单保留选择。
- 本机此前保存的是三个 id，本次按用户明确要求补齐第四个默认项。后续验证保留用户实际固定项，恢复验证前的实际调用模型（最后一轮为 `deepseek-v4.1-flash`）。此初始化不改变后续取消勾选时保留空位的行为。

## 本地来源与实现边界

Claude Desktop 安装资源来自 `C:/Program Files/WindowsApps/Claude_2.110.0.0_x64__pzs8sxrjxfjjc/app/resources/ion-dist/assets/v1`。这是本机编译后的 JS/CSS，不声称获取了未随安装包发布的原始 TS：

- `shared-frame-C5qE0AlO.js`：Menu 的 `p-1`、compact 控件高度、行内边距、分隔线与选中状态。
- `c6a992d55-CCAJX9iv.css`：24px 控件、13px 字体/19px 行高、6px 行圆角、`#2a78d6` 勾色，以及浅色 `0 8px 24px #0000001f, 0 2px 6px #00000014` / 深色阴影。
- `shared-13-D9bKPPt5.js` 与 Code 模型组件：快捷键、选中勾和 More。244px 主菜单宽按用户图 2 校准；More 的 216px 高度按用户后续“小高度、上下滚动”要求确定。

用户提到的 Pi 实际存在于 `D:/AI_Agents/pi`（MIT）。阅读了 `packages/ai/src/models.ts`、`model-catalog.ts`、`models-store.ts`、`types.ts` 及 coding-agent model registry。吸收 provider + model 联合身份、每模型元数据和目录部分失败语义，没有把 MP Runtime 外包给 Pi，也没有拷贝整套 provider 栈。

## 模型目录与实际运行

- 所有启用的模型 profile 并发读取目录，同名 id 在不同 provider 下保留独立身份；点击同时切换 profile、模型、地址、协议与凭据。凭据不进入渲染器目录。
- `/models` 保留 `contextWindow`、`context_length`、`context_window` 和 `top_provider.context_length`；明确的模型元数据优先，其次既有模型族表，再用 profile 默认值。未知模型仍可加入，不伪称每个网关都返回精确窗口。
- 发给 Runtime 的请求带上发现的元数据，真正的 compaction budget 使用同一条解析路径。已有显式 `MAGIC_POINTER_CONTEXT_TOKENS` 仍优先。
- 本机使用旧 secret 文件配置，仍由 Python 读取原地址、凭据和模型；Electron 仅补充目录元数据，不用空 profile 覆盖旧配置。切换模型实际走原有 bridge 并回读。
- 某一 profile 目录失败不抹掉其他服务商，错误在 More 内展示。未宣称每个兼容服务商的远程生成端点均已逐一验收。

## 切换卡顿与统一模型

用户实际截图里的“正在切换…”来自一个昂贵的多余操作：旧 secret 配置只需写一行模型名，却冷启动整个 Fabric Python bridge，成功后又等待完整远程目录刷新。

- Electron 直接按 Python 读取侧相同的优先级写本地 `model.txt`；已有 profile 仍写选中 profile。环境覆盖和写入错误保持真实反馈。
- 点击后立即关闭菜单，成功响应后使用已加载的目录更新模型；切换路径不再启动 Python、重读 `/models` 或展示等待卡。目录刷新用请求序号防止旧响应覆盖较新的选择。
- 实际开发版 main + preload + IPC 的切换验证 **57ms**（包含验证脚本40ms观测间隔），`selectionMs` 记录在实际见证内。不是远程模型推理耗时。
- 删除 More 的“先取消一个已勾选模型…”悬停句子及外部模型按钮的文本/视觉说明。
- 删除 `get_vision_model/base_url/key/api_mode` 四个独立配置入口和目录的 `visionModel` 字段；文字与读图共用所选模型、地址、凭据和协议，不再因旧 Gemini 配置转发到第二个模型。视觉 benchmark 也使用普通模型配置。真实的模型能力检查保留，不伪造服务商未提供的能力。
- 回归测试明确放入旧视觉环境变量，仍验证请求发给当前所选模型和 Responses 端点。

## 验证证据

红灯覆盖：取消第三项被自动补回、同名 provider 被合并、网关 1M/128K 元数据丢成64K、菜单宽408px、More 越过窗口底部、标题栏遮住第一项、缺少来源标签与 More 高度过大。上述测试随后通过。

- `scripts/probe_model_menu.cjs`：真实 Chromium 输入与布局，模型目录为明确标记的 fixture；最终主菜单244×139、More320×216，720×480窗口下仍可滚动到首尾。
- `scripts/verify_model_menu.cjs --keep-open --four-defaults`：真实 main、preload、IPC、用户保存配置和真实网关37个模型；四项默认、取消/替换第三项、重开持久化、实际模型选择、Runtime元数据一致均通过。该脚本调用实际 DOM 点击处理器，避免用户切到其他应用造成 native input 丢焦；真实 Chromium 输入及命中由前述独立探针覆盖。最终恢复验证前模型，保留四项配置。`usedBackend=real_electron_main_preload_ipc`。
- 实际 model-client bundle 补充验证：模型元数据1,000,000进入`context_budget`；显式环境覆盖后为96,000。
- Node **237 个文件通过**；全套 TypeScript、ESLint、Electron 构建通过。Python **2318 passed / 1 failed / 325.70s**，唯一失败仍为原有的`selection_bridge_test.py::test_screen_region_enrich_falls_back_to_full_capture_without_selection_bbox`，本批未改感知逻辑。三项压缩测试现在显式固定测试预算，避免其结果随用户正在切换的真实模型窗口变化；旧独立视觉覆盖功能对应的五项测试随入口移除，由统一路由的请求测试覆盖新契约。

日志、完整见证和截图：`data/runtime/model-menu-20260919/`；实际应用证据在其 `actual/` 子目录，`delivered.png` 是留给用户的真实窗口，非 fixture。这里只验收目录、配置与 GUI，没有额外发送模型生成请求。
