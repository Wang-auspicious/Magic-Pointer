
from __future__ import annotations

from typing import Any, Callable

from app.agent_runtime.tool_registry import Effect, ToolRegistry, ToolSpec
from .projection import project_artifacts


def register_artifact_tools(registry: ToolRegistry, *, session_getter: Callable[[], Any]) -> None:
    def session():
        active = session_getter()
        if active is None:
            raise RuntimeError("artifact session is not ready")
        return active

    def read(artifact_id: str, scope=None) -> dict[str, Any]:
        draft = next((item for item in project_artifacts(session().events)
                      if item.artifact_id == artifact_id), None)
        if draft is None:
            raise ValueError(f"unknown artifact {artifact_id!r}")
        return {
            "artifactId": draft.artifact_id, "revision": draft.revision,
            "title": draft.title, "kind": draft.kind, "content": draft.content,
            "state": draft.state.value,
        }

    def create(title: str, kind: str, content: str, scope=None) -> dict[str, Any]:
        title = title.strip()
        if not title:
            raise ValueError("artifact title must not be empty")
        event = session().record_artifact_generated(content, title=title, kind=kind)
        return {key: event.data[key] for key in ("artifactId", "revision", "title", "kind")}

    def update(artifact_id: str, expected_revision: int, content: str,
               title: str | None = None, scope=None) -> dict[str, Any]:
        if title is not None:
            title = title.strip()
            if not title:
                raise ValueError("artifact title must not be empty")
        event = session().record_artifact_patched(
            artifact_id, content, author="agent", expected_revision=expected_revision, title=title,
        )
        return {key: event.data[key] for key in ("artifactId", "revision", "title", "kind")}

    definitions = (
        ("Artifact.create", create,
         "创建用户需要单独阅读、编辑或复用的完整交付物，如文稿、报告、独立代码示例或图表。"
         "仅当独立交付物符合用户意图时调用，并给出明确标题和完整正文。"
         "普通问答、简短解释、澄清、权限请求、进度和计划状态直接回复或使用AskUser/Todo，不创建产物。"
         "不要将工作区代码改动、临时文件、日志和工具结果另存为产物；实际文件用文件工具交付。"
         "修改已有产物先Artifact.read，再Artifact.update；不要重复create。创建不会发布或发送。",
         {"title": {"type": "string", "description": "用户可识别的交付物标题"},
          "kind": {"type": "string", "enum": ["text", "markdown", "code", "html", "svg", "mermaid"]},
          "content": {"type": "string", "description": "完整交付物正文，不是完成说明"}},
         ["title", "kind", "content"]),
        ("Artifact.read", read,
         "读取当前会话已有产物的最新正文、标题、类型和revision。修改前先读取，保留用户在编辑器中的修改。"
         "读取不会创建产物或新版本。",
         {"artifact_id": {"type": "string"}}, ["artifact_id"]),
        ("Artifact.update", update,
         "更新已有独立交付物，保留同一个artifact_id。先Artifact.read获取最新内容与revision，"
         "expected_revision必须是读到的版本，content提交保留用户修改后的完整新稿。"
         "版本冲突时重新读取，不覆盖旧稿；普通答复、进度和计划状态不更新产物。"
         "不用于document_patch（结构化文档修改）。更新不会发布或发送。",
         {"artifact_id": {"type": "string"}, "expected_revision": {"type": "integer"},
          "content": {"type": "string"}, "title": {"type": "string"}},
         ["artifact_id", "expected_revision", "content"]),
    )
    for name, execute, description, properties, required in definitions:
        registry.register(ToolSpec(
            name=name, description=description,
            input_schema={"type": "object", "properties": properties, "required": required},
            execute=execute,
            effect=Effect.READ,
            is_concurrency_safe=name == "Artifact.read",
            resource_keys=("draft-artifacts",),
            used_backend="event_session.artifact",
        ))
