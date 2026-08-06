# Community-Demand Object Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Magic Pointer hand exact, privacy-filtered desktop objects and repo/runtime context to existing Agents through bounded capability discovery and stale-target-safe execution.

**Architecture:** Four focused pure-Python contracts—Target Lease, Capture Policy, Context Packet v2 and Capability Search—are composed by the existing signed `FabricEngine`. Electron remains a minimal PointerStage plus persistent Dashboard; bridge/MCP surfaces expose the same contracts without duplicating logic.

**Tech Stack:** Python 3 dataclasses/JSON/subprocess, pytest, Electron/Node CommonJS, existing Fabric Recipe/Agent adapters.

---

### Task 1: Target Lease

**Files:**
- Create: `app/fabric/target_lease.py`
- Create: `tests/fabric_target_lease_test.py`

- [ ] **Step 1: Write failing fingerprint and validation tests**

```python
def test_lease_fingerprint_is_stable_and_detects_source_change(tmp_path):
    first = TargetLease.create([screen_object(tmp_path)], selection_session_id="session-1")
    reordered = TargetLease.create([dict(reversed(list(screen_object(tmp_path).items())))], selection_session_id="session-1")
    changed = screen_object(tmp_path)
    changed["source"]["hwnd"] = 99
    assert first.object_fingerprint == reordered.object_fingerprint
    assert first.object_fingerprint != TargetLease.create([changed], selection_session_id="session-1").object_fingerprint

def test_live_window_mismatch_is_rejected(tmp_path):
    lease = TargetLease.create([screen_object(tmp_path)], selection_session_id="session-1")
    result = validate_target_lease(lease.to_dict(), live_windows=[{"hwnd": 12, "pid": 999}])
    assert result.valid is False
    assert result.reason == "stale_target_window"
```

- [ ] **Step 2: Run the tests and confirm import failure**

Run: `python -m pytest tests/fabric_target_lease_test.py -q --basetemp .pytest-target-lease-red`
Expected: FAIL because `app.fabric.target_lease` does not exist.

- [ ] **Step 3: Implement deterministic lease creation and validation**

```python
@dataclass(frozen=True)
class TargetLease:
    lease_id: str
    selection_session_id: str
    created_at: str
    expires_at: str
    window: dict[str, Any]
    object_ids: tuple[str, ...]
    object_fingerprint: str
    capture_fingerprint: str
    requires_live_validation: bool

    @classmethod
    def create(cls, objects, *, selection_session_id="", ttl_seconds=600, now=None):
        created = now or datetime.now(timezone.utc)
        canonical = canonical_object_metadata(objects)
        window = first_window_identity(objects)
        return cls(
            lease_id=str(uuid.uuid4()),
            selection_session_id=str(selection_session_id or ""),
            created_at=created.isoformat(timespec="milliseconds"),
            expires_at=(created + timedelta(seconds=ttl_seconds)).isoformat(timespec="milliseconds"),
            window=window,
            object_ids=tuple(item["id"] for item in canonical),
            object_fingerprint=sha256_json(canonical),
            capture_fingerprint=capture_fingerprint(objects),
            requires_live_validation=bool(window.get("hwnd") and window.get("processId")),
        )

def validate_target_lease(value, *, live_windows=None, now=None) -> LeaseValidation:
    expires = datetime.fromisoformat(str(value["expiresAt"]).replace("Z", "+00:00"))
    if expires <= (now or datetime.now(timezone.utc)):
        return LeaseValidation(False, "target_lease_expired")
    if value.get("requiresLiveValidation") is not True:
        return LeaseValidation(True, "lease_does_not_require_live_window")
    expected = dict(value.get("window") or {})
    matched = next(
        (
            item for item in (live_windows or [])
            if int(item.get("hwnd") or 0) == int(expected.get("hwnd") or 0)
            and int(item.get("pid") or item.get("processId") or 0)
            == int(expected.get("processId") or 0)
        ),
        None,
    )
    return LeaseValidation(matched is not None, "live_target_match" if matched else "stale_target_window")
```

The implementation hashes bounded canonical metadata and capture bytes when readable. It accepts both `pid` and `processId` source fields and compares the first leased window by `hwnd + processId`.

- [ ] **Step 4: Run focused tests**

Run: `python -m pytest tests/fabric_target_lease_test.py -q --basetemp .pytest-target-lease-green`
Expected: all tests pass.

### Task 2: Capture Policy

**Files:**
- Create: `app/fabric/capture_policy.py`
- Modify: `app/fabric/settings.py`
- Create: `tests/fabric_capture_policy_test.py`
- Modify: `tests/fabric_settings_test.py`

- [ ] **Step 1: Write failing policy tests**

