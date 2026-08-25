# SITE-RECON — sv-agentation.com 全站侦察报告

侦察日期:2026-06 会话;方法:静态抓取(首页/changelog/llms.txt HTML 原文)+ GitHub API(仓库元数据/文件树)+ raw.githubusercontent.com(源文件原文)。

## 一、这是什么站
**sv-agentation.com 是 npm 包 `sv-agentation` 的官方文档站**(SvelteKit 单页文档 + changelog)。该包是一个 **dev-only 的 Svelte 5 网页检查器**:在开发模式挂载后,可悬停/点选/框选页面元素、写标注,然后一键把标注导出为结构化 Markdown 上下文(compact/standard/detailed/forensic 四档),粘贴给 Claude Code、Cursor 等 AI 编码工具。灵感来自 agentation.com。
- GitHub:https://github.com/SikandarJODD/sv-agentation(115 stars,master 推送于 2026-08-13)
- 许可证:**MIT**(LICENSE 原文已存档)
- 版本:站上文档为 0.3.x;master 分支已是 **0.4.0**

## 二、全站组件/素材清单(穷尽)
站点路由仅 3 个:`/`(首页即全部文档)、`/changelog`、`/llms.txt`(机器可读全量文档,已存档为 llms.txt)。实际交付物:

| # | 组件/素材 | 一句话描述 |
|---|---|---|
| 1 | `Agentation` 检查器(npm 包本体) | dev-only 悬浮工具栏:元素/文本/分组/区域标注,localStorage 按路由隔离,快捷键 i/c/r/o/d |
| 2 | 标注导出器(note-export) | 把标注编译为四档结构化 Markdown 上下文,含选择器路径、源码位置、组件链、边界框、计算样式 |
| 3 | 公开类型契约(types.ts) | Annotation 快照、ExportPayload、OutputMode、KeyBindings 等纯 TS 类型 |
| 4 | demo-output ×4 | 官方四档输出样例(见 annotation-output-samples/) |
| 5 | 官网 UI 块(apps/web/src/lib/components/ui/*) | badge / button / button-group / code(Shiki 高亮+复制) / copy-button / dialog / kbd / separator / sonner(toast) / tabs / tooltip —— 全部是 **shadcn-svelte 通用注册块**,非本项目原创,且为 Svelte 专用 |
| 6 | 官网 markdown 渲染块(markdown/*) | 文档站的 Markdown→Svelte 渲染件(H1~Table),站点自用 |

## 三、适用性判定(对照需求:Electron 外壳 GUI 的 agent 状态指示 / thinking 流式展示 / 任务列表)
**结论:整个站不提供这三类运行时 UI 素材——就本次采购目标而言不适用,未硬凑。**
1. 类别不符:它是"开发期标注→喂上下文"工具,不含任何 agent 运行状态指示、thinking/流式输出展示或任务列表组件;官网 UI 块全是 shadcn-svelte 通用件(要这类素材应直接去 shadcn-svelte.com)。
2. 技术栈不符:全部 UI 是 Svelte 5 组件(peer: svelte ^5);Magic Pointer 渲染层为原生 TypeScript + DOM(无框架),原样复用不可能,而用户明确禁止模仿重写。
3. 有保留价值的相邻参考件(仅作格式/契约参考,**非可用素材**,均已按原文逐字节存档):
   - `agentation-inspector\types.ts` —— "UI 状态→结构化上下文"的数据契约
   - `agentation-inspector\note-export.ts` + `annotation-output-samples\*.md` —— 四档上下文编译输出
   与 Magic Pointer 的交互编译(gesture→frozen frame→object graph→RunEnvelope)方向相邻。

## 四、存档路径
```
D:\Desktop\Magic Pointer\_sv_sources\sv-agentation\
├── SITE-RECON.md                          ← 本报告
├── llms.txt                               ← 官方全量 API 文档原文(逐字节)
├── agentation-inspector\
│   ├── REPORT.md                          ← 来源/框架/依赖/清单/许可证/用途
│   ├── LICENSE                            ← MIT 原文
│   ├── package.json                       ← v0.4.0 包清单原文
│   ├── README.md                          ← 官方 README 原文
│   ├── code-structure.md                  ← 官方源码结构图原文
│   ├── types.ts                           ← 公开类型原文
│   └── note-export.ts                     ← 导出器源码原文
└── annotation-output-samples\
    ├── REPORT.md
    ├── compact.md / standard.md / detailed.md / forensic.md   ← 官方样例原文
```
