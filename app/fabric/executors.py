from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid
from difflib import unified_diff
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlencode

from app.fabric.schema import ExecutionReceipt, OperationPlan

_VISUAL_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp", ".heic", ".avif",
}


def _sha256(value: str | bytes) -> str:
    raw = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _atomic_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temp, path)
    return path


def _atomic_json(path: Path, value: dict[str, Any]) -> Path:
    return _atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _objects(plan: OperationPlan) -> list[dict[str, Any]]:
    return [dict(item) for item in plan.parameters.get("objects") or [] if isinstance(item, dict)]


def _content(obj: dict[str, Any]) -> str:
    return str(obj.get("content") or obj.get("text") or obj.get("label") or "").strip()


def _is_visual_attachment(value: str) -> bool:
    return Path(str(value or "")).suffix.casefold() in _VISUAL_SUFFIXES


def _receipt(
    plan: OperationPlan,
    *,
    status: str,
    output: dict[str, Any] | None = None,
    verified: bool = False,
    verification: dict[str, Any] | None = None,
    undo: dict[str, Any] | None = None,
    error: str | None = None,
) -> ExecutionReceipt:
    return ExecutionReceipt(
        id=str(uuid.uuid4()),
        plan_id=plan.id,
        recipe_id=plan.recipe_id,
        status=status,
        provider=plan.provider,
        output=output or {},
        verified=verified,
        verification=verification or {},
        undo=undo,
        error=error,
    )


def _parse_table(text: str) -> list[list[str]]:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return []
    if all("|" in line for line in lines):
        rows = [[cell.strip() for cell in line.strip("|").split("|")] for line in lines]
        rows = [row for row in rows if not all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in row)]
        return rows
    delimiter = "\t" if any("\t" in line for line in lines) else ","
    return [[cell.strip() for cell in next(csv.reader([line], delimiter=delimiter))] for line in lines]


