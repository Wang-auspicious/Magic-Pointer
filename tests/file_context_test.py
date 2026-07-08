from __future__ import annotations

import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.file_context import format_local_file_context, read_local_file_context, wants_file_content


def test_text_file_context() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "note.md"
        path.write_text("# Title\n\nMagic Pointer should read local content.", encoding="utf-8")
        ctx = read_local_file_context(str(path))
        assert ctx.method and ctx.method.startswith("text:")
        assert "Magic Pointer" in (ctx.content or "")
        rendered = format_local_file_context(ctx)
        assert "Local file content v1" in rendered
        assert "content_excerpt" in rendered


def test_html_file_context_strips_script() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "page.html"
        path.write_text("<html><head><title>Demo</title><script>evil()</script></head><body><h1>Hello</h1><p>World</p></body></html>", encoding="utf-8")
        ctx = read_local_file_context(str(path))
        assert ctx.method == "html:bs4"
        assert "Demo" in (ctx.content or "")
        assert "Hello" in (ctx.content or "")
        assert "evil" not in (ctx.content or "")


def test_zip_file_context_lists_entries() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bundle.zip"
        with zipfile.ZipFile(path, "w") as zf:
            zf.writestr("README.md", "hello")
            zf.writestr("src/main.py", "print('hi')")
        ctx = read_local_file_context(str(path))
        names = [item["name"] for item in ctx.entries]
        assert ctx.kind == "archive"
        assert "README.md" in names
        assert "src/main.py" in names
        assert "entries:" in format_local_file_context(ctx)


def test_pdf_file_context_when_reportlab_available() -> None:
    try:
        from reportlab.pdfgen import canvas
    except Exception:
        return
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "paper.pdf"
        c = canvas.Canvas(str(path))
        c.drawString(72, 720, "Magic Pointer PDF extraction works.")
        c.save()
        ctx = read_local_file_context(str(path), max_chars=4000)
        assert ctx.method in {"pdf:pypdf", "pdf:pdfplumber"}
        assert ctx.page_count == 1
        assert "Magic Pointer PDF" in (ctx.content or "")


def test_file_content_intent_detection() -> None:
    assert wants_file_content("\u603b\u7ed3\u8fd9\u4e2a PDF") is True
    assert wants_file_content("what is this file") is True
    assert wants_file_content("\u590d\u5236\u8def\u5f84") is False


def main() -> None:
    test_text_file_context()
    test_html_file_context_strips_script()
    test_zip_file_context_lists_entries()
    test_pdf_file_context_when_reportlab_available()
    test_file_content_intent_detection()
    print("file context test ok")


if __name__ == "__main__":
    main()
