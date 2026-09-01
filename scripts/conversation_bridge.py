"""Continue a Magic Pointer Studio conversation through the agent runtime.

Studio follow-ups are agent turns, not a plain text echo: the same plugin tree
(perception / look / capability / guard / model-client) boots here as in the
selection path, so the conversation is genuinely multi-turn and can call tools.
The composer's permission chip rides ``payload.permissionPreset`` (DSH 式预设：
sandbox × approval 捆绑，见 app.agent_runtime.permission_presets) and gates
every tool call exactly like the selection loop.

Honest boundaries (no live selection):
- perception reads operate over the recorded conversation history and the real
  visible-window list; a stale selection has no frozen frame, so pixel/OCR
  reads are unsupported rather than fabricated;
- the guard probe is fail-closed (no selection anchor) → in-loop writes are not
  executed; write capabilities propose a signed plan that the user confirms;
- ``local_action_input`` is the pure question, so history text can never hijack
  the request into a zero-model local action (red-team T6).
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Sequence

# 打包版以 ``python -I``（isolated）启动：sys.path 既没有 scripts/ 也没有
# cwd，import _bridge_common 必须发生在自举之前——与其它每座桥相同的
# 前置 sys.path 插入。真机失败不是理论：1.0.24 安装版 Studio 对话全部
# bridge_no_output exit 1，dev 树（不加 -I）永远复现不了。
_BRIDGE_ROOT = Path(__file__).resolve().parents[1]
if str(_BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_ROOT))

try:
    from scripts._bridge_common import (
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )
except ModuleNotFoundError:  # direct `python scripts/conversation_bridge.py`
    from _bridge_common import (  # type: ignore[no-redef]
        PayloadTooLargeError,
        ensure_root_on_path,
        force_utf8_stdio,
        read_bounded_json_payload,
        write_json,
    )

ensure_root_on_path()

ROOT = Path(__file__).resolve().parents[1]

from app.actions.office import clean_replacement_text  # noqa: E402
from app.ai_client import ask_text_model, request_ai_config  # noqa: E402
from app.governance.latency_budget import (  # noqa: E402
    BudgetPolicy,
    Stage,
    TimeoutAction,
)
from app.system_context import list_visible_windows  # noqa: E402
from scripts.bridge_progress import PhaseClock  # noqa: E402

MAX_QUESTION_CHARS = 4000
MAX_TURNS = 12

# Agent session 身份前缀。
#
# Agent session 是磁盘上一条哈希链 JSONL：断点续跑摘要（interrupted_turn_summary）、
# 待办、取消请求、has_pending_work 全挂在它上面。所以"一条对话 = 一条 session"
# 必须成立。旧实现用 ``sha256(object.windowTitle or "chat")`` 派生，而普通文本
# 对话根本没有 selection object —— 全 app 的普通对话塌缩成同一个常量 id，
# 于是：新开的对话会被上一条对话的未完成任务续跑块劫持、停止按钮打断的是
# 别的对话、并发两条对话往同一条哈希链里追加。
#
# 现在身份钉在 conversationId 上。两个前缀让"线程自己的 session"和"旧的
# 共享 session"可区分：只有带这两个前缀的 id 才会被信任并复用，历史遗留的
# ``agent-studio-<sha>`` 一律重新派生，不把旧的共享状态带进新语义。
CONV_SESSION_PREFIX = "agent-studio-conv-"
NEW_SESSION_PREFIX = "agent-studio-new-"

# Studio 对话没有"反馈节奏"约束：用户坐在屏幕前等这一轮答完。loop 默认的
# FULL_ANSWER 4 秒预算是给划线快速问答设计的（L8 延迟表），直接套在对话上
# 会在普通 3-6 秒模型回答上误杀（"full answer budget exhausted"）。这里把
# 对话路径的 FULL_ANSWER 预算放宽到 1 小时——实际不可能耗尽，只有用户取消
# 或进程退出才会停。
CONVERSATION_BUDGET_MS = 60 * 60 * 1000
CONVERSATION_BUDGETS = {
    Stage.FULL_ANSWER: BudgetPolicy(
        stage=Stage.FULL_ANSWER,
        budget_ms=CONVERSATION_BUDGET_MS,
        on_timeout=TimeoutAction.STASH_BACKGROUND,
    ),
}

from app.agent_runtime.slash_directory import SLASH_COMMANDS  # noqa: E402


def _trajectory_text(value: Any) -> str:
    """Serialize structured runtime facts as the JSON DSH's tool rows display."""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value or "")


