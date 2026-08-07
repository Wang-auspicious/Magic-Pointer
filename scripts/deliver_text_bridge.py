"""Write the capsule answer into the app the user was working in.

One request, one attempt, one honest verdict. The write reuses the existing
verified channel; when that channel refuses -- or cannot read the text back to
confirm it -- the answer goes to the clipboard instead and the reply names the
reason. Nothing here reports a write it did not confirm.
"""

from __future__ import annotations

from typing import Any

from _bridge_common import (
    PayloadTooLargeError,
    ensure_root_on_path,
    force_utf8_stdio,
    read_bounded_json_payload,
    write_json,
)

ensure_root_on_path()

from app.actions.capsule_delivery import (  # noqa: E402
    WRITTEN,
    DeliveryVerdict,
    describe_delivery_failure,
    make_capsule_delivery_proposal,
    make_clipboard_fallback_proposal,
)
from app.actions.draft_delivery import DraftDeliveryError  # noqa: E402
from app.actions.executor import SafeActionExecutor  # noqa: E402
from app.actions.schema import ExecutionStatus  # noqa: E402

MAX_DELIVERY_CHARS = 20000


def _reply(verdict: DeliveryVerdict, *, ok: bool = True, detail: str = "") -> dict[str, Any]:
    return {
        "ok": ok,
        "prompt": "填入",
        "answer": verdict.message,
        "detail": detail,
        "delivery": verdict.to_dict(),
    }


def _copy_to_clipboard(executor: SafeActionExecutor, text: str, verdict: DeliveryVerdict) -> dict[str, Any]:
    try:
        proposal = make_clipboard_fallback_proposal(text, reason_code=verdict.reason_code)
    except DraftDeliveryError as exc:
        return _reply(verdict, ok=False, detail=str(exc))
    result = executor.execute(proposal, confirmed=True)
    if result.status != ExecutionStatus.SUCCEEDED:
        # The write failed and the clipboard failed too; say both, claim neither.
        return _reply(
            DeliveryVerdict(
                kind="failed",
                reason_code=verdict.reason_code,
                message=f"{verdict.message.split('结果已复制')[0]}剪贴板也没写成功，什么都没做。",
                write_attempted=verdict.write_attempted,
            ),
            ok=False,
            detail=str(result.error or ""),
        )
    return _reply(verdict)


def main() -> int:
    force_utf8_stdio()
    try:
        payload = read_bounded_json_payload()
    except PayloadTooLargeError as exc:
        write_json({"ok": False, "prompt": "填入", "error": str(exc)})
        return 2
    except ValueError as exc:
        write_json({"ok": False, "prompt": "填入", "error": f"invalid payload: {exc}"})
        return 2

    text = str(payload.get("text") or "")
    if not text.strip():
        write_json({"ok": False, "prompt": "填入", "error": "没有可填入的文字。"})
        return 1
    if len(text) > MAX_DELIVERY_CHARS:
        write_json({
            "ok": False,
            "prompt": "填入",
            "error": f"这段文字有 {len(text)} 字，超过一次填入的上限 {MAX_DELIVERY_CHARS} 字。",
        })
        return 1

    target_window = payload.get("targetWindow")
    executor = SafeActionExecutor()
    try:
        proposal = make_capsule_delivery_proposal(
            text,
            target_window=target_window if isinstance(target_window, dict) else {},
            target_point=payload.get("targetPoint"),
            target_point_space=payload.get("targetPointSpace"),
            prefer_foreground=payload.get("preferForeground") is True,
        )
    except DraftDeliveryError as exc:
        # No trustworthy target: we never guess a window or a coordinate space.
        verdict = DeliveryVerdict(
            kind="clipboard",
            reason_code="missing_target_identity",
            message="没有可信的目标窗口或坐标，所以没往任何地方写。结果已复制，把光标点进输入框按 Ctrl+V 就行。",
            write_attempted=False,
        )
        reply = _copy_to_clipboard(executor, text, verdict)
        reply["detail"] = str(exc)
        write_json(reply)
        return 0 if reply.get("ok") else 1

    result = executor.execute(proposal, confirmed=True)
    if result.status == ExecutionStatus.SUCCEEDED:
        write_json(_reply(WRITTEN))
        return 0

    reply = _copy_to_clipboard(executor, text, describe_delivery_failure(result.error))
    write_json(reply)
    return 0 if reply.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
