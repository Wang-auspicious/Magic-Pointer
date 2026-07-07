from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ai_client import get_ai_config


def main() -> int:
    api_key, base_url, model = get_ai_config()
    if not api_key:
        print("缺少 OPENAI_API_KEY 或 secrets/openai_key.txt。")
        return 2

    base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
    print("model:", model)
    print("base_url:", base_url)

    try:
        import httpx

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "curl/8.0",
        }
        with httpx.Client(timeout=60, follow_redirects=True) as client:
            models = client.get(f"{base_url}/models", headers=headers)
            print("models:", models.status_code, models.text[:300].replace("\n", " "))
            response = client.post(
                f"{base_url}/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "只回复四个字：连接成功"}],
                    "max_tokens": 32,
                },
            )
        print("chat:", response.status_code, response.text[:500].replace("\n", " "))
        return 0 if response.status_code < 400 else 1
    except Exception as exc:
        print("API 测试失败：", type(exc).__name__, str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
