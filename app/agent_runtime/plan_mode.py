"""Session-owned planning state, separate from the Todo progress list.

Behavioral reference: Claude Code EnterPlanMode/ExitPlanMode and session
permission transitions. Implementation uses MP's existing event journal.
"""
from __future__ import annotations

import json
from typing import Any, Callable

from app.agent_runtime.tool_registry import Effect, ToolSpec, ToolRegistry


def current_mode(session: Any, fallback: str) -> str:
    if session is None:
        return fallback
    return session.permission_mode(fallback)


def select_mode(session: Any, requested: str) -> str:
    """A changed composer selection overrides the session; an unchanged one
    must not undo an approved plan or an in-loop EnterPlanMode transition."""
    previous = next((event.data['requested'] for event in reversed(session.events)
                     if event.type == 'permission/mode' and 'requested' in event.data), None)
    if previous != requested:
        session.append('permission/mode', {'mode': requested, 'requested': requested})
    return current_mode(session, requested)


def register_plan_tools(registry: ToolRegistry, *, session_getter: Callable[[], Any]) -> None:
    def active():
        session = session_getter()
        if session is None:
            raise ValueError('planning requires a durable task session')
        if session.header.parent_session_id:
            raise ValueError('subagents cannot change the parent planning mode')
        return session

    def enter(scope=None):
        active().append('permission/mode', {'mode': 'plan'})
        return 'Entered plan mode. Read and design only. Use ExitPlanMode with the complete plan for approval before making changes. Todo tracks progress; it does not approve execution.'

    def exit_plan(plan: str, scope=None):
        session = active()
        if current_mode(session, 'default') != 'plan':
            raise ValueError('ExitPlanMode requires plan mode; an already approved plan can be executed directly')
        if not plan.strip() or len(plan) > 32000:
            raise ValueError('plan must contain 1-32000 characters')
        return json.dumps({'kind': 'plan', 'tool': 'ExitPlanMode', 'plan': plan,
            'question': 'Approve this plan and start implementation?',
            'options': ['Approve with manual permissions', 'Approve and accept edits', 'Keep planning'],
            'awaitingUserInput': True}, ensure_ascii=False)

    registry.register(ToolSpec(name='EnterPlanMode', description='进入只读规划阶段。研究和设计，不执行修改；规划完成后用 ExitPlanMode 请求批准。',
        input_schema={'type': 'object', 'properties': {}, 'required': []}, execute=enter,
        effect=Effect.READ, is_concurrency_safe=False, used_backend='session_plan_mode'))
    registry.register(ToolSpec(name='ExitPlanMode', description='提交完整计划供用户批准。plan 是完整方案正文。等待批准后才能执行；Todo 不是批准。',
        input_schema={'type': 'object', 'properties': {'plan': {'type': 'string'}}, 'required': ['plan']},
        execute=exit_plan, effect=Effect.READ, is_concurrency_safe=False,
        used_backend='session_plan_mode', suspends_for_user_input=True))
