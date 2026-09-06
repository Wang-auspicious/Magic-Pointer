"""Identity-bound PowerPoint shape reads and structured local edits.

The model never supplies COM code.  It can only select one of the operations
defined by :mod:`app.artifacts.document_patch`; this module resolves an exact
presentation window, slide id, and recursively nested shape id before reading
or writing through a fixed PowerShell/COM program.
"""

from __future__ import annotations

import base64
import json
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from app.adapters.office_adapter import _run_powershell_json
from app.adapters.powerpoint_native import POWERPOINT_NATIVE_WINDOW_SCRIPT
from app.artifacts.document_patch import (
    OperationReadResult,
    OperationWriteResult,
    PatchOperation,
)
from app.context_pack.sources import SourceRef


class PowerPointGateway(Protocol):
    used_backend: str

    def read_shape(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
    ) -> Mapping[str, Any]: ...

    def replace_shape_text(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected_text: str,
        start: int,
        length: int,
        replacement: str,
    ) -> Mapping[str, Any]: ...

    def set_shape_style(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected: Mapping[str, Any],
        after: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...

    def set_shape_geometry(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected: Mapping[str, Any],
        after: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...


def _encoded(value: str) -> str:
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def _normalized_path(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("PowerPoint source has no absolute document path")
    return str(Path(raw).expanduser().resolve(strict=False))


def _source_binding(source: SourceRef) -> tuple[str, int]:
    identity = dict(source.identity)
    path = _normalized_path(
        identity.get("absolutePath")
        or identity.get("path")
        or identity.get("document")
    )
    raw_hwnd = identity.get("hwnd")
    if isinstance(raw_hwnd, bool):
        raise ValueError("PowerPoint source hwnd is invalid")
    try:
        hwnd = int(raw_hwnd)
    except (TypeError, ValueError) as exc:
        raise ValueError("PowerPoint source has no bound window hwnd") from exc
    if hwnd <= 0:
        raise ValueError("PowerPoint source has no bound window hwnd")
    return path, hwnd


def _shape_binding(operation: PatchOperation) -> tuple[int, int]:
    if operation.locator.kind != "slide-shape":
        raise ValueError("PowerPoint operation requires a slide-shape locator")
    value = operation.locator.value
    try:
        slide_id = int(value["slideId"])
        shape_id = int(value["shapeId"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("PowerPoint locator requires integer slideId and shapeId") from exc
    if slide_id <= 0 or shape_id <= 0:
        raise ValueError("PowerPoint locator slideId and shapeId must be positive")
    return slide_id, shape_id


def _fixed_shape_script(body: str, payload: Mapping[str, Any]) -> str:
    encoded_payload = _encoded(json.dumps(dict(payload), ensure_ascii=False))
    return r'''
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("__PAYLOAD__"))
$p = $payloadJson | ConvertFrom-Json
$result = [ordered]@{ ok=$false; wrote=$false; error=$null; shape=$null }
__NATIVE_WINDOW__
function Find-MpShape([object]$shapes, [int]$shapeId) {
  for ($i=1; $i -le [int]$shapes.Count; $i++) {
    $candidate = $shapes.Item($i)
    if ([int]$candidate.Id -eq $shapeId) { return $candidate }
    try {
      if ([int]$candidate.Type -eq 6) {
        $nested = Find-MpShape $candidate.GroupItems $shapeId
        if ($null -ne $nested) { return $nested }
      }
    } catch {}
  }
  return $null
}
function Get-MpPresentation([int64]$hwnd, [string]$path) {
  $window = [MpPowerPointWindow]::FromHandle($hwnd)
  if ($null -eq $window) { return $null }
  $presentation = $window.Presentation
  if ($null -ne $presentation -and [string]::Equals(
    [string]$presentation.FullName, $path,
    [StringComparison]::OrdinalIgnoreCase
  )) { return $presentation }
  return $null
}
try {
  $presentation = Get-MpPresentation ([int64]$p.hwnd) ([string]$p.path)
  if ($null -eq $presentation) { throw "bound_presentation_not_found" }
  $slide = $presentation.Slides.FindBySlideID([int]$p.slideId)
  if ($null -eq $slide) { throw "bound_slide_not_found" }
  $shape = Find-MpShape $slide.Shapes ([int]$p.shapeId)
  if ($null -eq $shape) { throw "bound_shape_not_found" }
__BODY__
} catch { $result.error = [string]$_.Exception.Message }
$result | ConvertTo-Json -Depth 12 -Compress
'''.replace("__PAYLOAD__", encoded_payload).replace("__BODY__", body).replace(
        "__NATIVE_WINDOW__", POWERPOINT_NATIVE_WINDOW_SCRIPT
    )


class PowerPointComGateway:
    used_backend = "powerpoint.com.powershell"

    def read_shape(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
    ) -> Mapping[str, Any]:
        body = r'''
  $text = ""
  try {
    if ([int]$shape.HasTextFrame -eq -1 -and [int]$shape.TextFrame.HasText -eq -1) {
      $text = [string]$shape.TextFrame.TextRange.Text
    }
  } catch {}
  $fill = $null; $line = $null
  try { if ([int]$shape.Fill.Visible -eq -1) { $fill = [int64]$shape.Fill.ForeColor.RGB } } catch {}
  try { if ([int]$shape.Line.Visible -eq -1) { $line = [int64]$shape.Line.ForeColor.RGB } } catch {}
  $result.shape = [ordered]@{
    text=$text
    geometry=[ordered]@{
      left=[double]$shape.Left; top=[double]$shape.Top
      width=[double]$shape.Width; height=[double]$shape.Height
    }
    style=[ordered]@{ fillRgb=$fill; lineRgb=$line }
    locked=([int]$shape.Locked -eq -1)
    masterShape=$false
    presentationSaved=[bool]$presentation.Saved
    presentationPath=[string]$presentation.FullName
    slideId=[int]$slide.SlideID
    shapeId=[int]$shape.Id
  }
  $result.ok = $true
'''
        probe = _run_powershell_json(_fixed_shape_script(body, {
            "path": path,
            "hwnd": hwnd,
            "slideId": slide_id,
            "shapeId": shape_id,
        }), timeout=8)
        if not probe.ok:
            raise RuntimeError(probe.error or "powerpoint_read_failed")
        if probe.data.get("ok") is not True or not isinstance(probe.data.get("shape"), dict):
            raise RuntimeError(str(probe.data.get("error") or "powerpoint_shape_not_found"))
        return dict(probe.data["shape"])

    def replace_shape_text(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected_text: str,
        start: int,
        length: int,
        replacement: str,
    ) -> Mapping[str, Any]:
        body = r'''
  if ([int]$shape.Locked -eq -1) { throw "shape_locked" }
  if ([int]$shape.HasTextFrame -ne -1) { throw "shape_has_no_text_frame" }
  $range = $shape.TextFrame.TextRange
  if (-not [string]::Equals([string]$range.Text, [string]$p.expectedText, [StringComparison]::Ordinal)) {
    throw "base_mismatch"
  }
  if ([int]$p.length -eq 0) {
    if ([int]$p.start -ge [int]$range.Length) {
      $range.InsertAfter([string]$p.replacement) | Out-Null
    } else {
      $range.Characters(([int]$p.start + 1), 1).InsertBefore([string]$p.replacement) | Out-Null
    }
  } else {
    $range.Characters(([int]$p.start + 1), [int]$p.length).Text = [string]$p.replacement
  }
  $result.ok = $true; $result.wrote = $true
'''
        return self._write(body, path, hwnd, slide_id, shape_id, {
            "expectedText": expected_text,
            "start": start,
            "length": length,
            "replacement": replacement,
        })

    def set_shape_style(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected: Mapping[str, Any],
        after: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        body = r'''
  if ([int]$shape.Locked -eq -1) { throw "shape_locked" }
  if ($null -ne $p.expected.fillRgb -and [int64]$shape.Fill.ForeColor.RGB -ne [int64]$p.expected.fillRgb) { throw "base_mismatch" }
  if ($null -ne $p.expected.lineRgb -and [int64]$shape.Line.ForeColor.RGB -ne [int64]$p.expected.lineRgb) { throw "base_mismatch" }
  if ($null -ne $p.after.fillRgb) { $shape.Fill.ForeColor.RGB = [int64]$p.after.fillRgb }
  if ($null -ne $p.after.lineRgb) { $shape.Line.ForeColor.RGB = [int64]$p.after.lineRgb }
  $result.ok = $true; $result.wrote = $true
'''
        return self._write(body, path, hwnd, slide_id, shape_id, {
            "expected": dict(expected), "after": dict(after),
        })

    def set_shape_geometry(
        self,
        *,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        expected: Mapping[str, Any],
        after: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        body = r'''
  if ([int]$shape.Locked -eq -1) { throw "shape_locked" }
  foreach ($name in @("left", "top", "width", "height")) {
    if ($null -ne $p.expected.$name -and [Math]::Abs([double]$shape.$name - [double]$p.expected.$name) -gt 0.01) { throw "base_mismatch" }
  }
  foreach ($name in @("left", "top", "width", "height")) {
    if ($null -ne $p.after.$name) { $shape.$name = [double]$p.after.$name }
  }
  $result.ok = $true; $result.wrote = $true
'''
        return self._write(body, path, hwnd, slide_id, shape_id, {
            "expected": dict(expected), "after": dict(after),
        })

    @staticmethod
    def _write(
        body: str,
        path: str,
        hwnd: int,
        slide_id: int,
        shape_id: int,
        extra: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        probe = _run_powershell_json(_fixed_shape_script(body, {
            "path": path,
            "hwnd": hwnd,
            "slideId": slide_id,
            "shapeId": shape_id,
            **dict(extra),
        }), timeout=12)
        if not probe.ok:
            return {"ok": False, "wrote": False, "error": probe.error}
        return dict(probe.data)


def _minimal_text_change(before: str, after: str) -> tuple[int, int, str]:
    prefix = 0
    bound = min(len(before), len(after))
    while prefix < bound and before[prefix] == after[prefix]:
        prefix += 1
    suffix = 0
    remaining_before = len(before) - prefix
    remaining_after = len(after) - prefix
    while (
        suffix < remaining_before
        and suffix < remaining_after
        and before[len(before) - suffix - 1] == after[len(after) - suffix - 1]
    ):
        suffix += 1
    removed = len(before) - prefix - suffix
    replacement_end = len(after) - suffix if suffix else len(after)
    return prefix, removed, after[prefix:replacement_end]


def _operation_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping) and isinstance(value.get("text"), str):
        return str(value["text"])
    raise ValueError("set_shape_text before/after require text")


def _project_snapshot(operation: PatchOperation, snapshot: Mapping[str, Any]) -> Any:
    if operation.operation == "set_shape_text":
        text = str(snapshot.get("text") or "")
        return text if isinstance(operation.before, str) else {"text": text}
    section = {
        "set_shape_style": "style",
        "set_shape_geometry": "geometry",
    }.get(operation.operation)
    if section is None:
        raise ValueError(f"unsupported PowerPoint operation: {operation.operation}")
    before = operation.before
    after = operation.after
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        raise ValueError(f"{operation.operation} before/after must be objects")
    if set(before) != set(after):
        raise ValueError(f"{operation.operation} before/after fields must match")
    allowed = {
        "set_shape_style": {"fillRgb", "lineRgb"},
        "set_shape_geometry": {"left", "top", "width", "height"},
    }[operation.operation]
    unsupported = sorted(set(before) - allowed)
    if unsupported:
        raise ValueError(
            f"unsupported {operation.operation} fields: {unsupported}"
        )
    if operation.operation == "set_shape_style":
        for key in before:
            for side, raw in (("before", before[key]), ("after", after[key])):
                if raw is None:
                    continue
                if isinstance(raw, bool) or not isinstance(raw, int):
                    raise ValueError(f"{key} {side} must be an integer RGB value or null")
                if raw < 0 or raw > 0xFFFFFF:
                    raise ValueError(f"{key} {side} RGB value is outside 0..16777215")
    else:
        for key in before:
            for side, raw in (("before", before[key]), ("after", after[key])):
                if (
                    isinstance(raw, bool)
                    or not isinstance(raw, (int, float))
                    or not math.isfinite(float(raw))
                ):
                    raise ValueError(f"{key} {side} must be a finite number")
            if key in {"width", "height"} and float(after[key]) <= 0:
                raise ValueError(f"{key} after must be positive")
    values = snapshot.get(section)
    if not isinstance(values, Mapping):
        raise ValueError(f"PowerPoint shape has no {section} snapshot")
    return {key: values.get(key) for key in before}


class PowerPointActionHandler:
    def __init__(self, *, gateway: PowerPointGateway | None = None) -> None:
        self.gateway = gateway or PowerPointComGateway()

    def _snapshot(self, source: SourceRef, operation: PatchOperation) -> Mapping[str, Any]:
        path, hwnd = _source_binding(source)
        slide_id, shape_id = _shape_binding(operation)
        return self.gateway.read_shape(
            path=path,
            hwnd=hwnd,
            slide_id=slide_id,
            shape_id=shape_id,
        )

    def read_current(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationReadResult:
        try:
            value = _project_snapshot(operation, self._snapshot(source, operation))
            return OperationReadResult(True, value, self.gateway.used_backend)
        except Exception as exc:
            return OperationReadResult(
                False,
                used_backend=self.gateway.used_backend,
                error=f"powerpoint_read_failed:{type(exc).__name__}:{exc}",
            )

    def execute(
        self,
        source: SourceRef,
        operation: PatchOperation,
    ) -> OperationWriteResult:
        try:
            path, hwnd = _source_binding(source)
            slide_id, shape_id = _shape_binding(operation)
            snapshot = self._snapshot(source, operation)
            current = _project_snapshot(operation, snapshot)
            if current != operation.before:
                return OperationWriteResult(
                    False, False, self.gateway.used_backend, "base_mismatch"
                )
            if snapshot.get("locked") is True:
                return OperationWriteResult(
                    False, False, self.gateway.used_backend, "shape_locked"
                )
            if snapshot.get("masterShape") is True:
                return OperationWriteResult(
                    False, False, self.gateway.used_backend, "master_shape_not_editable"
                )
            if operation.operation == "set_shape_text":
                before = _operation_text(operation.before)
                after = _operation_text(operation.after)
                start, length, replacement = _minimal_text_change(before, after)
                result = self.gateway.replace_shape_text(
                    path=path,
                    hwnd=hwnd,
                    slide_id=slide_id,
                    shape_id=shape_id,
                    expected_text=before,
                    start=start,
                    length=length,
                    replacement=replacement,
                )
            elif operation.operation == "set_shape_style":
                result = self.gateway.set_shape_style(
                    path=path,
                    hwnd=hwnd,
                    slide_id=slide_id,
                    shape_id=shape_id,
                    expected=dict(operation.before),
                    after=dict(operation.after),
                )
            elif operation.operation == "set_shape_geometry":
                result = self.gateway.set_shape_geometry(
                    path=path,
                    hwnd=hwnd,
                    slide_id=slide_id,
                    shape_id=shape_id,
                    expected=dict(operation.before),
                    after=dict(operation.after),
                )
            else:
                return OperationWriteResult(
                    False,
                    False,
                    self.gateway.used_backend,
                    f"unsupported_powerpoint_operation:{operation.operation}",
                )
            return OperationWriteResult(
                bool(result.get("ok")),
                bool(result.get("wrote")),
                self.gateway.used_backend,
                str(result.get("error") or "") or None,
            )
        except Exception as exc:
            return OperationWriteResult(
                False,
                False,
                self.gateway.used_backend,
                f"powerpoint_write_failed:{type(exc).__name__}:{exc}",
            )


__all__ = [
    "PowerPointActionHandler",
    "PowerPointComGateway",
    "PowerPointGateway",
]
