import json
import os
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[2]
installed = Path(os.environ["LOCALAPPDATA"]) / "Magic Pointer"
development = Path(os.environ["APPDATA"]) / "magic-pointer"
backup = Path(__file__).parent / "history-before-consolidation"
backup.mkdir(exist_ok=True)
merged = {}
projects = {}
for label, folder in [("installed", installed), ("development", development)]:
    for name in ["conversations", "projects"]:
        source = folder / "history" / f"{name}.json"
        target = backup / f"{label}-{name}.json"
        if not target.exists():
            shutil.copy2(source, target)
        values = json.loads(source.read_text(encoding="utf-8"))
        for value in values:
            key = value["id"] if name == "conversations" else str(value["root"]).casefold()
            dest = merged if name == "conversations" else projects
            if key in dest and name == "conversations" and dest[key] != value:
                raise RuntimeError(f"Conflicting conversation requires manual merge: {key}")
            if name == "conversations" or key not in dest or value.get("lastOpenedAt", 0) > dest[key].get("lastOpenedAt", 0):
                dest[key] = value
copied = []
for conversation in merged.values():
    session = conversation.get("agentSessionId")
    if not session:
        continue
    source = root / "data/runtime/agent-sessions" / f"{session}.jsonl"
    target = installed / "agent-sessions" / f"{session}.jsonl"
    if target.exists() or not source.exists():
        continue
    target.parent.mkdir(exist_ok=True)
    shutil.copy2(source, target)
    copied.append(session)
for name, values in [("conversations", list(merged.values())), ("projects", list(projects.values()))]:
    (installed / "history" / f"{name}.json").write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
report = {"conversations": len(merged), "turns": sum(len(c.get("turns", [])) for c in merged.values()),
          "projects": len(projects), "copiedSessions": copied, "backup": str(backup)}
(Path(__file__).parent / "history-consolidation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
