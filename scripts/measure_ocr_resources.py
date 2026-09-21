"""One real OCR engine, with process memory/thread/CPU evidence; no screen capture."""
from __future__ import annotations

import json
import sys
import threading
import time
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
process = psutil.Process()
samples: list[tuple[float, int, int]] = []
stop = threading.Event()
started = time.perf_counter()


def sample() -> None:
    while not stop.wait(0.05):
        samples.append((time.perf_counter() - started, process.memory_info().rss, process.num_threads()))


monitor = threading.Thread(target=sample, daemon=True)
monitor.start()
from rapidocr import RapidOCR  # noqa: E402
from scripts.ocr_resident_worker import _warm_detection_shapes  # noqa: E402

if '--default' in sys.argv:
    engine = RapidOCR()
else:
    from app.perception.ocr_engine import create_ocr_engine
    engine = create_ocr_engine()
loaded = time.perf_counter()
_warm_detection_shapes(engine)
warmed = time.perf_counter()
stop.set()
monitor.join()
cpu = process.cpu_times()
print(json.dumps({
    'mode': 'default' if '--default' in sys.argv else 'bounded',
    'loadMs': round((loaded - started) * 1000), 'warmMs': round((warmed - loaded) * 1000),
    'peakRssMB': round(max(s[1] for s in samples) / 1048576, 1),
    'peakThreads': max(s[2] for s in samples), 'cpuSeconds': round(cpu.user + cpu.system, 2),
    'usedBackend': 'rapidocr-onnx', 'errors': [],
}))
