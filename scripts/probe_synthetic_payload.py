from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from app.ai_client import ask_vision_model
out=Path('data/captures/synthetic_large.png')
out2=Path('data/captures/synthetic_large_annotated.png')
out.parent.mkdir(parents=True, exist_ok=True)
img=Image.new('RGB',(2203,1719),'white')
d=ImageDraw.Draw(img)
for i in range(0,2203,80):
    d.line((i,0,i,1719), fill=(220,220,220))
for j in range(0,1719,60):
    d.line((0,j,2203,j), fill=(230,230,230))
for k in range(80):
    d.text((30+(k%8)*260,30+(k//8)*150), f'Synthetic window {k}', fill='black')
img.save(out, optimize=True)
img2=img.copy(); d2=ImageDraw.Draw(img2)
for k in range(8):
    x=30+k*120; y=40+k*80
    d2.rectangle((x,y,x+600,y+360), outline='red', width=5)
    d2.text((x+10,y+10), str(k+1), fill='red')
img2.save(out2, optimize=True)
print(out, out.stat().st_size, out2, out2.stat().st_size)
for label, extras in [('single', []), ('two_images', [out2])]:
    print('\n---', label, '---')
    ans=ask_vision_model(out, '这是一张合成测试图，用一句话描述', extra_image_paths=extras)
    print(ans[:500])
