"""Tests for the agent runtime tool registry (plan T2.2).

Covers, per plan and the CC toolExecution/toolOrchestration port notes:
- ToolSpec contract: name/description/input_schema/effect/is_concurrency_safe/
  used_backend/execute/timeout_ms
- register validation (name format, schema structure, effect, execute,
  duplicate rejection), get/list, schemas_for_model shape (CC API tools
  parameters format)
- validate_input strict error lists (missing required, extra fields, type
  mismatch)
- concurrency_partition (CC isConcurrencySafe batching with input order)
- execute_tool result wrapping (ActionFailure failure_type passthrough,
  ordinary exceptions -> FailureType.tool_error, is_error semantics, honest
  used_backend/latency recording)

Only fake pure-function tools are registered; nothing real is touched.
"""

from __future__ import annotations

import sys
import time
from dataclasses import fields, replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.agent_runtime.tool_registry import (  # noqa: E402
    GLOBAL_REGISTRY,
    ActionFailure,
    Effect,
    FailureType,
    ToolRegistry,
    ToolResult,
    ToolSpec,
)

NAME_RE_MESSAGE = "name"
SCHEMA_MESSAGE = "schema"


def make_spec(name: str = "echo_tool", **overrides: object) -> ToolSpec:
    base: dict[str, object] = {
        "name": name,
        "description": "echoes the text argument",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
        "effect": Effect.READ,
        "execute": lambda text: f"echo:{text}",
    }
    base.update(overrides)
    return ToolSpec(**base)  # type: ignore[arg-type]


def make_add_spec(name: str = "add_tool") -> ToolSpec:
    return ToolSpec(
        name=name,
        description="adds two integers",
        input_schema={
            "type": "object",
            "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
            "required": ["a", "b"],
        },
        effect=Effect.LOCAL_IRREVERSIBLE,
        is_concurrency_safe=False,
        used_backend="fake_math",
        execute=lambda a, b: a + b,
    )


class TestEffectEnum:
    def test_has_all_six_contract_members(self) -> None:
        assert {e.value for e in Effect} == {
            "read",
            "reversible_write",
            "local_irreversible",
            "external_send",
            "destructive",
            "purchase",
        }

    def test_members_are_str_enum(self) -> None:
        assert Effect("read") is Effect.READ
        assert Effect("destructive") is Effect.DESTRUCTIVE


class TestToolSpecDefaults:
    def test_defaults_fail_closed(self) -> None:
        spec = make_spec()
        assert spec.effect is Effect.READ
        assert spec.is_concurrency_safe is False
        assert spec.used_backend == "local"
        assert spec.timeout_ms == 30000
        assert spec.resource_keys == ()
        assert spec.description == "echoes the text argument"
        assert "compensate" not in {field.name for field in fields(ToolSpec)}

    def test_explicit_effect_and_backend(self) -> None:
        spec = make_spec(effect=Effect.EXTERNAL_SEND, used_backend="foreground_click")
        assert spec.effect is Effect.EXTERNAL_SEND
        assert spec.used_backend == "foreground_click"

    def test_static_and_dynamic_resource_keys_are_resolved_from_arguments(self) -> None:
        registry = ToolRegistry()
        registry.register(
            make_spec(
                name="static_tool",
                resource_keys=("desktop-input", "clipboard"),
            )
        )
        registry.register(
            make_spec(
                name="dynamic_tool",
                resource_keys=lambda args: (f"file:{args['text']}",),
            )
        )

        assert registry.resource_keys_for("static_tool", {"text": "ignored"}) == (
            "desktop-input",
            "clipboard",
        )
        assert registry.resource_keys_for("dynamic_tool", {"text": "a.txt"}) == (
            "file:a.txt",
        )


