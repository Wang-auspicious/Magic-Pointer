from __future__ import annotations


def create_ocr_engine():
    import cv2
    from rapidocr import RapidOCR

    cv2.setNumThreads(1)
    return RapidOCR(params={
        'EngineConfig.onnxruntime.intra_op_num_threads': 2,
        'EngineConfig.onnxruntime.inter_op_num_threads': 1,
    })