```python
def test_sensitive_app_withholds_pixels_even_when_global_upload_is_on():
    policy = CapturePolicyEngine(
        upload_screenshots=True,
        default_mode="follow_global",
        sensitive_apps=["1password"],
        app_modes={},
    )
    decision = policy.decide({"source": {"app": "1Password", "path": "capture.png"}})
    assert decision.mode == "structured_only"
    assert decision.allow_upload is False

def test_explicit_app_upload_needs_global_switch():
    disabled = CapturePolicyEngine(False, "follow_global", [], {"figma": "upload_screenshot"})
    assert disabled.decide({"source": {"app": "Figma"}}).allow_upload is False
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `python -m pytest tests/fabric_capture_policy_test.py tests/fabric_settings_test.py -q --basetemp .pytest-capture-policy-red`
Expected: FAIL on missing policy module/settings fields.

- [ ] **Step 3: Implement modes, decisions and settings persistence**

```python
CAPTURE_MODES = {
    "follow_global", "structured_only", "local_ocr",
    "local_screenshot", "upload_screenshot", "deny",
}

@dataclass(frozen=True)
class CaptureDecision:
    mode: str
    allow_structure: bool
    allow_local_pixels: bool
    allow_upload: bool
    reason: str
    matched_rule: str | None
```

Add `default_capture_mode: str = "follow_global"` and `app_capture_modes: dict[str, str]` to `PrivacySettings`, validate every mode in `__post_init__`, and preserve schema version 1 compatibility.

- [ ] **Step 4: Run focused tests**

Run: `python -m pytest tests/fabric_capture_policy_test.py tests/fabric_settings_test.py -q --basetemp .pytest-capture-policy-green`
Expected: all tests pass.

### Task 3: Context Packet v2 and Capability Search

**Files:**
- Create: `app/fabric/context_packet.py`
- Create: `app/fabric/capabilities.py`
- Create: `tests/fabric_context_packet_test.py`
- Create: `tests/fabric_capabilities_test.py`

- [ ] **Step 1: Write failing packet/search tests**

```python
def test_packet_contains_repo_scope_and_omits_withheld_image(tmp_path):
    packet = ContextPacketBuilder().build(
        command="修这个",
        recipe_id="agent.handoff",
        objects=[screen_object],
        cwd=tmp_path,
        target_lease=lease,
        capture_decisions=[structured_only],
        capabilities=[],
    )
    assert packet["schemaVersion"] == 2
    assert packet["workspace"]["cwd"] == str(tmp_path.resolve())
    assert "screenshotPath" not in json.dumps(packet, ensure_ascii=False)

def test_search_is_bounded_and_pins_selected_recipe():
    matches = CapabilityRegistry().search(
        "让 Codex 修这个界面",
        objects=[{"kind": "screen_region"}],
        selected_recipe_id="agent.handoff",
        limit=6,
    )
    assert 3 <= len(matches) <= 6
    assert matches[0]["id"] == "agent.handoff"
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `python -m pytest tests/fabric_context_packet_test.py tests/fabric_capabilities_test.py -q --basetemp .pytest-object-packet-red`
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement bounded packet and deterministic search**

```python
class ContextPacketBuilder:
    def build(self, *, command, recipe_id, objects, cwd, target_lease,
              capture_decisions, capabilities, terminal_excerpt="",
              attachments=()):
        workspace = probe_workspace(cwd)
        safe_objects = [
            sanitize_object(item, capture_decisions[index])
            for index, item in enumerate(objects)
            if capture_decisions[index].mode != "deny"
        ]
        return {
            "schemaVersion": 2,
            "packetId": str(uuid.uuid4()),
            "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "intent": {"command": bounded(command, 6000), "recipeId": recipe_id},
            "targetLease": dict(target_lease),
            "objects": safe_objects[:12],
            "workspace": workspace,
            "runtime": {"terminalExcerpt": bounded(terminal_excerpt, 8000)},
            "capabilities": list(capabilities)[:8],
            "artifacts": nonvisual_artifacts(attachments)[:32],
            "privacy": capture_privacy_summary(capture_decisions),
        }

class CapabilityRegistry:
    def search(self, command, *, objects=(), selected_recipe_id=None,
               platform=None, provider_availability=None, limit=6):
        bounded_limit = min(8, max(3, int(limit)))
        ranked = sorted(
            (
                (
                    score_recipe(
                        recipe,
                        command=command,
                        object_kinds={str(item.get("kind") or "") for item in objects},
                        selected_recipe_id=selected_recipe_id,
                        platform=platform,
                        provider_availability=provider_availability or {},
                    ),
                    recipe,
                )
                for recipe in RECIPE_CATALOG
            ),
            key=lambda pair: (-pair[0], pair[1].id),
        )
        return [capability_descriptor(recipe, score) for score, recipe in ranked[:bounded_limit]]
```

