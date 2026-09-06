from __future__ import annotations

import base64
import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter
from app.adapters.powerpoint_native import POWERPOINT_NATIVE_WINDOW_SCRIPT

JsonDict = dict[str, Any]

OFFICE_CLASS_TO_APP = {
    "XLMAIN": "excel",
    "OpusApp": "word",
    "PPTFrameClass": "powerpoint",
}

WORD_COM_PROG_ID = "Word.Application"
WPS_WRITER_COM_PROG_ID = "KWPS.Application"
ALLOWED_WORD_COM_PROG_IDS = {WORD_COM_PROG_ID, WPS_WRITER_COM_PROG_ID}
WORD_SELECTION_VBS = Path(__file__).resolve().parents[2] / "scripts" / "office_selection_probe.vbs"


def office_app_from_window(window: JsonDict) -> str | None:
    class_name = str(window.get("class_name") or "")
    if class_name in OFFICE_CLASS_TO_APP:
        return OFFICE_CLASS_TO_APP[class_name]
    title = str(window.get("title") or "").lower()
    if "excel" in title:
        return "excel"
    if "word" in title or title.endswith(".docx") or title.endswith(".doc"):
        return "word"
    if "powerpoint" in title or title.endswith(".pptx") or title.endswith(".ppt"):
        return "powerpoint"
    return None


def word_com_prog_id_from_window(window: JsonDict) -> str:
    title = str(window.get("title") or "").lower()
    if "wps office" in title or "wps writer" in title:
        return WPS_WRITER_COM_PROG_ID
    return WORD_COM_PROG_ID


def word_host_from_prog_id(prog_id: str) -> str:
    return "wps_writer" if prog_id == WPS_WRITER_COM_PROG_ID else "microsoft_word"


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


@dataclass(frozen=True)
class OfficeProbeResult:
    ok: bool
    data: JsonDict
    error: str | None = None


