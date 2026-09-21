# Frozen-frame OCR scale comparison

The controlled local comparison confirms that downscaled full-frame detection loses the selected panel's labels and deletion count. Both cases used the same already-loaded default RapidOCR engine, the same unmodified worker `process` logic, original RGB pixels for recognition, the same closed selection, and the same warmed detector tensor shape `512 × 640 × 3`. No Provider/model calls were made.

| Case | Input region | Detection scale | Selection at detection scale | Detection + selected recognition |
|---|---|---:|---:|---:|
| Full frame | 3120 × 2080 | 0.205128 | 122.67 × 98.87 px | 1571.45 ms |
| Bounded ROI | LTRB [2441, 142, 3120, 752], 64 px context padding bounded by frame edge | 0.839344 | 501.93 × 404.56 px | 2195.00 ms |

Full-frame detection found 61 boxes globally, with six selected output fragments: `Local`, `+17,726`, `℃`, `Com`, `main`, `npare branch`.

The bounded ROI found eight complete selected blocks: `Environment`, `Changes`, `+17,726 -1,227`, `Local`, `main`, `Commit or push`, `Pull request status unavailable`, and `Compare branch`. Their physical full-frame coordinates are retained in the JSON result.

This supports keeping the full frozen frame/global detection while adding high-resolution detection near the selection. The ROI case is near native scale, not exactly 1:1. Its 2195 ms is an independent detection-and-recognition case, not a measured incremental cost of a future production implementation that merges boxes before recognition. Engine initialization cost 1007.47 ms; warming the two detector shapes cost 2945.63 ms, both excluded from the case timings.

Evidence: `selection-ocr-scale-comparison-20260918.json`, reproducible one-shot diagnostic script `selection-ocr-scale-comparison-20260918.py`, and exact context crop `selection-ocr-scale-comparison-20260918.roi.png`. Production and configuration files were not edited for this comparison.
