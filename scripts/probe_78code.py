from pathlib import Path
import sys
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ai_client import read_local_secret
key = read_local_secret('openai_key.txt')
model = read_local_secret('model.txt') or 'gpt-4o-mini'
candidates = [
    'https://www.78code.cc/v1',
    'https://78code.cc/v1',
    'https://api.78code.cc/v1',
    'https://www.78code.cc/api/v1',
    'https://78code.cc/api/v1',
]
headers={'Authorization': f'Bearer {key}', 'Content-Type':'application/json', 'User-Agent':'curl/8.0'}
for base in candidates:
    print('\n===', base, '===')
    try:
        r=httpx.get(base+'/models', headers=headers, timeout=15, follow_redirects=True)
        print('models', r.status_code, r.headers.get('content-type'), r.text[:180].replace('\n',' '))
    except Exception as e:
        print('models error', type(e).__name__, str(e)[:160])
    try:
        r=httpx.post(base+'/chat/completions', headers=headers, json={'model':model,'messages':[{'role':'user','content':'只回复：OK'}], 'max_tokens':16}, timeout=20, follow_redirects=True)
        print('chat', r.status_code, r.headers.get('content-type'), r.text[:220].replace('\n',' '))
    except Exception as e:
        print('chat error', type(e).__name__, str(e)[:160])