def _run_powershell_json(script: str, *, timeout: int = 2) -> OfficeProbeResult:
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except Exception as exc:
        return OfficeProbeResult(False, {}, f"powershell failed: {type(exc).__name__}: {exc}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout).strip().replace("\r", " ").replace("\n", " ")[:1000]
        return OfficeProbeResult(False, {}, f"powershell exited {proc.returncode}: {err}")
    try:
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        data = json.loads(lines[-1]) if lines else {}
        return OfficeProbeResult(True, data)
    except Exception as exc:
        raw = proc.stdout.strip().replace("\r", " ").replace("\n", " ")[:1000]
        return OfficeProbeResult(False, {}, f"invalid powershell json: {type(exc).__name__}: {exc}; raw={raw}")


def _run_word_selection_vbs(prog_id: str, *, timeout: int = 3) -> OfficeProbeResult:
    try:
        proc = subprocess.run(
            ["cscript.exe", "//nologo", "//U", str(WORD_SELECTION_VBS), prog_id],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except Exception as exc:
        return OfficeProbeResult(False, {}, f"cscript failed: {type(exc).__name__}: {exc}")
    stdout = proc.stdout.decode("utf-16le", errors="replace").lstrip("\ufeff").strip()
    stderr = proc.stderr.decode("utf-16le", errors="replace").lstrip("\ufeff").strip()
    try:
        lines = [line for line in stdout.splitlines() if line.strip()]
        data = json.loads(lines[-1]) if lines else {}
    except Exception as exc:
        raw = stdout.replace("\r", " ").replace("\n", " ")[:1000]
        return OfficeProbeResult(False, {}, f"invalid cscript json: {type(exc).__name__}: {exc}; raw={raw}")
    if proc.returncode != 0 or data.get("ok") is False:
        error = str(data.get("error") or stderr or f"cscript exited {proc.returncode}")[:1000]
        return OfficeProbeResult(False, data, error)
    return OfficeProbeResult(True, data)


_EXCEL_SELECTION_SCRIPT = '\n$ErrorActionPreference = "Stop"\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$targetHwnd = [int64]__TARGET_HWND__\n$result = [ordered]@{ app="excel"; method="com:excel.selection"; hwnd=$null; workbook=$null; workbook_saved=$null; worksheet=$null; address=$null; rows=@(); row_count=0; col_count=0; messages=@() }\ntry {\n  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")\n  $matchedWindow = $null\n  foreach ($candidate in @($excel.Windows)) { if ([int64]$candidate.HWND -eq $targetHwnd) { $matchedWindow = $candidate; break } }\n  if ($null -eq $matchedWindow) { throw "No Excel document window matches hwnd $targetHwnd" }\n  $result.hwnd = [int64]$matchedWindow.HWND\n  $sel = $matchedWindow.RangeSelection\n  if ($null -eq $sel) { throw "No Excel selection" }\n  $sheet = $sel.Worksheet\n  $workbook = $sheet.Parent\n  $result.workbook = [string]$workbook.FullName\n  $result.workbook_saved = [bool]$workbook.Saved\n  $result.worksheet = [string]$sheet.Name\n  $result.address = [string]$sel.Address($false, $false)\n  $maxRows = [Math]::Min([int]$sel.Rows.Count, 30)\n  $maxCols = [Math]::Min([int]$sel.Columns.Count, 12)\n  $result.row_count = [int]$sel.Rows.Count\n  $result.col_count = [int]$sel.Columns.Count\n  for ($r=1; $r -le $maxRows; $r++) {\n    $row = @()\n    for ($c=1; $c -le $maxCols; $c++) {\n      $cell = $sel.Cells.Item($r,$c)\n      $row += [ordered]@{ text=[string]$cell.Text; value=$cell.Value2; formula=[string]$cell.Formula }\n    }\n    $result.rows += ,$row\n  }\n} catch { $result.messages += $_.Exception.Message }\n$result | ConvertTo-Json -Depth 8 -Compress\n'


_EXCEL_REGION_SCRIPT = '\n$ErrorActionPreference = "Stop"\nAdd-Type @"\nusing System;\nusing System.Runtime.InteropServices;\npublic class MpDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }\n"@\n[MpDpi]::SetProcessDPIAware() | Out-Null\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$targetHwnd = [int64]__TARGET_HWND__\n$result = [ordered]@{ app="excel"; method="com:excel.region-from-point"; hwnd=$null; workbook=$null; workbook_saved=$null; worksheet=$null; address=$null; rows=@(); row_count=0; col_count=0; messages=@() }\ntry {\n  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")\n  $matchedWindow = $null\n  foreach ($candidate in @($excel.Windows)) { if ([int64]$candidate.HWND -eq $targetHwnd) { $matchedWindow = $candidate; break } }\n  if ($null -eq $matchedWindow) { throw "No Excel document window matches hwnd $targetHwnd" }\n  $result.hwnd = [int64]$matchedWindow.HWND\n  $x1 = [int]{region_x}; $y1 = [int]{region_y}\n  $x2 = [int]({region_x} + {region_w}); $y2 = [int]({region_y} + {region_h})\n  $r1 = $matchedWindow.RangeFromPoint($x1, $y1)\n  $r2 = $matchedWindow.RangeFromPoint($x2, $y2)\n  $sheet = $r1.Worksheet\n  $workbook = $sheet.Parent\n  $sel = $sheet.Range($r1, $r2)\n  $result.workbook = [string]$workbook.FullName\n  $result.workbook_saved = [bool]$workbook.Saved\n  $result.worksheet = [string]$sheet.Name\n  $result.address = [string]$sel.Address($false, $false)\n  $maxRows = [Math]::Min([int]$sel.Rows.Count, 50)\n  $maxCols = [Math]::Min([int]$sel.Columns.Count, 20)\n  $result.row_count = [int]$sel.Rows.Count\n  $result.col_count = [int]$sel.Columns.Count\n  for ($r=1; $r -le $maxRows; $r++) {\n    $row = @()\n    for ($c=1; $c -le $maxCols; $c++) {\n      $cell = $sel.Cells.Item($r,$c)\n      $row += [ordered]@{ text=[string]$cell.Text; value=$cell.Value2; formula=[string]$cell.Formula }\n    }\n    $result.rows += ,$row\n  }\n} catch { $result.messages += $_.Exception.Message }\n$result | ConvertTo-Json -Depth 8 -Compress\n'


class OfficeAdapter(AppAdapter):
    name = "office"
    perception_layer = "native_app"
    perception_priority = 10

    def match_window(self, window: JsonDict) -> bool:
        return office_app_from_window(window) is not None

    def read_context(self, window: JsonDict, **kwargs: Any) -> AdapterReadContext:
        app = office_app_from_window(window) or "office"
        if app == "excel":
            # Point sampling fires once per sampled point during a fallback
            # sweep; Excel COM Selection reads are global and useless there,
            # and each probe spins up a PowerShell + Excel round-trip that can
            # take seconds. Only region reads (the user's mark) use COM.
            if kwargs.get("target_region") is None and kwargs.get("target_point") is not None:
                return AdapterReadContext(
                    adapter=self.name,
                    app="excel",
                    window=window,
                    capabilities=self._base_caps("excel"),
                    error="excel_com_skipped_for_point_sampling",
                )
            return self._read_excel(window, target_region=kwargs.get("target_region"))
        if app == "word":
            return self._read_word(window)
        if app == "powerpoint":
            return self._read_powerpoint(window)
        return AdapterReadContext(adapter=self.name, app=app, window=window, error="unsupported Office window")

    def _base_caps(self, app: str) -> list[AdapterCapability]:
        if app == "excel":
            return [
                AdapterCapability("read_selection", "Read selected range values/formulas", "read_only"),
                AdapterCapability("explain_formula", "Explain selected formulas", "read_only"),
                AdapterCapability("generate_chart_plan", "Prepare a chart/pivot/table transformation plan", "low"),
                AdapterCapability("write_selection", "Write values/formulas back to the selected range", "high", True, False),
            ]
        if app == "word":
            return [
                AdapterCapability("read_selection", "Read selected Word text", "read_only"),
                AdapterCapability("rewrite_selection", "Rewrite selected text and preview replacement", "low"),
                AdapterCapability("replace_selection", "Replace selected Word text", "high", True, False),
                AdapterCapability("insert_comment", "Insert an explanatory comment", "medium", True, False),
            ]
        if app == "powerpoint":
            return [
                AdapterCapability("read_selection", "Read selected PowerPoint shapes and stable ids", "read_only"),
                AdapterCapability("set_shape_text", "Replace text in the selected shape without addressing by order", "high", True, False),
                AdapterCapability("set_shape_style", "Change allowlisted shape style properties", "high", True, False),
                AdapterCapability("set_shape_geometry", "Change allowlisted shape geometry properties", "high", True, False),
            ]
        return [AdapterCapability("read_selection", "Read selected Office object/text", "read_only")]

    def _read_excel(self, window: JsonDict, *, target_region: Any = None) -> AdapterReadContext:
        try:
            requested_hwnd = int(window.get("hwnd") or 0)
        except (TypeError, ValueError):
            requested_hwnd = 0
        if requested_hwnd <= 0:
            return AdapterReadContext(
                adapter=self.name,
                app="excel",
                window=window,
                capabilities=self._base_caps("excel"),
                error="Excel native read requires the captured window hwnd.",
            )
        region = None
        if isinstance(target_region, dict):
            try:
                region = {key: int(target_region.get(key) or 0) for key in ("x", "y", "width", "height")}
                if region["width"] <= 0 or region["height"] <= 0:
                    region = None
            except (TypeError, ValueError):
                region = None
        if region is not None:
            script = _EXCEL_REGION_SCRIPT
            for key, value in region.items():
                script = script.replace("{" + key + "}", str(value))
        else:
            script = _EXCEL_SELECTION_SCRIPT
        script = script.replace("__TARGET_HWND__", str(requested_hwnd))
        probe = _run_powershell_json(script)
        if not probe.ok:
            return AdapterReadContext(adapter=self.name, app="excel", window=window, capabilities=self._base_caps("excel"), error=probe.error)
        data = probe.data
        try:
            returned_hwnd = int(data.get("hwnd") or 0)
        except (TypeError, ValueError):
            returned_hwnd = 0
        if returned_hwnd != requested_hwnd:
            return AdapterReadContext(
                adapter=self.name,
                app="excel",
                window=window,
                capabilities=self._base_caps("excel"),
                error=f"Excel COM returned hwnd {returned_hwnd}, expected {requested_hwnd}.",
            )
        rows = _as_list(data.get("rows"))
        table_lines: list[str] = []
        for row in rows:
            cells = []
            for cell in _as_list(row):
                if isinstance(cell, dict):
                    text = str(cell.get("text") or cell.get("value") or cell.get("formula") or "")
                    formula = str(cell.get("formula") or "")
                    cells.append(formula if formula and formula != text else text)
            if cells:
                table_lines.append("\t".join(cells))
        label = f"{data.get('worksheet') or 'Sheet'}!{data.get('address') or 'Selection'}"
        locator = {
            "kind": "cell-range",
            "value": {
                "workbook": data.get("workbook"),
                "sheet": data.get("worksheet"),
                "range": data.get("address"),
            },
        }
        artifacts = {
            key: data.get(key)
            for key in ("hwnd", "workbook", "worksheet", "address", "row_count", "col_count", "messages")
        }
        artifacts.update({
            "document": data.get("workbook"),
            "document_saved": data.get("workbook_saved"),
            "source_identity": {
                "absolutePath": data.get("workbook"),
                "hwnd": returned_hwnd,
                "host": "microsoft_excel",
            },
            "locators": [locator],
        })
        return AdapterReadContext(
            adapter=self.name,
            app="excel",
            window=window,
            label=label,
            method=str(data.get("method") or "com:excel.selection"),
            content="\n".join(table_lines),
            capabilities=self._base_caps("excel"),
            artifacts=artifacts,
            error="; ".join(str(x) for x in _as_list(data.get("messages")) if x) or None,
        )

    def _read_word(self, window: JsonDict) -> AdapterReadContext:
        try:
            requested_hwnd = int(window.get("hwnd") or 0)
        except (TypeError, ValueError):
            requested_hwnd = 0
        if requested_hwnd <= 0:
            return AdapterReadContext(
                adapter=self.name,
                app="word",
                window=window,
                capabilities=self._base_caps("word"),
                error="Word native read requires the captured window hwnd.",
            )
        prog_id = word_com_prog_id_from_window(window)
        if prog_id not in ALLOWED_WORD_COM_PROG_IDS:
            prog_id = WORD_COM_PROG_ID
        host = word_host_from_prog_id(prog_id)
        fast_probe = _run_word_selection_vbs(prog_id)
        fast_hwnd = 0
        if fast_probe.ok:
            try:
                fast_hwnd = int(fast_probe.data.get("hwnd") or 0)
            except (TypeError, ValueError):
                fast_hwnd = 0
        if fast_probe.ok and fast_hwnd == requested_hwnd:
            data = {
                **fast_probe.data,
                "app": "word",
                "host": host,
                "com_prog_id": prog_id,
                "method": "com:word.selection.cscript",
                "messages": [],
            }
            return self._word_context_from_data(window, data, host=host, prog_id=prog_id)
        script = '''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targetHwnd = [int64]''' + str(requested_hwnd) + '''
$result = [ordered]@{ app="word"; host="''' + host + '''"; com_prog_id="''' + prog_id + '''"; method="com:word.selection"; hwnd=$null; document=$null; document_name=$null; document_path=$null; document_saved=$null; text=$null; selection_type=$null; selection_start=$null; selection_end=$null; messages=@() }
try {
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject("''' + prog_id + '''")
  $matchedWindow = $null
  foreach ($candidate in @($word.Windows)) { if ([int64]$candidate.Hwnd -eq $targetHwnd) { $matchedWindow = $candidate; break } }
  if ($null -eq $matchedWindow) { throw "No Word document window matches hwnd $targetHwnd" }
  $result.hwnd = [int64]$matchedWindow.Hwnd
  $document = $matchedWindow.Document
  $result.document = [string]$document.FullName
  $result.document_name = [string]$document.Name
  $result.document_path = [string]$document.Path
  $result.document_saved = [bool]$document.Saved
  $sel = $matchedWindow.Selection
  if ($null -eq $sel) { throw "No Word selection" }
  $result.selection_type = [string]$sel.Type
  try { $result.selection_start = [int]$sel.Start; $result.selection_end = [int]$sel.End } catch {}
  if ($null -ne $result.selection_start -and $null -ne $result.selection_end -and [int]$result.selection_end -le [int]$result.selection_start) {
    $result.text = ""
    $result.messages += "No text is selected."
  } else {
    $result.text = [string]$sel.Text
  }
} catch { $result.messages += $_.Exception.Message }
$result | ConvertTo-Json -Depth 6 -Compress
'''
        probe = _run_powershell_json(script)
        if not probe.ok:
            error = "; ".join(part for part in (fast_probe.error, probe.error) if part)
            return AdapterReadContext(adapter=self.name, app="word", window=window, capabilities=self._base_caps("word"), error=error)
        try:
            returned_hwnd = int(probe.data.get("hwnd") or 0)
        except (TypeError, ValueError):
            returned_hwnd = 0
        if returned_hwnd != requested_hwnd:
            return AdapterReadContext(
                adapter=self.name,
                app="word",
                window=window,
                capabilities=self._base_caps("word"),
                error=f"Word COM returned hwnd {returned_hwnd}, expected {requested_hwnd}.",
            )
        return self._word_context_from_data(window, probe.data, host=host, prog_id=prog_id)

    def _word_context_from_data(
        self,
        window: JsonDict,
        data: JsonDict,
        *,
        host: str,
        prog_id: str,
    ) -> AdapterReadContext:
        raw_text = str(data.get("text") or "")
        artifacts = {
            k: data.get(k)
            for k in (
                "hwnd",
                "document",
                "document_name",
                "document_path",
                "document_saved",
                "selection_type",
                "selection_start",
                "selection_end",
                "messages",
                "host",
                "com_prog_id",
            )
        }
        artifacts["host"] = data.get("host") or host
        artifacts["com_prog_id"] = data.get("com_prog_id") or prog_id
        artifacts["source_identity"] = {
            "absolutePath": data.get("document"),
            "hwnd": data.get("hwnd"),
            "host": host,
        }
        artifacts["locators"] = [{
            "kind": "text",
            "value": {
                "story": "selection",
                "start": data.get("selection_start"),
                "end": data.get("selection_end"),
            },
        }]
        artifacts["selection_text_sha256"] = hashlib.sha256(raw_text.encode("utf-8", errors="surrogatepass")).hexdigest()
        artifacts["selection_text_chars"] = len(raw_text)
        return AdapterReadContext(
            adapter=self.name,
            app="word",
            window=window,
            label=str(data.get("document") or "Word selection"),
            method=str(data.get("method") or "com:word.selection"),
            content=raw_text,
            capabilities=self._base_caps("word"),
            artifacts=artifacts,
            error="; ".join(str(x) for x in _as_list(data.get("messages")) if x) or None,
        )

    def _read_powerpoint(self, window: JsonDict) -> AdapterReadContext:
        try:
            requested_hwnd = int(window.get("hwnd") or 0)
        except (TypeError, ValueError):
            requested_hwnd = 0
        if requested_hwnd <= 0:
            return AdapterReadContext(
                adapter=self.name,
                app="powerpoint",
                window=window,
                capabilities=self._base_caps("powerpoint"),
                error="PowerPoint native read requires the captured window hwnd.",
            )
        script = r'''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targetHwnd = [int64]__TARGET_HWND__
$result = [ordered]@{ app="powerpoint"; method="com:powerpoint.selection"; hwnd=$null; presentation=$null; presentation_name=$null; presentation_path=$null; presentation_saved=$null; slide_id=$null; slide_index=$null; shapes=@(); messages=@() }
__NATIVE_WINDOW__
function Read-Shape([object]$shape, [object]$parentShapeId) {
  $text = ""
  try {
    if ([int]$shape.HasTextFrame -eq -1 -and [int]$shape.TextFrame.HasText -eq -1) {
      $text = [string]$shape.TextFrame.TextRange.Text
    }
  } catch {}
  $item = [ordered]@{
    shape_id=[int]$shape.Id
    name=[string]$shape.Name
    type=[int]$shape.Type
    left=[double]$shape.Left
    top=[double]$shape.Top
    width=[double]$shape.Width
    height=[double]$shape.Height
    text=$text
    parent_shape_id=$parentShapeId
  }
  $item
  try {
    if ([int]$shape.Type -eq 6) {
      for ($index=1; $index -le [int]$shape.GroupItems.Count; $index++) {
        Read-Shape $shape.GroupItems.Item($index) ([int]$shape.Id)
      }
    }
  } catch { $result.messages += $_.Exception.Message }
}
try {
  $matchedWindow = [MpPowerPointWindow]::FromHandle($targetHwnd)
  if ($null -eq $matchedWindow) { throw "No PowerPoint document window matches hwnd $targetHwnd" }
  $result.hwnd = $targetHwnd
  $presentation = $matchedWindow.Presentation
  if ($null -eq $presentation) { throw "Matched PowerPoint window has no presentation" }
  $result.presentation = [string]$presentation.FullName
  $result.presentation_name = [string]$presentation.Name
  $result.presentation_path = [string]$presentation.Path
  $result.presentation_saved = [bool]$presentation.Saved
  $selection = $matchedWindow.Selection
  try {
    $slide = $matchedWindow.View.Slide
    if ($null -ne $slide) {
      $result.slide_id = [int]$slide.SlideID
      $result.slide_index = [int]$slide.SlideIndex
    }
  } catch {}
  if ($null -ne $selection -and [int]$selection.Type -eq 2) {
    for ($index=1; $index -le [int]$selection.ShapeRange.Count; $index++) {
      $result.shapes += @(Read-Shape $selection.ShapeRange.Item($index) $null)
    }
  } elseif ($null -ne $result.slide_id) {
    $slide = $presentation.Slides.FindBySlideID([int]$result.slide_id)
    for ($index=1; $index -le [int]$slide.Shapes.Count; $index++) {
      $result.shapes += @(Read-Shape $slide.Shapes.Item($index) $null)
    }
    $result.messages += "No shape selection; returned current slide structure."
  }
} catch { $result.messages += $_.Exception.Message }
$result | ConvertTo-Json -Depth 10 -Compress
'''.replace("__TARGET_HWND__", str(requested_hwnd)).replace(
            "__NATIVE_WINDOW__", POWERPOINT_NATIVE_WINDOW_SCRIPT
        )
        probe = _run_powershell_json(script, timeout=3)
        if not probe.ok:
            return AdapterReadContext(
                adapter=self.name,
                app="powerpoint",
                window=window,
                capabilities=self._base_caps("powerpoint"),
                error=probe.error,
            )
        data = probe.data
        try:
            returned_hwnd = int(data.get("hwnd") or 0)
        except (TypeError, ValueError):
            returned_hwnd = 0
        if returned_hwnd != requested_hwnd:
            return AdapterReadContext(
                adapter=self.name,
                app="powerpoint",
                window=window,
                capabilities=self._base_caps("powerpoint"),
                error=f"PowerPoint COM returned hwnd {returned_hwnd}, expected {requested_hwnd}.",
            )
        shapes = [item for item in _as_list(data.get("shapes")) if isinstance(item, dict)]
        locators: list[JsonDict] = []
        content_parts: list[str] = []
        for shape in shapes:
            try:
                bbox = [float(shape.get(key) or 0) for key in ("left", "top", "width", "height")]
                shape_id = int(shape.get("shape_id"))
            except (TypeError, ValueError):
                continue
            locators.append({
                "kind": "slide-shape",
                "value": {
                    "slideId": int(data.get("slide_id")) if data.get("slide_id") is not None else None,
                    "shapeId": shape_id,
                    "parentShapeId": shape.get("parent_shape_id"),
                    "bboxPt": bbox,
                },
            })
            text = str(shape.get("text") or "").strip()
            if text:
                content_parts.append(text)
        messages = [str(item) for item in _as_list(data.get("messages")) if item]
        return AdapterReadContext(
            adapter=self.name,
            app="powerpoint",
            window=window,
            label=str(data.get("presentation") or data.get("presentation_name") or "PowerPoint selection"),
            method=str(data.get("method") or "com:powerpoint.selection"),
            content="\n\n".join(content_parts),
            capabilities=self._base_caps("powerpoint"),
            artifacts={
                "hwnd": data.get("hwnd"),
                "document": data.get("presentation"),
                "document_name": data.get("presentation_name"),
                "document_path": data.get("presentation_path"),
                "document_saved": data.get("presentation_saved"),
                "slide_id": data.get("slide_id"),
                "slide_index": data.get("slide_index"),
                "shapes": shapes,
                "locators": locators,
                "messages": messages,
                "source_identity": {
                    "absolutePath": data.get("presentation"),
                    "hwnd": returned_hwnd,
                    "host": "microsoft_powerpoint",
                },
            },
            error="; ".join(messages) or None,
        )
