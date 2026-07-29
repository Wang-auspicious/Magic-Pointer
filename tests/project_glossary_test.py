"""Contract tests for the isolated, local project glossary format."""

from __future__ import annotations

import importlib
import importlib.util

import pytest


def _glossary_module():
    try:
        spec = importlib.util.find_spec("app.terminology.glossary")
    except ModuleNotFoundError:
        spec = None
    assert spec is not None, "project glossary module must exist"
    return importlib.import_module("app.terminology.glossary")


def test_selects_global_and_current_project_terms_only() -> None:
    glossary = _glossary_module()
    entries = (
        glossary.GlossaryEntry(scope="", term="Acme Corp"),
        glossary.GlossaryEntry(scope=r"D:\\work\\alpha", term="TargetLease"),
        glossary.GlossaryEntry(scope=r"D:\\work\\alpha", term="x_i"),
        glossary.GlossaryEntry(scope=r"D:\\work\\alphabet", term="must-not-match"),
    )

    assert glossary.terms_for_path(entries, r"d:/work/alpha/src/main.py") == (
        "Acme Corp",
        "TargetLease",
        "x_i",
    )


def test_import_export_round_trip_is_canonical_and_deduplicated() -> None:
    glossary = _glossary_module()
    imported = glossary.import_glossary(
        {
            "schemaVersion": 1,
            "entries": [
                {"scope": r"D:\work\alpha", "term": "TargetLease"},
                {"scope": "", "term": "Acme Corp"},
                {"scope": r"d:/work/alpha", "term": "TargetLease"},
            ],
        }
    )

    assert glossary.export_glossary(imported) == {
        "schemaVersion": 1,
        "entries": [
            {"scope": "", "term": "Acme Corp"},
            {"scope": r"D:\work\alpha", "term": "TargetLease"},
        ],
    }


@pytest.mark.parametrize(
    "payload",
    [
        {"schemaVersion": 2, "entries": []},
        {"schemaVersion": 1, "entries": [{"scope": "relative", "term": "TargetLease"}]},
        {"schemaVersion": 1, "entries": [{"scope": "", "term": "   "}]},
        {"schemaVersion": 1, "entries": [{"scope": "", "term": "bad" + chr(10) + "term"}]},
    ],
)
def test_import_rejects_nonportable_or_unsafe_entries(payload: dict[str, object]) -> None:
    glossary = _glossary_module()

    with pytest.raises((TypeError, ValueError)):
        glossary.import_glossary(payload)
