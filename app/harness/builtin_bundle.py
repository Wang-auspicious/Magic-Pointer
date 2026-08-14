"""Magic Pointer builtin bundle: the loop's capabilities as plugins.

The plugin-kernel batch (plan T4) re-expresses what used to be hand-wired
inside ``scripts/selection_bridge._loop_router`` as a declarative bundle of
DSH-shaped plugins: every row declares ``inject`` dependencies and mounts
behaviour in ``apply(ctx, config)``. Row order is registration order, and
the boot tree is inspectable through ``dump_config``.

The bridge still owns the per-turn runtime adapters (perception backend,
vision backend, guard probe, the current selection anchor, the fabric
propose/execute closures) — they are *data for this turn*, injected as
core services or row config. The registration topology lives here.

Seam keys provided by the boot (the composition contract):

- ``tools``         ToolRegistry (the only model-facing registry)
- ``hooks``         HookManager (CC PreToolUse/PostToolUse seam)
- ``prompt``        SystemPromptBuilder (sections register here)
- ``llm``           LlmProvider (gateway/local/replay provider seam)
- ``perception``    evidence provider backend for this turn
- ``vision``        vision backend for this turn
- ``guard_probe`` / ``selection_anchor``  guard-chain evidence inputs
- plugin-contributed: ``precondition_factory`` (guard row),
  ``model_client`` / ``compactor`` / ``token_estimator`` (model-client row)
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.action_guard.guard_factory import (
    anchor_from_arguments,
    build_context_factory,
)
from app.agent_runtime.ask_todo_tools import (
    register_ask_user_question,
    register_todo_write,
)
from app.agent_runtime.errors import ActionFailure, FailureType
from app.agent_runtime.hooks import HookManager
from app.agent_runtime.look_tool import LookTool
from app.agent_runtime.mcp_provider import McpToolProvider
from app.agent_runtime.memory import MemoryLoader, SkillLoader, compact_messages
from app.agent_runtime.model_client import (
    AiClientMessagesBackend,
    LoopModelClient,
    StreamingMessagesBackend,
)
from app.agent_runtime.perception_tools import PerceptionTools
from app.agent_runtime.session import FileSessionStore
from app.agent_runtime.system_prompt import SystemPromptBuilder, default_sections
from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from app.computer_operator import (
    ComputerOperatorRegistry,
    ComputerTaskService,
    WindowsComputerOperatorBackend,
)
from app.fabric.capability_tools import (
    register_capability_tools,
    register_find_capability,
)
from app.fabric.mcp_client import load_server_configs
from app.harness.composition import BootReport, BundleRow, boot, load_patch_file
from app.harness.plugin import PluginSpec
from app.harness.runtime_host import HarnessRuntimeHost, RuntimeScope
from app.harness.services import LlmProvider
from app.self_evolution.background import BackgroundReviewLauncher
from app.surface_adapter.adapters.wechat_adapter import WeChatSurfaceAdapter
from app.surface_adapter.registry import SurfaceAdapterRegistry
from app.system_context import list_visible_windows

__all__ = [
    "BUILTIN_PLUGINS",
    "BUILTIN_ROW_IDS",
    "boot_loop_context",
    "boot_surface_context",
    "LoopHarnessHost",
]

_FALLBACK_ROOT = Path(__file__).resolve().parents[2]
"""Repo/app root when the bridge does not pass one explicitly."""


def _spec(
    name: str,
    inject: tuple[str, ...],
    apply: Callable[[Any, dict[str, Any]], None],
    *,
    scopes: tuple[str, ...] = ("agent",),
) -> PluginSpec:
    return PluginSpec(
        name=name,
        inject=inject,
        scopes=scopes,
        apply=apply,
        source=__file__,
    )


# ---------------------------------------------------------------------------
# Plugin rows (order = registration order)
# ---------------------------------------------------------------------------


def _apply_harness_tools(fork, config: dict[str, Any]) -> None:
    """CC-pattern loop tools: clarification + visible plan."""
    registry = fork.get("tools")
    register_ask_user_question(registry, ask=None)
    register_todo_write(registry, sink=None)


def _apply_perception_tools(fork, config: dict[str, Any]) -> None:
    """Model-facing perception over this turn's grounded evidence."""
    PerceptionTools(fork.get("perception")).register_all(fork.get("tools"))


