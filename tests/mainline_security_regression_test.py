from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_runtime_http_clients_do_not_follow_redirects_with_credentials() -> None:
    for relative in ("app/ai_client.py", "app/model_health.py", "app/models/runtime_client.py"):
        text = (ROOT / relative).read_text(encoding="utf-8")
        assert "follow_redirects=True" not in text
