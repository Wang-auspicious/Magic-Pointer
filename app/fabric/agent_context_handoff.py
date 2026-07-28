from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator


class AgentContextHandoffError(RuntimeError):
    pass


_PROCESS_LOCKS: dict[str, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_PROVIDERS = {"codex", "pi", "claude", "gemini", "cursor", "opencode", "aider"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


class AgentContextHandoffStore:
    """Immutable Context Packet plus provider-neutral dispatch contract."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _path(self, context_id: str) -> Path:
        clean = str(context_id or "").strip().casefold()
        if not clean or any(char not in "0123456789abcdef-" for char in clean):
            raise AgentContextHandoffError("invalid agent context id")
        return self.root / clean / "context.json"

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / ".agent-contexts.lock"
        key = str(lock_path.resolve()).casefold()
        with _PROCESS_LOCKS_GUARD:
            process_lock = _PROCESS_LOCKS.setdefault(key, threading.RLock())
        with process_lock, lock_path.open("a+b") as handle:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _write(self, value: dict[str, Any]) -> None:
        path = self._path(str(value.get("contextId") or ""))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".json.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        except OSError as exc:
            raise AgentContextHandoffError(
                f"could not persist agent context:{type(exc).__name__}"
            ) from exc
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def _read(self, context_id: str) -> dict[str, Any]:
        try:
            value = json.loads(self._path(context_id).read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise AgentContextHandoffError("unknown agent context id") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise AgentContextHandoffError("invalid agent context state") from exc
        if (
            not isinstance(value, dict)
            or value.get("schemaVersion") != 1
            or value.get("contextId") != str(context_id).casefold()
            or not isinstance(value.get("contextPacket"), dict)
            or not isinstance(value.get("dispatch"), dict)
            or not isinstance(value.get("deliveries"), list)
        ):
            raise AgentContextHandoffError("invalid agent context state")
        packet = value["contextPacket"]
        if packet.get("schemaVersion") != 2 or not packet.get("packetId"):
            raise AgentContextHandoffError("invalid agent context state")
        if _digest(packet) != value.get("contextPacketDigest"):
            raise AgentContextHandoffError("agent context digest mismatch")
        if _digest(value["dispatch"]) != value.get("dispatchDigest"):
            raise AgentContextHandoffError("agent dispatch contract digest mismatch")
        return value

    @staticmethod
    def _public(value: dict[str, Any], *, reused: bool = False) -> dict[str, Any]:
        packet = value["contextPacket"]
        intent = packet.get("intent") if isinstance(packet.get("intent"), dict) else {}
        deliveries = [dict(item) for item in value.get("deliveries") or [] if isinstance(item, dict)]
        providers = list(dict.fromkeys(
            str(item.get("provider") or "")
            for item in deliveries
            if str(item.get("provider") or "")
        ))
        return {
            "contextId": value["contextId"],
            "contextPacketId": str(packet.get("packetId") or ""),
            "contextPacketDigest": value["contextPacketDigest"],
            "recipeId": str(intent.get("recipeId") or ""),
            "objectCount": len([item for item in packet.get("objects") or [] if isinstance(item, dict)]),
            "providers": providers,
            "deliveryCount": len(deliveries),
            "deliveries": [{
                "deliveryId": item.get("deliveryId"),
                "provider": item.get("provider"),
                "status": item.get("status"),
                "taskId": item.get("taskId"),
                "createdAt": item.get("createdAt"),
                "updatedAt": item.get("updatedAt"),
            } for item in deliveries],
            "createdAt": value["createdAt"],
            "updatedAt": value["updatedAt"],
            "reused": reused,
        }

    def _find_packet_id(self, packet_id: str) -> dict[str, Any] | None:
        for path in self.root.glob("*/context.json"):
            value = self._read(path.parent.name)
            if value["contextPacket"].get("packetId") == packet_id:
                return value
        return None

    def seal(
        self,
        packet: dict[str, Any],
        *,
        prompt: str,
        attachments: list[str],
        permission: str,
        privacy: dict[str, Any],
    ) -> dict[str, Any]:
        if not isinstance(packet, dict) or packet.get("schemaVersion") != 2 or not packet.get("packetId"):
            raise AgentContextHandoffError("Context Packet v2 is required")
        if permission not in {"read", "write"}:
            raise AgentContextHandoffError("invalid agent context permission")
        clean_prompt = str(prompt or "").strip()
        if not clean_prompt:
            raise AgentContextHandoffError("agent context prompt is empty")
        dispatch = {
            "prompt": clean_prompt,
            "attachments": list(dict.fromkeys(str(item) for item in attachments if str(item).strip())),
            "permission": permission,
            "privacy": dict(privacy or {}),
        }
        packet_digest = _digest(packet)
        dispatch_digest = _digest(dispatch)
        with self._lock():
            existing = self._find_packet_id(str(packet["packetId"]))
            if existing is not None:
                if existing["contextPacketDigest"] != packet_digest:
                    raise AgentContextHandoffError("agent context packet id collision")
                if existing["dispatchDigest"] != dispatch_digest:
                    raise AgentContextHandoffError("agent context dispatch contract collision")
                return self._public(existing, reused=True)
            stamp = _now()
            value = {
                "schemaVersion": 1,
                "contextId": str(uuid.uuid4()),
                "contextPacket": json.loads(json.dumps(packet, ensure_ascii=False, default=str)),
                "contextPacketDigest": packet_digest,
                "dispatch": dispatch,
                "dispatchDigest": dispatch_digest,
                "deliveries": [],
                "createdAt": stamp,
                "updatedAt": stamp,
            }
            self._write(value)
            return self._public(value)

    def get(self, context_id: str) -> dict[str, Any]:
        with self._lock():
            return self._public(self._read(context_id))

    def list(self, *, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock():
            paths = sorted(
                self.root.glob("*/context.json"),
                key=lambda item: item.stat().st_mtime_ns,
                reverse=True,
            )
            return [self._public(self._read(path.parent.name)) for path in paths[:max(1, min(int(limit), 500))]]

    def reconcile(
        self,
        task_status: Callable[[str], dict[str, Any]],
        *,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Refresh delivery states from the durable AgentTaskStore truth."""
        with self._lock():
            paths = sorted(
                self.root.glob("*/context.json"),
                key=lambda item: item.stat().st_mtime_ns,
                reverse=True,
            )[:max(1, min(int(limit), 500))]
            results: list[dict[str, Any]] = []
            for path in paths:
                value = self._read(path.parent.name)
                changed = False
                for delivery in value["deliveries"]:
                    task_id = str(delivery.get("taskId") or "")
                    if not task_id:
                        continue
                    try:
                        task = dict(task_status(task_id))
                    except Exception:
                        continue
                    status = str(task.get("status") or "")
                    if status and status != delivery.get("status"):
                        delivery["status"] = status
                        delivery["updatedAt"] = str(task.get("updatedAt") or _now())
                        changed = True
                if changed:
                    value["updatedAt"] = _now()
                    self._write(value)
                results.append(self._public(value))
            return results

    def dispatch(
        self,
        context_id: str,
        *,
        provider: str,
        starter: Callable[[dict[str, Any]], dict[str, Any]],
        session_id: str = "",
    ) -> dict[str, Any]:
        provider = str(provider or "").strip().casefold()
        if provider not in _PROVIDERS:
            raise AgentContextHandoffError("unsupported agent context provider")
        with self._lock():
            value = self._read(context_id)
            existing = next((
                item for item in value["deliveries"]
                if item.get("provider") == provider and item.get("status") in {"queued", "running"}
            ), None)
            if existing is not None:
                return {
                    "accepted": True,
                    "reused": True,
                    "taskId": existing.get("taskId"),
                    "provider": provider,
                    "status": existing.get("status"),
                    "task": {
                        "taskId": existing.get("taskId"),
                        "status": existing.get("status"),
                        "provider": provider,
                    },
                    "context": self._public(value, reused=True),
                }
            delivery_id = str(uuid.uuid4())
            stamp = _now()
            value["deliveries"].append({
                "deliveryId": delivery_id,
                "provider": provider,
                "status": "dispatching",
                "taskId": None,
                "createdAt": stamp,
                "updatedAt": stamp,
            })
            value["updatedAt"] = stamp
            self._write(value)
            packet = json.loads(json.dumps(value["contextPacket"], ensure_ascii=False))
            dispatch = json.loads(json.dumps(value["dispatch"], ensure_ascii=False))
            packet_digest = value["contextPacketDigest"]

        payload = {
            "provider": provider,
            "prompt": dispatch["prompt"],
            "cwd": str((packet.get("workspace") or {}).get("cwd") or ""),
            "attachments": list(dispatch["attachments"]),
            "permission": dispatch["permission"],
            "submit": False,
            "sessionId": str(session_id or ""),
            "contextPacket": packet,
            "contextPacketId": str(packet.get("packetId") or ""),
            "contextPacketDigest": packet_digest,
            "privacy": dict(dispatch["privacy"]),
        }
        failure: Exception | None = None
        try:
            task = dict(starter(payload))
        except Exception as exc:
            failure = exc
            task = {}
        accepted = bool(task.get("taskId")) and task.get("status") in {"queued", "running"}
        with self._lock():
            value = self._read(context_id)
            delivery = next((item for item in value["deliveries"] if item.get("deliveryId") == delivery_id), None)
            if delivery is None:
                raise AgentContextHandoffError("agent context delivery state disappeared")
            delivery["status"] = str(task.get("status") or ("failed" if failure else "verification_failed"))
            delivery["taskId"] = str(task.get("taskId") or "") or None
            delivery["updatedAt"] = _now()
            value["updatedAt"] = delivery["updatedAt"]
            self._write(value)
            public = self._public(value)
        if failure is not None:
            raise AgentContextHandoffError(f"agent dispatch failed:{type(failure).__name__}") from failure
        return {
            "accepted": accepted,
            "reused": False,
            "taskId": str(task.get("taskId") or "") or None,
            "provider": provider,
            "status": str(task.get("status") or "verification_failed"),
            "contextPacketId": str(packet.get("packetId") or ""),
            "contextPacketDigest": packet_digest,
            "context": public,
            "task": task,
        }
