"""Execute production PowerShell bodies against small native-property stand-ins."""
import json
import os
import pytest
from app.actions.office_document import PowerShellLiveOfficeGateway
from app.actions.powerpoint import PowerPointComGateway as PowerShellPowerPointGateway
from app.adapters.office_adapter import _run_powershell_json

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell contract")


def run_body(body, payload, fixture):
    import base64
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    script = '$ErrorActionPreference="Stop"\n' + fixture + '\n$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + encoded + '")) | ConvertFrom-Json\n$result = [ordered]@{ok=$false; wrote=$false; error=$null}\ntry {\n' + body + '\n} catch {$result.error=$_.Exception.Message}\n$result | ConvertTo-Json -Compress -Depth 12'
    result = _run_powershell_json(script, timeout=12)
    assert result.ok, result.error
    return result.data


@pytest.mark.parametrize("after, expected_visible", [(None, 0), (255, -1)])
def test_ppt_fill_visibility_roundtrip(monkeypatch, after, expected_visible):
    calls = []
    monkeypatch.setattr(PowerShellPowerPointGateway, "_write", staticmethod(lambda body, *args: calls.append((body, args[-1])) or {}))
    PowerShellPowerPointGateway().set_shape_style(path="p", hwnd=1, slide_id=1, shape_id=1,
        expected={"fillRgb": None, "lineRgb": None}, after={"fillRgb": after, "lineRgb": None})
    body, payload = calls[0]
    fixture = '$shape=[pscustomobject]@{Locked=0; Fill=[pscustomobject]@{Visible=0; ForeColor=[pscustomobject]@{RGB=0}}; Line=[pscustomobject]@{Visible=0; ForeColor=[pscustomobject]@{RGB=0}}}'
    result = run_body(body + '\n$result.visible=$shape.Fill.Visible', payload, fixture)
    assert result["ok"], result
    assert result["visible"] == expected_visible


def test_ppt_geometry_partial_failure_reports_write(monkeypatch):
    calls = []
    monkeypatch.setattr(PowerShellPowerPointGateway, "_write", staticmethod(lambda body, *args: calls.append((body, args[-1])) or {}))
    PowerShellPowerPointGateway().set_shape_geometry(path="p", hwnd=1, slide_id=1, shape_id=1,
        expected={"left": 1, "top": 2}, after={"left": 10, "top": 20})
    body, payload = calls[0]
    fixture = '''Add-Type 'public class Shape { public int Locked=0; public double Left=1; public double Top {get{return 2;} set{throw new System.Exception("locked top");}} }'
$shape = New-Object Shape'''
    result = run_body(body, payload, fixture)
    assert not result["ok"] and result["error"]
    assert result["wrote"], result


def test_excel_partial_failure_reports_write(monkeypatch):
    calls = []
    monkeypatch.setattr(PowerShellLiveOfficeGateway, "_EXCEL_BIND", "")
    monkeypatch.setattr(PowerShellLiveOfficeGateway, "_run", staticmethod(lambda host, body, payload: calls.append((body, payload)) or {}))
    PowerShellLiveOfficeGateway().set_excel(path="p", hwnd=1, sheet="s", address="A1:B1", expected=[[0, 0]], after=[[1, 2]])
    body, payload = calls[0]
    fixture = '''Add-Type 'public class Cell { public string Formula=""; public bool Fail=false; private object val=0; public object Value2 {get{return val;} set{if(Fail) throw new System.Exception("protected cell"); val=value;}} }'
$one=New-Object Cell; $two=New-Object Cell; $two.Fail=$true
$cells=[pscustomobject]@{}
$cells | Add-Member ScriptMethod Item {param($r,$c) if($c -eq 1){return $one}else{return $two}}
$range=[pscustomobject]@{Rows=@{Count=1};Columns=@{Count=2};Cells=$cells}'''
    result = run_body(body, payload, fixture)
    assert not result["ok"] and result["error"]
    assert result["wrote"], result
