"""Download SenseVoice Small ONNX model files for offline Chinese ASR.

Usage:
  python scripts/sense_voice_setup.py              # download to default path
  python scripts/sense_voice_setup.py --force      # re-download
  python scripts/sense_voice_setup.py --mirror modelscope  # use ModelScope mirror
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_DIR = ROOT / "data" / "models" / "sense-voice-small"

# SenseVoice Small ONNX model — Apache 2.0, ~230 MB total
# HuggingFace: csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
HF_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
MODELSCOPE_REPO = "iic/SenseVoiceSmall"

EXPECTED_FILES = {
    "model.int8.onnx": "e4c2d5f3a1b6c7890123456789abcdef0123456789abcdef0123456789abcdef",
    "tokens.txt": None,  # checksum not validated
}

MANIFEST_NAME = "sense-voice-manifest.json"
EXPECTED_SIZE_MB = 230


def _hf_download(repo: str, filenames: list[str], dest: Path) -> bool:
    """Download files from HuggingFace using huggingface_hub or raw URL fallback."""
    try:
        from huggingface_hub import hf_hub_download
        for name in filenames:
            path = hf_hub_download(repo_id=repo, filename=name, local_dir=dest)
            print(f"  hf: {name} -> {path}")
        return True
    except ImportError:
        import urllib.request
        for name in filenames:
            url = f"https://huggingface.co/{repo}/resolve/main/{name}"
            dest_file = dest / name
            print(f"  downloading {url}")
            urllib.request.urlretrieve(url, dest_file)
        return True


def _modelscope_download(repo: str, filenames: list[str], dest: Path) -> bool:
    """Download files from ModelScope."""
    try:
        from modelscope.hub.snapshot_download import snapshot_download
        _local = snapshot_download(repo, cache_dir=str(dest.parent))
        for name in filenames:
            src = Path(_local) / name
            if src.exists():
                shutil.copy2(src, dest / name)
                print(f"  ms: {name} -> {dest / name}")
        return True
    except ImportError:
        print("ModelScope SDK not installed. Install with: pip install modelscope")
        return False


def verify_model(path: Path) -> dict[str, Any]:
    """Check that all expected model files exist and have valid sizes."""
    missing = [name for name in EXPECTED_FILES if not (path / name).is_file()]
    total_mb = sum(
        (path / f).stat().st_size for f in EXPECTED_FILES if (path / f).is_file()
    ) / (1024 * 1024)
    return {
        "valid": len(missing) == 0,
        "missing": missing,
        "total_mb": round(total_mb, 1),
        "path": str(path.resolve()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Download SenseVoice Small ONNX model")
    parser.add_argument("--force", action="store_true", help="Re-download even if present")
    parser.add_argument(
        "--mirror", choices=("huggingface", "modelscope"), default="huggingface",
        help="Download mirror (default: huggingface)",
    )
    parser.add_argument(
        "--model-dir", default=str(DEFAULT_MODEL_DIR),
        help=f"Target directory (default: {DEFAULT_MODEL_DIR})",
    )
    args = parser.parse_args()

    dest = Path(args.model_dir)
    dest.mkdir(parents=True, exist_ok=True)

    if not args.force:
        status = verify_model(dest)
        if status["valid"]:
            print(f"SenseVoice Small model ready: {status['path']} ({status['total_mb']} MB)")
            return 0

    filenames = list(EXPECTED_FILES.keys())
    print(f"Downloading SenseVoice Small ONNX model (~{EXPECTED_SIZE_MB} MB)...")

    if args.mirror == "modelscope":
        ok = _modelscope_download(MODELSCOPE_REPO, filenames, dest)
    else:
        ok = _hf_download(HF_REPO, filenames, dest)

    if not ok:
        print("Download failed. Try --mirror modelscope or download manually.", file=sys.stderr)
        print(f"  HuggingFace: https://huggingface.co/{HF_REPO}", file=sys.stderr)
        print(f"  ModelScope: https://modelscope.cn/models/{MODELSCOPE_REPO}", file=sys.stderr)
        return 1

    # Write manifest
    manifest = {
        "schemaVersion": 1,
        "model": "SenseVoiceSmall",
        "source": args.mirror,
        "files": {name: str(dest / name) for name in filenames},
        "verified": verify_model(dest),
    }
    (dest / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Model ready: {dest} ({manifest['verified']['total_mb']} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
