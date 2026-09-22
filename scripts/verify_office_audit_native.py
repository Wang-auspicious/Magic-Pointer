from __future__ import annotations
import json
import sys
from datetime import datetime
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import win32com.client
from app.actions.office_document import PowerShellLiveOfficeGateway
from app.actions.powerpoint import PowerPointComGateway


def application(name):
    try:
        return win32com.client.GetActiveObject(name), False
    except Exception:
        return win32com.client.DispatchEx(name), True


def native_integer(value):
    return int(value() if callable(value) else value)


def main():
    root = Path(__file__).resolve().parents[1] / "data" / ("acceptance-office-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    root.mkdir(parents=True, exist_ok=False)
    results = {}
    def save_results():
        (root / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    def cleanup(application_object, document_object, own, *, powerpoint=False):
        try:
            if document_object is not None:
                if powerpoint:
                    document_object.Saved = True
                    document_object.Close()
                else:
                    document_object.Close(False)
            if application_object is not None and own:
                application_object.Quit()
        except Exception as exc:
            results.setdefault("cleanupErrors", []).append(str(exc))
        save_results()
    app = document = None
    owned = False
    try:
        app, owned = application("Word.Application")
        document = app.Documents.Add()
        document.Content.Text = "Keep old ending"
        document.Range(0, 5).Bold = -1
        document.Range(5, 8).Italic = -1
        document.Range(8, 15).Underline = 1
        path = root / "word-minimal.docx"
        document.SaveAs2(str(path))
        hwnd = int(document.Windows.Item(1).Hwnd)
        result = PowerShellLiveOfficeGateway().replace_word(path=str(path), hwnd=hwnd, start=0, end=15,
            expected_text="Keep old ending", replacement="Keep longer ending")
        actual = str(document.Range(0, 18).Text)
        formats = [int(document.Range(0, 5).Bold), int(document.Range(5, 11).Italic), int(document.Range(11, 18).Underline)]
        results["word"] = {"gateway": dict(result), "text": actual, "formats": formats,
            "passed": result.get("ok") is True and actual == "Keep longer ending" and formats == [-1, -1, 1]}
        document.Save()
    except Exception as exc:
        results["word"] = {"passed": False, "error": str(exc)}
    finally:
        save_results()
        cleanup(app, document, owned)
    print(json.dumps({"word": results["word"]}, ensure_ascii=False), flush=True)

    app = document = None
    owned = False
    try:
        app, owned = application("Excel.Application")
        document = app.Workbooks.Add()
        sheet = document.Worksheets.Item(1)
        sheet.Range("A1:B1").Value2 = ((0, 0),)
        path = root / "excel-partial.xlsx"
        document.SaveAs(str(path), 51)
        sheet.Range("A1").Locked = False
        sheet.Protect()
        hwnd = int(document.Windows.Item(1).Hwnd)
        result = PowerShellLiveOfficeGateway().set_excel(path=str(path), hwnd=hwnd, sheet=str(sheet.Name),
            address="A1:B1", expected=[[0, 0]], after=[[1, 2]])
        actual = [sheet.Range("A1").Value2, sheet.Range("B1").Value2]
        results["excel"] = {"gateway": dict(result), "values": actual,
            "passed": result.get("ok") is False and result.get("wrote") is True and actual == [1, 0]}
        sheet.Unprotect()
        document.Save()
    except Exception as exc:
        results["excel"] = {"passed": False, "error": str(exc)}
    finally:
        save_results()
        cleanup(app, document, owned)
    print(json.dumps({"excel": results["excel"]}, ensure_ascii=False), flush=True)

    app = document = None
    owned = False
    try:
        app, owned = application("PowerPoint.Application")
        document = app.Presentations.Add(True)
        slide = document.Slides.Add(1, 12)
        shape = slide.Shapes.AddShape(1, 30, 40, 200, 100)
        shape.Fill.Visible = 0
        shape.Line.Visible = 0
        path = root / "powerpoint-style.pptx"
        document.SaveAs(str(path))
        gateway = PowerPointComGateway()
        import win32gui
        handles = []
        win32gui.EnumWindows(lambda handle, _: handles.append(handle) if path.stem in win32gui.GetWindowText(handle) else None, None)
        args = None
        for handle in handles:
            candidate = {"path": str(path), "hwnd": handle, "slide_id": native_integer(slide.SlideID), "shape_id": native_integer(shape.Id)}
            try:
                gateway.read_shape(**candidate)
                args = candidate
                break
            except RuntimeError:
                continue
        if args is None:
            raise RuntimeError("No native window was bound to this exact temporary presentation")
        shown = gateway.set_shape_style(**args, expected={"fillRgb": None, "lineRgb": None}, after={"fillRgb": 255, "lineRgb": None})
        visible = int(shape.Fill.Visible)
        hidden = gateway.set_shape_style(**args, expected={"fillRgb": 255, "lineRgb": None}, after={"fillRgb": None, "lineRgb": None})
        results["powerpoint"] = {"show": dict(shown), "hide": dict(hidden), "shownVisible": visible, "hiddenVisible": int(shape.Fill.Visible),
            "passed": shown.get("ok") is True and hidden.get("ok") is True and visible == -1 and int(shape.Fill.Visible) == 0}
        document.Save()
    except Exception as exc:
        results["powerpoint"] = {"passed": False, "error": str(exc)}
    finally:
        save_results()
        cleanup(app, document, owned, powerpoint=True)
    print(json.dumps({"powerpoint": results["powerpoint"]}, ensure_ascii=False), flush=True)
    (root / "result.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(root), flush=True)
    return 0 if all(results.get(name, {}).get("passed") for name in ("word", "excel", "powerpoint")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