class TestRegisterNameValidation:
    @pytest.mark.parametrize("bad", ["", "echo tool", "echo tool", "echo-tool", "回声"])
    def test_register_rejects_invalid_name(self, bad: str) -> None:
        with pytest.raises(ValueError, match=NAME_RE_MESSAGE):
            ToolRegistry().register(make_spec(name=bad))

    @pytest.mark.parametrize("good", ["echo", "echo_tool", "a1_b2"])
    def test_register_accepts_valid_name(self, good: str) -> None:
        registry = ToolRegistry()
        spec = make_spec(name=good)
        assert registry.register(spec) is spec
        assert registry.get(good) is spec


class TestRegisterSchemaValidation:
    def test_rejects_non_dict_schema(self) -> None:
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema="not-a-schema"))

    def test_rejects_schema_without_object_type(self) -> None:
        schema = {"type": "string", "properties": {}, "required": []}
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema=schema))

    def test_rejects_schema_without_properties(self) -> None:
        schema = {"type": "object", "required": []}
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema=schema))

    def test_rejects_schema_with_non_dict_properties(self) -> None:
        schema = {"type": "object", "properties": ["text"], "required": []}
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema=schema))

    def test_rejects_schema_with_non_list_required(self) -> None:
        schema = {"type": "object", "properties": {}, "required": "text"}
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema=schema))

    def test_rejects_schema_with_non_str_required_item(self) -> None:
        schema = {"type": "object", "properties": {}, "required": [1]}
        with pytest.raises(ValueError, match=SCHEMA_MESSAGE):
            ToolRegistry().register(make_spec(input_schema=schema))


class TestRegisterExecuteAndEffectValidation:
    def test_rejects_non_callable_execute(self) -> None:
        with pytest.raises(ValueError, match="execute"):
            ToolRegistry().register(make_spec(execute="not-callable"))

    def test_rejects_bare_string_effect(self) -> None:
        with pytest.raises(ValueError, match="effect"):
            ToolRegistry().register(make_spec(effect="read"))

    def test_rejects_non_tool_spec(self) -> None:
        with pytest.raises(TypeError):
            ToolRegistry().register({"name": "echo_tool"})  # type: ignore[arg-type]

    def test_rejects_non_callable_result_verifier(self) -> None:
        with pytest.raises(ValueError, match="verify_result"):
            ToolRegistry().register(make_spec(verify_result="not-callable"))

    @pytest.mark.parametrize(
        "resource_keys",
        [("",), ("ok", 3), "desktop-input", 3],
    )
    def test_rejects_invalid_resource_key_declaration(self, resource_keys) -> None:
        with pytest.raises(ValueError, match="resource_keys"):
            ToolRegistry().register(make_spec(resource_keys=resource_keys))

    def test_dynamic_resource_key_result_is_validated(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(resource_keys=lambda _args: ("ok", "")))

        with pytest.raises(ValueError, match="resource_keys"):
            registry.resource_keys_for("echo_tool", {"text": "x"})


class TestRegisterDuplicate:
    def test_duplicate_name_rejected(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(name="echo_tool"))
        with pytest.raises(ValueError, match="already"):
            registry.register(make_spec(name="echo_tool"))


class TestGetAndList:
    def test_get_unknown_raises_key_error(self) -> None:
        with pytest.raises(KeyError):
            ToolRegistry().get("no_such_tool")

    def test_get_returns_registered_spec(self) -> None:
        registry = ToolRegistry()
        spec = registry.register(make_spec(name="echo_tool"))
        assert registry.get("echo_tool") is spec

    def test_list_preserves_registration_order(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(name="echo_tool"))
        registry.register(make_add_spec())
        registry.register(make_spec(name="upper_tool", execute=lambda text: text.upper()))
        names = [spec.name for spec in registry.list()]
        assert names == ["echo_tool", "add_tool", "upper_tool"]
        assert isinstance(registry.list(), tuple)

    def test_list_is_empty_for_fresh_registry(self) -> None:
        assert ToolRegistry().list() == ()


