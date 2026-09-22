# Third-party notices

## Runtime document and image dependencies

The TypeScript Runtime uses the packages below. Their upstream license files
remain distributed with the production dependencies in `node_modules`.

| Package | Installed version | License | Upstream |
|---|---|---|---|
| adm-zip | 0.6.1 | MIT | https://github.com/cthackers/adm-zip |
| docx | 9.7.1 | MIT | https://github.com/dolanmiu/docx |
| exceljs | 4.4.0 | MIT | https://github.com/exceljs/exceljs |
| fast-xml-parser | 5.11.1 | MIT | https://github.com/NaturalIntelligence/fast-xml-parser |
| pdf-lib | 1.17.1 | MIT | https://github.com/Hopding/pdf-lib |
| pdfjs-dist | 6.3.289 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| pptxgenjs | 4.0.1 | MIT | https://github.com/gitbrent/PptxGenJS |
| sharp | 0.35.4 | Apache-2.0 | https://github.com/lovell/sharp |

## HermesAgent (Nous Research)

Parts of the Magic Pointer agent runtime are ported from the local HermesAgent
source (`hermes-agent` 0.18.2). Ported so far:

- `electron/runtime/session.ts` — request-level rough token estimation,
  from `agent/model_metadata.py` (`estimate_tokens_rough`,
  `estimate_messages_tokens_rough`, `estimate_request_tokens_rough`).
- `electron/runtime/agent.ts` — the task list that is re-attached after
  context compaction, from `tools/todo_tool.py` (`TodoStore`,
  `format_for_injection`), reduced to Magic Pointer's replace-only contract.
- `electron/runtime/agent.ts` — token-budgeted tail
  selection with a bounded message-count floor, from
  `agent/context_compressor.py::_find_tail_cut_by_tokens`.
- `electron/runtime/agent.ts` — the anti-thrash
  rule that stops re-summarising a history that will not shrink, from
  `agent/context_compressor.py::should_compress`.

Runtime source comments also recorded contract adaptations in replay cleanup,
tool guardrails, subagents and learning candidates. Component and license
attribution is maintained here; internal module names describe their function.

MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## sv-animations (Sikandar Bhide)

Magic Pointer Studio 的部分动效与布局实现源自 sv-animations
(https://github.com/SikandarJODD/sv-animations)。原独立 `sv_motion.ts` / `sv.css`
已退役；当前对应界面代码使用功能命名，仍保留以下来源与许可证：

- `animated-checkbox` → 计划卡勾选框(勾线 path/划入时长/删除线 spring 参数)
- `file-tree`(folder/file)→ Inspector 文件树展开动效与竖导轨
- `animated-list` → 会话列表弹簧入场(stiffness 500 / damping 30 / y -8)
- `bento-grid`(bento-card)→ Design 概览悬停编排
- `animated-theme-toggler` → 经逐行比对,Studio 既有 View Transition 实现已是其
  等价物(easing 更顺),未重复移植

motion-sv 运行时以解析解阻尼谐振子生成 CSS `linear()` 采样等价替换,视觉参数与源一致。

MIT License

Copyright (c) 2026 Sikandar Bhide

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lucide icons (ISC)

`electron/renderer/icons.ts` 中的 `ic-file-text` / `ic-file-input` /
`ic-calendar` / `ic-bell` / `ic-folder-open` 取自 lucide-static 0.525.0 官方
path 数据，描边统一到外壳的 1.5 约定。参考副本不随源码发行。

ISC License — Copyright (c) for portions of Lucide are held by Bogdan Chadkin
as well as Lucide Contributors.

## sv-particles / sv-agentation — 状态说明(未复制代码)

- **sv-particles**(https://github.com/SikandarJODD/sv-particles):全仓库无
  LICENSE、无 license 字段 → 默认保留所有权利。参考源码不随项目发行，
  **未复制任何代码进产品**；仅采用了
  不受版权保护的数值参数(rotating-toggle 的 135°/弹性贝塞尔/500ms,
  copy-with-feedback 的 2000ms 反馈),实现为自有代码并注明出处。批量采用前需
  先取得作者授权。
- **sv-agentation**(MIT):开发期 Svelte 页面标注工具，未采用，不随项目发行。

## DeepSeek Harness

Parts of the Magic Pointer Studio layout, styling, and interaction structure
are adapted from the local DeepSeek Harness client source at commit
`47f943859bef60e4160492346772ded9b24f765a`.

The current rendering modules are named `chat_view`, `chat_highlight`,
`chat_icons`, `chat_markdown` and `chat_trajectory`; their internal names do
not replace this attribution.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Existing desktop visual assets

The activity frame strips in `electron/renderer/assets/activity/`, library
previews in `electron/renderer/assets/library-previews/`, SVG marks in
`electron/renderer/activity_marks.ts`, effort shader and the Anthropic fonts
were previously extracted from a local Claude Desktop installation for design
comparison. The recorded version for the activity strips is 2.110.0.0, with
9/8 frames at 90 ms per frame. These are third-party assets, not original
Magic Pointer artwork. Renaming their paths does not change their provenance
or establish redistribution rights; the project's MIT license does not grant
rights to these assets. The original local note recorded that the branding
was intended to be replaced before publication.
