from __future__ import annotations

import base64
import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.adapters.base import AdapterCapability, AdapterReadContext, AppAdapter

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


def _run_powershell_json(script: str, *, timeout: int = 6) -> OfficeProbeResult:
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    try:
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
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


class OfficeAdapter(AppAdapter):
    name = "office"

    def match_window(self, window: JsonDict) -> bool:
        return office_app_from_window(window) is not None

    def read_context(self, window: JsonDict, **kwargs: Any) -> AdapterReadContext:
        app = office_app_from_window(window) or "office"
        if app == "excel":
            return self._read_excel(window)
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
        return [AdapterCapability("read_selection", "Read selected Office object/text", "read_only")]

    def _read_excel(self, window: JsonDict) -> AdapterReadContext:
        script = '''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$result = [ordered]@{ app="excel"; method="com:excel.selection"; hwnd=$null; workbook=$null; worksheet=$null; address=$null; rows=@(); row_count=0; col_count=0; messages=@() }
try {
  $excel = [Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
  $result.hwnd = [int64]$excel.Hwnd
  if ($excel.ActiveWorkbook) { $result.workbook = [string]$excel.ActiveWorkbook.FullName }
  if ($excel.ActiveSheet) { $result.worksheet = [string]$excel.ActiveSheet.Name }
  $sel = $excel.Selection
  if ($null -eq $sel) { throw "No Excel selection" }
  $result.address = [string]$sel.Address($false, $false)
  $maxRows = [Math]::Min([int]$sel.Rows.Count, 30)
  $maxCols = [Math]::Min([int]$sel.Columns.Count, 12)
  $result.row_count = [int]$sel.Rows.Count
  $result.col_count = [int]$sel.Columns.Count
  for ($r=1; $r -le $maxRows; $r++) {
    $row = @()
    for ($c=1; $c -le $maxCols; $c++) {
      $cell = $sel.Cells.Item($r,$c)
      $row += [ordered]@{ text=[string]$cell.Text; value=$cell.Value2; formula=[string]$cell.Formula }
    }
    $result.rows += ,$row
  }
} catch { $result.messages += $_.Exception.Message }
$result | ConvertTo-Json -Depth 8 -Compress
'''
        probe = _run_powershell_json(script)
        if not probe.ok:
            return AdapterReadContext(adapter=self.name, app="excel", window=window, capabilities=self._base_caps("excel"), error=probe.error)
        data = probe.data
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
        return AdapterReadContext(
            adapter=self.name,
            app="excel",
            window=window,
            label=label,
            method=str(data.get("method") or "com:excel.selection"),
            content="\n".join(table_lines),
            capabilities=self._base_caps("excel"),
            artifacts={k: data.get(k) for k in ("hwnd", "workbook", "worksheet", "address", "row_count", "col_count", "messages")},
            error="; ".join(str(x) for x in _as_list(data.get("messages")) if x) or None,
        )

    def _read_word(self, window: JsonDict) -> AdapterReadContext:
        prog_id = word_com_prog_id_from_window(window)
        if prog_id not in ALLOWED_WORD_COM_PROG_IDS:
            prog_id = WORD_COM_PROG_ID
        host = word_host_from_prog_id(prog_id)
        fast_probe = _run_word_selection_vbs(prog_id)
        if fast_probe.ok:
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
$result = [ordered]@{ app="word"; host="''' + host + '''"; com_prog_id="''' + prog_id + '''"; method="com:word.selection"; hwnd=$null; document=$null; document_name=$null; document_path=$null; document_saved=$null; text=$null; selection_type=$null; selection_start=$null; selection_end=$null; messages=@() }
try {
  $word = [Runtime.InteropServices.Marshal]::GetActiveObject("''' + prog_id + '''")
  try { if ($word.ActiveWindow) { $result.hwnd = [int64]$word.ActiveWindow.Hwnd } } catch {}
  if ($word.ActiveDocument) {
    $result.document = [string]$word.ActiveDocument.FullName
    $result.document_name = [string]$word.ActiveDocument.Name
    $result.document_path = [string]$word.ActiveDocument.Path
    $result.document_saved = [bool]$word.ActiveDocument.Saved
  }
  $sel = $word.Selection
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
        return AdapterReadContext(
            adapter=self.name,
            app="powerpoint",
            window=window,
            method="pending:powerpoint",
            capabilities=self._base_caps("powerpoint"),
            error="PowerPoint native selection adapter is registered but not implemented yet.",
        )
