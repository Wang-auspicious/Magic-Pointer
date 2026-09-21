from __future__ import annotations

import sys
from types import SimpleNamespace


def test_ocr_engine_bounds_native_cpu_pools(monkeypatch):
    """All OCR entry points must leave cores for the desktop and pointer hook."""
    calls = []
    sentinel = object()
    monkeypatch.setitem(sys.modules, 'cv2', SimpleNamespace(setNumThreads=lambda n: calls.append(('cv', n))))
    monkeypatch.setitem(sys.modules, 'rapidocr', SimpleNamespace(RapidOCR=lambda **kw: (calls.append(('ocr', kw)), sentinel)[1]))
    from app.perception.ocr_engine import create_ocr_engine

    assert create_ocr_engine() is sentinel
    assert calls == [('cv', 1), ('ocr', {'params': {
        'EngineConfig.onnxruntime.intra_op_num_threads': 2,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
    }})]