Workspace probing uses `git -C <cwd> rev-parse`, `branch --show-current`, `status --porcelain` and `diff --stat` with hard timeouts. All arrays/text are capped. Packet writing is atomic, and prompt rendering references the artifact path while keeping the direct summary bounded.

- [ ] **Step 4: Run focused tests**

Run: `python -m pytest tests/fabric_context_packet_test.py tests/fabric_capabilities_test.py -q --basetemp .pytest-object-packet-green`
Expected: all tests pass.

### Task 4: Compose Contracts Into Signed Plans and Agent Handoff

**Files:**
- Modify: `app/fabric/engine.py`
- Modify: `app/fabric/executors.py`
- Modify: `app/actions/executor.py`
- Modify: `scripts/selection_bridge.py`
- Modify: `tests/fabric_engine_test.py`
- Modify: `tests/fabric_action_integration_test.py`

- [ ] **Step 1: Write failing integration tests**

```python
def test_plan_exposes_lease_capture_decisions_packet_and_bounded_capabilities(tmp_path):
    plan = engine.plan("让 Pi 修这个", objects=[window_object], parameters={"cwd": str(tmp_path)})["plan"]
    assert plan["parameters"]["targetLease"]["requiresLiveValidation"] is True
    assert len(plan["parameters"]["capabilitySelection"]) <= 8
    assert plan["parameters"]["contextPacket"]["schemaVersion"] == 2

def test_stale_target_blocks_external_action(tmp_path):
    engine = FabricEngine(root=tmp_path, target_probe=lambda lease: [])
    plan = engine.plan("让 Pi 修这个", objects=[window_object], parameters={"cwd": str(tmp_path)})["plan"]
    receipt = engine.execute(plan, confirmed=True)
    assert receipt["error"] == "stale_target_window"
```

- [ ] **Step 2: Run focused integration tests and confirm failure**

Run: `python -m pytest tests/fabric_engine_test.py tests/fabric_action_integration_test.py -q --basetemp .pytest-engine-object-bridge-red`
Expected: new assertions fail.

- [ ] **Step 3: Integrate planning and execution**

In `FabricEngine.plan()`:

```python
lease = TargetLease.create(clean_objects, selection_session_id=params.get("selectionSessionId", ""))
decisions = capture_policy.decide_all(clean_objects)
capabilities = registry.search(command, objects=clean_objects, selected_recipe_id=recipe.id)
packet = packet_builder.build(
    command=command,
    recipe_id=recipe.id,
    objects=clean_objects,
    cwd=params.get("cwd") or Path.cwd(),
    target_lease=lease.to_dict(),
    capture_decisions=decisions,
    capabilities=capabilities,
    terminal_excerpt=str(params.get("terminalExcerpt") or ""),
    attachments=params.get("attachments") or (),
)
params.update({
    "targetLease": lease.to_dict(),
    "capturePolicy": capture_policy.to_plan_dict(decisions, attachments),
    "capabilitySelection": capabilities,
    "contextPacket": packet,
})
```

Fail planning on a denied object. In `execute()`, validate live target before calling the executor when `requiresLiveValidation` is true. The production `SafeActionExecutor` constructs a Fabric engine with the Windows visible-window probe.

In `_agent()`, write Packet v2 to `artifacts/<id>-context-packet.json`, use `build_agent_prompt()`, and attach only `capturePolicy.uploadAllowedPaths`. Keep `submit=False` and use an explicitly supplied existing `sessionId` when present.

- [ ] **Step 4: Run engine and bridge suites**

Run: `python -m pytest tests/fabric_engine_test.py tests/fabric_action_integration_test.py tests/selection_bridge_test.py -q --basetemp .pytest-engine-object-bridge-green`
Expected: all tests pass.

### Task 5: Bounded Gateway and Honest Task Recovery

**Files:**
- Modify: `app/fabric/task_store.py`
- Modify: `scripts/fabric_bridge.py`
- Modify: `app/fabric/mcp.py`
- Modify: `tests/agent_task_store_test.py`
- Modify: `tests/fabric_bridge_test.py`
- Modify: `tests/mcp_server_test.py`

- [ ] **Step 1: Write failing task/gateway tests**

```python
def test_cancel_stays_cancelling_when_process_survives(tmp_path):
    store = AgentTaskStore(
        tmp_path,
        spawn_worker=lambda task_file: 321,
        process_alive=lambda pid: True,
        terminate_process=lambda pid: None,
    )
    result = store.cancel(task_id)
    assert result["status"] == "cancelling"
    assert result["error"] == "termination_not_verified"

def test_mcp_search_capabilities_is_bounded(tmp_path):
    result = server.call_tool("search_capabilities", {"command": "修这个", "limit": 5})
    assert result["ok"] is True
    assert 3 <= len(result["capabilities"]) <= 5
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `python -m pytest tests/agent_task_store_test.py tests/fabric_bridge_test.py tests/mcp_server_test.py -q --basetemp .pytest-gateway-task-red`
Expected: new operations/assertions fail.

- [ ] **Step 3: Implement task list/recover/resume and capability search operations**

```python
def list(self, *, limit=100) -> list[dict[str, Any]]:
    task_ids = sorted(
        (path.parent.name for path in self.root.glob("*/task.json")),
        key=lambda task_id: self._task_file(task_id).stat().st_mtime,
        reverse=True,
    )
    return [self.status(task_id) for task_id in task_ids[:max(0, min(limit, 500))]]

