from pathlib import Path


def test_worker_supports_live_pi_rpc_prompt_steer_and_settled_receipt() -> None:
    source = Path("scripts/agent_worker.py").read_text(encoding="utf-8")
    assert 'invocation.protocol == "jsonl-rpc"' in source
    assert '"type": "prompt"' in source
    assert '"streamingBehavior": "steer"' in source
    assert '"agent_settled"' in source
    assert "events.jsonl" in source
