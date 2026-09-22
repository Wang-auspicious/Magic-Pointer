import json
import os
from pathlib import Path
import subprocess
import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_npm_tests_compile_current_source_before_probes():
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts.get("pretest") == "npm run build:electron"
    workflow = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert workflow.count("npm run lint") == 3
    assert workflow.count("npm run typecheck") == 3


@pytest.mark.skipif(os.name != "nt", reason="Windows install sync")
def test_sync_removes_deleted_runtime_code_and_preserves_user_data(tmp_path):
    src, dst = tmp_path / "unpacked", tmp_path / "installed"
    for root in (src, dst):
        (root / "resources/app/app").mkdir(parents=True)
        (root / "resources/app/build").mkdir()
        (root / "resources/app/scripts").mkdir()
    (src / "resources/app/app/current.py").write_text("current", encoding="utf-8")
    (dst / "resources/app/app/obsolete.py").write_text("obsolete", encoding="utf-8")
    (dst / "resources/app/data").mkdir()
    (dst / "resources/app/data/user.json").write_text("user", encoding="utf-8")
    script = ROOT / "scripts/sync_owned_runtime.ps1"
    assert script.is_file()
    completed = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-SourceRoot", str(src), "-InstalledRoot", str(dst)], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert not (dst / "resources/app/app/obsolete.py").exists()
    assert (dst / "resources/app/app/current.py").read_text(encoding="utf-8") == "current"
    assert (dst / "resources/app/data/user.json").read_text(encoding="utf-8") == "user"