class TestSchemasForModel:
    def test_examples_are_surfaced_in_schema_when_present(self) -> None:
        """ToolSpec.examples (CC prompt_sample / Codex examples) ride the
        schema so the model sees one concrete usage on the first round instead
        of guessing argument shapes (roadmap §1.1)."""
        registry = ToolRegistry()
        registry.register(make_spec(
            name="echo_tool",
            examples=({"text": "hello"}, {"text": "世界"}),
        ))
        emitted = registry.schemas_for_model()[0]
        assert "examples" in emitted
        assert emitted["examples"] == ({"text": "hello"}, {"text": "世界"})

    def test_examples_absent_keeps_schema_shape_stable(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(name="echo_tool"))
        first = registry.schemas_for_model()[0]
        assert set(first) == {"name", "description", "parameters"}

    def test_search_hits_words_that_only_appear_in_examples(self) -> None:
        """find_capability must find a tool whose keyword lives only in
        examples, not in name/description (roadmap §1.2)."""
        registry = ToolRegistry()
        registry.register(make_spec(
            name="apply_patch",
            description="用 Codex 补丁格式修改多个文件",
            examples=({"patch": "*** Begin Patch *** End Patch"},),
        ))
        hits = registry.search("codex", limit=4)
        assert any(h.name == "apply_patch" for h in hits)

    def test_output_shape_matches_cc_api_tools_parameters(self) -> None:
        registry = ToolRegistry()
        spec = registry.register(make_spec(name="echo_tool"))
        registry.register(make_add_spec())
        schemas = registry.schemas_for_model()
        assert isinstance(schemas, list)
        assert len(schemas) == 2
        first = schemas[0]
        assert set(first) == {"name", "description", "parameters"}
        assert first["name"] == "echo_tool"
        assert first["description"] == spec.description
        assert first["parameters"] is spec.input_schema

    def test_parameters_is_json_schema_style_object(self) -> None:
        registry = ToolRegistry()
        registry.register(make_add_spec())
        parameters = registry.schemas_for_model()[0]["parameters"]
        assert parameters["type"] == "object"
        assert set(parameters["properties"]) == {"a", "b"}
        assert parameters["required"] == ["a", "b"]


