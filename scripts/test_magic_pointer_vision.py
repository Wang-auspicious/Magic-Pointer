from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from app.ai_client import ask_vision_model, get_ai_config
p=Path('data/captures/test_vision.png')
p.parent.mkdir(parents=True, exist_ok=True)
img=Image.new('RGB',(320,140),'white')
d=ImageDraw.Draw(img)
d.text((24,55),'Magic Pointer MVP0', fill='black')
img.save(p)
print('config:', get_ai_config()[1], get_ai_config()[2])
print(ask_vision_model(p, '图片里有什么文字？')[:1000])
