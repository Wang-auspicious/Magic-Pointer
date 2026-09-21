"""Current production OCR + one new read-only production Agent replay."""
from __future__ import annotations
import copy
from dataclasses import replace
import json
import os
from pathlib import Path
import sys
import time
import traceback
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
os.environ["MAGIC_POINTER_PERMISSION_MODE"]="plan"
os.environ["MAGIC_POINTER_INLOOP_REVERSIBLE"]="0"
from rapidocr import RapidOCR
from scripts import ocr_resident_worker as worker
from scripts import selection_bridge as bridge
from app.perception import PerceptionBroker
from app.perception.pixel_ocr import FrozenFrameOcrProvider

bridge._configure_stdio()
stem=ROOT/"artifacts/selection-sovereign-replay-20260918-identity"
baseline=json.loads((ROOT/"artifacts/selection-sovereign-replay-20260918.json").read_text(encoding="utf-8-sig"))
source=Path(baseline["sourceFrame"])
source_stat=source.stat()
original_session=ROOT/"data/runtime/agent-sessions/agent-a3618dc7-e244-4894-b2a6-2157f77a05d9.jsonl"
original_stat=original_session.stat()
snapshot=copy.deepcopy(baseline["snapshot"])
snapshot.pop("perception_trace",None)
snapshot.pop("context",None)
target=copy.deepcopy(baseline["perceptionContext"]["window"])
snapshot["source_window"]=target
session_id=str(uuid.uuid4())
report={
    "validation":"current production WINDOW identity + selection visual anchor + fresh OCR, one production _loop_router replay",
    "ocrInvocation":"fresh Python process directly calls current scripts.ocr_resident_worker.process; does not contact or restart an existing resident OCR process",
    "permissionMode":"plan", "inloopReversible":False,
    "provider":"unchanged configured default", "selectionSessionId":session_id,
    "command":baseline["command"], "sourceFrame":str(source),
    "sourceSizePx":baseline["sourceSizePx"],"regionXYWH":baseline["regionXYWH"],
    "limitation":baseline["limitation"],
    "originalSession":str(original_session),
}
def save():
    stem.with_suffix(".json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")

with stem.with_suffix(".progress.log").open("w",encoding="utf-8") as progress:
    clock=bridge.PhaseClock("selection-identity-acceptance",stream=progress)
    try:
        started=time.perf_counter()
        engine=RapidOCR()
        report["ocrEngineLoadMs"]=round((time.perf_counter()-started)*1000,2)
        started=time.perf_counter()
        worker._warm_detection_shapes(engine)
        report["ocrShapeWarmMs"]=round((time.perf_counter()-started)*1000,2)
        def direct_reader(path,*,strokes_local=None,selection_local=None):
            payload={"path":path,"strokes_local":strokes_local or [],"selection_bbox_local":selection_local}
            started=time.perf_counter()
            result=worker.process(engine,payload)
            report["ocrProcessMs"]=round((time.perf_counter()-started)*1000,2)
            report["ocrResult"]=result
            report["detailRegionLTRB"]=worker._detail_region(tuple(report["sourceSizePx"]),strokes_local or [],selection_local)
            report["detectionCacheRegions"]=[key[-1] for key in worker._DETECTION_CACHE]
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "OCR failed")
            return result["blocks"],result["engine"]
        request=bridge._pixel_tier_request(target,snapshot)
        fused=PerceptionBroker().resolve(request,[FrozenFrameOcrProvider(reader=direct_reader)],policy_mode="local_screenshot")
        if fused.selected is None or fused.selected.context is None:
            raise RuntimeError("Fresh production OCR did not resolve selected context")
        app_ctx=replace(fused.selected.context,artifacts={**dict(fused.selected.context.artifacts),"perception_trace":fused.trace})
        snapshot["context"]=app_ctx.to_dict()
        snapshot["perception_trace"]=fused.trace
        report["perceptionContext"]=app_ctx.to_dict()
        report["actualOcrText"]=app_ctx.content
        report["snapshot"]=snapshot
        clock.mark("fresh_ocr_complete",blocks=len(report["ocrResult"]["blocks"]),ms=report["ocrProcessMs"])
        save()
        print(json.dumps({"stage":"production_ocr_complete","text":app_ctx.content,"ms":report["ocrProcessMs"]},ensure_ascii=False),flush=True)
        payload={"command":report["command"],"selectionSessionId":session_id,"selectionSnapshot":snapshot}
        settings=bridge._capture_settings()
        started=time.perf_counter()
        report["result"]=bridge._loop_router(
            report["command"],bridge._fabric_objects(payload,target,app_ctx,snapshot),
            target,app_ctx,snapshot,dict(getattr(settings,"recipe_enabled",None) or {}),
            session_id,str(snapshot.get("snapshot_id") or "") or None,clock=clock,
        )
        report["loopWallMs"]=round((time.perf_counter()-started)*1000,2)
    except Exception as exc:
        report["error"]=f"{type(exc).__name__}: {exc}"
        report["traceback"]=traceback.format_exc()
    finally:
        current_source=source.stat()
        current_original=original_session.stat()
        report["originalFullFrameRetained"]=(source_stat.st_size==current_source.st_size and source_stat.st_mtime_ns==current_source.st_mtime_ns)
        report["originalSessionUnchanged"]=(original_stat.st_size==current_original.st_size and original_stat.st_mtime_ns==current_original.st_mtime_ns)
        save()
        clock.mark("report_saved",ok=bool((report.get("result") or {}).get("ok")))
result=report.get("result") or {}
print(json.dumps({"report":str(stem.with_suffix(".json")),"error":report.get("error"),"ok":result.get("ok"),"usedBackend":result.get("usedBackend"),"loopWallMs":report.get("loopWallMs"),"answer":result.get("answer"),"tools":result.get("loopReceipts")},ensure_ascii=False,indent=2))