class TestValidateInput:
    def test_missing_required_field(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec())
        errors = registry.validate_input(registry.get("echo_tool"), {})
        assert any("text" in e and "required" in e for e in errors)

    def test_extra_field_rejected(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec())
        errors = registry.validate_input(
            registry.get("echo_tool"), {"text": "hi", "bogus": 1}
        )
        assert any("bogus" in e and "unexpected" in e for e in errors)

    def test_type_mismatch_rejected(self) -> None:
        registry = ToolRegistry()
        registry.register(make_add_spec())
        errors = registry.validate_input(registry.get("add_tool"), {"a": "one", "b": 2})
        assert any("a" in e and "integer" in e for e in errors)

    def test_bool_is_not_an_integer(self) -> None:
        registry = ToolRegistry()
        registry.register(make_add_spec())
        errors = registry.validate_input(registry.get("add_tool"), {"a": True, "b": 2})
        assert any("a" in e for e in errors)

    def test_valid_args_pass_with_empty_error_list(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec())
        assert registry.validate_input(registry.get("echo_tool"), {"text": "hi"}) == []

    def test_non_dict_args_raise_type_error(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec())
        with pytest.raises(TypeError):
            registry.validate_input(registry.get("echo_tool"), ["text"])  # type: ignore[arg-type]

    def test_nested_schema_enum_and_bounds_are_enforced(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(input_schema={
            "type": "object",
            "properties": {
                "request": {
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string", "enum": ["read", "write"]},
                        "files": {
                            "type": "array",
                            "items": {"type": "string", "maxLength": 8},
                            "minItems": 1,
                            "maxItems": 2,
                        },
                    },
                    "required": ["mode", "files"],
                    "additionalProperties": False,
                },
            },
            "required": ["request"],
        }))

        errors = registry.validate_input(registry.get("echo_tool"), {
            "request": {
                "mode": "delete",
                "files": ["short", "way-too-long", "third"],
                "untrusted": True,
            },
        })

        assert any("request.mode" in error and "enum" in error for error in errors)
        assert any("request.files" in error and "maxItems" in error for error in errors)
        assert any("request.files[1]" in error and "maxLength" in error for error in errors)
        assert any("request.untrusted" in error and "unexpected" in error for error in errors)

    def test_non_finite_numbers_and_excessive_nesting_are_rejected(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(input_schema={
            "type": "object",
            "properties": {"payload": {}},
            "required": ["payload"],
        }))

        non_finite = registry.validate_input(
            registry.get("echo_tool"),
            {"payload": float("nan")},
        )
        nested: object = "leaf"
        for _ in range(40):
            nested = [nested]
        excessive = registry.validate_input(
            registry.get("echo_tool"),
            {"payload": nested},
        )

        assert any("finite" in error for error in non_finite)
        assert any("nesting" in error for error in excessive)

    def test_local_defs_reference_is_resolved_and_enforced(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(input_schema={
            "type": "object",
            "properties": {"request": {"$ref": "#/$defs/request"}},
            "required": ["request"],
            "$defs": {
                "request": {
                    "type": "object",
                    "properties": {
                        "mode": {"type": "string", "enum": ["read", "write"]},
                    },
                    "required": ["mode"],
                    "additionalProperties": False,
                },
            },
        }))

        assert registry.validate_input(
            registry.get("echo_tool"),
            {"request": {"mode": "read"}},
        ) == []
        errors = registry.validate_input(
            registry.get("echo_tool"),
            {"request": {"mode": "delete"}},
        )

        assert any("request.mode" in error and "enum" in error for error in errors)

    def test_unresolved_or_external_schema_reference_fails_closed(self) -> None:
        registry = ToolRegistry()
        registry.register(make_spec(input_schema={
            "type": "object",
            "properties": {
                "missing": {"$ref": "#/$defs/missing"},
                "external": {"$ref": "https://example.test/schema.json"},
            },
            "required": ["missing", "external"],
        }))

        errors = registry.validate_input(
            registry.get("echo_tool"),
            {"missing": "x", "external": "y"},
        )

        assert any("missing" in error and "unresolved" in error for error in errors)
        assert any("external" in error and "local" in error for error in errors)


class TestConcurrencyPartition:
    def _registry_with_mixed_tools(self) -> ToolRegistry:
        registry = ToolRegistry()
        registry.register(make_spec(name="echo_tool", is_concurrency_safe=True))
        registry.register(make_add_spec(name="add_tool"))
        registry.register(
            make_spec(name="upper_tool", is_concurrency_safe=True, execute=lambda text: text.upper())
        )
        return registry

    def test_all_safe_go_parallel(self) -> None:
        registry = self._registry_with_mixed_tools()
        parallel, sequential = registry.concurrency_partition(
            ["echo_tool", "upper_tool"]
        )
        assert parallel == ["echo_tool", "upper_tool"]
        assert sequential == []

    def test_all_unsafe_stay_sequential_in_input_order(self) -> None:
        registry = self._registry_with_mixed_tools()
        registry.register(make_add_spec(name="add_tool_2"))
        parallel, sequential = registry.concurrency_partition(
            ["add_tool", "add_tool_2"]
        )
        assert parallel == []
        assert sequential == ["add_tool", "add_tool_2"]

    def test_mixed_partition_preserves_order_within_each_list(self) -> None:
        registry = self._registry_with_mixed_tools()
        parallel, sequential = registry.concurrency_partition(
            ["echo_tool", "add_tool", "upper_tool", "add_tool"]
        )
        assert parallel == ["echo_tool", "upper_tool"]
        assert sequential == ["add_tool", "add_tool"]

    def test_unknown_tool_raises_key_error(self) -> None:
        registry = self._registry_with_mixed_tools()
        with pytest.raises(KeyError):
            registry.concurrency_partition(["echo_tool", "no_such_tool"])


