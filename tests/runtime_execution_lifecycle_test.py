import asyncio
import threading
import time

from agent_runtime_loop_test import ScriptedBackend, collect, make_params
from app.agent_runtime.coding_tools import register_coding_tools
from app.agent_runtime.hooks import HookManager
from app.agent_runtime.loop import _execute_one
from app.agent_runtime.model_client import LoopModelClient, ToolCallArrived, TurnDone
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall
from app.governance.cancellation import CancellationRegistry, CancellationScope, CancellationToken
from app.run_kernel import project_operations


def test_hook_rewrite_precedes_journal_and_effect_classification(tmp_path):
    registry = ToolRegistry()
    seen = []
    registry.register(ToolSpec(name="Mode", description="mode", input_schema={"type": "object", "properties": {"write": {"type": "boolean"}}, "required": ["write"]}, execute=lambda write, **_: seen.append(write) or "done", effect=Effect.READ, effect_for=lambda args: Effect.REVERSIBLE_WRITE if args["write"] else Effect.READ))
    session = FileSessionStore(tmp_path).create("task")
    backend = ScriptedBackend([ToolCallArrived(call=ToolCall(id="c", name="Mode", arguments={"write": False})), TurnDone(usage=None, raw_text=None)], [TurnDone(usage=None, raw_text="done")])
    asyncio.run(collect(make_params(client=LoopModelClient(backend), registry=registry, session=session, hook_manager=HookManager(pre_tool_use=[lambda _: {"input": {"write": True}}]))))
    assert seen == [True]
    operation = project_operations(session.events)[0]
    assert operation.arguments == {"write": True}
    assert operation.effect == "reversible_write"


def test_interrupt_reaches_inflight_tool_scope():
    registry = ToolRegistry()
    requested = threading.Event()
    observed = threading.Event()

    def work(scope):
        requested.set()
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            if scope.is_cancelled():
                observed.set()
                return "cancelled"
            time.sleep(.02)
        return "missed cancel"

    registry.register(ToolSpec(name="Wait", description="wait", input_schema={"type": "object", "properties": {}, "required": []}, execute=work, effect=Effect.READ))
    cancellations = CancellationRegistry()
    with CancellationScope(cancellations) as outer:
        _execute_one(registry, ToolCall(id="c", name="Wait", arguments={}), cancellations, outer, (Effect.READ,), None, interrupt_check=requested.is_set)
    assert observed.is_set()


def test_bash_cancellation_kills_command_before_effect(tmp_path):
    registry = ToolRegistry()
    register_coding_tools(registry, workspace_root=tmp_path)
    token = CancellationToken()
    timer = threading.Timer(.2, token.cancel)
    timer.start()
    started = time.monotonic()
    result = registry.execute_tool("Bash", {"command": 'python -c "import time; time.sleep(2); open(\'late.txt\',\'w\').write(\'bad\')"'}, scope=token)
    timer.join()
    assert time.monotonic() - started < 1.7
    assert result.is_error
    assert not (tmp_path / "late.txt").exists()
