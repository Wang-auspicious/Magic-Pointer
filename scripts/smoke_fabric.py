from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fabric.catalog import RECIPE_CATALOG
from app.fabric.engine import FabricEngine
from app.fabric.mcp import MagicPointerMcpServer
from app.fabric.providers import AgentProviderDiscovery


def main() -> int:
    clipboard = {"value": ""}
    with tempfile.TemporaryDirectory(prefix="magic-pointer-smoke-", dir=ROOT) as temp:
        runtime = Path(temp)
        engine = FabricEngine(
            root=runtime,
            clipboard_writer=lambda value: clipboard.__setitem__("value", value),
            clipboard_reader=lambda: clipboard["value"],
            agent_availability={"pi": True},
            agent_starter=lambda _payload: {"taskId": "smoke-agent-task", "status": "queued"},
        )

        cleaned = engine.plan(
            "去掉号码空格再复制",
            objects=[{"id": "text-1", "kind": "text", "content": "138  0013  8000"}],
        )
        clean_receipt = engine.execute(cleaned["plan"], confirmed=True)
        assert clean_receipt["verified"] is True
        assert clipboard["value"] == "13800138000"

        evidence = engine.plan(
            "把这段和来源保存成证据卡",
            objects=[{
                "id": "evidence-1",
                "kind": "text",
                "content": "A source-bounded claim.",
                "source": {"app": "pdf", "path": "paper.pdf", "page": 3},
            }],
        )
        evidence_receipt = engine.execute(evidence["plan"], confirmed=True)
        assert Path(evidence_receipt["output"]["artifact"]).exists()

        fallback = engine.plan(
            "把这个公式转成 LaTeX",
            objects=[{"id": "formula-1", "kind": "formula", "content": "integral x squared"}],
            parameters={"cwd": str(ROOT)},
        )
        fallback_receipt = engine.execute(fallback["plan"], confirmed=True)
        assert fallback["plan"]["provider"] == "agent.task"
        assert fallback_receipt["verified"] is True

        server = MagicPointerMcpServer(root=runtime)
        initialized = server.handle({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {},
        })
        tools = server.handle({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        })
        assert initialized and initialized["result"]["serverInfo"]["name"] == "magic-pointer"
        assert tools and len(tools["result"]["tools"]) >= 7

        providers = AgentProviderDiscovery().discover_all()
        result = {
            "ok": True,
            "recipes": len(RECIPE_CATALOG),
            "providersAvailable": [item.id for item in providers if item.available],
            "clipboardVerified": clean_receipt["verified"],
            "evidenceVerified": evidence_receipt["verified"],
            "agentFallbackVerified": fallback_receipt["verified"],
            "mcpTools": len(tools["result"]["tools"]),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