class FabricExecutors:
    def __init__(
        self,
        *,
        root: Path,
        clipboard_writer: Callable[[str], Any] | None = None,
        clipboard_reader: Callable[[], str] | None = None,
        url_opener: Callable[[str], Any] | None = None,
        model_transform: Callable[[str, str, str], str] | None = None,
        provider_handlers: dict[str, Callable[[OperationPlan], dict[str, Any]]] | None = None,
        agent_starter: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        ocr_reader: Callable[[Path], str] | None = None,
        allow_screenshot_upload: bool = False,
    ) -> None:
        self.root = Path(root)
        self.clipboard_writer = clipboard_writer
        self.clipboard_reader = clipboard_reader
        self.url_opener = url_opener
        self.model_transform = model_transform
        self.provider_handlers = dict(provider_handlers or {})
        self.agent_starter = agent_starter
        self.allow_screenshot_upload = allow_screenshot_upload is True
        self.last_ocr_engine = "custom" if ocr_reader is not None else "unresolved"
        self.ocr_reader = ocr_reader or self._default_ocr

    def execute(self, plan: OperationPlan) -> ExecutionReceipt:
        if plan.provider == "denied":
            return _receipt(plan, status="denied", error="permission_denied")
        if plan.provider.startswith("unavailable:"):
            return _receipt(plan, status="capability_unavailable", error=plan.provider.split(":", 1)[1])
        if plan.provider == "internal":
            return _receipt(
                plan,
                status="succeeded",
                output={"state": "available", "recipeId": plan.recipe_id},
                verified=True,
                verification={"mode": "internal_contract"},
            )
        if plan.provider == "clipboard":
            return self._clipboard(plan)
        if plan.provider == "native.ocr":
            return self._ocr(plan)
        if plan.provider == "artifact.table":
            return self._table(plan)
        if plan.provider == "artifact.evidence":
            return self._evidence(plan)
        if plan.provider == "artifact.compare":
            return self._compare(plan)
        if plan.provider == "artifact.visual_context":
            return self._visual_context(plan)
        if plan.provider == "artifact.list":
            return self._list(plan)
        if plan.provider == "local.task":
            return self._task(plan)
        if plan.provider == "maps.deep_link":
            return self._map(plan)
        if plan.provider == "model.text":
            return self._model_text(plan)
        if plan.provider == "agent.task":
            return self._agent(plan)
        if plan.provider in self.provider_handlers:
            try:
                value = self.provider_handlers[plan.provider](plan)
            except Exception as exc:
                return _receipt(plan, status="failed", error=f"provider_failed:{type(exc).__name__}:{exc}")
            verified = value.get("verified") is True
            return _receipt(
                plan,
                status="succeeded" if verified else "verification_failed",
                output=dict(value.get("output") or {}),
                verified=verified,
                verification=dict(value.get("verification") or {}),
                undo=value.get("undo"),
                error=None if verified else str(value.get("error") or "provider_did_not_verify"),
            )
        return _receipt(plan, status="capability_unavailable", error=f"executor_not_registered:{plan.provider}")

    def _default_ocr(self, image_path: Path) -> str:
        rapid_error: Exception | None = None
        try:
            from rapidocr import RapidOCR

            result = RapidOCR()(str(image_path))
            text = "\n".join(str(item).strip() for item in (result.txts or ()) if str(item).strip())
            if text:
                self.last_ocr_engine = "rapidocr-onnx"
                return text
            rapid_error = RuntimeError("rapidocr_returned_empty")
        except Exception as exc:
            rapid_error = exc
        try:
            text = self._tesseract_ocr(image_path)
            self.last_ocr_engine = "tesseract"
            return text
        except Exception as tesseract_error:
            raise RuntimeError(
                f"rapidocr_failed:{type(rapid_error).__name__}:{rapid_error}; "
                f"tesseract_failed:{type(tesseract_error).__name__}:{tesseract_error}"
            ) from tesseract_error

    @staticmethod
    def _tesseract_ocr(image_path: Path) -> str:
        executable = shutil.which("tesseract")
        if not executable:
            raise RuntimeError("tesseract_not_installed")
        language_probe = subprocess.run(
            [executable, "--list-langs"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            shell=False,
        )
        available = {
            line.strip()
            for line in language_probe.stdout.splitlines()
            if line.strip() and not line.startswith("List of available")
        }
        preferred = [language for language in ("chi_sim", "eng") if language in available]
        argv = [executable, str(image_path), "stdout", "--psm", "6"]
        if preferred:
            argv.extend(["-l", "+".join(preferred)])
        completed = subprocess.run(
            argv,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=45,
            shell=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"tesseract_failed:{completed.stderr.strip()[:400]}")
        return completed.stdout

    def _ocr(self, plan: OperationPlan) -> ExecutionReceipt:
        if self.clipboard_writer is None:
            return _receipt(plan, status="capability_unavailable", error="clipboard_writer_not_configured")
        candidates: list[str] = []
        for obj in _objects(plan):
            source = dict(obj.get("source") or {})
            for candidate in (
                obj.get("path"),
                source.get("path"),
                source.get("imagePath"),
                source.get("screenshotPath"),
            ):
                value = str(candidate or "").strip()
                if value:
                    candidates.append(value)
        candidates.extend(str(item) for item in plan.parameters.get("attachments") or [] if str(item).strip())
        image_path = next(
            (
                Path(value).expanduser().resolve()
                for value in candidates
                if Path(value).expanduser().is_file()
                and Path(value).suffix.casefold() in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
            ),
            None,
        )
        if image_path is None:
            return _receipt(plan, status="failed", error="ocr_image_not_found")
        try:
            value = str(self.ocr_reader(image_path) or "").strip()
        except Exception as exc:
            return _receipt(plan, status="failed", error=f"ocr_failed:{type(exc).__name__}:{exc}")
        if not value:
            return _receipt(plan, status="verification_failed", error="ocr_returned_empty")
        if plan.recipe_id == "text.ocr_clean":
            command = plan.command.casefold()
            if any(token in command for token in ("去掉空格", "remove spaces", "号码空格")):
                value = re.sub(r"\s+", "", value)
            else:
                value = re.sub(r"[ \t]+", " ", value)
                value = re.sub(r"\n{3,}", "\n\n", value).strip()
        self.clipboard_writer(value)
        actual = self.clipboard_reader() if self.clipboard_reader is not None else value
        verified = actual == value
        return _receipt(
            plan,
            status="succeeded" if verified else "verification_failed",
            output={
                "text": value,
                "sha256": _sha256(value),
                "sourceImage": str(image_path),
                "ocrEngine": self.last_ocr_engine,
            },
            verified=verified,
            verification={
                "clipboardSha256": _sha256(actual),
                "characters": len(value),
                "sourceImageSha256": _sha256(image_path.read_bytes()),
            },
            error=None if verified else "clipboard_readback_mismatch",
        )

    def _clipboard(self, plan: OperationPlan) -> ExecutionReceipt:
        if self.clipboard_writer is None:
            return _receipt(plan, status="capability_unavailable", error="clipboard_writer_not_configured")
        objects = _objects(plan)
        value = _content(objects[0]) if objects else ""
        if not value:
            return _receipt(plan, status="failed", error="selected_text_is_empty")
        if plan.recipe_id == "text.ocr_clean":
            command = plan.command.casefold()
            if any(token in command for token in ("去掉空格", "remove spaces", "号码空格")):
                value = re.sub(r"\s+", "", value)
            else:
                value = re.sub(r"[ \t]+", " ", value)
                value = re.sub(r"\n{3,}", "\n\n", value).strip()
        self.clipboard_writer(value)
        actual = self.clipboard_reader() if self.clipboard_reader is not None else value
        verified = actual == value
        return _receipt(
            plan,
            status="succeeded" if verified else "verification_failed",
            output={"text": value, "sha256": _sha256(value)},
            verified=verified,
            verification={"clipboardSha256": _sha256(actual), "characters": len(value)},
            error=None if verified else "clipboard_readback_mismatch",
        )

    def _table(self, plan: OperationPlan) -> ExecutionReceipt:
        object_rows = [_parse_table(_content(obj)) for obj in _objects(plan)]
        object_rows = [rows for rows in object_rows if rows]
        if not object_rows:
            return _receipt(plan, status="failed", error="no_structured_table_content")
        if plan.recipe_id == "table.merge":
            header = object_rows[0][0]
            rows = [header]
            for table in object_rows:
                if table[0] != header:
                    return _receipt(plan, status="verification_failed", error="table_schema_conflict")
                rows.extend(table[1:])
        else:
            rows = object_rows[0]
        width = max(len(row) for row in rows)
        normalized = [row + [""] * (width - len(row)) for row in rows]
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-table.csv"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        temp = artifact.with_suffix(".csv.tmp")
        with temp.open("w", encoding="utf-8", newline="") as handle:
            csv.writer(handle, lineterminator="\n").writerows(normalized)
        os.replace(temp, artifact)
        readback = _parse_table(artifact.read_text(encoding="utf-8"))
        verified = readback == normalized
        return _receipt(
            plan,
            status="succeeded" if verified else "verification_failed",
            output={"artifact": str(artifact), "format": "csv", "sourceObjectIds": list(plan.object_ids)},
            verified=verified,
            verification={"rows": len(normalized), "columns": width, "sha256": _sha256(artifact.read_bytes())},
            undo={"action": "delete_artifact", "path": str(artifact), "sha256": _sha256(artifact.read_bytes())},
            error=None if verified else "artifact_readback_mismatch",
        )

    def _evidence(self, plan: OperationPlan) -> ExecutionReceipt:
        objects = _objects(plan)
        if not objects:
            return _receipt(plan, status="failed", error="no_evidence_objects")
        lines = ["# Magic Pointer Evidence Card", "", f"idempotency_key: {plan.idempotency_key}", ""]
        for index, obj in enumerate(objects, 1):
            source = dict(obj.get("source") or {})
            lines.extend([
                f"## Evidence {index}",
                "",
                f"object_id: {obj.get('id') or plan.object_ids[index - 1]}",
                f"app: {source.get('app') or ''}",
                f"path: {source.get('path') or ''}",
                f"page: {source.get('page') if source.get('page') is not None else ''}",
                f"bbox: {json.dumps(source.get('bbox'), ensure_ascii=False) if source.get('bbox') is not None else ''}",
                f"file_sha256: {source.get('fileSha256') or source.get('file_sha256') or ''}",
                "",
                _content(obj),
                "",
            ])
        text = "\n".join(lines).rstrip() + "\n"
        artifact = self.root / "evidence" / f"{plan.idempotency_key[:16]}.md"
        _atomic_text(artifact, text)
        digest = _sha256(artifact.read_bytes())
        return _receipt(
            plan,
            status="succeeded",
            output={"artifact": str(artifact), "sha256": digest},
            verified=artifact.exists() and _sha256(artifact.read_bytes()) == digest,
            verification={"sourceObjects": len(objects), "sha256": digest},
            undo={"action": "delete_artifact", "path": str(artifact), "sha256": digest},
        )

    def _compare(self, plan: OperationPlan) -> ExecutionReceipt:
        objects = _objects(plan)
        if len(objects) < 2:
            return _receipt(plan, status="failed", error="comparison_requires_two_objects")
        left = _content(objects[0]).splitlines()
        right = _content(objects[1]).splitlines()
        diff = "\n".join(unified_diff(left, right, fromfile=str(objects[0].get("label") or "THIS"), tofile=str(objects[1].get("label") or "THAT"), lineterm=""))
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-comparison.md"
        text = "# Object Comparison\n\n```diff\n" + diff + "\n```\n"
        _atomic_text(artifact, text)
        return _receipt(plan, status="succeeded", output={"artifact": str(artifact), "diff": diff}, verified=artifact.exists(), verification={"sourceObjects": len(objects)})

    def _visual_context(self, plan: OperationPlan) -> ExecutionReceipt:
        objects = _objects(plan)
        if not objects:
            return _receipt(plan, status="failed", error="no_visual_objects")
        has_structure = any(_content(obj) or obj.get("bbox") or obj.get("elements") for obj in objects)
        if not has_structure:
            return _receipt(plan, status="capability_unavailable", error="vision_provider_not_configured")
        value = {
            "schemaVersion": 1,
            "sourceObjectIds": list(plan.object_ids),
            "objects": [
                {
                    "id": obj.get("id"),
                    "kind": obj.get("kind"),
                    "label": obj.get("label"),
                    "content": _content(obj),
                    "bbox": obj.get("bbox"),
                    "elements": obj.get("elements") or [],
                    "source": obj.get("source") or {},
                }
                for obj in objects
            ],
        }
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-visual-context.json"
        _atomic_json(artifact, value)
        return _receipt(plan, status="succeeded", output={"artifact": str(artifact)}, verified=artifact.exists(), verification={"objects": len(objects)})

    def _list(self, plan: OperationPlan) -> ExecutionReceipt:
        items: list[dict[str, str]] = []
        for obj in _objects(plan):
            for line in _content(obj).splitlines():
                clean = re.sub(r"^\s*[-*•\d.)]+\s*", "", line).strip()
                if clean:
                    items.append({"text": clean})
        if not items:
            return _receipt(plan, status="failed", error="no_list_items")
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-list.json"
        _atomic_json(artifact, {"schemaVersion": 1, "items": items, "sourceObjectIds": list(plan.object_ids)})
        return _receipt(plan, status="succeeded", output={"artifact": str(artifact), "items": items}, verified=artifact.exists(), verification={"items": len(items)})

    def _task(self, plan: OperationPlan) -> ExecutionReceipt:
        path = self.root / "tasks" / "tasks.json"
        try:
            state = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "tasks": []}
        except json.JSONDecodeError:
            return _receipt(plan, status="failed", error="task_store_corrupt")
        tasks = list(state.get("tasks") or [])
        existing = next((item for item in tasks if item.get("idempotencyKey") == plan.idempotency_key), None)
        if existing is None:
            text = "\n\n".join(_content(obj) for obj in _objects(plan) if _content(obj))
            existing = {
                "id": str(uuid.uuid4()),
                "title": text.splitlines()[0][:160] if text else plan.command[:160],
                "description": text[:12000],
                "sourceObjectIds": list(plan.object_ids),
                "idempotencyKey": plan.idempotency_key,
                "status": "open",
            }
            tasks.append(existing)
            _atomic_json(path, {"schemaVersion": 1, "tasks": tasks})
        verified = path.exists() and any(item.get("id") == existing["id"] for item in json.loads(path.read_text(encoding="utf-8")).get("tasks", []))
        return _receipt(plan, status="succeeded" if verified else "verification_failed", output={"taskId": existing["id"], "store": str(path)}, verified=verified, verification={"taskFound": verified})

    def _map(self, plan: OperationPlan) -> ExecutionReceipt:
        objects = _objects(plan)
        if len(objects) != 2:
            return _receipt(plan, status="failed", error="route_requires_two_locations")
        origin, destination = _content(objects[0]), _content(objects[1])
        if not origin or not destination:
            return _receipt(plan, status="failed", error="route_location_is_empty")
        query = urlencode({"api": "1", "origin": origin, "destination": destination, "travelmode": str(plan.parameters.get("travelMode") or "driving")})
        url = f"https://www.google.com/maps/dir/?{query}"
        if not url.startswith("https://www.google.com/maps/dir/?api=1&"):
            return _receipt(plan, status="failed", error="route_url_not_allowlisted")
        opened = bool(self.url_opener(url)) if self.url_opener is not None else False
        if self.url_opener is None:
            return _receipt(plan, status="capability_unavailable", output={"url": url}, error="url_opener_not_configured")
        return _receipt(plan, status="succeeded" if opened else "verification_failed", output={"url": url}, verified=opened, verification={"allowlisted": True, "opened": opened}, error=None if opened else "url_open_not_verified")

    def _model_text(self, plan: OperationPlan) -> ExecutionReceipt:
        if self.model_transform is None:
            return _receipt(plan, status="capability_unavailable", error="text_model_not_configured")
        source = "\n\n".join(_content(obj) for obj in _objects(plan) if _content(obj))
        if not source:
            return _receipt(plan, status="failed", error="selected_text_is_empty")
        try:
            transformed = str(self.model_transform(plan.command, source, plan.recipe_id) or "").strip()
        except Exception as exc:
            return _receipt(plan, status="failed", error=f"text_model_failed:{type(exc).__name__}:{exc}")
        if not transformed:
            return _receipt(plan, status="verification_failed", error="text_model_returned_empty")
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-text.md"
        _atomic_text(artifact, transformed + "\n")
        return _receipt(plan, status="succeeded", output={"artifact": str(artifact), "text": transformed}, verified=artifact.exists(), verification={"characters": len(transformed), "mode": "artifact_only"})

    def _agent(self, plan: OperationPlan) -> ExecutionReceipt:
        if self.agent_starter is None:
            return _receipt(plan, status="capability_unavailable", error="agent_provider_not_configured")
        objects = _objects(plan)
        context = "\n\n".join(
            f"[{obj.get('id') or index}] {_content(obj)}"
            for index, obj in enumerate(objects, 1)
            if _content(obj)
        )
        discovered_attachments: list[str] = []
        for obj in objects:
            source = dict(obj.get("source") or {})
            for candidate in (obj.get("path"), source.get("path"), source.get("imagePath"), source.get("screenshotPath")):
                value = str(candidate or "").strip()
                if value and value not in discovered_attachments:
                    discovered_attachments.append(value)
        attachments = list(dict.fromkeys([
            *[str(item) for item in plan.parameters.get("attachments") or []],
            *discovered_attachments,
        ]))
        withheld_visual_attachments = [
            item for item in attachments
            if _is_visual_attachment(item) and not self.allow_screenshot_upload
        ]
        if not self.allow_screenshot_upload:
            attachments = [item for item in attachments if not _is_visual_attachment(item)]
        capability_fallback = str(plan.parameters.get("capabilityFallback") or "")
        prompt_parts = [
            "Magic Pointer grounded task",
            f"User intent: {plan.command}",
            f"Recipe: {plan.recipe_id}",
            f"Source object IDs: {', '.join(plan.object_ids)}",
            context,
        ]
        if capability_fallback:
            prompt_parts.append(f"Specialist capability fallback: {capability_fallback}")
        if attachments:
            prompt_parts.append(
                "Grounded local attachments:\n" + "\n".join(f"- {item}" for item in attachments)
            )
        if withheld_visual_attachments:
            prompt_parts.append(
                "Privacy boundary: Magic Pointer withheld screen/image attachments because "
                "Dashboard screenshot upload is disabled. Work only from the textual and structured context."
            )
        prompt_parts.append(
            "Inspect the current workspace yourself before changing files. "
            "Complete the named recipe, save concrete artifacts when the destination cannot be written natively, "
            "and report the exact artifact or target changed. Verify the outcome on the relevant surface. "
            "Do not submit, send, purchase, or delete external data."
        )
        prompt = "\n\n".join(item for item in prompt_parts if item)
        payload = {
            "provider": str(plan.parameters.get("agent") or ""),
            "prompt": prompt,
            "cwd": str(plan.parameters.get("cwd") or ""),
            "attachments": attachments,
            "permission": str(plan.parameters.get("agentPermission") or "write"),
            "submit": False,
            "background": plan.recipe_id == "agent.background_task",
            "sessionId": plan.id,
            "privacy": {
                "screenshotUploadAllowed": self.allow_screenshot_upload,
                "withheldVisualAttachmentCount": len(withheld_visual_attachments),
            },
        }
        try:
            task = dict(self.agent_starter(payload))
        except Exception as exc:
            return _receipt(plan, status="failed", error=f"agent_start_failed:{type(exc).__name__}:{exc}")
        accepted = bool(task.get("taskId")) and task.get("status") in {"queued", "running"}
        task["privacy"] = dict(payload["privacy"])
        return _receipt(
            plan,
            status="accepted" if accepted else "verification_failed",
            output=task,
            verified=False,
            verification={
                "taskAccepted": accepted,
                "terminalOutcomeVerified": False,
                **dict(payload["privacy"]),
            },
            error=None if accepted else "agent_task_receipt_invalid",
        )
