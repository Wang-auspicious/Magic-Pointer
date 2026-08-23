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

import json
from pathlib import Path
from typing import Any, Sequence

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

    def __init__(self, clock: PhaseClock) -> None:
        self.clock = clock
        self.activities: list[dict[str, Any]] = []
        self.trajectory: list[dict[str, Any]] = []
        self._active_model: dict[str, Any] | None = None
        self._active_message: dict[str, Any] | None = None
        self._tools: dict[str, dict[str, Any]] = {}
        self._trajectory_tools: dict[str, dict[str, Any]] = {}
        self._first_chunk_seen = False

    def _append_record(self, record: dict[str, Any]) -> dict[str, Any]:
        record["seq"] = len(self.trajectory) + 1
        self.trajectory.append(record)
        return record

    def __call__(self, event: Any) -> None:
        kind = str(getattr(event, "kind", ""))
        if kind == "loop_start":
            self.clock.mark("agent_start")
            return
        if kind == "turn_started":
            turn = int(getattr(event, "turn", 0) or 0)
            started_ms = self.clock.mark("model_request", turn=turn)
            self._append_record({
                "kind": "request-header",
                "turn": turn,
                "step": turn,
                "startedAt": started_ms,
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
            return
        if kind == "tool_call_started":
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
    return {
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


def route_slash_command(prompt: str, catalog) -> dict | None:
    """DSH 斜杠管线：``/name args`` 是命令或 skill；否则原样放行给模型。

    - ``/permission [preset]``：无参列出可用预设；有参校验后交渲染层落芯片；
    - ``/model [id]``：走 :func:`app.models_catalog.select_model` 真实写配置；
    - 已知 skill：返回剥离 frontmatter 的正文，由回合注入为指令；
    - 未知名：不是命令，返回 None（按普通问题走模型）。
    """
    text = str(prompt or "").strip()
    if not text.startswith("/"):
        return None
    name, _, rest = text[1:].partition(" ")
    if name in SLASH_COMMANDS:
        args = rest.strip()
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
            from app.agent_runtime.workspace_state import read_workspace

            try:
                steps = max(0, int(args)) if args else 1
            except ValueError:
                return {"ok": False, "error": f"/rewind 步数必须是整数，收到：{args!r}"}
            report = FileCheckpointStore(Path(read_workspace(ROOT))).restore(steps)
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
            return {
                "ok": True,
                "command": {"type": "skill", "name": name},
                "injectedInstruction": body,
                "rest": rest.strip(),
            }
    return None


def _history_text(turns: list[dict[str, Any]], obj: dict[str, Any]) -> str:
    object_label = " · ".join(
        str(obj.get(key) or "").strip() for key in ("app", "windowTitle", "label")
        if str(obj.get(key) or "").strip()
    )
    chunks = [f"当前对象：{object_label}"] if object_label else []
    for turn in turns[-MAX_TURNS:]:
        question = str(turn.get("question") or "").strip()[:2000]
        answer = str(turn.get("answer") or "").strip()[:4000]
        if question:
            chunks.append(f"用户：{question}")
        if answer:
            chunks.append(f"助手：{answer}")
    return "\n\n".join(chunks)


class _HistoryPerceptionBackend:
    """PerceptionBackend over the recorded conversation history + live windows.

    The history is the only local evidence a Studio follow-up owns; window
    enumeration is real and lets the agent look at what is actually on screen.
    """

    def __init__(self, history: str) -> None:
        self._content = history

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


def _build_permission_decisions(grants, denials, once):
    """Thread-scoped memo (CC toolPermissionDecision); empty → None."""
    from app.agent_runtime.permission_decisions import PermissionDecisions

    allowed = tuple(grants or ()) + tuple(once or ())
    denied = tuple(denials or ())
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


def answer_conversation(
    question: str,
    turns: list[dict[str, Any]],
    obj: dict[str, Any],
    permission_preset: str,
    *,
    workspace_root: str = "",
    clock: PhaseClock | None = None,
    reply_style: str = "normal",
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

    # 斜杠管线：命令直接结算；skill 正文作为本回合指令注入（DSH pre-step 同款）。
    from app.agent_runtime.skill_catalog import SkillCatalog

    catalog = SkillCatalog(project_root=ROOT, user_home=Path.home())
    routed = route_slash_command(prompt, catalog=catalog)
    agent_prompt = prompt
    if routed is not None:
        if routed.get("ok") is not True:
            return routed
        if routed["command"]["type"] == "skill":
            agent_prompt = (
                f"<<<SKILL:{routed['command']['name']}>>>\n{routed['injectedInstruction']}\n<<<END SKILL>>>\n\n"
                f"{routed.get('rest') or '按上面的 skill 执行。'}"
            )
        else:
            return routed

    history = _history_text(turns if isinstance(turns, list) else [], obj if isinstance(obj, dict) else {})
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

    runtime: dict[str, Any] = {
        "perception_backend": _HistoryPerceptionBackend(history),
        "vision_backend": None,          # no frozen frame → look is honest unsupported
        "frame_crop": None,
        "guard_probe": None,             # fail-closed: no selection anchor
        "selection_anchor": None,
        "propose": propose,
        "execute_plan": None,
        "enabled_recipes": None,
        "summarize": lambda text: _summarize_history(text),
        "content": history,
        "capture_path": "",
        "target_window": {
            "title": str(window.get("windowTitle") or ""),
            "process_name": str(window.get("app") or ""),
        },
        "command": agent_prompt,
        "reply_style": reply_style,
    }

    from app.agent_runtime.workspace_state import read_workspace

    runtime["workspace_root"] = str(read_workspace(ROOT))
    runtime["permission_mode"] = mode.value
    runtime["permission_preset"] = permission_preset
    # Codex thread workspace_roots: the conversation carries its own
    # workspace; an explicit one overrides the persisted default for THIS
    # request only. The profile default is written by /cwd, never silently
    # by a chip pick (a chip pick used to rewrite workspace.txt globally,
    # leaking this thread's choice into every other conversation).
    explicit_workspace = str(workspace_root or "").strip()
    if explicit_workspace:
        candidate = Path(explicit_workspace).expanduser()
        if not candidate.is_dir():
            return {
                "ok": False,
                "error": f"工作区目录不存在：{explicit_workspace}",
            }
        runtime["workspace_root"] = str(candidate.resolve())

    conversation_clock.mark("runtime_boot")
    report = boot_loop_context(runtime, root=ROOT)
    conversation_clock.mark("runtime_ready")
    ctx = report.ctx
    registry = ctx.get("tools")
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
        import base64

        payload_json = json.dumps({"steps": snapshot}, ensure_ascii=False)
        conversation_clock.mark(
            "plan", plan=base64.b64encode(payload_json.encode("utf-8")).decode("ascii")
        )

    todo_store.on_update = _push_plan
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


    evidence = f"[本次对话历史]\n{history}" if history.strip() else ""
    try:
        import hashlib

        session_key = str(window.get("windowTitle") or "chat")
        agent_session_id = "agent-studio-" + hashlib.sha256(session_key.encode("utf-8")).hexdigest()[:32]
        agent_session = sessions.open_or_create(agent_session_id, repair=True)
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
        activity_sink = _ConversationActivitySink(conversation_clock)
        from app.agent_runtime.session import cancel_interrupt_check

        terminal = run_agent_turn(
            agent_prompt,
            objects=[],
            registry=registry,
            client=client,
            allowed_effects=_effect_ceiling(mode.value),
            permission_mode=mode.value,
            tool_limit=64,
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
            permission_decisions=_build_permission_decisions(
                permission_grants, permission_denials, permission_grant_once
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
        return {
            "ok": False,
            "error": answer or "模型没有返回内容。",
            "usedBackend": getattr(client, "used_backend", "") or "agent_runtime",
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
        agent_session_id=agent_session_id,
        interaction_ledger=interaction_ledger,
    )
    result["answer"] = answer
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
        )
    write_json(result)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