class _ConversationActivitySink:
    """Project loop events into honest Studio lifecycle rows and phase marks."""

    #: 流式正文增量的节流窗口：太密会淹没 stderr，太久会让用户看着空屏。
    CHUNK_FLUSH_INTERVAL_S = 0.12

    def __init__(
        self,
        clock: PhaseClock,
        request_header: Mapping[str, Any] | None = None,
    ) -> None:
        self.clock = clock
        raw_header = request_header if isinstance(request_header, Mapping) else {}
        try:
            max_tokens = max(0, int(raw_header.get("maxTokens") or 0))
        except (TypeError, ValueError):
            max_tokens = 0
        self._request_header = {
            "promptCache": bool(raw_header.get("promptCache")),
            **(
                {"usedBackend": str(raw_header.get("usedBackend") or "")[:160]}
                if str(raw_header.get("usedBackend") or "").strip()
                else {}
            ),
            **({"maxTokens": max_tokens} if max_tokens else {}),
        }
        self.activities: list[dict[str, Any]] = []
        self.trajectory: list[dict[str, Any]] = []
        self._active_model: dict[str, Any] | None = None
        self._active_message: dict[str, Any] | None = None
        self._tools: dict[str, dict[str, Any]] = {}
        self._trajectory_tools: dict[str, dict[str, Any]] = {}
        self._first_chunk_seen = False
        self._pending_chunk_text: list[str] = []
        self._last_chunk_flush = 0.0
        # 思考流（reasoning）：trajectory message record 逐轮累计 + 进度行
        # 边想边画；turn_reasoning 供终态载荷的 thinking 字段（Think 行）。
        self._pending_reasoning_text: list[str] = []
        self._last_reasoning_flush = 0.0
        self.turn_reasoning: list[str] = []

    def _flush_answer_chunks(self) -> None:
        if not self._pending_chunk_text:
            return
        text = "".join(self._pending_chunk_text)
        self._pending_chunk_text.clear()
        blob = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._last_chunk_flush = time.perf_counter()
        try:
            self.clock.mark_blob("answer_chunk", blob)
        except Exception:  # noqa: BLE001 - 流式展示永远不能弄坏回合本身
            self._pending_chunk_text.clear()

    def _flush_reasoning_chunks(self) -> None:
        if not self._pending_reasoning_text:
            return
        text = "".join(self._pending_reasoning_text)
        self._pending_reasoning_text.clear()
        blob = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._last_reasoning_flush = time.perf_counter()
        try:
            self.clock.mark_blob("reasoning_chunk", blob)
        except Exception:  # noqa: BLE001 - 流式展示永远不能弄坏回合本身
            self._pending_reasoning_text.clear()

    def _append_record(self, record: dict[str, Any]) -> dict[str, Any]:
        record["seq"] = len(self.trajectory) + 1
        self.trajectory.append(record)
        return record

    def __call__(self, event: Any) -> None:
        kind = str(getattr(event, "kind", ""))
        if kind == "loop_start":
            self.clock.mark("agent_start")
            return
        if kind == "tools_truncated":
            dropped = tuple(str(name) for name in getattr(event, "dropped", ()) if str(name))
            limit = int(getattr(event, "limit", 0) or 0)
            self._append_record({
                "kind": "notice",
                "state": "done",
                "text": (
                    f"已注册 {limit + len(dropped)} 个工具，超过本轮上限 {limit}；"
                    "本轮未暴露："
                    + "、".join(dropped)
                    + "。需要时可用 Tools 搜索加载。"
                ),
            })
            return
        if kind == "turn_started":
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            self.turn_reasoning.clear()
            turn = int(getattr(event, "turn", 0) or 0)
            started_ms = self.clock.mark("model_request", turn=turn)
            self._append_record({
                "kind": "request-header",
                "turn": turn,
                "step": turn,
                "startedAt": started_ms,
                **self._request_header,
            })
            self._active_message = self._append_record({
                "kind": "message",
                "turn": turn,
                "step": turn,
                "state": "running",
                "text": "",
                "startedAt": started_ms,
            })
            self._active_model = {
                "kind": "model",
                "turn": turn,
                "state": "running",
                "startedMs": started_ms,
            }
            self.activities.append(self._active_model)
            self._first_chunk_seen = False
            return
        if kind == "model_chunk":
            text = str(getattr(event, "text", "") or "")
            if self._active_message is not None and text:
                self._active_message["text"] = str(self._active_message.get("text") or "") + text
            if not self._first_chunk_seen:
                self._first_chunk_seen = True
                at_ms = self.clock.mark("model_first_chunk")
                if self._active_model is not None:
                    self._active_model["firstTokenMs"] = max(
                        0.0, at_ms - float(self._active_model.get("startedMs") or 0.0)
                    )
                if self._active_message is not None:
                    self._active_message["firstTokenAt"] = at_ms
            if text:
                # Studio 流式正文：增量 base64 上线，渲染层边收边画。
                self._pending_chunk_text.append(text)
                if time.perf_counter() - self._last_chunk_flush >= self.CHUNK_FLUSH_INTERVAL_S:
                    self._flush_answer_chunks()
            return
        if kind == "reasoning_chunk":
            # 思考流：记进 message record（正式渲染）+ 进度行（边想边画）。
            text = str(getattr(event, "text", "") or "")
            if not text:
                return
            self.turn_reasoning.append(text)
            if self._active_message is not None:
                self._active_message["reasoning"] = (
                    str(self._active_message.get("reasoning") or "") + text
                )
            self._pending_reasoning_text.append(text)
            if time.perf_counter() - self._last_reasoning_flush >= self.CHUNK_FLUSH_INTERVAL_S:
                self._flush_reasoning_chunks()
            return
        if kind == "tool_call_started":
            # 工具边界前把持有的正文尾巴冲出去：模型先说话再调工具时，
            # 文本必须落在工具行之前，不能被节流窗口吞到下一轮。
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            call_id = str(getattr(event, "id", ""))
            name = str(getattr(event, "name", "") or "tool")
            started_ms = self.clock.mark("tool_call", id=call_id, name=name)
            activity = {
                "kind": "tool",
                "id": call_id,
                "name": name,
                "state": "running",
            }
            self.activities.append(activity)
            self._tools[call_id] = activity
            record = self._append_record({
                "kind": "tool",
                "turn": int(self._active_message.get("turn", 0)) if self._active_message else 0,
                "callId": call_id,
                "name": name,
                "state": "running",
                "text": "",
                "startedAt": started_ms,
            })
            self._trajectory_tools[call_id] = record
            return
        if kind == "tool_call_finished":
            result = getattr(event, "result", None)
            call_id = str(getattr(result, "tool_call_id", ""))
            name = str(getattr(result, "tool_name", "") or "tool")
            failed = bool(getattr(result, "is_error", False))
            backend = str(getattr(result, "used_backend", "") or "")
            latency = float(getattr(result, "latency_ms", 0.0) or 0.0)
            completed_ms = self.clock.mark(
                "tool_result", id=call_id, name=name,
                state="error" if failed else "done", backend=backend or "-",
                latency_ms=latency,
            )
            activity = self._tools.get(call_id)
            if activity is None:
                activity = {"kind": "tool", "id": call_id, "name": name}
                self.activities.append(activity)
            activity.update({
                "state": "error" if failed else "done",
                "latencyMs": latency,
                "usedBackend": backend,
            })
            record = self._trajectory_tools.get(call_id)
            if record is None:
                record = self._append_record({
                    "kind": "tool",
                    "turn": int(self._active_message.get("turn", 0)) if self._active_message else 0,
                    "callId": call_id,
                    "name": name,
                    "startedAt": max(0.0, completed_ms - latency),
                })
            record.update({
                "state": "error" if failed else "done",
                "completedAt": completed_ms,
                "latencyMs": latency,
                "usedBackend": backend,
                "text": _trajectory_text(getattr(result, "arguments", "")),
                "result": _trajectory_text(getattr(result, "value", "")),
                "isError": failed,
            })
            return
        if kind == "turn_finished":
            # 回合正文结束：把节流窗口里持有的尾巴全部冲出去，不能丢字。
            self._flush_answer_chunks()
            self._flush_reasoning_chunks()
            state = getattr(event, "state", None)
            transition = getattr(state, "transition", None)
            state_value = str(
                getattr(transition, "value", None)
                or getattr(state, "value", None)
                or "done"
            )
            at_ms = self.clock.mark("model_response", state=state_value)
            if self._active_model is not None:
                self._active_model["state"] = (
                    "error" if state_value not in {"done", "completed", "tool_result"} else "done"
                )
                self._active_model["latencyMs"] = max(
                    0.0, at_ms - float(self._active_model.pop("startedMs", at_ms))
                )
            if self._active_message is not None:
                self._active_message["state"] = (
                    "error" if state_value not in {"done", "completed", "tool_result"} else "done"
                )
                self._active_message["completedAt"] = at_ms
            return
        if kind == "budget_renewed":
            self.clock.mark(
                "budget_renewed",
                turn=getattr(event, "turn", 0),
                renewals=getattr(event, "renewals_used", 0),
            )