def _apply_look_tool(fork, config: dict[str, Any]) -> None:
    """The look escape hatch over the vision seam and the frozen frame."""
    LookTool(
        backend=fork.get("vision"),
        timeout_ms=int(config.get("timeout_ms") or 30000),
        capture=config.get("capture"),
    ).register(fork.get("tools"))


def _apply_local_action_tools(fork, config: dict[str, Any]) -> None:
    """Copy/screenshot/source as real tools the model can call directly."""
    registry = fork.get("tools")
    empty_schema = {"type": "object", "properties": {}, "required": []}
    content = str(config.get("content") or "")
    capture_path = str(config.get("capture_path") or "").strip()
    window_title = str(config.get("window_title") or "当前窗口")
    window_process = str(config.get("window_process") or "")

    def copy_execute(scope: object = None) -> str:
        if not content.strip():
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                "没有可复制的文本内容。",
                recovery_hint="重新读取圈选目标后再复制",
            )
        try:
            import pyperclip  # noqa: PLC0415 - optional desktop dependency

            pyperclip.copy(content)
        except Exception as exc:  # noqa: BLE001 - honest tool result
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                f"clipboard write failed: {type(exc).__name__}: {exc}",
            ) from exc
        return f"已复制 {len(content)} 个字符到剪贴板。"

    def verify_copy(_result: Any) -> None:
        try:
            import pyperclip  # noqa: PLC0415 - optional desktop dependency

            actual = pyperclip.paste()
        except Exception as exc:  # noqa: BLE001 - verification boundary
            raise ActionFailure(
                FailureType.TOOL_ERROR,
                f"clipboard verification failed: {type(exc).__name__}: {exc}",
            ) from exc
        if actual != content:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                "clipboard verification failed: readback did not match selection",
                recovery_hint="retry after clipboard ownership settles",
            )

    def screenshot_execute(scope: object = None) -> str:
        if not capture_path:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                "当前选区没有可保存的截图。",
                recovery_hint="重新圈选并冻结画面后再保存",
            )
        source = Path(capture_path)
        try:
            if not source.is_file() or source.stat().st_size <= 0:
                raise OSError("capture file is missing or empty")
        except OSError as exc:
            raise ActionFailure(
                FailureType.CONTENT_CHANGED,
                f"capture file is missing or unreadable: {exc}",
                recovery_hint="重新圈选并冻结画面后再保存",
            ) from exc
        return f"选区截图已保存：{capture_path}"

    def source_execute(scope: object = None) -> str:
        return (
            f"来源：{window_title}"
            + (f"（{window_process}）" if window_process else "")
        )

    registry.register(ToolSpec(
        name="copy_selected_text",
        description="把圈选对象的结构化文本复制到剪贴板。",
        input_schema=empty_schema,
        execute=copy_execute,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=True,
        used_backend="pyperclip",
        resource_keys=("clipboard",),
        verify_result=verify_copy,
    ))
    registry.register(ToolSpec(
        name="save_screenshot",
        description="保存当前选区的截图。",
        input_schema=empty_schema,
        execute=screenshot_execute,
        effect=Effect.REVERSIBLE_WRITE,
        is_concurrency_safe=True,
        used_backend="selection_bridge",
    ))
    registry.register(ToolSpec(
        name="show_source",
        description="说明当前圈选对象的来源窗口。",
        input_schema=empty_schema,
        execute=source_execute,
        effect=Effect.READ,
        is_concurrency_safe=True,
        used_backend="selection_bridge",
    ))


def _apply_capability_tools(fork, config: dict[str, Any]) -> None:
    """Recipe capabilities as model-facing tools (propose-only by default)."""
    registry = fork.get("tools")
    register_capability_tools(
        registry,
        config["propose"],
        enabled_recipes=config.get("enabled_recipes"),
        execute_plan=config.get("execute_plan"),
        inloop_reversible=bool(config.get("inloop_reversible")),
    )
    register_find_capability(registry)


def _apply_guard(fork, config: dict[str, Any]) -> None:
    """Guard chain: probe + selection anchor -> precondition factory."""
    probe = fork.get("guard_probe")
    anchor = fork.get("selection_anchor")
    factory = build_context_factory(
        probe,
        lambda args: anchor_from_arguments(args, fallback_anchor=anchor),
    )
    fork.provide_up("precondition_factory", factory)


