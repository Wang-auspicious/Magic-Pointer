# Third-party notices

## HermesAgent (Nous Research)

Parts of the Magic Pointer agent runtime are ported from the local HermesAgent
source (`hermes-agent` 0.18.2). Ported so far:

- `app/agent_runtime/token_estimate.py` — request-level rough token estimation,
  from `agent/model_metadata.py` (`estimate_tokens_rough`,
  `estimate_messages_tokens_rough`, `estimate_request_tokens_rough`).
- `app/agent_runtime/todo_store.py` — the task list that is re-attached after
  context compaction, from `tools/todo_tool.py` (`TodoStore`,
  `format_for_injection`), reduced to Magic Pointer's replace-only contract.
- `app/agent_runtime/memory.py::_tail_cut_by_tokens` — token-budgeted tail
  selection with a bounded message-count floor, from
  `agent/context_compressor.py::_find_tail_cut_by_tokens`.
- `app/agent_runtime/loop.py::_MAX_FRUITLESS_COMPACTIONS` — the anti-thrash
  rule that stops re-summarising a history that will not shrink, from
  `agent/context_compressor.py::should_compress`.

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

Magic Pointer Studio 的动效组件层(`electron/renderer/sv_motion.ts`、
`electron/renderer/sv.css` 的对应段落,以及 `studio.ts` 中计划卡/文件树/会话列表/
Design bento 的编排)逐字移植自 sv-animations
(https://github.com/SikandarJODD/sv-animations,原文存 `_sv_sources/sv-animations/`):

- `animated-checkbox` → 计划卡勾选框(勾线 path/划入时长/删除线 spring 参数)
- `file-tree`(folder/file)→ Inspector 文件树展开动效与竖导轨
- `animated-list` → 会话列表弹簧入场(stiffness 500 / damping 30 / y -8)
- `bento-grid`(bento-card)→ Design 概览悬停编排
- `animated-theme-toggler` → 经逐行比对,Studio 既有 View Transition 实现已是其
  等价物(easing 更顺),未重复移植
- `smooth-cursor` → 经用户裁决不上(源码留档 `_sv_sources`)

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
path 数据(原文存 `_sv_sources/icons/`),描边统一到外壳的 1.5 约定。

ISC License — Copyright (c) for portions of Lucide are held by Bogdan Chadkin
as well as Lucide Contributors.

## sv-particles / sv-agentation — 状态说明(未复制代码)

- **sv-particles**(https://github.com/SikandarJODD/sv-particles):全仓库无
  LICENSE、无 license 字段 → 默认保留所有权利。96 个源文件仅存档于
  `_sv_sources/sv-particles/` 作参考,**未复制任何代码进产品**;本批仅采用了
  不受版权保护的数值参数(rotating-toggle 的 135°/弹性贝塞尔/500ms,
  copy-with-feedback 的 2000ms 反馈),实现为自有代码并注明出处。批量采用前需
  先取得作者授权。
- **sv-agentation**(MIT):经侦察为开发期 Svelte 页面标注工具,与外壳 GUI
  无关,未采用;types 契约与输出样例存档于 `_sv_sources/sv-agentation/`。

## DeepSeek Harness

Parts of the Magic Pointer Studio layout, styling, and interaction structure
are adapted from the local DeepSeek Harness client source at commit
`47f943859bef60e4160492346772ded9b24f765a`.

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