def _completed_result(
    mapped: dict[str, Any],
    *,
    client_backend: str,
    permission_preset: str,
    activities: list[dict[str, Any]],
    trajectory: list[dict[str, Any]],
    timing_ms: float,
    question: str = "",
    agent_session_id: str | None = None,
    has_pending_work: bool = False,
    interaction_ledger: dict[str, Any] | None = None,
) -> dict[str, Any]:
    answer = clean_replacement_text(str(mapped.get("answer") or ""))
    model_usage = mapped.get("modelUsage") or {}
    used_backend = mapped.get("usedBackend") or client_backend or "agent_runtime"
    records = [dict(record) for record in trajectory]
    if question:
        records = [{
            "seq": 1,
            "kind": "user",
            "turn": 1,
            "state": "done",
            "text": question,
            "startedAt": 0.0,
        }] + [{**record, "seq": int(record.get("seq", 0) or 0) + 1} for record in records]
    messages = [record for record in records if record.get("kind") == "message"]
    if messages:
        last_message = messages[-1]
        if not str(last_message.get("text") or "").strip():
            last_message["text"] = answer
        last_message["usedBackend"] = used_backend
        for source, target in (
            ("outputTokens", "outputTokens"),
            ("reasoningTokens", "reasoningTokens"),
        ):
            value = model_usage.get(source) if isinstance(model_usage, dict) else None
            if isinstance(value, (int, float)):
                last_message[target] = value
    receipts_by_id = {
        str(receipt.get("toolCallId") or ""): receipt
        for receipt in mapped.get("loopReceipts") or []
        if isinstance(receipt, dict)
    }
    for record in records:
        if record.get("kind") != "tool":
            continue
        receipt = receipts_by_id.get(str(record.get("callId") or ""))
        if receipt is None:
            continue
        record["text"] = _trajectory_text(receipt.get("arguments") or record.get("text") or "")
        record["result"] = _trajectory_text(receipt.get("valuePreview") or record.get("result") or "")
        record["usedBackend"] = str(receipt.get("usedBackend") or record.get("usedBackend") or "")
        if isinstance(receipt.get("latencyMs"), (int, float)):
            record["latencyMs"] = receipt["latencyMs"]
    _completed_payload = {
        "ok": True,
        "answer": answer,
        "usedBackend": used_backend,
        "permissionPreset": permission_preset or "workspace-write",
        "receipts": mapped.get("loopReceipts") or [],
        "events": mapped.get("events") or [],
        "activities": activities,
        "trajectory": records,
        "modelUsage": model_usage,
        "timingMs": timing_ms,
        "agentSessionId": agent_session_id,
        "hasPendingWork": bool(has_pending_work),
        "interactionLedger": interaction_ledger,
        # Clarification / plan-approval gates ride through so the Stage can
        # render its option buttons (same shape as loop_answer's AWAITING_USER).
        **(
            {
                "awaitingUserInput": True,
                "pendingInput": mapped["pendingInput"],
            }
            if mapped.get("awaitingUserInput") and mapped.get("pendingInput")
            else {}
        ),
    }
    return _strip_options_tail(_completed_payload)


def _strip_options_tail(result: dict[str, Any]) -> dict[str, Any]:
    """等待输入时，loop_answer 把选项编成 1. 2. 3. 接在问题后面——那是给没有
    结构化审批面的表面准备的。Studio 有审批卡，正文再印一遍编号列表就是
    同一个事实写两遍，还会诱导用户打字回答。这里把追加的选项尾巴裁掉。"""
    pending = result.get("pendingInput")
    if isinstance(pending, dict) and pending.get("options"):
        tail = "\n\n" + "\n".join(
            f"{index}. {option}" for index, option in enumerate(pending["options"], 1)
        )
        answer_text = result.get("answer")
        if isinstance(answer_text, str) and answer_text.endswith(tail):
            result["answer"] = answer_text[: -len(tail)].rstrip()
    return result


def emit_plan_snapshot(clock: PhaseClock, steps: Any) -> None:
    """Codex update_plan live push：计划快照以 base64 走 mark_blob。

    必须走 blob 通道：_token 的 120 字符截断会把多步计划的 JSON 剪断，
    渲染层 decodePlanToken 解不出来，计划卡就静默消失。
    """
    payload_json = json.dumps({"steps": steps}, ensure_ascii=False)
    clock.mark_blob("plan", base64.b64encode(payload_json.encode("utf-8")).decode("ascii"))


def emit_session_ready(clock: PhaseClock, agent_session_id: str) -> None:
    """把 durable session id 广播给渲染层——停止/插话按钮都指向它。"""
    clock.mark("session_ready", sid=agent_session_id)


