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

from app.fabric.context_packet import build_agent_prompt, write_context_packet_artifact
from app.fabric.agent_context_handoff import AgentContextHandoffError, AgentContextHandoffStore
from app.fabric.schema import ExecutionReceipt, OperationPlan, RiskLevel

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


def _numbered_lines(reply: str, expected: int) -> list[str]:
    """Read a "1. text" reply back into positional slots.

    Models drop lines, merge them, add a preamble, or renumber from scratch. Any
    of those, taken as a plain list, shifts every later translation onto the
    wrong sentence — which on an overlay means a confident mistranslation sitting
    on top of the real text. So the numbers are honoured where present: a line
    that says which slot it belongs to goes in that slot, and slots nobody claimed
    stay empty and simply do not get covered.
    """
    slots = [""] * max(0, int(expected))
    unnumbered: list[str] = []
    for raw in str(reply or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        match = re.match(r"^(\d{1,3})\s*[.、．)]\s*(.*)$", line)
        if match:
            index = int(match.group(1)) - 1
            value = match.group(2).strip()
            if 0 <= index < len(slots) and value and not slots[index]:
                slots[index] = value
            continue
        unnumbered.append(line)
    # A reply with no numbering at all is still usable if it has exactly as many
    # lines as we asked about; anything else is too ambiguous to place.
    if not any(slots) and len(unnumbered) == len(slots):
        return unnumbered
    return slots


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
        if plan.provider == "clipboard.history":
            return self._clipboard_history(plan)
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
            # image.to_prompt wants words a text-only model can act on; the older
            # vision.prompt_bridge wants the structured packet. Same provider,
            # different output shape, so the recipe decides.
            if plan.recipe_id == "image.to_prompt":
                return self._image_prompt(plan)
            return self._visual_context(plan)
        if plan.provider == "artifact.list":
            return self._list(plan)
        if plan.provider == "local.memory":
            return self._memory_recall(plan)
        if plan.provider == "local.task":
            return self._task(plan)
        if plan.provider == "maps.deep_link":
            return self._map(plan)
        if plan.provider == "overlay.translation":
            return self._overlay_translation(plan)
        if plan.provider == "model.text":
            return self._model_text(plan)
        if plan.provider == "inplace.text":
            return self._inplace_text(plan)
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
        if verified:
            # One place records history: the moment a copy is known to have
            # landed. Recording before the readback would remember copies that
            # never happened.
            try:
                from app.actions.clipboard_history import ClipboardHistory

                ClipboardHistory().record(value, app=str(plan.parameters.get("sourceApp") or ""))
            except Exception:
                pass
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

    def _memory_recall(self, plan: OperationPlan) -> ExecutionReceipt:
        """Answer "what was I reading this morning" from the local screen memory.

        Read-only, and empty is a real answer rather than a failure: the memory
        may be switched off, or the thing simply was not seen. Saying "I have
        nothing from that time" is useful; failing is not.
        """
        from app.context_pack.screen_memory import ScreenMemory

        memory = ScreenMemory(enabled=plan.parameters.get("enabled") is not False)
        entries = memory.recall(
            str(plan.parameters.get("query") or plan.command or ""),
            since=plan.parameters.get("since"),
            until=plan.parameters.get("until"),
        )
        return _receipt(
            plan,
            status="succeeded",
            output={
                "entries": [entry.to_dict() for entry in entries],
                "coverage": (
                    "最近 24 小时里没有找到相关记录。" if not entries
                    else f"找到 {len(entries)} 条相关记录。"
                ),
            },
            verified=True,
            verification={"mode": "read_only", "count": str(len(entries))},
        )

    def _clipboard_history(self, plan: OperationPlan) -> ExecutionReceipt:
        """Look back at what was copied, and put one of them back.

        Read-only by default. Restoring is a write, so it only happens when the
        user names an entry — recalling history must never silently change what
        is on the clipboard right now.
        """
        from app.actions.clipboard_history import ClipboardHistory

        history = ClipboardHistory()
        digest = str(plan.parameters.get("digest") or "").strip()
        if digest:
            entry = history.get(digest)
            if entry is None:
                return _receipt(plan, status="failed", error="clipboard_entry_expired")
            if self.clipboard_writer is None:
                return _receipt(plan, status="capability_unavailable", error="clipboard_writer_not_configured")
            self.clipboard_writer(entry.text)
            actual = self.clipboard_reader() if self.clipboard_reader is not None else entry.text
            verified = actual == entry.text
            return _receipt(
                plan,
                status="succeeded" if verified else "verification_failed",
                output={"text": entry.text, "restored": True},
                verified=verified,
                verification={"clipboardSha256": _sha256(actual)},
                error=None if verified else "clipboard_readback_mismatch",
            )

        query = str(plan.parameters.get("query") or plan.command or "").strip()
        matches = history.search(query) if query else history.recent()
        return _receipt(
            plan,
            status="succeeded",
            output={
                "entries": [
                    {
                        "digest": entry.digest,
                        "excerpt": entry.text[:200],
                        "at": entry.at,
                        "app": entry.app,
                        "truncated": entry.truncated,
                    }
                    for entry in matches
                ],
                "coverage": (
                    "还没有记录到复制内容。" if not matches
                    else f"找到 {len(matches)} 条复制记录。"
                ),
            },
            verified=True,
            verification={"mode": "read_only", "count": str(len(matches))},
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
        if verified:
            # One place records history: the moment a copy is known to have
            # landed. Recording before the readback would remember copies that
            # never happened.
            try:
                from app.actions.clipboard_history import ClipboardHistory

                ClipboardHistory().record(value, app=str(plan.parameters.get("sourceApp") or ""))
            except Exception:
                pass
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

    def _image_prompt(self, plan: OperationPlan) -> ExecutionReceipt:
        """Compose a paste-ready description of an image for a blind model.

        Reads whichever layers are available from the grounded object and names
        the ones that are not. Never claims a visual layer it does not have: a
        description that silently omits appearance would let the user believe
        DeepSeek was told what the picture looks like.
        """
        from app.vision.image_prompt import ImagePromptLayers, compose_prompt, describe_coverage

        objects = _objects(plan)
        if not objects:
            return _receipt(plan, status="failed", error="no_visual_objects")

        primary = objects[0]
        source = dict(primary.get("source") or {})
        artifacts = dict(primary.get("artifacts") or {})
        bbox = primary.get("bbox")
        width = height = 0
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            try:
                width = max(0, int(round(float(bbox[2]))))
                height = max(0, int(round(float(bbox[3]))))
            except (TypeError, ValueError):
                width = height = 0

        missing: dict[str, str] = {}
        text = "\n".join(_content(obj) for obj in objects if _content(obj)).strip()
        if not text:
            missing["text"] = "这块区域没有识别出文字"

        elements = [
            element
            for element in (primary.get("elements") or [])
            if isinstance(element, dict)
        ]
        if not elements:
            missing["elements"] = "这个窗口没有向系统汇报界面元件"

        # The caption needs a vision model AND permission for the image to leave
        # the machine. Absent either, the layer is missing and says which.
        caption = str(artifacts.get("vision_caption") or "").strip()
        caption_model = str(artifacts.get("vision_caption_model") or "")
        if not caption:
            missing["caption"] = str(
                artifacts.get("vision_caption_unavailable_reason")
                or "没有配置可用的视觉模型，或未授权把这张图交给模型"
            )

        layers = ImagePromptLayers(
            text=text,
            text_engine=str(artifacts.get("ocr_engine") or source.get("method") or ""),
            elements=elements,
            element_engine=str(artifacts.get("perception_result_kind") or source.get("adapter") or ""),
            caption=caption,
            caption_model=caption_model,
            width=width,
            height=height,
            missing=missing,
        )
        prompt = compose_prompt(layers, question=str(plan.parameters.get("question") or ""))
        if not prompt:
            # Nothing readable at all. An empty shell that says "this is an image"
            # would be worse than saying so.
            return _receipt(
                plan,
                status="capability_unavailable",
                error="image_has_no_readable_layer",
                output={"coverage": describe_coverage(layers)},
                verified=False,
            )

        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-image-prompt.md"
        _atomic_text(artifact, prompt + "\n")
        return _receipt(
            plan,
            status="succeeded",
            output={
                "artifact": str(artifact),
                "text": prompt,
                "coverage": describe_coverage(layers),
                "layers": layers.available_layers,
            },
            verified=artifact.exists(),
            verification={
                "layers": ",".join(layers.available_layers),
                "characters": len(prompt),
                # What is missing is part of the receipt, not a footnote.
                "missing": ",".join(sorted(missing)),
            },
        )

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

    def _overlay_translation(self, plan: OperationPlan) -> ExecutionReceipt:
        """Translate a screen region block by block, to be drawn where it was read.

        The value of overlay translation is that the user keeps reading the
        interface they were reading, so the output is not prose — it is a list of
        rectangles with text that fits inside them. Pairing is positional and one
        line per block, because a model that merges or reorders lines would put
        each translation on the wrong sentence, and a wrong sentence rendered
        confidently over the real one is worse than no translation at all.
        """
        from app.vision.overlay_translation import coverage_summary, plan_overlay

        if self.model_transform is None:
            return _receipt(plan, status="capability_unavailable", error="text_model_not_configured")

        blocks: list[dict[str, Any]] = []
        for obj in _objects(plan):
            for block in list(obj.get("blocks") or []):
                if isinstance(block, dict) and str(block.get("text") or "").strip():
                    blocks.append(block)
        if not blocks:
            return _receipt(
                plan,
                status="capability_unavailable",
                error="region_has_no_readable_text",
                output={"coverage": coverage_summary([], [])},
            )

        target = str(plan.parameters.get("targetLanguage") or "中文")
        numbered = "\n".join(f"{index + 1}. {str(block.get('text') or '').strip()}" for index, block in enumerate(blocks))
        instruction = (
            f"把下面每一行翻译成{target}。严格逐行对应：输出的行数必须和输入相同，"
            "每行只输出译文本身，保留行号前缀。已经是目标语言的行，原样输出该行。"
        )
        try:
            reply = str(self.model_transform(instruction, numbered, plan.recipe_id) or "")
        except Exception as exc:
            return _receipt(plan, status="failed", error=f"text_model_failed:{type(exc).__name__}:{exc}")

        translations = _numbered_lines(reply, len(blocks))
        planned = plan_overlay(blocks, translations)
        coverage = coverage_summary(blocks, planned)
        if not planned:
            # Nothing to draw is a real outcome — usually the region is already in
            # the target language. Reporting success with an empty overlay would
            # leave the user waiting for something that is never coming.
            return _receipt(
                plan,
                status="succeeded",
                output={"overlay": [], "coverage": coverage},
                verified=True,
                verification={"blocks": str(len(blocks)), "covered": "0"},
            )
        return _receipt(
            plan,
            status="succeeded",
            output={
                "overlay": [item.to_dict() for item in planned],
                "coverage": coverage,
                "targetLanguage": target,
            },
            verified=True,
            verification={
                "blocks": str(len(blocks)),
                "covered": str(len(planned)),
                "truncated": str(sum(1 for item in planned if item.truncated)),
            },
        )

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

    def _inplace_text(self, plan: OperationPlan) -> ExecutionReceipt:
        """Rewrite/translate text that is supposed to land back in the source app.

        This provider exists to keep "in place" honest. It used to share
        `model.text` with `text.summarize_route`, whose contract genuinely is
        "produce an artifact" -- so writing a .md file and returning succeeded was
        correct there and a lie here: the recipes promise the user's own document
        changes, and outside Word nothing was ever written back.

        Writing back is a privileged act (it needs the target's identity checked,
        a confirmation, and an undo path), so it belongs to the action layer, not
        to this executor. What this provider does is produce the replacement text
        and then refuse to claim the write happened. The transformed text is kept
        in an artifact so a caller that can write back has something to write, and
        so the user's work is not lost when nobody can.
        """
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
        artifact = self.root / "artifacts" / f"{plan.idempotency_key[:16]}-inplace.md"
        _atomic_text(artifact, transformed + "\n")
        return _receipt(
            plan,
            status="capability_unavailable",
            output={
                "artifact": str(artifact),
                "text": transformed,
                "proposalRequired": True,
                "originalCharacters": len(source),
            },
            verified=False,
            verification={"characters": len(transformed), "mode": "requires_write_back_proposal"},
            error="inplace_write_back_requires_action_proposal",
        )

    def _agent(self, plan: OperationPlan) -> ExecutionReceipt:
        if self.agent_starter is None:
            return _receipt(plan, status="capability_unavailable", error="agent_provider_not_configured")
        objects = _objects(plan)
        discovered_attachments: list[str] = []
        for obj in objects:
            source = dict(obj.get("source") or {})
            for candidate in (
                obj.get("path"),
                source.get("path"),
                source.get("imagePath"),
                source.get("screenshotPath"),
                source.get("annotatedPath"),
            ):
                value = str(candidate or "").strip()
                if value and value not in discovered_attachments:
                    discovered_attachments.append(value)
        attachments = list(dict.fromkeys([
            *[str(item) for item in plan.parameters.get("attachments") or []],
            *discovered_attachments,
        ]))
        capture_policy = dict(plan.parameters.get("capturePolicy") or {})
        allowed_visual_paths = {
            str(Path(item).expanduser().resolve()).casefold()
            for item in capture_policy.get("uploadAllowedPaths") or []
            if str(item or "").strip()
        }
        withheld_visual_attachments = [
            item
            for item in attachments
            if _is_visual_attachment(item)
            and (
                not self.allow_screenshot_upload
                or str(Path(item).expanduser().resolve()).casefold() not in allowed_visual_paths
            )
        ]
        attachments = [
            item
            for item in attachments
            if not _is_visual_attachment(item)
            or (
                self.allow_screenshot_upload
                and str(Path(item).expanduser().resolve()).casefold() in allowed_visual_paths
            )
        ]
        capability_fallback = str(plan.parameters.get("capabilityFallback") or "")
        packet = plan.parameters.get("contextPacket")
        context_packet_artifact: Path | None = None
        if isinstance(packet, dict) and packet.get("schemaVersion") == 2:
            try:
                context_packet_artifact = write_context_packet_artifact(packet, root=self.root)
                prompt = build_agent_prompt(packet, artifact_path=context_packet_artifact)
            except Exception as exc:
                return _receipt(
                    plan,
                    status="failed",
                    error=f"context_packet_failed:{type(exc).__name__}:{exc}",
                )
        else:
            context = "\n\n".join(
                f"[{obj.get('id') or index}] {_content(obj)}"
                for index, obj in enumerate(objects, 1)
                if _content(obj)
            )
            prompt = "\n\n".join([
                "Magic Pointer grounded task",
                f"User intent: {plan.command}",
                f"Recipe: {plan.recipe_id}",
                f"Source object IDs: {', '.join(plan.object_ids)}",
                context,
                "Inspect the current workspace yourself before changing files. "
                "Verify the outcome on the relevant surface. "
                "Do not submit, send, purchase, or delete external data.",
            ])
        if capability_fallback:
            prompt += f"\n\nSpecialist capability fallback: {capability_fallback}"
        if withheld_visual_attachments and "withheld visual" not in prompt.casefold():
            prompt += (
                "\n\nPrivacy boundary: Magic Pointer withheld screen/image attachments. "
                "Work only from textual and structured context."
            )
        workspace = dict(packet.get("workspace") or {}) if isinstance(packet, dict) else {}
        privacy = {
            "screenshotUploadAllowed": bool(
                self.allow_screenshot_upload and allowed_visual_paths
            ),
            "withheldVisualAttachmentCount": len(withheld_visual_attachments),
        }
        payload = {
            "provider": str(plan.parameters.get("agent") or ""),
            "prompt": prompt,
            "cwd": str(workspace.get("cwd") or plan.parameters.get("cwd") or ""),
            "attachments": attachments,
            "permission": str(plan.parameters.get("agentPermission") or "write"),
            "submit": False,
            "background": plan.recipe_id == "agent.background_task",
            "sessionId": str(plan.parameters.get("sessionId") or ""),
            "contextPacketArtifact": (
                str(context_packet_artifact)
                if context_packet_artifact is not None
                else ""
            ),
            "privacy": privacy,
        }
        context_handoff: dict[str, Any] | None = None
        if isinstance(packet, dict) and packet.get("schemaVersion") == 2:
            contexts = AgentContextHandoffStore(self.root / "agent-contexts")
            try:
                context_handoff = contexts.seal(
                    packet,
                    prompt=prompt,
                    attachments=attachments,
                    permission=payload["permission"],
                    privacy=privacy,
                )

                def start_sealed_context(context_payload: dict[str, Any]) -> dict[str, Any]:
                    return dict(self.agent_starter({
                        **context_payload,
                        "background": payload["background"],
                        "contextPacketArtifact": payload["contextPacketArtifact"],
                    }))

                dispatch = contexts.dispatch(
                    context_handoff["contextId"],
                    provider=payload["provider"],
                    starter=start_sealed_context,
                    session_id=payload["sessionId"],
                )
                task = dict(dispatch.get("task") or {})
            except AgentContextHandoffError as exc:
                return _receipt(
                    plan,
                    status="failed",
                    error=f"agent_context_handoff_failed:{type(exc.__cause__).__name__ if exc.__cause__ else type(exc).__name__}",
                )
        else:
            try:
                task = dict(self.agent_starter(payload))
            except Exception as exc:
                return _receipt(plan, status="failed", error=f"agent_start_failed:{type(exc).__name__}:{exc}")
        accepted = bool(task.get("taskId")) and task.get("status") in {"queued", "running"}
        if context_packet_artifact is not None:
            task["contextPacketArtifact"] = str(context_packet_artifact)
        if context_handoff is not None:
            task["contextHandoffId"] = context_handoff["contextId"]
            task["contextPacketId"] = context_handoff["contextPacketId"]
            task["contextPacketDigest"] = context_handoff["contextPacketDigest"]
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


# ---------------------------------------------------------------------------
# Tool registry migration: high-traffic actions as registered tools.
#
# This block only ADDS tool envelopes around the existing executor methods.
# Nothing above is modified: the engine's provider dispatch keeps working
# exactly as before, and every registered tool routes through the very same
# methods. Envelopes serialise tool arguments into an OperationPlan, call the
# existing method, and return the receipt serialised as a JSON string.
# ---------------------------------------------------------------------------


def _fabric_input_schema(
    *,
    extra: dict[str, dict[str, Any]] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    """Input schema shared by all fabric tools, plus action-specific fields."""
    properties: dict[str, Any] = {
        "command": {
            "type": "string",
            "description": "The user intent text that routed to this recipe.",
        },
        "objects": {
            "type": "array",
            "items": {"type": "object"},
            "description": (
                "Grounded source objects (text/image/table/region) the action "
                "operates on; each carries id/kind/content/source as grounded."
            ),
        },
        "attachments": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Absolute file paths to attach (images, documents).",
        },
        "sourceApp": {
            "type": "string",
            "description": "Foreground app that produced the selection.",
        },
        "idempotencyKey": {
            "type": "string",
            "description": "Deduplication and artifact-naming key.",
        },
    }
    if extra:
        properties.update(extra)
    return {
        "type": "object",
        "properties": properties,
        "required": list(required or []),
    }


def _fabric_tool_plan(
    recipe_id: str,
    provider: str,
    risk: RiskLevel,
    *,
    command: str = "",
    objects: list[dict[str, Any]] | None = None,
    attachments: list[str] | None = None,
    source_app: str = "",
    idempotency_key: str = "",
    extra: dict[str, Any] | None = None,
) -> OperationPlan:
    """Compose the OperationPlan a tool envelope hands to an executor method."""
    parameters: dict[str, Any] = dict(extra or {})
    if objects is not None:
        parameters["objects"] = [
            dict(item) for item in objects if isinstance(item, dict)
        ]
    if attachments is not None:
        parameters["attachments"] = [str(item) for item in attachments]
    if source_app:
        parameters["sourceApp"] = source_app
    return OperationPlan(
        id=str(uuid.uuid4()),
        recipe_id=recipe_id,
        command=command,
        risk=risk,
        provider=provider,
        object_ids=tuple(
            str(item.get("id") or "")
            for item in (objects or [])
            if isinstance(item, dict)
        ),
        parameters=parameters,
        idempotency_key=idempotency_key,
    )


def _fabric_tool_execute(
    runner: FabricExecutors,
    *,
    recipe_id: str,
    provider: str,
    risk: RiskLevel,
    method_name: str,
) -> Callable[..., str]:
    """Build the ToolSpec.execute envelope for one executor method.

    The envelope never reimplements logic: it serialises tool arguments into
    an OperationPlan and calls the existing method at call time (so a
    monkeypatched or injected method is honoured). ``scope`` is accepted
    because the harness forwards its cancellation token; it is not threaded
    into the executor methods, which have no cancellation support today.
    """

    def execute(
        *,
        scope: object = None,
        command: str = "",
        objects: list[dict[str, Any]] | None = None,
        attachments: list[str] | None = None,
        sourceApp: str = "",
        idempotencyKey: str = "",
        **extra: Any,
    ) -> str:
        plan = _fabric_tool_plan(
            recipe_id,
            provider,
            risk,
            command=command,
            objects=objects,
            attachments=attachments,
            source_app=sourceApp,
            idempotency_key=idempotencyKey,
            extra=extra,
        )
        receipt = getattr(runner, method_name)(plan)
        return json.dumps(receipt.to_dict(), ensure_ascii=False, sort_keys=True)

    return execute


def register_fabric_tools(
    registry: ToolRegistry,
    *,
    executors: FabricExecutors | None = None,
) -> None:
    """Register the high-traffic fabric actions as ToolSpec entries.

    One tool per recipe. The tool name is the short recipe-style id (registry
    names must match ``[a-z0-9_]+``, so the dotted recipe id lives in the
    description). Every envelope calls the existing executor method and
    returns the receipt serialised as a JSON string. Re-registering the same
    registry is a no-op: names already present are skipped, so both a fresh
    registry and a process-wide singleton stay safe.

    ``executors`` is the runner the envelopes call; when omitted a default
    instance (``root=Path.cwd()``) is constructed — registration performs no
    I/O either way.
    """
    from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec

    runner = executors if executors is not None else FabricExecutors(root=Path.cwd())

    def spec_of(
        *,
        name: str,
        recipe_id: str,
        provider: str,
        method_name: str,
        risk: RiskLevel,
        effect: Effect,
        description: str,
        backend: str,
        timeout_ms: int = 30000,
        concurrency_safe: bool = False,
        extra_properties: dict[str, dict[str, Any]] | None = None,
        required: tuple[str, ...] = ("objects",),
    ) -> ToolSpec:
        return ToolSpec(
            name=name,
            description=(
                f"{description} Recipe: {recipe_id} (provider {provider})."
            ),
            input_schema=_fabric_input_schema(
                extra=extra_properties, required=list(required)
            ),
            execute=_fabric_tool_execute(
                runner,
                recipe_id=recipe_id,
                provider=provider,
                risk=risk,
                method_name=method_name,
            ),
            effect=effect,
            is_concurrency_safe=concurrency_safe,
            used_backend=backend,
            timeout_ms=timeout_ms,
        )

    specs: list[ToolSpec] = [
        spec_of(
            name="ocr_copy",
            recipe_id="text.ocr_copy",
            provider="native.ocr",
            method_name="_ocr",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Recognise text from a non-selectable screen region or image "
                "and copy it to the clipboard (verified by readback)."
            ),
            backend="ocr",
            timeout_ms=45000,
        ),
        spec_of(
            name="ocr_clean",
            recipe_id="text.ocr_clean",
            provider="clipboard",
            method_name="_clipboard",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Clean OCR text (collapse spaces, normalise blank lines, or "
                "strip all whitespace per the command tokens) and copy it to "
                "the clipboard (verified by readback)."
            ),
            backend="ocr",
            timeout_ms=45000,
        ),
        spec_of(
            name="rewrite_in_place",
            recipe_id="text.rewrite_in_place",
            provider="inplace.text",
            method_name="_inplace_text",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Rewrite the selected text and produce the replacement "
                "artifact; the actual write-back needs an action proposal and "
                "is never claimed by this step."
            ),
            backend="model",
            timeout_ms=60000,
        ),
        spec_of(
            name="translate_in_place",
            recipe_id="text.translate_in_place",
            provider="inplace.text",
            method_name="_inplace_text",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Translate the selected text and produce the replacement "
                "artifact; the actual write-back needs an action proposal and "
                "is never claimed by this step."
            ),
            backend="model",
            timeout_ms=60000,
        ),
        spec_of(
            name="summarize_route",
            recipe_id="text.summarize_route",
            provider="model.text",
            method_name="_model_text",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Summarise or bullet the selected text into a routed draft "
                "artifact on disk."
            ),
            backend="model",
            timeout_ms=60000,
        ),
        spec_of(
            name="selection_expand",
            recipe_id="selection.expand",
            provider="inplace.text",
            method_name="_inplace_text",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Expand the selected text to a target length and produce the "
                "replacement artifact; write-back needs an action proposal."
            ),
            backend="model",
            timeout_ms=60000,
        ),
        spec_of(
            name="selection_condense",
            recipe_id="selection.condense",
            provider="inplace.text",
            method_name="_inplace_text",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Condense the selected text to a target length and produce "
                "the replacement artifact; write-back needs an action "
                "proposal."
            ),
            backend="model",
            timeout_ms=60000,
        ),
        spec_of(
            name="to_spreadsheet",
            recipe_id="table.to_spreadsheet",
            provider="artifact.table",
            method_name="_table",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Extract a table from the screen/selection and write it as a "
                "CSV artifact on disk (verified by readback)."
            ),
            backend="local",
        ),
        spec_of(
            name="merge_tables",
            recipe_id="table.merge",
            provider="artifact.table",
            method_name="_table",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Merge multiple table objects with a shared header into one "
                "CSV artifact on disk (verified by readback)."
            ),
            backend="local",
        ),
        spec_of(
            name="evidence_card",
            recipe_id="research.evidence_card",
            provider="artifact.evidence",
            method_name="_evidence",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Save the grounded objects with source anchors (app, path, "
                "page, bbox, sha256) as a local evidence-card artifact."
            ),
            backend="local",
        ),
        spec_of(
            name="image_to_prompt",
            recipe_id="image.to_prompt",
            provider="artifact.visual_context",
            method_name="_image_prompt",
            risk=RiskLevel.LOCAL_WRITE,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Compose a paste-ready, coverage-honest description of an "
                "image for a text-only model, written as a prompt artifact."
            ),
            backend="local",
            extra_properties={
                "question": {
                    "type": "string",
                    "description": "Optional question the prompt should answer.",
                },
            },
        ),
        spec_of(
            name="map_route",
            recipe_id="map.route",
            provider="maps.deep_link",
            method_name="_map",
            risk=RiskLevel.EXTERNAL_SEND,
            effect=Effect.EXTERNAL_SEND,
            description=(
                "Open an allowlisted Google Maps directions deep link between "
                "two locations in the default browser."
            ),
            backend="local",
            timeout_ms=15000,
            extra_properties={
                "travelMode": {
                    "type": "string",
                    "description": "driving/walking/bicycling/transit (default driving).",
                },
            },
        ),
        spec_of(
            name="agent_handoff",
            recipe_id="agent.handoff",
            provider="agent.task",
            method_name="_agent",
            risk=RiskLevel.EXTERNAL_SEND,
            effect=Effect.EXTERNAL_SEND,
            description=(
                "Hand the grounded context (window, repo, screenshots, object "
                "anchors) to an external agent session and return the task "
                "receipt."
            ),
            backend="agent",
            timeout_ms=120000,
            extra_properties={
                "agent": {
                    "type": "string",
                    "description": "Target agent provider (codex/pi/claude/gemini/...).",
                },
                "agentPermission": {"type": "string"},
                "sessionId": {"type": "string"},
                "cwd": {"type": "string"},
                "capabilityFallback": {"type": "string"},
                "capturePolicy": {"type": "object"},
                "contextPacket": {"type": "object"},
            },
        ),
        spec_of(
            name="background_task",
            recipe_id="agent.background_task",
            provider="agent.task",
            method_name="_agent",
            risk=RiskLevel.EXTERNAL_SEND,
            effect=Effect.EXTERNAL_SEND,
            description=(
                "Start a background external agent task with progress, pause "
                "and takeover support."
            ),
            backend="agent",
            timeout_ms=120000,
            required=(),
            extra_properties={
                "agent": {
                    "type": "string",
                    "description": "Target agent provider (codex/pi/claude/gemini/...).",
                },
                "agentPermission": {"type": "string"},
                "sessionId": {"type": "string"},
                "cwd": {"type": "string"},
                "capabilityFallback": {"type": "string"},
                "capturePolicy": {"type": "object"},
                "contextPacket": {"type": "object"},
            },
        ),
        spec_of(
            name="task_route",
            recipe_id="task.route",
            provider="local.task",
            method_name="_task",
            risk=RiskLevel.EXTERNAL_SEND,
            effect=Effect.EXTERNAL_SEND,
            description=(
                "Route the grounded problem into the local task store and "
                "return the task id."
            ),
            backend="local",
            timeout_ms=15000,
        ),
        spec_of(
            name="screen_translate",
            recipe_id="screen.translate",
            provider="overlay.translation",
            method_name="_overlay_translation",
            risk=RiskLevel.READ,
            effect=Effect.READ,
            description=(
                "Translate a screen region block by block and return an "
                "overlay of rectangles with in-place translations (does not "
                "modify the underlying app)."
            ),
            backend="model",
            timeout_ms=60000,
            concurrency_safe=True,
            extra_properties={
                "targetLanguage": {
                    "type": "string",
                    "description": "Target language for the overlay (default 中文).",
                },
            },
        ),
        spec_of(
            name="clipboard_history",
            recipe_id="clipboard.history",
            provider="clipboard.history",
            method_name="_clipboard_history",
            risk=RiskLevel.READ,
            effect=Effect.REVERSIBLE_WRITE,
            description=(
                "Search or list clipboard history; with a digest, restore "
                "that entry to the clipboard (write-back restore, not a "
                "pure read)."
            ),
            backend="local",
            timeout_ms=10000,
            required=(),
            extra_properties={
                "query": {"type": "string", "description": "Search term."},
                "digest": {"type": "string", "description": "Entry digest to restore."},
            },
        ),
        spec_of(
            name="memory_recall",
            recipe_id="memory.recall",
            provider="local.memory",
            method_name="_memory_recall",
            risk=RiskLevel.READ,
            effect=Effect.READ,
            description=(
                "Recall what was on screen in the last 24 hours from the "
                "local screen memory (read-only; empty is a real answer)."
            ),
            backend="local",
            timeout_ms=10000,
            concurrency_safe=True,
            required=(),
            extra_properties={
                "query": {"type": "string", "description": "What to look back for."},
                "since": {"type": "string", "description": "ISO start bound."},
                "until": {"type": "string", "description": "ISO end bound."},
                "enabled": {"type": "boolean"},
            },
        ),
    ]

    for spec in specs:
        try:
            registry.get(spec.name)
        except KeyError:
            registry.register(spec)