def _apply_system_prompt(fork, config: dict[str, Any]) -> None:
    """Register the default prompt sections on the shared builder."""
    builder = fork.get("prompt")
    for section in default_sections():
        builder.add(section)


class _MessagesLlmProvider:
    """Built-in gateway provider; replaceable through the ``llm`` seam."""

    def __init__(self, *, streaming: bool) -> None:
        self.streaming = streaming

    @property
    def used_backend(self) -> str:
        return (
            "magic_pointer.messages_multiturn_streaming"
            if self.streaming
            else "magic_pointer.messages_multiturn"
        )

    def create_client(
        self,
        *,
        system_prompt: str,
        max_tokens: int,
    ) -> LoopModelClient:
        backend_cls = StreamingMessagesBackend if self.streaming else AiClientMessagesBackend
        return LoopModelClient(
            backend_cls(system_prompt=system_prompt, max_tokens=max_tokens)
        )


def _apply_llm_provider(fork, config: dict[str, Any]) -> None:
    """Provide the default gateway implementation at the stable ``llm`` key."""
    fork.provide_up(
        "llm",
        _MessagesLlmProvider(streaming=bool(config.get("streaming"))),
    )


def _apply_model_client(fork, config: dict[str, Any]) -> None:
    """Model client + compaction services from config and the prompt seam."""
    memory = MemoryLoader(
        user_dir=Path(config.get("user_data_dir") or str(_FALLBACK_ROOT)),
        workspace_root=Path.cwd(),
    ).load()
    user_data_dir = Path(config.get("user_data_dir") or str(_FALLBACK_ROOT))
    context = {
        "permission_mode": str(config.get("permission_mode") or "default"),
        "memory": memory or None,
        "skills": SkillLoader(
            user_data_dir,
            command=str(config.get("command") or ""),
        ).load() or None,
        "language": "用中文",
    }
    system_prompt = fork.get("prompt").build(context)
    provider = fork.get("llm")
    if not isinstance(provider, LlmProvider):
        raise TypeError("llm service does not implement LlmProvider")
    client = provider.create_client(
        system_prompt=system_prompt,
        max_tokens=int(config.get("max_tokens") or 800),
    )
    fork.provide_up("model_client", client)
    fork.provide_up(
        "model_request_header",
        {
            "systemPrompt": system_prompt,
            "usedBackend": str(provider.used_backend),
            "maxTokens": int(config.get("max_tokens") or 800),
            "permissionMode": str(config.get("permission_mode") or "default"),
        },
    )

    def compactor(messages):
        return compact_messages(
            list(messages), config["summarize"], keep_last=4
        )

    fork.provide_up("compactor", compactor)

    def token_estimator(messages) -> int:
        return sum(max(0, len(message.content or "") // 2) for message in messages)

    fork.provide_up("token_estimator", token_estimator)


def _apply_wechat_surface_adapter(fork, config: dict[str, Any]) -> None:
    """Register the built-in WeChat adapter through the shared seam."""
    fork.get("surface_adapters").register(WeChatSurfaceAdapter())


def _apply_session_store(fork, config: dict[str, Any]) -> None:
    """Provide append-only local sessions at the stable ``sessions`` seam."""
    root = Path(config.get("root") or _FALLBACK_ROOT)
    session_dir = Path(
        config.get("session_dir")
        or root / "data" / "runtime" / "agent-sessions"
    )
    fork.provide_up("sessions", FileSessionStore(session_dir))


def _apply_mcp_provider(fork, config: dict[str, Any]) -> None:
    """Mount configured MCP servers lazily; discovery starts no processes."""
    configs = load_server_configs(Path(config["config_path"]))
    provider = McpToolProvider(
        configs,
        timeout=float(config.get("timeout_s") or 8.0),
    )
    fork.provide_up("mcp", provider)
    if configs:
        provider.register(fork.get("tools"))
    fork.effect(provider.close)


def _apply_learning_review(fork, config: dict[str, Any]) -> None:
    """Provide the detached Hermes-style reviewer launcher."""
    sessions = fork.get("sessions")
    session_root = getattr(sessions, "root", None)
    if session_root is None:
        raise TypeError(
            "builtin learning-review requires a file-backed sessions provider; "
            "replace this row when using another persistence backend"
        )
    fork.provide_up(
        "learning_review",
        BackgroundReviewLauncher(
            project_root=Path(config.get("project_root") or _FALLBACK_ROOT),
            user_root=Path(config["user_root"]),
            session_root=Path(session_root),
            enabled=bool(config.get("enabled", True)),
        ),
    )


def _apply_computer_agent(fork, config: dict[str, Any]) -> None:
    """Provide explicit-authority visual task orchestration, not a raw tool."""
    fork.provide_up(
        "computer_agent",
        ComputerTaskService(
            fork.get("computer_operators"),
            live_window_probe=list_visible_windows,
        ),
    )


BUILTIN_PLUGINS: dict[str, PluginSpec] = {
    spec.name: spec
    for spec in (
        _spec("harness-tools", ("tools",), _apply_harness_tools),
        _spec("perception-tools", ("tools", "perception"), _apply_perception_tools),
        _spec("look-tool", ("tools", "vision"), _apply_look_tool),
        _spec("local-action-tools", ("tools",), _apply_local_action_tools),
        _spec("capability-tools", ("tools",), _apply_capability_tools),
        _spec("guard", ("guard_probe", "selection_anchor"), _apply_guard),
        _spec("system-prompt", ("prompt",), _apply_system_prompt),
        _spec("llm-provider", (), _apply_llm_provider),
        _spec("session-store", (), _apply_session_store),
        _spec("mcp-provider", ("tools",), _apply_mcp_provider),
        _spec("learning-review", ("sessions",), _apply_learning_review),
        _spec("computer-agent", ("computer_operators",), _apply_computer_agent),
        _spec("model-client", ("prompt", "llm"), _apply_model_client),
        _spec(
            "surface-wechat",
            ("surface_adapters",),
            _apply_wechat_surface_adapter,
            scopes=("surface",),
        ),
    )
}

BUILTIN_ROW_IDS: tuple[str, ...] = (
    "harness-tools",
    "perception-tools",
    "look-tool",
    "local-action-tools",
    "capability-tools",
    "guard",
    "system-prompt",
    "llm-provider",
    "session-store",
    "mcp-provider",
    "learning-review",
    "computer-agent",
    "model-client",
)


# ---------------------------------------------------------------------------
# Environment knobs (legacy MAGIC_POINTER_* keep working; they become the
# base row config, so an explicit patch layer still wins over them).
# ---------------------------------------------------------------------------


def _env_flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().casefold() not in ("0", "false", "no", "off")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return default


def _user_plugin_dir(root: Path) -> Path:
    override = os.environ.get("MAGIC_POINTER_PLUGIN_DIR")
    if override:
        return Path(override)
    user_data = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if user_data:
        return Path(user_data) / "data" / "plugins"
    return root / "data" / "plugins"


def _runtime_root(root: Path) -> Path:
    user_data = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    return Path(user_data) if user_data else root / "data" / "runtime"


def _computer_operator_registry(root: Path) -> ComputerOperatorRegistry:
    registry = ComputerOperatorRegistry()
    if os.name == "nt":
        registry.register(WindowsComputerOperatorBackend(
            output_root=_runtime_root(root) / "computer-observations",
        ))
    return registry


def _user_extension_root(root: Path) -> Path:
    user_data = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    return (Path(user_data) / "data") if user_data else root / "data"


def _harness_patch_path(root: Path) -> Path:
    override = os.environ.get("MAGIC_POINTER_HARNESS_CONFIG")
    if override:
        return Path(override)
    user_data = os.environ.get("MAGIC_POINTER_USER_DATA_DIR")
    if user_data:
        return Path(user_data) / "data" / "harness.patch.json"
    return root / "data" / "harness.patch.json"


def _mcp_config_path(root: Path) -> Path:
    override = os.environ.get("MAGIC_POINTER_MCP_CONFIG")
    if override:
        return Path(override)
    return _user_extension_root(root) / "mcp.json"


def _layered_patch(
    root: Path,
    explicit: dict[str, dict[str, Any]] | None,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    file_patch, warnings = load_patch_file(_harness_patch_path(root))
    layered = {row_id: dict(entry) for row_id, entry in file_patch.items()}
    for row_id, entry in (explicit or {}).items():
        layered[row_id] = dict(entry)
    return layered, warnings


def _global_loop_rows(root: Path) -> list[BundleRow]:
    """Rows whose providers live for the whole resident Agent process."""
    return [
        BundleRow("harness-tools", "harness-tools"),
        BundleRow("computer-agent", "computer-agent"),
        BundleRow("system-prompt", "system-prompt"),
        BundleRow(
            "llm-provider",
            "llm-provider",
            {"streaming": _env_flag("MAGIC_POINTER_STREAMING", True)},
        ),
        BundleRow(
            "session-store",
            "session-store",
            {"session_dir": str(_runtime_root(root) / "agent-sessions")},
        ),
        BundleRow(
            "mcp-provider",
            "mcp-provider",
            {"config_path": str(_mcp_config_path(root)), "timeout_s": 8.0},
        ),
        BundleRow(
            "learning-review",
            "learning-review",
            {
                "project_root": str(root),
                "user_root": str(_user_extension_root(root)),
                "enabled": _env_flag("MAGIC_POINTER_BACKGROUND_REVIEW", True),
            },
        ),
    ]


def _run_loop_rows(runtime: dict[str, Any], root: Path) -> list[BundleRow]:
    window = dict(runtime.get("target_window") or {})
    return [
        BundleRow("perception-tools", "perception-tools"),
        BundleRow(
            "look-tool",
            "look-tool",
            {"capture": runtime.get("frame_crop"), "timeout_ms": 30000},
        ),
        BundleRow(
            "local-action-tools",
            "local-action-tools",
            {
                "content": str(runtime.get("content") or ""),
                "capture_path": str(runtime.get("capture_path") or "").strip(),
                "window_title": str(window.get("title") or ""),
                "window_process": str(window.get("process_name") or ""),
            },
        ),
        BundleRow(
            "capability-tools",
            "capability-tools",
            {
                "propose": runtime.get("propose"),
                "execute_plan": runtime.get("execute_plan"),
                "enabled_recipes": runtime.get("enabled_recipes"),
                "inloop_reversible": _env_flag(
                    "MAGIC_POINTER_INLOOP_REVERSIBLE", False
                ),
            },
        ),
        BundleRow("guard", "guard"),
        BundleRow(
            "model-client",
            "model-client",
            {
                "permission_mode": (
                    os.environ.get("MAGIC_POINTER_PERMISSION_MODE", "default").strip()
                    or "default"
                ),
                "max_tokens": 800,
                "context_budget_tokens": _env_int(
                    "MAGIC_POINTER_CONTEXT_TOKENS", 64000
                ),
                "summarize": runtime.get("summarize"),
                "user_data_dir": str(_user_extension_root(root)),
                "command": str(runtime.get("command") or ""),
            },
        ),
    ]


class LoopHarnessHost:
    """Resident loop host: stable providers once, request tools per scope."""

    def __init__(
        self,
        *,
        root: Path | None = None,
        patch: dict[str, dict[str, Any]] | None = None,
        plugin_dir: Path | None = None,
    ) -> None:
        self.root = root or _FALLBACK_ROOT
        layered_patch, patch_warnings = _layered_patch(self.root, patch)
        self._host = HarnessRuntimeHost(
            global_rows=_global_loop_rows(self.root),
            builtin_plugins=BUILTIN_PLUGINS,
            core={
                "tools": ToolRegistry(),
                "hooks": HookManager(),
                "prompt": SystemPromptBuilder(),
                "computer_operators": _computer_operator_registry(self.root),
            },
            plugin_dir=(
                plugin_dir if plugin_dir is not None else _user_plugin_dir(self.root)
            ),
            scope_name="agent",
            patch=layered_patch,
        )
        self._host.report.warnings[:0] = patch_warnings

    @property
    def report(self) -> BootReport:
        return self._host.report

    def open(self, runtime: dict[str, Any]) -> RuntimeScope:
        return self._host.open_scope(
            run_rows=_run_loop_rows(runtime, self.root),
            core={
                "perception": runtime.get("perception_backend"),
                "vision": runtime.get("vision_backend"),
                "guard_probe": runtime.get("guard_probe"),
                "selection_anchor": runtime.get("selection_anchor"),
            },
        )

    def close(self) -> None:
        self._host.close()


def boot_loop_context(
    runtime: dict[str, Any],
    *,
    root: Path | None = None,
    patch: dict[str, dict[str, Any]] | None = None,
    plugin_dir: Path | None = None,
):
    """Boot the loop's composed plugin tree for one turn.

    ``runtime`` carries the per-turn adapters the bridge owns:
    ``perception_backend``, ``vision_backend``, ``frame_crop``,
    ``guard_probe``, ``selection_anchor``, ``propose``, ``execute_plan``,
    ``enabled_recipes``, ``summarize``, ``content``, ``capture_path``,
    ``target_window``, ``command``.
    """
    root = root or _FALLBACK_ROOT
    window = dict(runtime.get("target_window") or {})
    content = str(runtime.get("content") or "")
    capture_path = str(runtime.get("capture_path") or "").strip()
    command = str(runtime.get("command") or "")

    rows = [
        BundleRow("harness-tools", "harness-tools"),
        BundleRow("computer-agent", "computer-agent"),
        BundleRow("perception-tools", "perception-tools"),
        BundleRow(
            "look-tool",
            "look-tool",
            {
                "capture": runtime.get("frame_crop"),
                "timeout_ms": 30000,
            },
        ),
        BundleRow(
            "local-action-tools",
            "local-action-tools",
            {
                "content": content,
                "capture_path": capture_path,
                "window_title": str(window.get("title") or ""),
                "window_process": str(window.get("process_name") or ""),
            },
        ),
        BundleRow(
            "capability-tools",
            "capability-tools",
            {
                "propose": runtime.get("propose"),
                "execute_plan": runtime.get("execute_plan"),
                "enabled_recipes": runtime.get("enabled_recipes"),
                "inloop_reversible": _env_flag("MAGIC_POINTER_INLOOP_REVERSIBLE", False),
            },
        ),
        BundleRow("guard", "guard"),
        BundleRow("system-prompt", "system-prompt"),
        BundleRow(
            "llm-provider",
            "llm-provider",
            {"streaming": _env_flag("MAGIC_POINTER_STREAMING", True)},
        ),
        BundleRow(
            "session-store",
            "session-store",
            {"session_dir": str(_runtime_root(root) / "agent-sessions")},
        ),
        BundleRow(
            "learning-review",
            "learning-review",
            {
                "project_root": str(root),
                "user_root": str(_user_extension_root(root)),
                "enabled": _env_flag("MAGIC_POINTER_BACKGROUND_REVIEW", True),
            },
        ),
        BundleRow(
            "model-client",
            "model-client",
            {
                "permission_mode": (
                    os.environ.get("MAGIC_POINTER_PERMISSION_MODE", "default").strip()
                    or "default"
                ),
                "max_tokens": 800,
                "context_budget_tokens": _env_int(
                    "MAGIC_POINTER_CONTEXT_TOKENS", 64000
                ),
                "summarize": runtime.get("summarize"),
                "user_data_dir": str(_user_extension_root(root)),
                "command": command,
            },
        ),
    ]

    core = {
        "tools": ToolRegistry(),
        "hooks": HookManager(),
        "prompt": SystemPromptBuilder(),
        "computer_operators": _computer_operator_registry(root),
        "perception": runtime.get("perception_backend"),
        "vision": runtime.get("vision_backend"),
        "guard_probe": runtime.get("guard_probe"),
        "selection_anchor": runtime.get("selection_anchor"),
    }

    layered_patch, patch_warnings = _layered_patch(root, patch)
    report: BootReport = boot(
        bundle_rows=rows,
        builtin_plugins=BUILTIN_PLUGINS,
        plugin_dir=plugin_dir if plugin_dir is not None else _user_plugin_dir(root),
        scope_name="agent",
        patch=layered_patch,
        core=core,
    )
    report.warnings[:0] = patch_warnings
    return report


def boot_surface_context(
    *,
    root: Path | None = None,
    patch: dict[str, dict[str, Any]] | None = None,
    plugin_dir: Path | None = None,
) -> BootReport:
    """Boot the pre-perception SurfaceAdapter plugin scope.

    The surface bridge runs before the agent loop, so it has its own narrow
    service scope. User plugins declaring ``inject = ("surface_adapters",)``
    mount from the same plugin directory and unwind after the snapshot read.
    """
    root = root or _FALLBACK_ROOT
    layered_patch, patch_warnings = _layered_patch(root, patch)
    report = boot(
        bundle_rows=[BundleRow("surface-wechat", "surface-wechat")],
        builtin_plugins=BUILTIN_PLUGINS,
        plugin_dir=plugin_dir if plugin_dir is not None else _user_plugin_dir(root),
        scope_name="surface",
        patch=layered_patch,
        core={"surface_adapters": SurfaceAdapterRegistry()},
    )
    report.warnings[:0] = patch_warnings
    return report
