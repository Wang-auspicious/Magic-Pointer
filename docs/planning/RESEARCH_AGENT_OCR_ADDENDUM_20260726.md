# Magic Pointer 补充调研：OCR 与 Agent 接入

Date: 2026-07-26

## 结论

1. **OCR 默认使用 RapidOCR + ONNX Runtime。** 它是 Apache-2.0、多平台、本机运行的
   PaddleOCR 工程化封装，默认中英文，适合普通 Windows/macOS CPU；Tesseract 留作无
   RapidOCR 时的兜底。
2. **PaddleOCR 是高精度/复杂文档可选后端。** PP-OCRv5 覆盖 100+ 语言，官方支持
   Windows/macOS 和 CPU/GPU/新硬件，但依赖、模型和启动成本更高，不适合作为动作条的
   默认冷启动。
3. **MCP 降级为最后兼容层。** 当前 Agent 生态更有价值的连接点是 turn/prompt/tool
   生命周期 hook、原生 JSON-RPC/session、plugin、steer 和可恢复后台 loop。
4. **ACP 值得预留。** 它标准化 client↔agent 会话、流式更新、权限和多 session；
   ACP proxy 还能拦截 prompt 并注入上下文。它比 MCP 更接近 Magic Pointer 的“操作层
   + 多 Agent 客户端”，但当前兼容面仍不如各 Agent 原生 hook，不能提前宣称完成。
5. **不引入通用重型 graph 框架作为核心依赖。** LangGraph、Microsoft Agent
   Framework 和 OpenAI Agents SDK 的有效思想是 durable execution、checkpoint、
   HITL、guardrail、trace、handoff。Magic Pointer 已将这些收敛为自己的签名 Action
   Graph 与 TaskStore，避免把模型编排框架绑死在桌面操作底层。

## 实际采用

- 上游源码：`external/rapidocr`
- 固定 commit：`095232a4c94f7f0e6600ba5bba1177010ad696d4`
- 安装：`rapidocr==3.8.1` + 已有 `onnxruntime`
- 本机实测：对 Magic Pointer 在普通应用冻结的 640×420 屏幕区域完成 OCR，
  `ocrEngine=rapidocr-onnx`，没有上传截图。
- 真实 hooks：
  - Claude `UserPromptSubmit.additionalContext`
  - Gemini `BeforeAgent.additionalContext`
  - Pi `before_agent_start` / `/pointer` / RPC steer
- MCP server 继续存在，但 Dashboard 标为 FALLBACK。

## 来源

- RapidOCR: https://github.com/RapidAI/RapidOCR
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- PP-OCRv5 deployment: https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv5/PP-OCRv5.md
- Claude hooks: https://code.claude.com/docs/en/hooks
- Gemini hooks: https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md
- Pi extensions: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- OpenCode plugins: https://opencode.ai/docs/plugins/
- Cursor Agent loop hooks: https://cursor.com/blog/agent-best-practices
- ACP architecture: https://agentclientprotocol.com/get-started/architecture
- ACP proxy chains: https://agentclientprotocol.com/rfds/proxy-chains
- LangGraph: https://github.com/langchain-ai/langgraph
- OpenAI Agents SDK loop: https://openai.github.io/openai-agents-python/running_agents/
- Microsoft Agent Framework workflow graph: https://learn.microsoft.com/en-us/agent-framework/workflows/workflows
