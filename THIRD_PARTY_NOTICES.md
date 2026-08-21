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
