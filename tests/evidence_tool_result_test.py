import json

import pytest

from app.agent_runtime.errors import FailureType
from app.agent_runtime.loop import _normalize_result
from app.agent_runtime.tool_registry import ToolResult as ExecutedResult
from app.agent_runtime.types import ToolCall
from app.evidence.contract import Evidence, EvidenceSource, EvidenceStatus


@pytest.mark.parametrize(("status", "failure"), [
    (EvidenceStatus.ERROR, FailureType.TOOL_ERROR),
    (EvidenceStatus.UNSUPPORTED, FailureType.TOOL_ERROR),
    (EvidenceStatus.TIMEOUT, FailureType.TIMEOUT),
    (EvidenceStatus.BUSY, FailureType.COMPUTER_USE_BUSY),
    (EvidenceStatus.DENIED, FailureType.PERMISSION_DENIED),
])
def test_failed_perception_sets_tool_error_without_discarding_evidence(status, failure):
    evidence = Evidence(None, status, 0, EvidenceSource.VISION, note="HTTP 429: unavailable")
    result = _normalize_result(
        ExecutedResult(value=evidence, used_backend="vision", latency_ms=123),
        ToolCall("look-1", "Look", {"anchor": "bbox:0,0,300,300"}),
    )
    assert result.is_error, "model history and both progress renderers must see the perception failure"
    assert result.failure_type == failure
    assert json.loads(result.value) == {
        "status": status.value, "confidence": 0, "value": None, "note": "HTTP 429: unavailable",
    }
    assert result.used_backend == "vision" and result.latency_ms == 123


@pytest.mark.parametrize("status", [EvidenceStatus.OK, EvidenceStatus.DEGRADED, EvidenceStatus.EMPTY_CONFIRMED])
def test_partial_or_confirmed_empty_perception_is_not_a_tool_failure(status):
    evidence = Evidence("visible text" if status is not EvidenceStatus.EMPTY_CONFIRMED else None,
                        status, 0.7, EvidenceSource.OCR)
    result = _normalize_result(ExecutedResult(value=evidence), ToolCall("read-1", "Read", {}))
    assert not result.is_error and result.failure_type is None
    assert json.loads(result.value)["status"] == status.value
