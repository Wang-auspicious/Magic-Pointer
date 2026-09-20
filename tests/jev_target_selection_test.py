"""Jev is a bounded advisory selector, never an input executor."""
import time
import httpx
from app.desktop_actions.jev import JevTargetSelector

CANDIDATES = [{"ref": "@e1", "name": "Archive", "role": "button"}, {"ref": "@e2", "name": "Delete forever", "role": "button"}]


def client(reply, requests):
    def handler(request):
        requests.append(request)
        return httpx.Response(200, json=reply)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_exact_label_avoids_network():
    requests = []
    selector = JevTargetSelector(api_key="test", client=client({}, requests))
    result = selector.select("Archive", CANDIDATES, state_id="s")
    assert result["ref"] == "@e1" and result["usedBackend"] == "uia.exact-label"
    assert not requests


def test_structured_choice_uses_free_model_and_only_known_refs():
    requests = []
    c = client({"answers": {"target": {"choice": "c0", "confidence": 0.98, "probabilities": {"c0": 0.98, "c1": 0.01, "none": 0.01}}}, "cost": "0"}, requests)
    result = JevTargetSelector(api_key="test", client=c).select("Keep this message but remove it from inbox", CANDIDATES, state_id="s")
    assert result["ref"] == "@e1" and result["state_id"] == "s"
    assert result["usedBackend"] == "opencode.jev-1.13-free"
    assert b'jev-1.13-free' in requests[0].content
    assert str(requests[0].url) == "https://opencode.ai/zen/v1/systemone"


def test_unknown_or_uncertain_choice_abstains():
    for choice, confidence in [("c999", 1), ("c0", 0.5), ("none", 1)]:
        c = client({"answers": {"target": {"choice": choice, "confidence": confidence}}}, [])
        result = JevTargetSelector(api_key="test", client=c).select("Handle this", CANDIDATES, state_id="s")
        assert result["ref"] is None
        assert result["candidates"]


def test_deadline_returns_without_waiting_for_slow_remote():
    class Slow:
        def post(self, *_args, **_kwargs):
            time.sleep(0.25)
            return httpx.Response(200, request=httpx.Request("POST", "https://example.invalid"), json={})
    selector = JevTargetSelector(api_key="test", client=Slow(), budget_s=0.025)
    start = time.monotonic()
    result = selector.select("Handle this", CANDIDATES, state_id="s")
    assert time.monotonic() - start < 0.15
    assert result["ref"] is None and result["fallbackReason"] == "deadline"
    assert selector.select("Handle this", CANDIDATES, state_id="s")["fallbackReason"] == "busy"


def test_no_key_or_cancelled_does_not_call_remote():
    requests = []
    c = client({}, requests)
    assert JevTargetSelector(api_key="", client=c).select("Handle this", CANDIDATES, state_id="s")["ref"] is None
    class Cancelled:
        is_cancelled = True
    result = JevTargetSelector(api_key="test", client=c).select("Handle this", CANDIDATES, state_id="s", scope=Cancelled())
    assert result["fallbackReason"] == "cancelled"
    assert not requests


def test_registered_tool_uses_full_raw_pool_and_preserves_state_id():
    import json
    from app.desktop_actions.jev import register_jev_target_tool
    from app.agent_runtime.tool_registry import ToolRegistry, Effect
    class Session:
        def candidate_pool(self, state_id):
            assert state_id == "frozen-7"
            return [{"ref": f"@e{i}", "name": "Save" if i == 150 else f"item {i}"} for i in range(160)]
    registry = ToolRegistry()
    register_jev_target_tool(registry, Session())
    spec = registry.get("choose_ui_target")
    assert spec.effect == Effect.READ
    result = json.loads(spec.execute(state_id="frozen-7", target="Save"))
    assert result["ref"] == "@e150" and result["state_id"] == "frozen-7"
