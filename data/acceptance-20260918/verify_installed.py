import json
import os
import sys
from pathlib import Path

installed = Path(os.environ["LOCALAPPDATA"]) / "Programs/Magic Pointer"
app = installed / "resources/app"
sys.path.insert(0, str(app))
from app.grounding.explorer_adapter import ExplorerFileGrounder
from app.context_pack.document_reader import DocumentReader
from app.context_pack.sources import SourceRef
import app.grounding.explorer_adapter as grounding
import pythoncom

assert Path(grounding.__file__).resolve().is_relative_to(app.resolve())
items, trace = ExplorerFileGrounder()._read_desktop_shell_items()
pdf = next(item for item in items if item.name == "CVPR 2027 选题核验.pdf")
source = SourceRef.from_dict({"sourceId": "installed-native-pdf", "taskId": "acceptance", "kind": "document", "title": pdf.name,
    "identity": {"absolutePath": pdf.path}, "revision": {}, "capabilities": ["read", "search"], "origin": "user-attached", "parentSourceId": None})
result = DocumentReader().read(source, None, None, 100)
assert result.evidence_status == "ok" and result.fragments
history = json.loads((Path(os.environ["LOCALAPPDATA"]) / "Magic Pointer/history/conversations.json").read_text(encoding="utf-8"))
actual = next(c for c in history if c["id"] == "c1789708549905")["turns"][0]
report = {"version": json.loads((app / "package.json").read_text(encoding="utf-8"))["version"],
    "executable": sys.executable, "module": grounding.__file__, "nativePath": pdf.path, "nativeBackend": pdf.source,
    "pdfBackend": result.used_backend, "pdfPages": result.coverage.total_units, "historyConversations": len(history),
    "historyTurns": sum(len(c.get("turns", [])) for c in history),
    "incidentTools": sum(r["kind"] == "tool" for r in actual["trajectory"]),
    "incidentReasoning": sum(r["kind"] == "message" and bool(r.get("reasoning")) for r in actual["trajectory"]), "errors": []}
assert report["version"] == "1.0.48"
assert report["incidentTools"] == 12 and report["incidentReasoning"] == 10
(Path(__file__).parent / "installed-verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
