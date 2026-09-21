"""Verify this same-version delivery without touching the foreground desktop."""

import json
import os
import subprocess
import time
from pathlib import Path

root = Path(__file__).resolve().parents[2]
installed = Path(os.environ["LOCALAPPDATA"]) / "Programs/Magic Pointer/resources"
application = installed / "app"
python = installed / "python-runtime/python.exe"
expected_version = json.loads((root / "package.json").read_text())["version"]
actual_version = json.loads((application / "package.json").read_text())["version"]
assert actual_version == expected_version == "1.0.50"

paths = [
    "scripts/agent_session_bridge.py", "scripts/conversation_bridge.py",
    "app/agent_runtime/coding_tools.py", "app/agent_runtime/ask_todo_tools.py",
    "app/agent_runtime/todo_store.py", "app/agent_runtime/system_prompt.py",
    "app/desktop_actions/session.py", "app/computer_operator/windows.py",
    "app/harness/builtin_bundle.py", "app/context_pack/desktop_binding.py",
    "build/electron/main.js", "build/electron/conversation_control.js",
    "build/electron/conversation_store.js", "build/electron/renderer/dsh_chat.js",
    "build/electron/renderer/studio.js",
]
for relative in paths:
    assert (root / relative).read_bytes() == (application / relative).read_bytes(), relative

probe_root = Path(__file__).parent / f"installed-probe-{time.time_ns()}"
probe_root.mkdir()
env = {**os.environ, "MAGIC_POINTER_USER_DATA_DIR": str(probe_root)}
setup = (
    "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); "
    "from app.agent_runtime.session import FileSessionStore; "
    "FileSessionStore(Path(sys.argv[2]) / 'agent-sessions').create('delivery-probe').start_turn()"
)
subprocess.run([str(python), "-I", "-X", "utf8", "-c", setup, str(application), str(probe_root)],
               env=env, capture_output=True, text=True, encoding="utf-8", check=True, timeout=30)

results = {}
def invoke(script, payload, expected_code=0):
    started = time.perf_counter()
    completed = subprocess.run([str(python), "-I", "-X", "utf8", str(application / script)],
                               input=json.dumps(payload, ensure_ascii=False), env=env,
                               capture_output=True, text=True, encoding="utf-8", timeout=30)
    assert completed.returncode == expected_code, completed.stderr
    return json.loads(completed.stdout), round((time.perf_counter() - started) * 1000)

for action, extra in [
    ("put", {"target": "next-step", "text": "继续核对修正版"}),
    ("pending", {"target": "next-step"}), ("cancel", {}),
]:
    payload, elapsed = invoke("scripts/agent_session_bridge.py",
                              {"action": action, "sessionId": "delivery-probe", **extra})
    assert payload["ok"], payload
    if action == "pending":
        assert payload["messages"][0]["text"] == "继续核对修正版"
    results[action] = {"ok": True, "elapsedMs": elapsed}

large = {"question": "", "turns": [{"question": "材料" * 25000, "answer": "完成"}]}
payload, elapsed = invoke("scripts/conversation_bridge.py", large, expected_code=1)
assert payload.get("error") == "问题不能为空。", payload
results["largeRequest"] = {"bytes": len(json.dumps(large, ensure_ascii=False).encode()),
                           "parsed": True, "elapsedMs": elapsed}

resolve = "import sys,json; sys.path.insert(0,sys.argv[1]); from app.desktop_actions.session import _resolve_app; print(json.dumps(_resolve_app('excel')))"
completed = subprocess.run([str(python), "-I", "-X", "utf8", "-c", resolve, str(application)],
                           env=env, capture_output=True, text=True, encoding="utf-8", check=True, timeout=30)
excel_path = json.loads(completed.stdout)
assert excel_path and Path(excel_path).is_file()
results["registeredExcelPath"] = excel_path
report = {"version": actual_version, "matchedInstalledFiles": paths, "probes": results,
          "nativeApplicationAcceptance": "deferred_by_user"}
output = Path(__file__).parent / "installed-background-verification.json"
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