class TestExecuteToolSuccess:
    def test_success_records_value_backend_and_latency(self) -> None:
        registry = ToolRegistry()
        spec = registry.register(make_spec(name="echo_tool"))
        result = registry.execute_tool("echo_tool", {"text": "hi"})
        assert isinstance(result, ToolResult)
        assert result.value == "echo:hi"
        assert result.is_error is False
        assert result.failure_type is None
        assert result.used_backend == spec.used_backend
        assert isinstance(result.latency_ms, float)
        assert result.latency_ms >= 0.0
        assert result.error_message is None

    def test_latency_reflects_real_execution_duration(self) -> None:
        registry = ToolRegistry()
        spec = make_spec(
            name="slow_tool",
            execute=lambda text: (time.sleep(0.01), text)[1],
        )
        registry.register(spec)
        result = registry.execute_tool("slow_tool", {"text": "x"})
        assert result.latency_ms >= 10.0

    def test_scope_is_forwarded_to_execute(self) -> None:
        captured: dict[str, object] = {}

        def scoped_execute(scope: object, text: str) -> str:
            captured["scope"] = scope
            return text.upper()

        registry = ToolRegistry()
        registry.register(make_spec(name="scoped_tool", execute=scoped_execute))
        scope_obj = object()
        result = registry.execute_tool("scoped_tool", {"text": "hi"}, scope=scope_obj)
        assert result.value == "HI"
        assert captured["scope"] is scope_obj

    def test_unknown_tool_raises_key_error(self) -> None:
        with pytest.raises(KeyError):
            ToolRegistry().execute_tool("no_such_tool", {})


class TestExecuteToolFailure:
    def test_action_failure_passes_failure_type_through(self) -> None:
        def failing_execute(text: str) -> str:
            raise ActionFailure(FailureType.PERMISSION_DENIED, "denied by policy")

        registry = ToolRegistry()
        spec = registry.register(make_spec(name="denied_tool", execute=failing_execute))
        result = registry.execute_tool("denied_tool", {"text": "hi"})
        assert result.is_error is True
        assert result.failure_type is FailureType.PERMISSION_DENIED
        assert "denied by policy" in result.error_message
        assert result.value is None
        assert result.used_backend == spec.used_backend
        assert isinstance(result.latency_ms, float)

    def test_result_verification_failure_is_a_tool_error_not_success(self) -> None:
        def verify(value: dict) -> None:
            if value.get("verified") is not True:
                raise ActionFailure(
                    FailureType.CONTENT_CHANGED,
                    "action receipt was not verified",
                )

        registry = ToolRegistry()
        registry.register(
            make_spec(
                name="write_tool",
                execute=lambda text: {"text": text, "verified": False},
                verify_result=verify,
            )
        )

        result = registry.execute_tool("write_tool", {"text": "hi"})

        assert result.is_error is True
        assert result.failure_type is FailureType.CONTENT_CHANGED
        assert "not verified" in (result.error_message or "")

    def test_ordinary_exception_wrapped_as_tool_error(self) -> None:
        def broken_execute(text: str) -> str:
            raise ValueError("boom")

        registry = ToolRegistry()
        registry.register(make_spec(name="broken_tool", execute=broken_execute))
        result = registry.execute_tool("broken_tool", {"text": "hi"})
        assert result.is_error is True
        assert result.failure_type is FailureType.TOOL_ERROR
        assert "boom" in result.error_message
        assert "broken_tool" in result.error_message
        assert result.value is None

    def test_used_backend_recorded_even_on_failure(self) -> None:
        def broken_execute(text: str) -> str:
            raise RuntimeError("kaboom")

        registry = ToolRegistry()
        registry.register(make_spec(name="broken_tool", execute=broken_execute, used_backend="fake_echo"))
        result = registry.execute_tool("broken_tool", {"text": "hi"})
        assert result.used_backend == "fake_echo"


class TestGlobalRegistry:
    def test_global_registry_is_tool_registry_singleton(self) -> None:
        assert isinstance(GLOBAL_REGISTRY, ToolRegistry)
        registry = GLOBAL_REGISTRY
        assert GLOBAL_REGISTRY is registry
