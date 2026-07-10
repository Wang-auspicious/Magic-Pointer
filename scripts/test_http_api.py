from pathlib import Path
import sys, base64, io
from PIL import Image, ImageDraw
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ai_client import _httpx_client, read_local_secret


def post(client, base, headers, payload):
    r = client.post(base + '/chat/completions', headers=headers, json=payload)
    print('status', r.status_code)
    print(r.text[:1000])
    return r


def main() -> int:
    key = read_local_secret('openai_key.txt')
    base = read_local_secret('openai_base_url.txt') or 'https://www.78code.cc/v1'
    model = read_local_secret('model.txt') or 'gpt-5.4-mini'
    if not key:
        print('missing API key')
        return 2
    headers = {'Authorization': f'Bearer {key}', 'Content-Type': 'application/json', 'User-Agent': 'curl/8.0'}

    with _httpx_client(httpx, timeout=60) as client:
        print('--- text ---')
        text_result = post(client, base, headers, {
            'model': model,
            'messages': [{'role': 'user', 'content': '只回复四个字：连接成功'}],
            'max_tokens': 32,
        })

        print('--- vision ---')
        img = Image.new('RGB', (260, 120), 'white')
        draw = ImageDraw.Draw(img)
        draw.text((20, 40), 'Magic Pointer Test', fill='black')
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        data = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
        vision_result = post(client, base, headers, {
            'model': model,
            'messages': [{
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': '图片里有什么文字？'},
                    {'type': 'image_url', 'image_url': {'url': data}},
                ],
            }],
            'max_tokens': 100,
        })
    return 0 if text_result.status_code < 400 and vision_result.status_code < 400 else 1


if __name__ == '__main__':
    raise SystemExit(main())
