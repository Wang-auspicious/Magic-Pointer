"""Benchmark Whisper vs SenseVoice on the same recordings.

Loads each engine once, transcribes the same WAV files through each engine,
and reports character error rate (CER), optional intent accuracy (via the
production RecipeRouter), model load time, and per-utterance latency.

Usage:
  python scripts/benchmark_voice_engines.py --wav-dir data/runtime/voice-bench       --references references.json [--engines whisper,sense_voice] [--output report.json]

``references.json`` shape:
  {"clip.wav": {"text": "????", "intent": "text.ocr_copy"}}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if __package__ in {None, ""}:
    sys.path.insert(0, str(ROOT))

ENGINES = ("whisper", "sense_voice")


def _norm(value: str) -> str:
    return "".join(str(value or "").split())


def _levenshtein(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for i, char_l in enumerate(left, 1):
        current = [i]
        for j, char_r in enumerate(right, 1):
            current.append(min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (char_l != char_r),
            ))
        previous = current
    return previous[-1]


def character_error_rate(reference: str, hypothesis: str) -> float:
    ref = _norm(reference)
    hyp = _norm(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return _levenshtein(ref, hyp) / len(ref)


def _load_engine(engine: str, model_name: str):
    if engine == "whisper":
        from scripts.local_voice_bridge import load_model, load_pcm_wav, transcribe
    else:
        from scripts.sense_voice_bridge import load_model
        from scripts.local_voice_bridge import load_pcm_wav

        def transcribe(model, audio, **kwargs):  # type: ignore[misc]
            from scripts.sense_voice_bridge import transcribe as sense_transcribe

            return sense_transcribe(model, audio, **kwargs)

    return load_model, load_pcm_wav, transcribe


def _load_references(path: Path | None) -> dict[str, dict[str, str]]:
    if path is None or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        str(name): dict(entry)
        for name, entry in data.items()
        if isinstance(entry, dict)
    }


def run_benchmark(
    wav_dir: Path,
    references: dict[str, dict[str, str]],
    engines: tuple[str, ...] = ENGINES,
    model_name: str = "tiny",
    language: str = "zh",
    output: Path | None = None,
) -> dict:
    wavs = sorted(path for path in wav_dir.glob("*.wav") if path.is_file())
    if not wavs:
        raise ValueError(f"no .wav files found in {wav_dir}")

    from app.fabric.router import RecipeRouter

    router = RecipeRouter()
    report: dict = {
        "engines": list(engines),
        "language": language,
        "files": [path.name for path in wavs],
        "results": {},
        "summary": {},
    }

    for engine in engines:
        load_model, load_pcm_wav, transcribe = _load_engine(engine, model_name)
        start = time.perf_counter()
        model = load_model("sense-voice-small" if engine == "sense_voice" else model_name)
        load_seconds = time.perf_counter() - start

        per_file = []
        total_cer = 0.0
        cer_count = 0
        intent_hits = 0
        intent_count = 0
        latencies: list[float] = []

        for wav in wavs:
            audio = load_pcm_wav(wav)
            started = time.perf_counter()
            text = transcribe(model, audio, language=language)
            latency = time.perf_counter() - started
            latencies.append(latency)

            entry: dict = {"file": wav.name, "latency_seconds": round(latency, 3), "transcript": text}
            ref = references.get(wav.name)
            if ref and ref.get("text"):
                entry["reference"] = ref["text"]
                entry["cer"] = round(character_error_rate(ref["text"], text), 4)
                total_cer += entry["cer"]
                cer_count += 1
                expected_intent = ref.get("intent")
                if expected_intent:
                    intent_count += 1
                    routed = router.route(text)
                    entry["expectedIntent"] = expected_intent
                    entry["routedIntent"] = routed.recipe_id
                    if routed.recipe_id == expected_intent:
                        intent_hits += 1
            per_file.append(entry)

        report["results"][engine] = {
            "model_load_seconds": round(load_seconds, 3),
            "average_latency_seconds": round(float(np.mean(latencies)), 3),
            "p95_latency_seconds": round(float(np.percentile(latencies, 95)), 3),
            "cer": round(total_cer / cer_count, 4) if cer_count else None,
            "intent_accuracy": round(intent_hits / intent_count, 4) if intent_count else None,
            "files": per_file,
        }

    for engine in engines:
        result = report["results"][engine]
        print(f"[{engine}] load={result['model_load_seconds']}s "
              f"avg={result['average_latency_seconds']}s p95={result['p95_latency_seconds']}s "
              f"CER={result['cer']} intent_acc={result['intent_accuracy']}")

    report["summary"] = {
        "best_cer": min(
            ((engine, report["results"][engine]["cer"]) for engine in engines),
            key=lambda item: item[1] if item[1] is not None else float("inf"),
            default=None,
        ),
        "best_intent_accuracy": max(
            ((engine, report["results"][engine]["intent_accuracy"]) for engine in engines),
            key=lambda item: item[1] if item[1] is not None else float("-inf"),
            default=None,
        ),
    }

    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Whisper vs SenseVoice benchmark on the same recordings.")
    parser.add_argument("--wav-dir", required=True, type=Path)
    parser.add_argument("--references", type=Path)
    parser.add_argument("--engines", default=",".join(ENGINES))
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    engines = tuple(
        engine.strip() for engine in args.engines.split(",") if engine.strip() in ENGINES
    )
    if not engines:
        print("no valid engines requested", flush=True)
        return 2

    references = _load_references(args.references)
    try:
        run_benchmark(
            args.wav_dir,
            references,
            engines=engines,
            model_name=args.model,
            language=args.language,
            output=args.output,
        )
    except Exception as exc:  # pragma: no cover - CLI error path
        print(f"benchmark_failed:{type(exc).__name__}:{exc}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