def recover(self) -> list[dict[str, Any]]:
    return self.list(limit=500)

def resume(self, task_id: str) -> dict[str, Any]:
    value = self._read(task_id)
    if value["status"] not in {"failed", "interrupted"}:
        raise AgentTaskError("task_not_resumable")
    value["attempt"] = int(value.get("attempt") or 1) + 1
    value["status"] = "queued"
    value["workerPid"] = int(self.spawn_worker(self._task_file(task_id)))
    value["agentPid"] = None
    value["exitCode"] = None
    value["error"] = None
    value["updatedAt"] = _now()
    self._write(value)
    self._append_event(task_id, "resume", {"attempt": value["attempt"]})
    return self._public(value)
```

`cancel()` probes both agent and worker after termination. `resume()` accepts only `interrupted` or `failed`, increments `attempt`, clears terminal fields, records an event, and spawns a new worker. Bridge operations are `capabilities.search`, `task.list`, `task.recover`, and `task.resume`. MCP adds `search_capabilities`, `agent_task_list`, and `agent_task_resume`.

- [ ] **Step 4: Run focused tests**

Run: `python -m pytest tests/agent_task_store_test.py tests/fabric_bridge_test.py tests/mcp_server_test.py -q --basetemp .pytest-gateway-task-green`
Expected: all tests pass.

### Task 6: Dashboard Capture Policies

**Files:**
- Modify: `electron/settings_store.js`
- Modify: `electron/renderer/dashboard.html`
- Modify: `electron/renderer/dashboard.js`
- Modify: `tests/settings_store_test.js`
- Modify: `tests/fabric_dashboard_static_test.js`

- [ ] **Step 1: Write failing Node tests**

```javascript
const payload = defaultSettings();
payload.privacy.default_capture_mode = 'local_ocr';
payload.privacy.app_capture_modes = { '1password': 'deny' };
const configured = validate(payload);
assert.strictEqual(configured.privacy.default_capture_mode, 'local_ocr');
assert.strictEqual(configured.privacy.app_capture_modes['1password'], 'deny');
const badModePayload = defaultSettings();
badModePayload.privacy.default_capture_mode = 'send_everything';
assert.throws(() => validate(badModePayload), /capture mode/);
```

- [ ] **Step 2: Run focused Node tests and confirm failure**

Run: `node tests/settings_store_test.js && node tests/fabric_dashboard_static_test.js`
Expected: a new capture-policy assertion fails.

- [ ] **Step 3: Add persistent controls without changing PointerStage**

Add a default-mode `<select id="default-capture-mode">` and `<textarea id="app-capture-modes">` using one `pattern=mode` rule per line. `applySettings()` renders them; `collectSettings()` parses them into `privacy.app_capture_modes`. The Electron settings validator rejects invalid modes and non-object rule maps.

- [ ] **Step 4: Run Node tests**

Run: `node tests/settings_store_test.js && node tests/fabric_dashboard_static_test.js`
Expected: both tests pass.

### Task 7: Full Verification and Evidence Log

**Files:**
- Modify: `COMMUNITY_DEMAND_AND_BUILD_LOG_20260726.md`
- Modify: `IMPLEMENTATION_STATUS_20260726.md`

- [ ] **Step 1: Run all automated tests**

Run: `npm test`
Expected: every Node/static suite passes.

Run: `python -m pytest -q --basetemp .pytest-community-object-bridge-final`
Expected: every Python test passes.

- [ ] **Step 2: Run bridge smoke probes**

Run:

```powershell
'{"operation":"capabilities.search","command":"让 Codex 修这个界面","objects":[{"kind":"screen_region"}],"limit":6}' | python scripts/fabric_bridge.py
```

Expected: UTF-8 JSON with `ok=true`, 3–6 capabilities and `agent.handoff` ranked first.

Run:

```powershell
'{"operation":"settings.get"}' | python scripts/fabric_bridge.py
```

Expected: settings contain `default_capture_mode` and `app_capture_modes`.

- [ ] **Step 3: Record exact proof and remaining provider boundaries**

Update both status documents with test counts, smoke output, implemented requirement IDs, unverified desktop checks and still-missing external providers. Do not promote source-only macOS support or provider contracts into verified product claims.