def resolve_agent_session_id(
    *,
    explicit: str = "",
    conversation_id: str = "",
) -> str:
    """一条对话一条 agent session。

    优先级：
    1. 线程已经持有的、本语义下签发的 session（``agentSessionId`` 由结果回传、
       conversation_store 落库、下次请求带回来）——新建对话的第一轮还没有
       conversationId，只能靠它把第一轮和后续轮接上；
    2. conversationId 派生——确定性、跨轮稳定，历史对话也能就地脱离旧的
       共享 session；
    3. 都没有 → 全新对话的第一轮，签发一个唯一 id，由回传链路落库。

    绝不回退到常量：一个共享 id 会把断点状态、取消请求和哈希链写入混在一起。
    """
    explicit = str(explicit or "").strip()
    if explicit.startswith((CONV_SESSION_PREFIX, NEW_SESSION_PREFIX)):
        # session id 会变成文件名，越界的一律重新派生而不是让 store 抛错。
        if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", explicit):
            return explicit
    conversation_id = str(conversation_id or "").strip()
    if conversation_id:
        digest = hashlib.sha256(conversation_id.encode("utf-8")).hexdigest()[:32]
        return CONV_SESSION_PREFIX + digest
    return NEW_SESSION_PREFIX + uuid.uuid4().hex


def route_slash_command(
    prompt: str,
    catalog,
    *,
    workspace_root: Path | None = None,
) -> dict | None:
    """DSH 斜杠管线：``/name args`` 是命令或 skill；否则原样放行给模型。

    - ``/permission [preset]``：无参列出可用预设；有参校验后交渲染层落芯片；
    - ``/model [id]``：走 :func:`app.models_catalog.select_model` 真实写配置；
    - ``/compact`` / ``/help``：只返回延后命令，runtime 启动后执行；
    - 已知 skill：返回剥离 frontmatter 的正文，由回合注入为指令；
    - 未知名：不是命令，返回 None（按普通问题走模型）。
    """
    text = str(prompt or "").strip()
    if not text.startswith("/"):
        return None
    name, _, rest = text[1:].partition(" ")
    if name in SLASH_COMMANDS:
        args = rest.strip()
        if name in {"compact", "help"}:
            return {
                "ok": True,
                "command": {"type": name},
            }
        if name == "permission":
            from app.agent_runtime.permission_presets import PRESETS

            if not args:
                return {
                    "ok": True,
                    "command": {"type": "permission"},
                    "answer": "可用权限预设：" + "、".join(PRESETS) + "。用 /permission <名字> 切换。",
                }
            if args not in PRESETS:
                return {"ok": False, "error": f"未知权限预设：{args}（可用：{', '.join(PRESETS)}）"}
            return {
                "ok": True,
                "command": {"type": "permission", "preset": args},
                "answer": f"权限预设已切换为 {args}。",
            }
        if name == "cwd":
            from app.agent_runtime.workspace_state import read_workspace, write_workspace

            if not args:
                return {
                    "ok": True,
                    "command": {"type": "cwd"},
                    "answer": f"当前工作区：{read_workspace(ROOT)}。用 /cwd <目录路径> 切换。",
                }
            try:
                resolved = write_workspace(ROOT, Path(args))
            except (OSError, ValueError) as exc:
                return {"ok": False, "error": f"工作区切换失败：{exc}"}
            return {
                "ok": True,
                "command": {"type": "cwd", "path": str(resolved)},
                "answer": f"工作区已切换为 {resolved}，下一次发送即生效。",
            }
        if name == "rewind":
            # B5-25：checkpoint 的用户入口。备份落在 <workspace>/.mp/backups，
            # 跨进程持久；默认回滚最近一次改动，/rewind N 回滚 N 步。
            from app.agent_runtime.coding_tools import FileCheckpointStore

            if workspace_root is None:
                return {
                    "ok": False,
                    "error": "当前会话未绑定文件夹，无法回滚文件。",
                }

            try:
                steps = max(0, int(args)) if args else 1
            except ValueError:
                return {"ok": False, "error": f"/rewind 步数必须是整数，收到：{args!r}"}
            report = FileCheckpointStore(workspace_root).restore(steps)
            return {
                "ok": True,
                "command": {"type": "rewind"},
                "answer": report,
            }
        # /model
        from app import models_catalog

        args = rest.strip()
        if not args:
            listing = models_catalog.list_models()
            names = [entry["id"] for entry in listing["groups"][0]["models"][:12]]
            return {
                "ok": True,
                "command": {"type": "model"},
                "answer": "当前模型：" + str(listing["current"]) + "。网关模型（前 12）：" + "、".join(names),
            }
        result = models_catalog.select_model(args)
        if not result.get("ok"):
            return {"ok": False, "error": str(result.get("error") or "模型切换失败。")}
        return {
            "ok": True,
            "command": {"type": "model", "model": args},
            "answer": f"默认模型已切换为 {args}，下一次发送即生效。",
        }
    if catalog is not None:
        body = catalog.load_skill_body(name)
        if body:
            # 斜杠显式加载也计入使用频次（P2-5），与注入路径共用
            # skill-usage.json，SkillLoader 同分排序时高频技能靠前。
            try:
                from app.agent_runtime.skill_usage import bump_skill_usage, usage_env_user_dir

                bump_skill_usage(usage_env_user_dir(ROOT / "data" / "runtime"), name)
            except OSError:
                pass
            return {
                "ok": True,
                "command": {"type": "skill", "name": name},
                "injectedInstruction": body,
                "rest": rest.strip(),
            }
    return None


def _help_text(catalog, registry) -> str:
    commands = "\n".join(
        f"/{name} — {description}"
        for name, description in SLASH_COMMANDS.items()
    )
    skills = catalog.list_skills()
    skill_lines = "\n".join(
        f"/{row['name']} — {row['description']}"
        for row in skills
    ) or "（当前没有可由用户调用的技能）"
    tool_names = "、".join(spec.name for spec in registry.list()) or "（无）"
    return (
        "可用命令：\n"
        f"{commands}\n\n"
        "可用技能：\n"
        f"{skill_lines}\n\n"
        "当前 Runtime 工具：\n"
        f"{tool_names}"
    )


def _object_label_text(obj: dict[str, Any]) -> str:
    object_label = " · ".join(
        str(obj.get(key) or "").strip() for key in ("app", "windowTitle", "label")
        if str(obj.get(key) or "").strip()
    )
    return f"当前对象：{object_label}" if object_label else ""


_SCENE_EVIDENCE_ID_RE = re.compile(r"\[scene-evidence:([0-9a-f]{16})\]")


