import json

from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.loop import _normalize_result
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.agent_runtime.types import ToolCall


def test_partial_failure_survives_registry_and_model_message():
    partial = {"ok": False, "executed": [{"receiptId": "first-click"}]}

    def run():
        raise ActionFailure(FailureType.TOOL_ERROR, "second click failed", partial_result=partial)

    registry = ToolRegistry()
    registry.register(ToolSpec(name="Steps", description="steps", input_schema={"type": "object", "properties": {}, "required": []}, execute=run, effect=Effect.REVERSIBLE_WRITE))
    executed = registry.execute_tool("Steps", {})
    assert executed.is_error
    assert executed.value == partial
    normalized = _normalize_result(executed, ToolCall(id="c", name="Steps", arguments={}))
    payload = json.loads(normalized.value)
    assert normalized.is_error
    assert payload["partialResult"] == partial
    assert "second click failed" in payload["error"]
