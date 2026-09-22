
from __future__ import annotations

import pytest

from app.agent_runtime.permission_modes import PermissionMode
from app.agent_runtime.permission_presets import (
    APPROVAL_POLICIES,
    CUSTOM_PRESET,
    PRESETS,
    SANDBOX_MODES,
    PermissionPresetSpec,
    mode_for_preset,
    preset_select,
    resolve_preset,
)


def test_preset_table_matches_permission_defaults() -> None:
    assert list(PRESETS) == [
        "auto",
        "plan",
        "read-only",
        "workspace-write",
        "danger-full-access",
    ]
    assert PRESETS["auto"].sandbox == "workspace-write"
    assert PRESETS["auto"].approval == "never"
    assert mode_for_preset("auto") == PermissionMode.ACCEPT_REVERSIBLE
    assert mode_for_preset("workspace-write") == PermissionMode.DEFAULT
    assert PRESETS["workspace-write"].sandbox == "workspace-write"
    assert PRESETS["workspace-write"].approval == "ask"
    assert PRESETS["danger-full-access"].sandbox == "danger-full-access"
    assert PRESETS["danger-full-access"].approval == "never"
    for spec in PRESETS.values():
        assert spec.sandbox in SANDBOX_MODES
        assert spec.approval in APPROVAL_POLICIES
        assert spec.name and spec.description


def test_full_access_carries_confirmation_gate() -> None:
    assert PRESETS["danger-full-access"].confirm is True
    assert all(spec.confirm is not True for name, spec in PRESETS.items() if name != "danger-full-access")


def test_mode_mapping_covers_effect_table() -> None:
    assert mode_for_preset("read-only") is PermissionMode.SAFE
    assert mode_for_preset("workspace-write") is PermissionMode.DEFAULT
    assert mode_for_preset("danger-full-access") is PermissionMode.BYPASS
    with pytest.raises(KeyError):
        mode_for_preset(CUSTOM_PRESET)
    with pytest.raises(KeyError):
        mode_for_preset("no-such-preset")


def test_select_payload_shape() -> None:
    select = preset_select("workspace-write")
    assert select["currentValue"] == "workspace-write"
    values = [option["value"] for option in select["options"]]
    assert values == [
        "auto",
        "plan",
        "read-only",
        "workspace-write",
        "danger-full-access",
    ]
    for option in select["options"]:
        assert option["name"] and option["description"]
    full = next(o for o in select["options"] if o["value"] == "danger-full-access")
    assert full["confirmTitle"] and full["confirmDescription"]


def test_custom_is_display_only() -> None:
    select = preset_select(CUSTOM_PRESET)
    assert select["currentValue"] == CUSTOM_PRESET
    values = [option["value"] for option in select["options"]]
    assert CUSTOM_PRESET in values
    with pytest.raises(KeyError):
        resolve_preset(CUSTOM_PRESET)


def test_resolve_unknown_preset_raises() -> None:
    with pytest.raises(KeyError):
        resolve_preset("yolo")


def test_preset_spec_is_plain_data() -> None:
    spec = resolve_preset("read-only")
    assert isinstance(spec, PermissionPresetSpec)
    assert spec.sandbox == "read-only"
    assert spec.approval == "ask"
