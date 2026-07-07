from pathlib import Path
import sys, httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.ai_client import read_local_secret
key=read_local_secret('openai_key.txt')
base=read_local_secret('openai_base_url.txt') or 'https://www.78code.cc/v1'
r=httpx.get(base+'/models', headers={'Authorization':f'Bearer {key}','User-Agent':'curl/8.0'}, timeout=20)
r.raise_for_status()
data=r.json().get('data',[])
ids=[m.get('id') for m in data if m.get('id')]
print('count',len(ids))
for mid in ids[:200]:
    print(mid)
