from __future__ import annotations

from pathlib import Path

from app.review.compiler import compile_review_prompt, write_prompt_artifact


def session_with_anchors() -> dict:
    return {
        "session_id": "review-1",
        "status": "active",
        "artifact": {
            "document_path": r"D:\papers\paper.pdf",
            "document_label": "paper.pdf",
            "app": "pdf",
        },
        "anchors": [
            {
                "anchor_id": "anchor-7",
                "sequence": 1,
                "instruction": "这个表格的单位需要统一",
                "app": "pdf",
                "document_path": r"D:\papers\paper.pdf",
                "document_label": "paper.pdf",
                "page_number": 7,
                "selected_text": "Table 4",
                "surrounding_context": "Table 4 reports runtime in ms.",
            },
            {
                "anchor_id": "anchor-2",
                "sequence": 2,
                "instruction": "图注和正文不一致",
                "app": "pdf",
                "document_path": r"D:\papers\paper.pdf",
                "document_label": "paper.pdf",
                "page_number": 2,
                "selected_text": "Figure 2",
                "surrounding_context": "Figure 2 shows the full pipeline.",
            },
        ],
    }


def test_compiler_preserves_verbatim_notes_and_orders_pdf_pages() -> None:
    prompt = compile_review_prompt(
        session_with_anchors(),
        global_context="这是一次论文成稿验收，保持现有实验结论不变。",
    )

    assert prompt.index("第 2 页") < prompt.index("第 7 页")
    assert "用户原话：图注和正文不一致" in prompt
    assert "用户原话：这个表格的单位需要统一" in prompt
    assert "D:\\papers\\paper.pdf" in prompt
    assert "不要修改未被指出的内容" in prompt
    assert "完成后逐项报告" in prompt
    assert "这是一次论文成稿验收" in prompt
    assert "执行性补充" in prompt


def test_compiler_does_not_invent_pages_for_non_pdf_anchors() -> None:
    session = {
        "session_id": "review-word",
        "artifact": {"document_label": "draft.docx", "app": "word"},
        "anchors": [
            {
                "anchor_id": "anchor-word",
                "sequence": 1,
                "instruction": "这一段语气太像宣传文案",
                "app": "word",
                "document_label": "draft.docx",
                "document_path": r"D:\draft.docx",
                "page_number": None,
                "source_window": {"title": "draft.docx - Word"},
                "selected_text": "We introduce a revolutionary framework.",
                "surrounding_context": "Abstract paragraph",
            }
        ],
    }

    prompt = compile_review_prompt(session)

    assert "位置：draft.docx - Word" in prompt
    assert "第 None 页" not in prompt
    assert "用户原话：这一段语气太像宣传文案" in prompt


def test_compiler_excerpts_long_evidence_and_writes_utf8_artifact(tmp_path: Path) -> None:
    session = session_with_anchors()
    session["anchors"][0]["selected_text"] = "证据" * 5000

    prompt = compile_review_prompt(session)
    artifact = write_prompt_artifact(session, prompt, root=tmp_path)

    assert len(prompt) < 20000
    assert artifact == tmp_path / "review" / "artifacts" / "review-1-improvement-prompt.md"
    assert artifact.read_text(encoding="utf-8") == prompt + "\n"