def _scene_evidence_id(evidence: dict[str, Any]) -> str:
    identity = {
        key: str(evidence.get(key) or "").strip()
        for key in ("capturePath", "annotatedPath", "label", "contentDigest")
    }
    return hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16]


def _scene_evidence_ids(messages) -> set[str]:
    ids: set[str] = set()
    for message in messages or ():
        ids.update(_SCENE_EVIDENCE_ID_RE.findall(str(message.content or "")))
    return ids


def _selection_evidence_text(
    turns: list[dict[str, Any]],
    *,
    exclude_ids: set[str] | frozenset[str] = frozenset(),
) -> str:
    """Retain per-turn selection facts that EventSession messages do not own."""
    chunks: list[str] = []
    for index, turn in enumerate(turns[-MAX_TURNS:], 1):
        # 划线轮次的现场证据随轮持久化：截图存档路径 + 当时读到的内容。
        # 没有它，几分钟后的追问就接不上那次圈选（证据早已出上下文）。
        evidence = turn.get("evidence") if isinstance(turn.get("evidence"), dict) else None
        if evidence:
            evidence_id = _scene_evidence_id(evidence)
            if evidence_id in exclude_ids:
                continue
            label = str(evidence.get("label") or "").strip()
            capture = str(evidence.get("capturePath") or "").strip()
            annotated = str(evidence.get("annotatedPath") or "").strip()
            head = (
                f"[第{index}轮现场证据] [scene-evidence:{evidence_id}]"
                f"{f' 对象：{label}' if label else ' '}"
            )
            paths = "；".join(
                part for part in (
                    f"截图存档：{capture}" if capture else "",
                    f"标注图：{annotated}" if annotated else "",
                ) if part
            )
            chunks.append(head if not paths else f"{head} {paths}")
            digest = str(evidence.get("contentDigest") or "").strip()
            if digest:
                chunks.append(f"当时读取到的内容：{digest[:1200]}")
    return "\n\n".join(chunks)


def _history_text(turns: list[dict[str, Any]], obj: dict[str, Any]) -> str:
    """Legacy Electron history projection used only for first attachment.

    Established EventSessions already project their lossless user/assistant
    messages through ``derive_messages()``; injecting this truncated copy on
    every turn would duplicate and sometimes contradict that durable truth.
    """
    chunks = [text for text in (_object_label_text(obj),) if text]
    for turn in turns[-MAX_TURNS:]:
        question = str(turn.get("question") or "").strip()[:2000]
        answer = str(turn.get("answer") or "").strip()[:4000]
        if question:
            chunks.append(f"用户：{question}")
        if answer:
            chunks.append(f"助手：{answer}")
    scene_evidence = _selection_evidence_text(turns)
    if scene_evidence:
        chunks.append(scene_evidence)
    return "\n\n".join(chunks)


class _HistoryPerceptionBackend:
    """PerceptionBackend over saved object/scene evidence + live windows.

    Durable user/assistant/tool history stays on EventSession's model surface;
    this backend only exposes evidence not represented by those messages.
    """

    def __init__(self, history: str) -> None:
        self._content = history

    def set_content(self, history: str) -> None:
        self._content = str(history or "")

    def read_around(self, anchor: str, radius: int) -> list[dict]:
        if not self._content.strip():
            return []
        return [{"text": self._content[:12000], "source": "conversation", "confidence": 1.0}]

    def dump_subtree(self, anchor: str, depth: int) -> dict | None:
        return None

    def find_in_window(self, pattern: str) -> list[dict]:
        pattern = str(pattern or "")
        if not pattern:
            return []
        hits: list[dict] = []
        for line in self._content.splitlines():
            if pattern in line:
                hits.append({"text": line[:500]})
                if len(hits) >= 20:
                    break
        return hits

    def list_windows(self) -> list[dict]:
        rows: list[dict] = []
        for window in list_visible_windows():
            title = str(window.get("title") or "").strip()
            if not title or title == "Magic Pointer Overlay":
                continue
            rows.append({
                "hwnd": int(window.get("hwnd") or 0),
                "title": title[:120],
                "process_name": str(window.get("app") or ""),
                "pid": int(window.get("pid") or 0),
            })
        return rows

    def get_focused(self) -> dict | None:
        for window in list_visible_windows():
            title = str(window.get("title") or "").strip()
            if title and title != "Magic Pointer Overlay":
                return {
                    "hwnd": int(window.get("hwnd") or 0),
                    "title": title[:120],
                    "process_name": str(window.get("app") or ""),
                    "pid": int(window.get("pid") or 0),
                }
        return None


def _tool_names(value: Any) -> tuple[str, ...]:
    """Canonical tool names or bounded ``Bash(prefix)`` grant rules.

    A grant becomes a permission decision, so the shape is checked here rather
    than trusted. Free-form strings never widen the thread permission memo.
    """
    if not isinstance(value, (list, tuple)):
        return ()
    names: list[str] = []
    for item in list(value)[:64]:
        name = str(item or "").strip()
        bare_name = re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name)
        bash_rule = re.fullmatch(r"Bash\(([^()\r\n]{1,160})\)", name)
        if bare_name or (bash_rule and bash_rule.group(1).strip()):
            names.append(name)
    return tuple(dict.fromkeys(names))


def _build_permission_decisions(grants, denials, once, *, registry=None):
    """Thread memo normalized to tools that exist on this runtime surface."""
    from app.agent_runtime.permission_decisions import PermissionDecisions

    def canonical(values) -> tuple[str, ...]:
        normalized: list[str] = []
        for value in values or ():
            rule = str(value or "").strip()
            if not rule:
                continue
            if registry is None:
                normalized.append(rule)
                continue
            if re.fullmatch(r"Bash\(([^()\r\n]{1,160})\)", rule):
                try:
                    registry.get("Bash")
                except KeyError:
                    continue
                normalized.append(rule)
                continue
            name = registry.canonical_name(rule)
            try:
                registry.get(name)
            except KeyError:
                continue
            normalized.append(name)
        return tuple(dict.fromkeys(normalized))

    allowed = canonical(tuple(grants or ()) + tuple(once or ()))
    denied = canonical(denials)
    if not allowed and not denied:
        return None
    return PermissionDecisions(allowed=allowed, denied=denied)


