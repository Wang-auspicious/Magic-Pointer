import json
import os
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
INSTALLED = Path(os.environ["LOCALAPPDATA"]) / "Programs/Magic Pointer/resources/app"
sys.path.insert(0, str(INSTALLED))

from app.context_pack.document_reader import DocumentReader
from app.context_pack.sources import SourceRef
import app.desktop_actions.uia as uia

paths = [
    "app/context_pack/document_reader.py", "app/context_pack/initial_evidence.py",
    "app/context_pack/sources.py", "app/context_pack/tools.py",
    "app/input_artifact/schema.py", "app/agent_runtime/context_projection.py",
    "app/agent_runtime/model_client.py", "app/agent_runtime/loop.py",
    "app/agent_runtime/memory_tools.py", "app/agent_runtime/system_prompt.py",
    "app/desktop_actions/session.py", "app/desktop_actions/uia.py",
    "scripts/selection_bridge.py",
]
assert Path(uia.__file__).resolve().is_relative_to(INSTALLED.resolve())
for name in paths:
    assert (WORKSPACE / name).read_bytes() == (INSTALLED / name).read_bytes(), name
version = json.loads((INSTALLED / "package.json").read_text(encoding="utf-8"))["version"]
assert version == json.loads((WORKSPACE / "package.json").read_text(encoding="utf-8"))["version"] == "1.0.48"
pdf = Path("D:/Desktop/CVPR 2027 选题核验.pdf")
source = SourceRef.from_dict({"sourceId": "installed-pdf", "taskId": "acceptance",
    "kind": "document", "title": pdf.name, "identity": {"absolutePath": str(pdf)},
    "revision": {}, "capabilities": ["read", "search"], "origin": "user-attached",
    "parentSourceId": None})
read = DocumentReader().read(source, None, None, 32, view="text")
assert read.evidence_status == "ok" and read.coverage.complete
assert len(read.fragments) == 21
# Test fixtures are not shipped. Execute the workspace fixture with its import
# root bound to the installed app, then write evidence back to this workspace.
fixture = WORKSPACE / "scripts/verify_context_cu_native.py"
namespace = {"__name__": "installed_acceptance", "__file__": str(INSTALLED / "scripts/verify_context_cu_native.py")}
exec(compile(fixture.read_text(encoding="utf-8"), str(fixture), "exec"), namespace)
namespace["ROOT"] = WORKSPACE
native_path = WORKSPACE / "data/backend-20260918/native-cu.json"
if native_path.exists():
    (native_path.parent / "native-cu-development.json").write_bytes(native_path.read_bytes())
namespace["main"]()
native = json.loads(native_path.read_text(encoding="utf-8"))
report = {"version": version, "executable": sys.executable, "module": uia.__file__,
    "byteIdenticalFiles": paths, "pdfPages": len(read.fragments),
    "pdfBackend": read.used_backend, "pdfComplete": read.coverage.complete,
    "nativeCU": native}
(WORKSPACE / "data/backend-20260918/installed-verification.json").write_text(
    json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
