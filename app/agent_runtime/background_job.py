from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path


def run(meta_path: Path) -> None:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    def persist() -> None:
        temporary = meta_path.with_suffix(".pending")
        temporary.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        temporary.replace(meta_path)

    meta["pid"] = os.getpid()
    persist()
    try:
        with Path(meta["log"]).open("wb") as log:
            completed = subprocess.run(meta["command"], shell=True, cwd=meta["cwd"],
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        meta["exit"] = completed.returncode
    except Exception as exc:
        meta["exit"] = -1
        meta["error"] = f"{type(exc).__name__}: {exc}"
    meta["finished"] = time.time()
    persist()
    if meta.get("sessionPath"):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
        from app.agent_runtime.session import FileSessionStore

        path = Path(meta["sessionPath"])
        try:
            session = FileSessionStore(path.parent).resume(path.stem, repair=False)
            session.enqueue_inbox(
                f"background job {meta['id']} finished (exit={meta['exit']}); poll BashRead(id={meta['id']}) for its output",
                "next-step", message_id=f"background-{meta['id']}",
            )
            meta["notified"] = True
        except Exception as exc:
            meta["notificationError"] = f"{type(exc).__name__}: {exc}"
        persist()


if __name__ == "__main__":
    run(Path(sys.argv[1]))
