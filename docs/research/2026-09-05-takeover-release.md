# 1.0.34 接管交付记录

接管任务：01a06f84-7741-7092-854d-73c046ab0443。保留已有工作，不开 subagent，不重复推导 PRD 或历史架构审计。本次目标是修复实际断路并交付安装版；完整办公／设计上线仍须满足 PRD 的真实验收条件。

## 实际修复

| 问题 | 修复与结果 |
| --- | --- |
| 普通 Studio 对话报 provider_unavailable | bridge 总会加入 effort，旧配置解析因此把空模型档案当成完整覆盖，丢失本机密钥／地址。努力程度现在独立于模型配置；回归先失败，修复后通过。 |
| PowerPoint 原生读写全部绑定失败 | 本机 PowerPoint 16 的 DocumentWindow 没有 HWND 属性。通过实际 HWND 下的 mdiClass + OBJID_NATIVEOM 取得正确窗口，核对文件路径后按 slideId/shapeId 读写。 |
| Excel 选中工作簿与活动工作簿不同时失败 | 旧代码使用 Window.Parent.ActiveWorkbook。现在先匹配文件，再从该 Workbook.Windows 匹配 HWND。 |
| 收藏笔记／分类按钮报错 | Electron 不支持 window.prompt；改用可取消、可键盘提交的应用内输入框。 |
| 材料连续保存并发启动重复任务 | 同一关注项串行执行，运行期间保存合并为一次后续任务；异步拒绝有明确处理。 |
| 已写 tracker 未进入产品 | 关注／停止、来源范围、设置持久化和正常 conversation bridge 已接通；单文件不授权父目录。 |
| 验证链失败 | 修正 settings map 的 unknown 类型和三处已经过时的 UI 文本／布局断言；不删除功能验证。 |

## 验证证据

- PowerPoint 真机：原实现收到有效 HWND 仍返回 `bound_presentation_not_found`；修复后 `Keep this concise` → `Keep concise`，读／写／读回约 5656 ms，`usedBackend=powerpoint.com.powershell`。选中形状 ID 2 所在 SlideID 256 已因插入新页移至第 2 页，定位仍正确。加粗保留为 -1，另一个幻灯片仍为 `UNCHANGED`。
- Excel 真机：另一工作簿处于活动状态时，目标 A1 由 10 变 15，B1 公式仍为 `=A1*2`、结果 30，另一工作簿 A1 仍为 999。生产 backend + SafeActionExecutor 读／写／读回约 9156 ms。
- Office 实物与日志：`data/runtime/office-native-20260905-213049/`、`data/runtime/takeover-office-final.log`。这证明原生适配器和写入链路，未声称模型自主操作和所有 UI 路径均已验收。测试创建的 Office 文档已保存并关闭。
- 真实 Electron 渲染器：`tests/studio_interaction_probe_test.js` 使用实际点击验证收藏输入弹层、已有菜单和首页交互；preload 为确定性测试替身，不计为 provider 验证。
- Windows 文件系统：`data/runtime/takeover-tracker-files.ts` 连续两次临时文件替换保存均触发，未发现本机 watcher 在正常保存后失效，因此没有添加额外监控层。
- 正式 Studio / preload / IPC / Runtime 活链路：`data/runtime/runtime-live-2WkU9t/result.json`。使用隔离测试数据创建关注，真实文件变化触发读文件任务，模型正确回答新金额 271828 SGD 和文件名，会话落盘，停止关注返回 enabled=false。`usedBackend=magic_pointer.messages_multiturn_streaming`，模型桥报告 19823 ms，任务从触发到完成约 25.7 s。修复前此测试真实暴露 effort 覆盖配置问题，修复后通过；未给模型提供预期金额。
- 接管前完整 Python 基线为 1825 passed，Node 和 typecheck 暴露的失败已修复。发布门以本次 `npm run sync` 的新鲜完整结果为准，不以基线冒充发布结果。

## 尚未达到完整 PRD 上线条件的部分

- Figma 只有协议／插件构建测试。没有真实数字插件 ID，构建不生成可安装 manifest；原生多字体、auto-layout、安装与断开尚未验收。
- Word 原生测试在新建测试文档时卡住；已停止这次测试创建的进程，不能据此声称 Word 原生闭环通过。离线 DOCX 路径有测试。
- O03 已有真实 Runtime 报告 `data/runtime/evals/O03/20260905T095111Z-8c9403fe/report.json`，答案涉及第 2、36、37 页和 SGD 100,000。报告仍为 `manual-required`，自动证据 ID／状态未达成；本次没有重复跑模型或改评分器制造绿灯。
- 微信／钉钉、浏览器深读、运行中改指和跨重启办公任务尚未完成整套真实桌面验收。协议测试通过不等于这些场景完成。
- 本机 sync 与公开发布不同；本次不推送 tag、不发布 GitHub release。

## 发布状态

1.0.34 正在执行完整 verify／sync。安装版本与安装后 smoke 完成后更新本节和 STATUS。
