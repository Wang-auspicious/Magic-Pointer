from __future__ import annotations

import hashlib
import re
import uuid
from pathlib import Path
from typing import Any

from app.actions.schema import ActionProposal, ActionTarget, SafetyLevel
from app.adapters.base import AdapterReadContext

JsonDict = dict[str, Any]

_REWRITE_TERMS = (
    "rewrite", "polish", "replace", "improve", "make it", "shorten", "summarize",
    "translate", "formal", "friendly", "fix grammar",
    "\u6da6\u8272", "\u6539\u5199", "\u66ff\u6362", "\u4fee\u6539", "\u4f18\u5316",
    "\u53d8\u6210", "\u6539\u6210", "\u7ffb\u8bd1", "\u66f4\u6b63\u5f0f", "\u66f4\u53e3\u8bed",
    "\u7f29\u77ed", "\u6269\u5199", "\u4fee\u6b63",
)


def text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def short_excerpt(text: str, limit: int = 700) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "..."


def wants_word_rewrite(command: str) -> bool:
    normalized = str(command or "").strip().lower()
    if not normalized:
        return False
    return any(term in normalized for term in _REWRITE_TERMS)


def clean_replacement_text(answer: str) -> str:
    text = str(answer or "").strip()
    fence = re.search(r"```(?:\w+)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    # The model is instructed to return only replacement text. These very small
    # label removals handle common slip-ups without trying to parse a full answer.
    for prefix in ("Replacement:", "Rewritten:", "\u6539\u5199\u5982\u4e0b\uff1a", "\u6539\u5199\u5982\u4e0b:", "\u66ff\u6362\u6587\u672c\uff1a", "\u66ff\u6362\u6587\u672c:"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
    return text


def _basename(path: str | None) -> str:
    if not path:
        return "Word selection"
    try:
        return Path(path).name or path
    except Exception:
        return str(path)


def make_word_replace_selection_proposal(
    ctx: AdapterReadContext,
    *,
    command: str,
    replacement_text: str,
) -> ActionProposal | None:
    if ctx.app != "word":
        return None
    original_text = ctx.content or ""
    replacement = str(replacement_text or "")
    if not original_text.strip() or not replacement.strip():
        return None
    if replacement == original_text:
        return None

    artifacts = dict(ctx.artifacts or {})
    document = artifacts.get("document") or ctx.label
    selection_start = artifacts.get("selection_start")
    selection_end = artifacts.get("selection_end")
    try:
        if selection_start is not None and selection_end is not None and int(selection_end) <= int(selection_start):
            return None
    except Exception:
        return None
    before_hash = str(artifacts.get("selection_text_sha256") or text_sha256(original_text))
    after_hash = text_sha256(replacement)
    proposal_id = f"word-replace-{uuid.uuid4().hex[:12]}"
    before_excerpt = short_excerpt(original_text)
    after_excerpt = short_excerpt(replacement)

    return ActionProposal(
        id=proposal_id,
        action_type="office_replace_selection",
        target=ActionTarget(
            description=f"Word selection in {_basename(str(document) if document else None)}",
            metadata={
                "app": "word",
                "document": document,
                "hwnd": artifacts.get("hwnd"),
                "selection_start": selection_start,
                "selection_end": selection_end,
                "expected_text_sha256": before_hash,
                "office_host": artifacts.get("host"),
                "com_prog_id": artifacts.get("com_prog_id"),
            },
        ),
        parameters={
            "app": "word",
            "document": document,
            "hwnd": artifacts.get("hwnd"),
            "selection_type": artifacts.get("selection_type"),
            "selection_start": selection_start,
            "selection_end": selection_end,
            "expected_text_sha256": before_hash,
            "expected_text_excerpt": before_excerpt,
            "replacement_text": replacement,
            "replacement_text_sha256": after_hash,
            "replacement_text_excerpt": after_excerpt,
            "command": command,
            "office_host": artifacts.get("host"),
            "com_prog_id": artifacts.get("com_prog_id"),
        },
        safety_level=SafetyLevel.HIGH,
        confirmation_required=True,
        rationale="Replace the current Word selection only if the document and selection still match the preview.",
        metadata={
            "adapter": ctx.adapter,
            "method": ctx.method,
            "document": document,
            "selection_start": selection_start,
            "selection_end": selection_end,
            "expected_text_sha256": before_hash,
            "replacement_text_sha256": after_hash,
            "office_host": artifacts.get("host"),
            "com_prog_id": artifacts.get("com_prog_id"),
        },
    )
