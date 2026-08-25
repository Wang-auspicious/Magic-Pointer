# REPORT — agentation-inspector(sv-agentation 核心组件,参考件)

## 用途一句话
一个 dev-only 的 Svelte 5 网页检查器:悬停/框选页面元素→写标注→一键导出为结构化 Markdown 上下文,供 Claude Code/Cursor 等 AI 编码工具直接粘贴使用。**注意:这是开发期标注工具,不是 Agent 外壳的运行时 UI 组件。**

## 结论(适用性判定)
**不适用作 Magic Pointer(Electron 外壳 GUI)的运行时 UI 素材**:它是 Svelte 5 单框架组件(peerDependencies: svelte ^5),而本项目渲染层是原生 TypeScript + DOM;且功能类别(UI 标注→上下文导出)不属于用户要找的三类素材(agent 状态指示 / thinking 流式展示 / 任务列表)。仅其**数据契约与输出格式设计**(types.ts、note-export.ts、四档输出模式)与本项目的"交互编译→结构化上下文"方向相邻,故按原文存档作参考。按用户要求未做任何改写/移植。

## 来源 URL
- 仓库:https://github.com/SikandarJODD/sv-agentation (branch: master)
- 官网文档:https://sv-agentation.com
- npm:https://www.npmjs.com/package/sv-agentation
- 本目录各文件的原始路径见下"文件清单"

## 版本
- master 分支 package.json:**0.4.0**(2026-08-13 推送)
- 官网/changelog 文档仍描述 **0.3.x API**(旧类型名 `Annotation`/`AnnotationPayload`;0.3.0 起改为更简的公开类型名,master 已用新名如 `AgentationAnnotationSnapshot`)。引用时以本目录 types.ts 原文为准。

## 框架与技术栈
- Svelte 5(run runes,`.svelte.ts` 协调器)+ TypeScript,ESM(`"type": "module"`)
- 运行依赖:`@lucide/svelte ^1.8.0`(图标)、`element-source ^0.0.5`(元素→源码定位);peer: `svelte ^5.0.0`
- 浏览器 DOM + localStorage 持久化,dev-only 挂载(`browser && dev`)

## 许可证
MIT — 见本目录 LICENSE(原文,Copyright (c) 2026 Sikandar JODD)。

## 文件清单(全部为一手原文逐字节拷贝)
| 文件 | 原始路径(raw.githubusercontent.com/SikandarJODD/sv-agentation/master/…) | 说明 |
|---|---|---|
| LICENSE | LICENSE | MIT 许可证原文 |
| package.json | packages/sv-agentation/package.json | 包清单:版本/依赖/exports |
| README.md | packages/sv-agentation/README.md | 官方 README(完整 props/回调/类型文档) |
| code-structure.md | packages/sv-agentation/code-structure.md | 官方源码结构图(贡献者向) |
| types.ts | packages/sv-agentation/src/lib/types.ts | 公开数据契约:Annotation 快照、ExportPayload、OutputMode、KeyBindings 等(纯类型,无框架耦合) |
| note-export.ts | packages/sv-agentation/src/lib/utils/note-export.ts | 四档(compact/standard/detailed/forensic)Markdown 导出器(纯 TS;import 同包 note-capture/types/constants) |

## 未取部分及原因
- `src/lib/components/*.svelte`(工具栏/composer/标记浮层等 UI)与 `internal/controller-*`:Svelte 5 组件,无法在本项目原生 TS 渲染层原样使用;按"不模仿重写"约束不取。
- `apps/web/**`:官网自身(SvelteKit + shadcn-svelte 通用块),非独立可复用素材。
