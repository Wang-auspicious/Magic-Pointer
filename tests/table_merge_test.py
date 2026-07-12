from __future__ import annotations

from app.actions.table_merge import merge_episode_tables, parse_table, to_safe_csv, wants_table_merge


def test_table_merge_intent_is_strict():
    for command in ("合并这些表格", "把这些合成一张表", "Merge these tables"):
        assert wants_table_merge(command)
    for command in ("解释这个表格", "merge cells", "", "合并文字"):
        assert not wants_table_merge(command)


def test_parse_tsv_and_markdown_tables():
    tsv = parse_table("姓名\t城市\n张三\t上海\n李四\t杭州", source_id="a")
    assert tsv["columns"] == ["姓名", "城市"]
    assert tsv["rows"][0]["姓名"] == "张三"
    markdown = parse_table("| Name | Score |\n| --- | ---: |\n| Alice | 9 |", source_id="b")
    assert markdown["columns"] == ["Name", "Score"]
    assert markdown["rows"][0]["Score"] == "9"


def test_merge_aligns_case_insensitive_headers_and_preserves_source():
    episode = {
        "episodeId": "tables-1",
        "slots": {"these": [
            {"objectId": "a", "label": "Q1", "content": "Name,City\nAlice,Shanghai"},
            {"objectId": "b", "label": "Q2", "content": "name,Score\nBob,10"},
        ]},
    }
    merged = merge_episode_tables(episode)
    assert merged["columns"] == ["Name", "City", "Score"]
    assert merged["rows"] == [
        {"Name": "Alice", "City": "Shanghai", "Score": "", "_source_id": "a"},
        {"Name": "Bob", "City": "", "Score": "10", "_source_id": "b"},
    ]
    assert merged["missing_fields"] == []


def test_duplicate_headers_and_ragged_rows_fail_closed():
    assert parse_table("Name,Name\nA,B", source_id="a")["error"]
    assert parse_table("A,B\n1,2,3", source_id="a")["error"]


def test_formula_like_cells_are_escaped_on_csv_export():
    csv_text = to_safe_csv({
        "columns": ["Name", "Value"],
        "rows": [{"Name": "Alice", "Value": "=HYPERLINK(\"bad\")", "_source_id": "a"}],
    })
    assert "'=HYPERLINK" in csv_text
    assert "_source_id" not in csv_text.splitlines()[0]


def test_missing_two_valid_tables_returns_incomplete_preview():
    merged = merge_episode_tables({"slots": {"these": [{"objectId": "a", "content": "not a table"}]}})
    assert "tables" in merged["missing_fields"]
