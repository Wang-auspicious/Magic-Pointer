from __future__ import annotations

from app.adapters.browser_devtools_adapter import ChromeDevToolsDocumentClient
from app.context_pack.browser_reader import BrowserContextReader
from app.context_pack.sources import FragmentLocator, SourceRef


class _FakeBrowserDocuments:
    def __init__(self, *, current_epoch: str = "epoch-b") -> None:
        self.current_epoch = current_epoch
        self.calls: list[dict] = []

    def read_document(self, **request):
        self.calls.append(dict(request))
        return {
            "browserInstanceId": request["browser_instance_id"],
            "targetId": request["target_id"],
            "documentEpoch": self.current_epoch,
            "title": "Duplicate URL — selected tab",
            "url": "https://example.test/same",
            "nodes": [
                {
                    "nodeId": "row-204",
                    "selector": "#row-204",
                    "tag": "tr",
                    "role": "row",
                    "text": "OFFSCREEN TABLE ROW 204 — target amount 98",
                    "inViewport": False,
                    "parentSelector": "#ledger",
                },
            ],
            "totalUnits": 205,
            "nextCursor": None,
            "complete": True,
            "usedBackend": "cdp.dom.document",
            "limitations": [],
        }


def _source(*, epoch: str = "epoch-b") -> SourceRef:
    return SourceRef(
        source_id="source:web-b",
        task_id="task-browser",
        kind="web",
        title="Same URL tab B",
        identity={
            "browserInstanceId": "browser-instance-1",
            "targetId": "target-b",
            "documentEpoch": epoch,
            "endpoint": "http://127.0.0.1:9222",
            "url": "https://example.test/same",
        },
        revision={"documentEpoch": epoch},
        capabilities=("read", "search", "follow"),
        origin="user-pointed",
        parent_source_id=None,
    )


def test_exact_target_identity_wins_when_two_tabs_have_the_same_url() -> None:
    backend = _FakeBrowserDocuments()
    reader = BrowserContextReader(backend)

    result = reader.search(_source(), "OFFSCREEN TABLE", None, 10)

    assert backend.calls[0]["browser_instance_id"] == "browser-instance-1"
    assert backend.calls[0]["target_id"] == "target-b"
    assert backend.calls[0]["query"] == "OFFSCREEN TABLE"
    assert result.evidence_status == "ok"
    assert result.fragments[0].text.startswith("OFFSCREEN TABLE ROW 204")
    assert result.fragments[0].locator.value == {
        "browserInstanceId": "browser-instance-1",
        "targetId": "target-b",
        "documentEpoch": "epoch-b",
        "nodeId": "row-204",
        "selector": "#row-204",
    }
    assert result.fragments[0].metadata["inViewport"] is False
    assert result.coverage.total_units == 205
    assert result.coverage.complete is True


def test_navigation_invalidates_old_dom_locator_instead_of_returning_new_page_node() -> None:
    backend = _FakeBrowserDocuments(current_epoch="epoch-after-navigation")
    reader = BrowserContextReader(backend)
    old_locator = FragmentLocator("dom-node", {
        "browserInstanceId": "browser-instance-1",
        "targetId": "target-b",
        "documentEpoch": "epoch-b",
        "nodeId": "row-204",
        "selector": "#row-204",
    })

    result = reader.read(_source(epoch="epoch-b"), old_locator, None, 5)

    assert backend.calls[0]["target_id"] == "target-b"
    assert result.fragments == ()
    assert result.evidence_status == "degraded"
    assert result.coverage.complete is False
    assert result.coverage.missing_reason == "browser-document-epoch-changed"
    assert result.used_backend == "cdp.dom.document"


def test_read_can_return_nodes_that_are_outside_the_viewport() -> None:
    backend = _FakeBrowserDocuments()
    result = BrowserContextReader(backend).read(_source(), None, None, 20)

    assert len(result.fragments) == 1
    assert result.fragments[0].metadata["inViewport"] is False
    assert result.fragments[0].metadata["parentSelector"] == "#ledger"
    assert result.fragments[0].citations[0]["locator"]["value"]["documentEpoch"] == "epoch-b"


def test_cdp_document_client_selects_exact_target_not_an_equal_url() -> None:
    chosen: list[str] = []
    targets = [
        ("browser-instance-1", {"id": "target-a", "url": "https://example.test/same"}),
        ("browser-instance-1", {"id": "target-b", "url": "https://example.test/same"}),
    ]

    def evaluate(instance: str, target: dict, request: dict) -> dict:
        chosen.append(f"{instance}:{target['id']}")
        return {
            "documentEpoch": "epoch-b",
            "title": "selected B",
            "url": target["url"],
            "nodes": [{
                "nodeId": "deep-row",
                "selector": "#deep-row",
                "tag": "tr",
                "role": "row",
                "text": "screen-off row from target B",
                "inViewport": False,
            }],
            "totalUnits": 1,
            "nextCursor": None,
            "complete": True,
            "limitations": [],
        }

    client = ChromeDevToolsDocumentClient(
        targets=lambda: targets,
        evaluate=evaluate,
    )
    result = BrowserContextReader(client).read(_source(), None, None, 10)

    assert chosen == ["browser-instance-1:target-b"]
    assert result.fragments[0].text == "screen-off row from target B"
    assert result.used_backend == "cdp.dom.document"