def _effect_ceiling(permission_mode: str):
    from app.agent_runtime.permission_modes import PermissionMode
    from app.agent_runtime.tool_registry import Effect

    PermissionMode(permission_mode)  # reject unknown configuration early
    return tuple(Effect)


def _summarize_history(history_text: str) -> str:
    from app.agent_runtime.compaction_prompt import (
        COMPACT_SOURCE_MODEL_CAP_CHARS,
        compaction_instructions,
    )

    try:
        return ask_text_model(
            compaction_instructions(),
            context_text=str(history_text)[:COMPACT_SOURCE_MODEL_CAP_CHARS],
            timeout_s=25.0,
            attempts=1,
        )
    except Exception:
        return ""


def _resolve_workspace_root(explicit_workspace: str) -> Path | None:
    raw = str(explicit_workspace or "").strip()
    if not raw:
        return None
    candidate = Path(raw).expanduser()
    if not candidate.is_dir():
        raise ValueError(f"工作区目录不存在：{raw}")
    return candidate.resolve()


def answer_conversation(
    question: str,
    turns: list[dict[str, Any]],
    obj: dict[str, Any],
    permission_preset: str,
    *,
    workspace_root: str = "",
    clock: PhaseClock | None = None,
    reply_style: str = "normal",
    conversation_id: str = "",
    agent_session_id: str = "",
    permission_grants: Sequence[str] | tuple = (),
    permission_denials: Sequence[str] | tuple = (),
    permission_grant_once: Sequence[str] | tuple = (),
) -> dict[str, Any]:
    from app.agent_runtime.permission_modes import PermissionMode
    from app.agent_runtime.permission_presets import PRESETS, mode_for_preset
    from app.fabric.engine import FabricEngine, run_agent_turn
    from app.fabric.loop_answer import terminal_to_answer
    from app.harness.builtin_bundle import boot_loop_context

    conversation_clock = clock or PhaseClock("conversation")
    prompt = str(question or "").strip()
    if not prompt:
        return {"ok": False, "error": "问题不能为空。"}
    if len(prompt) > MAX_QUESTION_CHARS:
        return {"ok": False, "error": f"问题最多 {MAX_QUESTION_CHARS} 字。"}
    try:
        mode: PermissionMode = mode_for_preset(permission_preset or "workspace-write")
    except KeyError:
        return {"ok": False, "error": f"未知权限预设：{permission_preset}（可用：{', '.join(PRESETS)}）"}

    try:
        resolved_workspace_path = _resolve_workspace_root(workspace_root)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    resolved_workspace = (
        str(resolved_workspace_path)
        if resolved_workspace_path is not None
        else ""
    )

    # 斜杠管线：命令直接结算；skill 正文作为本回合指令注入（DSH pre-step 同款）。
    from app.agent_runtime.skill_catalog import SkillCatalog

    catalog = SkillCatalog(
        project_root=resolved_workspace_path,
        user_home=Path.home(),
        include_project=resolved_workspace_path is not None,
    )
    routed = route_slash_command(
        prompt,
        catalog=catalog,
        workspace_root=resolved_workspace_path,
    )
    agent_prompt = prompt
    deferred_command: str | None = None
    if routed is not None:
        if routed.get("ok") is not True:
            return routed
        if routed["command"]["type"] == "skill":
            agent_prompt = (
                f"<<<SKILL:{routed['command']['name']}>>>\n{routed['injectedInstruction']}\n<<<END SKILL>>>\n\n"
                f"{routed.get('rest') or '按上面的 skill 执行。'}"
            )
        elif routed["command"]["type"] in {"compact", "help"}:
            deferred_command = str(routed["command"]["type"])
        else:
            return routed

    safe_turns = turns if isinstance(turns, list) else []
    safe_obj = obj if isinstance(obj, dict) else {}
    legacy_history = _history_text(safe_turns, safe_obj)
    legacy_evidence = (
        f"[旧对话首次迁移]\n{legacy_history}"
        if safe_turns and legacy_history.strip()
        else ""
    )
    current_evidence = "\n\n".join(
        text for text in (
            _object_label_text(safe_obj),
            _selection_evidence_text(safe_turns),
        ) if text
    )
    window = obj if isinstance(obj, dict) else {}

    def _identity_transform(_command: str, context_text: str, _recipe_id: str) -> str:
        return context_text

    active_engine = FabricEngine(model_transform=_identity_transform)

    def propose(recipe_id: str, args: dict) -> dict:
        planned = active_engine.plan(
            agent_prompt,
            objects=[],
            recipe_id=recipe_id,
            parameters=dict(args or {}),
        )
        if planned.get("ok") is not True:
            return {
                "ok": False,
                "error": str(planned.get("error") or "plan_failed"),
                "recipeId": recipe_id,
            }
        return {
            "ok": True,
            "recipeId": recipe_id,
            "requiresConfirmation": planned["plan"].get("requiresConfirmation"),
            "plan": planned["plan"],
        }

    history_backend = _HistoryPerceptionBackend(current_evidence)
    runtime: dict[str, Any] = {
        # Durable user/assistant messages live in EventSession. Perception and
        # local context retain only object/scene facts so an established
        # session cannot rediscover a truncated duplicate history via tools.
        "perception_backend": history_backend,
        "vision_backend": None,          # no frozen frame → look is honest unsupported
        "frame_crop": None,
        "guard_probe": None,             # fail-closed: no selection anchor
        # 对象证据（从划线/圈选入库的对话才有）：存在才注入"圈选"身份与
        # 冻结帧规则；普通文本对话谎称有圈选对象会把模型骗去全桌面空转。
        "selection_anchor": obj if isinstance(obj, dict) and obj else None,
        "propose": propose,
        "execute_plan": None,
        "enabled_recipes": None,
        "summarize": lambda text: _summarize_history(text),
        "content": current_evidence,
        "capture_path": "",
        "target_window": {
            "title": str(window.get("windowTitle") or ""),
            "process_name": str(window.get("app") or ""),
        },
        "command": agent_prompt,
        "reply_style": reply_style,
    }

    # 后台 job 完成推送（Hermes notify_on_complete）：cell 先进 runtime，
    # durable session 打开后回填真正的 enqueue 回调。
    inbox_cell: dict[str, Any] = {"fn": None}
    runtime["session_inbox"] = lambda text: (inbox_cell["fn"] or (lambda _t: None))(text)
    runtime["workspace_root"] = resolved_workspace
    runtime["permission_mode"] = mode.value
    runtime["permission_preset"] = permission_preset
    # Codex thread workspace_roots: the conversation carries its own
    # workspace; an explicit one overrides the persisted default for THIS
    # request only. The profile default is written by /cwd, never silently
    # by a chip pick (a chip pick used to rewrite workspace.txt globally,
    # leaking this thread's choice into every other conversation).
    conversation_clock.mark("runtime_boot")
    report = boot_loop_context(runtime, root=ROOT)
    conversation_clock.mark("runtime_ready")
    ctx = report.ctx
    registry = ctx.get("tools")
    if deferred_command == "help":
        return {
            "ok": True,
            "answer": _help_text(catalog, registry),
            "command": {"type": "help"},
            "usedBackend": "agent_runtime.slash_help",
            "permissionPreset": permission_preset,
            "timingMs": conversation_clock.total("total", ok=1),
        }
    client = ctx.get("model_client")
    compactor = ctx.get("compactor")
    token_estimator = ctx.get("token_estimator")
    precondition_factory = ctx.get("precondition_factory")
    sessions = ctx.get("sessions")
    request_header = ctx.get("model_request_header")
    model_cfg = next(
        row.resolved_config for row in report.rows if row.id == "model-client"
    )
    context_tokens = int(
        ctx.get("context_budget") or model_cfg.get("context_budget_tokens") or 64000
    )

    # Codex update_plan live push: every todo_write transitions the plan card.
    todo_store = ctx.get("todo_store")

    def _push_plan(snapshot):
        emit_plan_snapshot(conversation_clock, snapshot)

    todo_store.on_update = _push_plan

    # 计划门：模型想收工但计划还有未完成步骤 → nudge 续跑（最多两次，防死循环）。
    plan_nudges = {"count": 0}

    def _plan_completion_gate():
        steps = todo_store.read()
        pending = [s for s in steps if s.get("status") != "completed"]
        if not pending or plan_nudges["count"] >= 2:
            return None
        plan_nudges["count"] += 1
        names = "；".join(str(s.get("content"))[:40] for s in pending[:5])
        return (
            f"（计划门）计划还有 {len(pending)} 步未完成：{names}。"
            "继续执行；每做完一步调用 todo_write 把该步标为 completed、"
            "正在做的标为 in_progress。全部完成后正常给出最终回答。"
        )
    try:
        resolved_session_id = resolve_agent_session_id(
            explicit=agent_session_id,
            conversation_id=conversation_id,
        )
        # 渲染层由此拿到停止/插话要指向的 durable session（Studio stop/steer）。
        emit_session_ready(conversation_clock, resolved_session_id)
        agent_session = sessions.open_or_create(resolved_session_id, repair=True)
        if deferred_command == "compact":
            session_messages, compact_surface_hash = agent_session.surface_snapshot()
            if not session_messages and legacy_evidence:
                from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role

                agent_session.append_message(AgentMessage(
                    role=Role.USER,
                    content=legacy_evidence,
                    tool_call_id=None,
                    name=None,
                    origin=ORIGIN_DATA,
                    injected=True,
                ))
                session_messages, compact_surface_hash = agent_session.surface_snapshot()
        else:
            session_messages = agent_session.derive_messages()
            compact_surface_hash = ""
        if deferred_command == "compact":
            before_count = len(session_messages)
            before_tokens = int(token_estimator(session_messages))
            compacted_messages = list(compactor(list(session_messages), force=True))
            after_count = len(compacted_messages)
            after_tokens = int(token_estimator(compacted_messages))
            if after_tokens < before_tokens:
                replacement = agent_session.replace_messages_if_unchanged(
                    compacted_messages,
                    expected_surface_hash=compact_surface_hash,
                    reason="manual_compaction",
                )
                if replacement is None:
                    answer = (
                        "未替换：压缩期间对话收到新消息或仍有回合在运行，"
                        "请等当前回合结束后再试。"
                    )
                else:
                    answer = (
                        f"已压缩：{before_count} 条消息 → {after_count} 条，"
                        f"估算 token {before_tokens} → {after_tokens}"
                        f"（减少 {before_tokens - after_tokens}）。"
                    )
            else:
                answer = (
                    "未替换：压缩后估算 token 未下降"
                    f"（{before_tokens} → {after_tokens}，"
                    f"{before_count} 条消息 → {after_count} 条）。"
                )
            return {
                "ok": True,
                "answer": answer,
                "command": {"type": "compact"},
                "usedBackend": "agent_runtime.compactor",
                "permissionPreset": permission_preset,
                "timingMs": conversation_clock.total("total", ok=1),
                "agentSessionId": resolved_session_id,
                "hasPendingWork": bool(
                    getattr(agent_session, "has_pending_work", lambda: False)()
                ),
            }

        # EventSession already carries lossless user/assistant/tool messages.
        # Only an old Electron conversation attaching to an empty Agent
        # session gets the legacy full-history projection, once. Every
        # established turn retains just the object label and saved selection
        # evidence that the Agent session itself does not own.
        first_legacy_attachment = not session_messages and bool(safe_turns)
        if first_legacy_attachment:
            evidence_body = legacy_history
        else:
            fresh_scene_evidence = _selection_evidence_text(
                safe_turns,
                exclude_ids=_scene_evidence_ids(session_messages),
            )
            evidence_body = "\n\n".join(
                text for text in (
                    _object_label_text(safe_obj),
                    fresh_scene_evidence,
                ) if text
            )
        history_backend.set_content(evidence_body)
        evidence = (
            legacy_evidence
            if first_legacy_attachment
            else (
                f"[本轮对象与现场证据]\n{evidence_body}"
                if evidence_body.strip()
                else ""
            )
        )
        inbox_cell["fn"] = lambda text: agent_session.enqueue_inbox(text, "next-step")
        # Harness-v2 resume: if the previous turn ended unfinished, surface
        # the breakpoint on this send. One-shot by construction — this turn
        # becomes the newest one, so the reduction moves past it.
        continuation_block = ""
        try:
            from app.agent_runtime.resume_context import continuation_prefix

            continuation_block = continuation_prefix(
                agent_session.interrupted_turn_summary()
            )
        except Exception:
            continuation_block = ""
        activity_sink = _ConversationActivitySink(
            conversation_clock,
            request_header=request_header,
        )
        from app.agent_runtime.session import cancel_interrupt_check

        terminal = run_agent_turn(
            agent_prompt,
            objects=[],
            registry=registry,
            client=client,
            allowed_effects=_effect_ceiling(mode.value),
            permission_mode=mode.value,
            # Keep headroom for the direct coding/desktop surface plus MCP
            # tools; any real overflow is surfaced as ToolsTruncated notice.
            tool_limit=128,
            precondition_context_factory=precondition_factory,
            compactor=compactor,
            context_budget_tokens=context_tokens,
            token_estimator=token_estimator,
            hook_manager=ctx.get("hooks"),
            session=agent_session,
            request_header=request_header,
            local_action_input=agent_prompt,
            evidence_input="\n\n".join(x for x in (continuation_block, evidence) if x) or None,
            budgets=CONVERSATION_BUDGETS,
            event_sink=activity_sink,
            interaction_metadata={
                "appName": str(window.get("app") or "").strip(),
            },
            interrupt_check=cancel_interrupt_check(agent_session),
            nudge_hooks=(_plan_completion_gate,),
            keepalive=conversation_clock.mark,
            # 计划必须过参数边界：loop 用它做压缩后的未完成步骤回贴，
            # 以及 BUDGET_EXHAUSTED 的部分交付。桥自己拿了 todo_store 挂
            # on_update 推计划卡，却没交给 loop —— 长任务压过一次上下文
            # 之后，进度就只剩摘要模型记得住多少。
            todo_store=todo_store,
            permission_decisions=_build_permission_decisions(
                permission_grants,
                permission_denials,
                permission_grant_once,
                registry=registry,
            ),
            # 超大工具结果全文落盘 <workspace>/.mp/tool-results（与 .mp/backups
            # 并列），模型拿预览+绝对路径，可用 read_file 分页回读。
            tool_result_dir=(
                str(resolved_workspace_path / ".mp" / "tool-results")
                if resolved_workspace_path is not None
                else None
            ),
        )
    except Exception as exc:  # noqa: BLE001 - loop crash must never kill the answer path
        timing_ms = conversation_clock.total("total", ok=0)
        return {
            "ok": False,
            "error": f"Agent 运行失败：{type(exc).__name__}",
            "usedBackend": "agent_runtime",
            "timingMs": timing_ms,
        }

    mapped = terminal_to_answer(terminal, agent_prompt)
    answer = clean_replacement_text(str(mapped.get("answer") or ""))
    if not answer or answer.startswith("AI 调用失败"):
        failure = str(
            mapped.get("error")
            or mapped.get("loopTerminatedReason")
            or ("empty_answer" if not answer else answer)
        ).strip()
        return {
            "ok": False,
            "error": failure,
            "loopTerminatedReason": mapped.get("loopTerminatedReason"),
            "usedBackend": getattr(client, "used_backend", "") or "agent_runtime",
            "timingMs": conversation_clock.total("total", ok=0),
        }
    timing_ms = conversation_clock.total("total", ok=1)
    from app.telemetry.interaction_ledger import InteractionLedger

    ledger_entries = InteractionLedger.from_session(agent_session).query()
    interaction_ledger = (
        ledger_entries[-1].to_public_dict() if ledger_entries else None
    )
    result = _completed_result(
        mapped,
        client_backend=getattr(client, "used_backend", ""),
        permission_preset=permission_preset,
        activities=activity_sink.activities,
        trajectory=activity_sink.trajectory,
        timing_ms=timing_ms,
        question=question,
        agent_session_id=resolved_session_id,
        has_pending_work=bool(
            getattr(agent_session, "has_pending_work", lambda: False)()
        ),
        interaction_ledger=interaction_ledger,
    )
    result["answer"] = answer
    # 思考流（用户裁决：思考流一定要有）：turn 级 thinking 供 Think 行渲染；
    # 逐轮 reasoning 已在 trajectory message record 里。
    turn_thinking = "".join(activity_sink.turn_reasoning).strip()
    if turn_thinking:
        result["thinking"] = turn_thinking
    # 终态计划卡（与实时推送同一形状）
    result["plan"] = {"steps": todo_store.read()} if todo_store.has_items() else None
    return result


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
    except (PayloadTooLargeError, ValueError) as exc:
        write_json({"ok": False, "error": f"请求格式不对：{exc}"})
        return 2

    from app.agent_runtime.permission_presets import PRESETS

    permission_preset = str(payload.get("permissionPreset") or "workspace-write")
    if permission_preset not in PRESETS:
        write_json({"ok": False, "error": f"未知权限预设：{permission_preset}（可用：{', '.join(PRESETS)}）"})
        return 2
    reply_style = str(payload.get("replyStyle") or "normal").strip().lower()[:20]

    with request_ai_config(payload.get("modelRuntime")):
        result = answer_conversation(
            str(payload.get("question") or ""),
            payload.get("turns") if isinstance(payload.get("turns"), list) else [],
            payload.get("object") if isinstance(payload.get("object"), dict) else {},
            permission_preset,
            workspace_root=str(payload.get("workspaceRoot") or ""),
            reply_style=reply_style,
            conversation_id=str(payload.get("conversationId") or ""),
            agent_session_id=str(payload.get("agentSessionId") or ""),
            # 权限授权条的三个通道（本会话总是允许 / 仅这一次 / 拒绝）。
            # main() 原先不读它们，于是 run_command 这类 LOCAL_IRREVERSIBLE
            # 工具在 workspace-write 下永远 ask：用户点了「总是允许」，下一轮
            # 又被同一道门拦住，编程闭环走不完。
            permission_grants=_tool_names(payload.get("permissionGrants")),
            permission_denials=_tool_names(payload.get("permissionDenials")),
            permission_grant_once=_tool_names(payload.get("permissionGrantOnce")),
        )
    write_json(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
