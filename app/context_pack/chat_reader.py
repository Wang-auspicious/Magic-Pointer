
from __future__ import annotations

import copy
import json
import re
import time
from collections import OrderedDict
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any, Protocol

from .sources import Coverage, FragmentLocator, ReadFragment, ReadResult, SourceRef


class ChatHistoryBackend(Protocol):

    def read_chat_page(self, **request: Any) -> Mapping[str, Any]: ...


def _window_xywh(window: Mapping[str, Any]) -> tuple[int, int, int, int] | None:
    raw = window.get("rect") or window.get("bbox")
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        left, top, right, bottom = (int(round(float(item))) for item in raw)
    except (TypeError, ValueError):
        return None
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height


class DesktopChatNavigator:

    def __init__(self, session: Any, *, wheel_delta: int = 6) -> None:
        self._session = session
        self._wheel_delta = max(1, int(wheel_delta))

    def __call__(
        self,
        *,
        window: Mapping[str, Any],
        conversation_identity: Mapping[str, Any],
        cursor: str,
    ) -> dict[str, Any]:
        del cursor
        hwnd = int(window.get("hwnd") or 0)
        if hwnd != int(conversation_identity.get("windowHwnd") or 0):
            return {"ok": False, "error": "bound-chat-window-identity-mismatch"}
        window_id = f"w-{hwnd}"
        try:
            self._session.activate_window(window_id=window_id)
            state = json.loads(
                self._session.get_app_state(window_id=window_id, mode="full")
            )
            actual_window = dict((state.get("windows") or [{}])[0] or {})
            if int(actual_window.get("hwnd") or 0) != hwnd:
                return {"ok": False, "error": "bound-chat-window-changed"}
            bounds = _window_xywh(actual_window)
            if bounds is None:
                return {"ok": False, "error": "bound-chat-window-bounds-unavailable"}
            left, top, width, height = bounds
            receipt = json.loads(self._session.scroll(
                snapshot_id=str(state.get("snapshot_id") or ""),
                x=left + max(1, width // 2),
                y=top + max(1, height // 2),
                dy=self._wheel_delta,
            ))
            time.sleep(0.12)
            return {
                "ok": True,
                "usedBackend": str(receipt.get("used_backend") or "foreground_wheel"),
                "receipt": receipt,
            }
        except Exception as exc:
            return {"ok": False, "error": f"chat-scroll-failed:{type(exc).__name__}"}
        finally:
            turn_ended = getattr(self._session, "turn_ended", None)
            if callable(turn_ended):
                turn_ended()


class SurfaceChatHistoryBackend:

    def __init__(
        self,
        registry: Any,
        *,
        windows_probe: Any,
        navigate: Any | None = None,
    ) -> None:
        self._registry = registry
        self._windows_probe = windows_probe
        self._navigate = navigate
        self._last_pages: dict[str, list[tuple[Any, ...]]] = {}

    @staticmethod
    def _window_region(window: Mapping[str, Any]) -> dict[str, int] | None:
        bounds = _window_xywh(window)
        if bounds is None:
            return None
        x, y, width, height = bounds
        return {"x": x, "y": y, "width": width, "height": height}

    def read_chat_page(self, **request: Any) -> Mapping[str, Any]:
        expected = _mapping(request.get("conversation_identity"))
        try:
            expected_hwnd = int(expected.get("windowHwnd") or 0)
        except (TypeError, ValueError):
            expected_hwnd = 0
        windows = [
            dict(item) for item in list(self._windows_probe() or ())
            if isinstance(item, Mapping)
        ]
        window = next(
            (item for item in windows if int(item.get("hwnd") or 0) == expected_hwnd),
            None,
        )
        if window is None:
            return {
                "conversationIdentity": {},
                "messages": [],
                "complete": False,
                "nextCursor": request.get("cursor"),
                "limitations": ["bound-chat-window-unavailable"],
                "usedBackend": "surface-adapter.registry",
            }

        cursor = str(request.get("cursor") or "").strip() or None
        navigation_backend = ""
        navigation: dict[str, Any] = {}
        if cursor is not None:
            if (
                str(expected.get("keyProvenance") or "") == "window-surface"
                and not str(expected.get("nativeConversationId") or "").strip()
            ):
                return {
                    "conversationIdentity": expected,
                    "messages": [],
                    "complete": False,
                    "nextCursor": cursor,
                    "limitations": ["conversation-identity-insufficient-for-navigation"],
                    "usedBackend": "surface-adapter.registry",
                }
            if not callable(self._navigate):
                return {
                    "conversationIdentity": expected,
                    "messages": [],
                    "complete": False,
                    "nextCursor": cursor,
                    "limitations": ["history-navigation-requires-recorded-desktop-action"],
                    "usedBackend": "surface-adapter.registry",
                }
            preflight = self._registry.try_resolve(
                window,
                target_point=None,
                target_region=self._window_region(window),
            )
            preflight_conversation = next(
                (
                    item for item in getattr(preflight, "objects", ())
                    if item.kind == "conversation"
                ),
                None,
            )
            preflight_identity = _mapping(
                preflight_conversation.fields.get("conversationIdentity")
                if preflight_conversation else None
            )
            if not _same_conversation(expected, preflight_identity):
                return {
                    "conversationIdentity": preflight_identity,
                    "messages": [],
                    "complete": False,
                    "nextCursor": cursor,
                    "limitations": ["conversation-identity-changed-before-navigation"],
                    "usedBackend": "surface-adapter.registry",
                }
            navigation = _mapping(self._navigate(
                window=window,
                conversation_identity=copy.deepcopy(expected),
                cursor=cursor,
            ))
            navigation_backend = str(navigation.get("usedBackend") or "desktop-action.scroll")
            if navigation.get("ok") is not True:
                return {
                    "conversationIdentity": expected,
                    "messages": [],
                    "complete": False,
                    "nextCursor": cursor,
                    "limitations": [str(navigation.get("error") or "history-navigation-failed")],
                    "usedBackend": navigation_backend,
                }
            windows = [
                dict(item) for item in list(self._windows_probe() or ())
                if isinstance(item, Mapping)
            ]
            window = next(
                (item for item in windows if int(item.get("hwnd") or 0) == expected_hwnd),
                None,
            )
            if window is None:
                return {
                    "conversationIdentity": {},
                    "messages": [],
                    "complete": False,
                    "nextCursor": cursor,
                    "limitations": ["bound-chat-window-changed-after-navigation"],
                    "usedBackend": navigation_backend,
                }

        result = self._registry.try_resolve(
            window,
            target_point=None,
            target_region=self._window_region(window),
        )
        if result is None:
            return {
                "conversationIdentity": {},
                "messages": [],
                "complete": False,
                "nextCursor": cursor,
                "limitations": ["chat-surface-adapter-unavailable"],
                "usedBackend": "surface-adapter.registry",
            }
        conversation = next(
            (item for item in result.objects if item.kind == "conversation"),
            None,
        )
        actual = _mapping(
            conversation.fields.get("conversationIdentity") if conversation else None
        )
        messages: list[dict[str, Any]] = []
        limitations: list[str] = []
        evidences: list[str] = []
        for raw in sorted(result.objects, key=lambda item: item.order_index):
            if raw.evidence and raw.evidence not in evidences:
                evidences.append(raw.evidence)
            if raw.kind != "chat_message":
                if raw.fields.get("requiresVisualObservation") is True:
                    limitations.append("visual-observation-required-for-message-semantics")
                continue
            fields = dict(raw.fields)
            messages.append({
                "visibleObjectId": fields.get("visibleObjectId"),
                "nativeMessageId": fields.get("nativeMessageId"),
                "speaker": fields.get("speaker"),
                "time": fields.get("time"),
                "replyTo": fields.get("replyTo"),
                "attachments": copy.deepcopy(fields.get("attachments") or []),
                "text": raw.text,
                "rect": list(raw.rect_xywh) if raw.rect_xywh is not None else None,
                "orderIndex": raw.order_index,
                "confidence": raw.confidence,
                "evidence": raw.evidence,
            })
            if fields.get("requiresVisualObservation") is True:
                limitations.append("visual-observation-required-for-message-semantics")
        limitations = list(dict.fromkeys(limitations))
        backend_parts = [f"surface-adapter:{result.adapter_id}", *evidences]
        if navigation_backend:
            backend_parts.insert(0, navigation_backend)
        source_id = str(request.get("source_id") or "")
        page_keys = [_message_overlap_key(item) for item in messages]
        previous_keys = self._last_pages.get(source_id)
        if cursor is None or page_keys:
            self._last_pages[source_id] = page_keys
        boundary = navigation.get("atBoundary") is True
        if cursor is not None and previous_keys == page_keys and page_keys:
            if all(str(item.get("nativeMessageId") or "").strip() for item in messages):
                boundary = True
            else:
                limitations.append("history-boundary-uncertain-identical-page")
        identity_supports_navigation = bool(
            actual.get("nativeConversationId")
            or actual.get("surfaceRuntimeId")
        ) and callable(self._navigate)
        if boundary:
            next_cursor = None
            complete = True
        elif identity_supports_navigation and messages:
            try:
                current_page = int(cursor.rsplit(":", 1)[-1]) if cursor else 0
            except ValueError:
                current_page = 0
            next_cursor = f"older:{current_page + 1}"
            complete = False
        else:
            next_cursor = None
            complete = False
            if "visible-chat-viewport-only" not in limitations:
                limitations.append("visible-chat-viewport-only")
        return {
            "conversationIdentity": actual,
            "messages": messages,
            "pagePosition": "before" if cursor is not None else "initial",
            "navigationReceipt": copy.deepcopy(navigation.get("receipt")),
            "complete": complete,
            "nextCursor": next_cursor,
            "limitations": list(dict.fromkeys(limitations)),
            "usedBackend": "+".join(dict.fromkeys(backend_parts)),
        }


_IDENTITY_FIELDS = (
    "adapterId",
    "conversationKey",
    "nativeConversationId",
    "accountKey",
    "windowHwnd",
    "title",
    "type",
)
_DOCUMENT_SUFFIXES = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm",
}


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        result = to_dict()
        if isinstance(result, Mapping):
            return dict(result)
    return {}


def _conversation_identity(source: SourceRef) -> dict[str, Any]:
    value = source.identity.get("conversationIdentity")
    identity = _mapping(value)
    if not str(identity.get("adapterId") or "").strip():
        raise ValueError("chat source requires conversationIdentity.adapterId")
    if not any(
        str(identity.get(field) or "").strip()
        for field in ("conversationKey", "nativeConversationId")
    ):
        raise ValueError(
            "chat source requires conversationKey or nativeConversationId; title is not identity"
        )
    return identity


def _same_conversation(expected: Mapping[str, Any], actual: Mapping[str, Any]) -> bool:
    for field in _IDENTITY_FIELDS:
        expected_value = expected.get(field)
        if expected_value is None or str(expected_value).strip() == "":
            continue
        actual_value = actual.get(field)
        if field == "windowHwnd":
            try:
                if int(actual_value or 0) != int(expected_value):
                    return False
            except (TypeError, ValueError):
                return False
        elif str(actual_value or "").strip() != str(expected_value).strip():
            return False
    return True


def _attachment_identity(attachment: Mapping[str, Any]) -> tuple[Any, ...]:
    native_id = str(attachment.get("nativeAttachmentId") or "").strip()
    if native_id:
        return ("native", native_id)
    return (
        "observed",
        str(attachment.get("name") or ""),
        str(attachment.get("versionLabel") or ""),
        str(attachment.get("absolutePath") or ""),
        str(attachment.get("url") or ""),
        attachment.get("size"),
    )


def _message_overlap_key(message: Mapping[str, Any]) -> tuple[Any, ...]:
    native_id = str(message.get("nativeMessageId") or "").strip()
    if native_id:
        return ("native-message", native_id)
    attachments = tuple(
        _attachment_identity(_mapping(item))
        for item in list(message.get("attachments") or ())
    )
    return (
        str(message.get("speaker") or ""),
        str(message.get("time") or ""),
        str(message.get("text") or ""),
        str(message.get("replyTo") or ""),
        attachments,
    )


def _adjacent_overlap(previous: list[dict[str, Any]], current: list[dict[str, Any]]) -> int:
    maximum = min(len(previous), len(current))
    for size in range(maximum, 0, -1):
        if [
            _message_overlap_key(item) for item in previous[-size:]
        ] == [
            _message_overlap_key(item) for item in current[:size]
        ]:
            return size
    return 0


def _safe_component(value: str, *, fallback: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._:-]+", "-", str(value)).strip("-.")
    return normalized[:160] or fallback


class ChatReader:

    def __init__(self, backend: ChatHistoryBackend, *, max_pages: int = 100) -> None:
        if max_pages < 1:
            raise ValueError("max_pages must be positive")
        self._backend = backend
        self._max_pages = int(max_pages)
        self._followed: dict[tuple[str, str], tuple[SourceRef, ...]] = {}
        self._result_pages: OrderedDict[str, tuple[Any, ReadResult]] = OrderedDict()
        self._result_sequence = 0

    @staticmethod
    def _result_page(result: ReadResult, key: str, offset: int, limit: int) -> ReadResult:
        end = min(len(result.fragments), offset + limit)
        more = end < len(result.fragments)
        return replace(
            result, fragments=result.fragments[offset:end],
            coverage=replace(
                result.coverage,
                complete=result.coverage.complete and not more,
                next_cursor=f"chat-results:{key}:{end}" if more else result.coverage.next_cursor,
            ),
        )

    @staticmethod
    def _empty(
        source: SourceRef,
        *,
        started: float,
        backend: str,
        reason: str,
        status: str,
        next_cursor: str | None = None,
    ) -> ReadResult:
        return ReadResult(
            source_id=source.source_id,
            fragments=(),
            coverage=Coverage(
                extent="document",
                read_ranges=(),
                total_units=None,
                complete=False,
                next_cursor=next_cursor,
                missing_reason=reason,
            ),
            evidence_status=status,
            used_backend=backend,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )

    def _child_sources(
        self,
        source: SourceRef,
        fragment_id: str,
        attachments: list[dict[str, Any]],
    ) -> tuple[SourceRef, ...]:
        children: list[SourceRef] = []
        for index, attachment in enumerate(attachments):
            name = str(attachment.get("name") or "Attachment").strip() or "Attachment"
            native_id = str(attachment.get("nativeAttachmentId") or "").strip()
            identity: dict[str, Any] = {
                "chatSourceId": source.source_id,
                "messageFragmentId": fragment_id,
                "attachmentOrdinal": index,
                "name": name,
            }
            for field in (
                "nativeAttachmentId", "absolutePath", "url", "versionLabel", "size",
                "mimeType", "downloadState",
            ):
                value = attachment.get(field)
                if value is not None and str(value).strip() != "":
                    identity[field] = copy.deepcopy(value)
            suffix = Path(name).suffix.casefold()
            kind = "document" if suffix in _DOCUMENT_SUFFIXES else "file"
            identity_token = native_id or f"{fragment_id}:attachment:{index}"
            source_id = (
                "source:chat-attachment:"
                f"{_safe_component(source.source_id, fallback='chat')}:"
                f"{_safe_component(identity_token, fallback=str(index))}"
            )
            revision = {
                key: copy.deepcopy(identity[key])
                for key in ("nativeAttachmentId", "versionLabel", "size")
                if key in identity
            }
            readable = bool(identity.get("absolutePath"))
            if not readable and identity.get("url"):
                identity["downloadState"] = "requires-download"
            capabilities = ("read", "search", "follow") if readable else ("follow",)
            children.append(SourceRef(
                source_id=source_id,
                task_id=source.task_id,
                kind=kind,
                title=name,
                identity=identity,
                revision=revision,
                capabilities=capabilities,
                origin="task-discovered",
                parent_source_id=source.source_id,
            ))
        return tuple(children)

    def _fragment(
        self,
        source: SourceRef,
        message: Mapping[str, Any],
        *,
        page_index: int,
        object_index: int,
        sequence_index: int,
        expected_identity: Mapping[str, Any],
    ) -> ReadFragment:
        native_id = str(message.get("nativeMessageId") or "").strip()
        observed_id = str(message.get("visibleObjectId") or "").strip()
        token = native_id or observed_id or f"page-{page_index}-object-{object_index}"
        fragment_id = (
            f"fragment:{source.source_id}:message:"
            f"{_safe_component(token, fallback=str(sequence_index))}"
        )
        locator_value: dict[str, Any] = {
            "adapterId": str(expected_identity.get("adapterId") or ""),
            "conversationKey": str(expected_identity.get("conversationKey") or ""),
            "sequenceIndex": sequence_index,
            "pageIndex": page_index,
            "visibleObjectId": observed_id or None,
        }
        if native_id:
            locator_value["nativeMessageId"] = native_id
        attachments = [
            copy.deepcopy(_mapping(item))
            for item in list(message.get("attachments") or ())
            if _mapping(item)
        ]
        locator = FragmentLocator("message", locator_value)
        metadata = {
            "speaker": str(message.get("speaker") or ""),
            "time": str(message.get("time") or ""),
            "replyTo": str(message.get("replyTo") or "") or None,
            "nativeMessageId": native_id or None,
            "messageIdProvenance": "native" if native_id else "unavailable",
            "attachments": attachments,
            "evidence": str(message.get("evidence") or "public-chat-surface"),
            "confidence": message.get("confidence"),
            "sourceRevision": copy.deepcopy(source.revision),
        }
        fragment = ReadFragment(
            fragment_id=fragment_id,
            locator=locator,
            text=str(message.get("text") or ""),
            metadata=metadata,
            citations=({"sourceId": source.source_id, "locator": locator.to_dict()},),
        )
        self._followed[(source.source_id, fragment_id)] = self._child_sources(
            source, fragment_id, attachments
        )
        return fragment

    def _scan(
        self,
        source: SourceRef,
        *,
        locator: FragmentLocator | None,
        query: str | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        started = time.perf_counter()
        default_backend = "public-chat-surface"
        wanted = max(1, min(int(limit), 100))
        page_scope = (source.to_dict(), query, locator.to_dict() if locator else None)
        if str(cursor or "").startswith("chat-results:"):
            try:
                _, key, raw_offset = str(cursor).split(":")
                previous_scope, previous = self._result_pages[key]
                offset = int(raw_offset)
                if previous_scope != page_scope or not 0 <= offset < len(previous.fragments):
                    raise ValueError("cursor scope changed")
                page = self._result_page(previous, key, offset, wanted)
                return replace(page, latency_ms=(time.perf_counter() - started) * 1000.0)
            except (KeyError, ValueError):
                return self._empty(
                    source, started=started, backend=default_backend, status="error",
                    reason="chat-result-cursor-unavailable-or-mismatched:restart-read-or-search",
                )
        try:
            expected = _conversation_identity(source)
        except Exception as exc:
            return self._empty(
                source,
                started=started,
                backend=default_backend,
                reason=f"chat-source-identity-error:{type(exc).__name__}",
                status="error",
            )

        current_cursor = str(cursor).strip() if cursor else None
        next_cursor = current_cursor
        seen_cursors: set[str] = set()
        merged: list[dict[str, Any]] = []
        previous_page: list[dict[str, Any]] = []
        page_ranges: list[dict[str, Any]] = []
        backends: list[str] = []
        complete = False
        missing_reason: str | None = None

        for page_index in range(self._max_pages):
            cursor_key = current_cursor or "<initial>"
            if cursor_key in seen_cursors:
                missing_reason = "chat-cursor-repeated"
                break
            seen_cursors.add(cursor_key)
            try:
                response = _mapping(self._backend.read_chat_page(
                    source_id=source.source_id,
                    conversation_identity=copy.deepcopy(expected),
                    cursor=current_cursor,
                    locator=locator.to_dict() if locator is not None else None,
                    query=query,
                    limit=wanted,
                ))
            except Exception as exc:
                missing_reason = f"chat-read-error:{type(exc).__name__}"
                break

            backend = str(response.get("usedBackend") or default_backend)
            if backend not in backends:
                backends.append(backend)
            actual = _mapping(response.get("conversationIdentity"))
            if not _same_conversation(expected, actual):
                missing_reason = "conversation-identity-changed"
                next_cursor = current_cursor
                break

            raw_page = [
                _mapping(item) for item in list(response.get("messages") or ())
                if _mapping(item)
            ]
            prepend = response.get("pagePosition") == "before" and bool(previous_page)
            if prepend:
                overlap = _adjacent_overlap(raw_page, previous_page)
                page = raw_page[:-overlap] if overlap else raw_page
            else:
                overlap = _adjacent_overlap(previous_page, raw_page) if previous_page else 0
                page = raw_page[overlap:]
            native_seen = {
                str(item.get("nativeMessageId") or "").strip()
                for item in merged
                if str(item.get("nativeMessageId") or "").strip()
            }
            accepted: list[dict[str, Any]] = []
            for message in page:
                native_id = str(message.get("nativeMessageId") or "").strip()
                if native_id and native_id in native_seen:
                    continue
                message["_pageIndex"] = page_index
                message["_objectIndex"] = len(accepted) + overlap
                accepted.append(message)
                if native_id:
                    native_seen.add(native_id)
            if prepend:
                merged[0:0] = accepted
            else:
                merged.extend(accepted)
            page_range = {
                "pageIndex": page_index,
                "cursor": current_cursor,
                "observedMessages": len(raw_page),
                "overlapMessages": overlap,
                "acceptedMessages": len(accepted),
                "position": "before" if prepend else "after",
            }
            if isinstance(response.get("navigationReceipt"), Mapping):
                page_range["navigationReceipt"] = copy.deepcopy(
                    dict(response["navigationReceipt"])
                )
            if prepend:
                page_ranges.insert(0, page_range)
            else:
                page_ranges.append(page_range)
            previous_page = raw_page

            raw_next = response.get("nextCursor")
            next_cursor = str(raw_next).strip() if raw_next is not None else None
            complete = response.get("complete") is True and next_cursor is None
            limitations = [
                str(item).strip() for item in list(response.get("limitations") or ())
                if str(item).strip()
            ]
            if limitations:
                missing_reason = ";".join(limitations)
                complete = False
            if complete or next_cursor is None:
                break
            if query is None and len(merged) >= wanted:
                break
            current_cursor = next_cursor
        else:
            missing_reason = "chat-page-limit-reached"

        fragments: list[ReadFragment] = []
        folded_query = str(query or "").casefold()
        locator_native = ""
        locator_sequence: int | None = None
        if locator is not None:
            locator_native = str(locator.value.get("nativeMessageId") or "").strip()
            raw_sequence = locator.value.get("sequenceIndex")
            if isinstance(raw_sequence, int) and not isinstance(raw_sequence, bool):
                locator_sequence = raw_sequence
        for sequence_index, message in enumerate(merged):
            if folded_query and folded_query not in str(message.get("text") or "").casefold():
                continue
            if locator is not None:
                message_native = str(message.get("nativeMessageId") or "").strip()
                if locator_native and message_native != locator_native:
                    continue
                if not locator_native and locator_sequence is not None and sequence_index != locator_sequence:
                    continue
            fragment = self._fragment(
                source,
                message,
                page_index=int(message.get("_pageIndex") or 0),
                object_index=int(
                    message.get("_objectIndex")
                    or message.get("orderIndex")
                    or sequence_index
                ),
                sequence_index=sequence_index,
                expected_identity=expected,
            )
            fragments.append(fragment)

        used_backend = "+".join(backends) or default_backend
        if missing_reason:
            status = "degraded" if merged else "error"
        elif fragments:
            status = "ok"
        elif complete:
            status = "empty_confirmed"
        else:
            status = "degraded"
        result = ReadResult(
            source_id=source.source_id,
            fragments=tuple(fragments),
            coverage=Coverage(
                extent="query-results" if query is not None else "document",
                read_ranges=tuple(page_ranges),
                total_units=len(merged),
                complete=bool(complete and missing_reason is None),
                next_cursor=None if complete else next_cursor,
                missing_reason=missing_reason,
            ),
            evidence_status=status,
            used_backend=used_backend,
            latency_ms=(time.perf_counter() - started) * 1000.0,
        )
        if len(fragments) <= wanted:
            return result
        self._result_sequence += 1
        key = str(self._result_sequence)
        self._result_pages[key] = (page_scope, result)
        while len(self._result_pages) > 8:
            self._result_pages.popitem(last=False)
        return self._result_page(result, key, 0, wanted)

    def describe(self, source: SourceRef) -> ReadResult:
        return self._scan(source, locator=None, query=None, cursor=None, limit=1)

    def read(
        self,
        source: SourceRef,
        locator: FragmentLocator | None,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        if locator is not None and locator.kind != "message":
            raise ValueError("chat reader requires a message locator")
        return self._scan(
            source,
            locator=locator,
            query=None,
            cursor=cursor,
            limit=limit,
        )

    def search(
        self,
        source: SourceRef,
        query: str,
        cursor: str | None,
        limit: int,
    ) -> ReadResult:
        normalized = str(query or "").strip()
        if not normalized:
            raise ValueError("query must be non-empty")
        return self._scan(
            source,
            locator=None,
            query=normalized,
            cursor=cursor,
            limit=limit,
        )

    def follow(self, source: SourceRef, fragment_id: str) -> tuple[SourceRef, ...]:
        return self._followed.get((source.source_id, str(fragment_id)), ())


__all__ = [
    "ChatHistoryBackend",
    "ChatReader",
    "DesktopChatNavigator",
    "SurfaceChatHistoryBackend",
]
