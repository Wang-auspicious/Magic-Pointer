import json
import subprocess
import sys
import time
from pathlib import Path

from app.agent_runtime.session import FileSessionStore


def test_session_worker_does_not_load_office_libraries():
    code = "import sys; import app.agent_runtime.session; assert 'openpyxl' not in sys.modules; from app.context_pack import DocumentReader; assert callable(DocumentReader)"
    completed = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=15)
    assert completed.returncode == 0, completed.stderr


def test_background_completion_survives_launching_bridge_exit(tmp_path):
    session = FileSessionStore(tmp_path / "sessions").create("task")
    code = "\n".join([
        "from pathlib import Path",
        "from app.agent_runtime.coding_tools import BackgroundJobs",
        "from app.agent_runtime.session import FileSessionStore",
        f"session = FileSessionStore({str(session.path.parent)!r}).resume('task')",
        f"jobs = BackgroundJobs(Path({str(tmp_path)!r}), session_getter=lambda: session)",
        f"print(jobs.start('python -c \"import time; time.sleep(.3); print(123)\"', Path({str(tmp_path)!r})), flush=True)",
    ])
    launched = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=10)
    assert launched.returncode == 0, launched.stderr
    job_id = int(launched.stdout.strip())
    meta_path = tmp_path / ".mp" / "background" / f"{job_id}.json"
    deadline = time.monotonic() + 8
    meta = {}
    pending = ()
    while time.monotonic() < deadline:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except PermissionError:
            time.sleep(.05)
            continue
        pending = FileSessionStore(session.path.parent).resume("task").pending_inbox()
        if "exit" in meta and pending:
            break
        time.sleep(.05)
    assert meta.get("exit") == 0
    assert meta.get("finished")
    assert len(pending) == 1
    assert str(job_id) in pending[0].text
    assert "123" in Path(meta["log"]).read_text()
