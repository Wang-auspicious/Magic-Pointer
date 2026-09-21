"""One frozen-frame full-vs-bounded-ROI OCR diagnostic; no model/provider calls."""
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
from rapidocr import RapidOCR
from scripts import ocr_resident_worker as worker

source = ROOT / "data/runtime/frame-leases/frame-77cd6b736b74471b.png"
stem = ROOT / "artifacts/selection-ocr-scale-comparison-20260918"
selection = [2505, 206, 598, 482]
x, y, width, height = selection
padding = 64
with Image.open(source).convert("RGB") as full_image:
    full_size = list(full_image.size)
    roi = [max(0, x-padding), max(0, y-padding), min(full_image.width, x+width+padding), min(full_image.height, y+height+padding)]
    roi_image = full_image.crop(roi)
    roi_path = stem.with_suffix(".roi.png")
    roi_image.save(roi_path)
    full_canvas, full_scale = worker._detection_canvas(full_image)
    roi_canvas, roi_scale = worker._detection_canvas(roi_image)
started = time.perf_counter()
engine = RapidOCR()
load_ms = (time.perf_counter()-started)*1000
started = time.perf_counter()
worker._warm_detection_shapes(engine)
warm_ms = (time.perf_counter()-started)*1000
report = {
    "sourceFrame": str(source), "sourceSizePx": full_size,
    "selectionXYWH": selection, "roiLTRB": roi, "paddingPx": padding,
    "engineLoadMs": round(load_ms,2), "warmShapesMs": round(warm_ms,2),
    "method": "Unmodified worker.process and default RapidOCR engine, one full-frame and one bounded crop, fixed detection shapes warmed before both; original RGB pixels used for recognition; identical closed selection region; no model calls.",
    "cases": [],
}
for name,path,offset,scale,shape in (
    ("full-frame",source,[0,0],full_scale,list(full_canvas.shape)),
    ("bounded-roi",roi_path,roi[:2],roi_scale,list(roi_canvas.shape)),
):
    sx,sy=x-offset[0],y-offset[1]
    payload={"path":str(path),"selection_bbox_local":[sx,sy,width,height],"strokes_local":[[[sx,sy],[sx+width,sy],[sx+width,sy+height],[sx,sy+height],[sx,sy]]]}
    started=time.perf_counter()
    result=worker.process(engine,payload)
    elapsed=(time.perf_counter()-started)*1000
    total_boxes=len(worker._detect_boxes(engine,path))
    for block in result.get("blocks",[]):
        bx,by,bw,bh=block["rect"]
        block["fullFrameRect"]=[bx+offset[0],by+offset[1],bw,bh]
    report["cases"].append({"name":name,"detectionScale":scale,"detectorShapeHWC":shape,"selectedAreaOnDetectorPx":[round(width*scale,2),round(height*scale,2)],"totalDetectedBoxes":total_boxes,"elapsedMs":round(elapsed,2),"result":result})
stem.with_suffix(".json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(json.dumps(report,ensure_ascii=False,indent=2))
