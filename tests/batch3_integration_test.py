"""Batch 3 integration: privacy gate -> ledger -> repair flow -> bench report."""

from __future__ import annotations

from app.failure_flow.repair_prompt import RepairAction, build_repair
from app.permissions.app_blacklist import AppBlacklist
from app.permissions.offline_mode import FORBIDDEN_SCOPES, OfflineForbiddenError, OfflineMode
from app.permissions.sensitive_detect import redact
from app.telemetry.interaction_ledger import InteractionLedger, LedgerEntry
from app.telemetry.pointerbench import BackendTag, BenchReport, BenchRun, BenchTask, PointerBench


def test_blacklisted_bank_window_is_blocked_before_perception() -> None:
    blacklist = AppBlacklist()
    decision = blacklist.check(
        {"process_name": "somebank.exe", "title": "网上银行登录", "window_class": None}
    )
    assert decision.allowed is False
    assert decision.rule is not None
    assert "银行" in decision.rule.reason or "bank" in decision.rule.reason.lower()


def test_password_manager_process_is_blocked() -> None:
    blacklist = AppBlacklist()
    decision = blacklist.check(
        {"process_name": "KeePass.exe", "title": "KeePass", "window_class": None}
    )
    assert decision.allowed is False


def test_sensitive_redaction_keeps_no_full_card_number() -> None:
    result = redact("卡号 4532 0151 1283 0366 谢谢")
    assert "4532015112830366" not in result.text_redacted.replace(" ", "")
    assert result.hits
    assert result.text_redacted.startswith("卡号 4532")
    assert result.text_redacted.endswith("谢谢")


def test_offline_mode_blocks_model_scopes_but_keeps_local() -> None:
    mode = OfflineMode()
    mode.set(True)
    try:
        for scope in ("model_text", "model_vision", "external_send", "mcp_remote"):
            try:
                mode.assert_allowed(scope)
                raise AssertionError(f"{scope} should be forbidden offline")
            except OfflineForbiddenError:
                pass
        summary = mode.impact_summary()
        assert "local_ocr" in summary["local_scopes"]
        assert "model_text" in summary["forbidden_scopes"]
    finally:
        mode.set(False)


def test_ledger_records_look_usage_and_failure() -> None:
    ledger = InteractionLedger()
    ledger.record(
        LedgerEntry(
            interaction_id="i1",
            started_at_utc="2026-08-12T00:00:00Z",
            ended_at_utc="2026-08-12T00:00:01Z",
            app_name="wechat",
            turns=3,
            tokens_text=500,
            tokens_vision=800,
            used_look=True,
            succeeded=False,
            failure_type="timeout",
        )
    )
    summary = ledger.summarize()
    assert summary.tokens_vision_total == 800
    assert summary.success_rate == 0.0
    assert summary.look_ratio == 1.0
    assert any(name == "timeout" for name, _ in summary.top_failure_types)


def test_repair_suggestion_carries_attribution() -> None:
    suggestion = build_repair(failure_type="timeout", evidence_status="busy")
    assert RepairAction.USE_LOOK in suggestion.actions
    assert RepairAction.RETRY in suggestion.actions
    assert "超时" in suggestion.title or "忙" in suggestion.title
    assert suggestion.title != "出错了"


def test_bench_report_marks_missing_backends_honestly() -> None:
    bench = PointerBench(
        tasks=[
            BenchTask(
                task_id="t1",
                app="edge",
                target="网页段落",
                goal="翻译",
                expected_result="译文",
                difficulty="easy",
            )
        ]
    )
    bench.record_run(
        BenchRun(
            task_id="t1",
            backend=BackendTag.MAGIC_POINTER,
            succeeded=True,
            e2e_latency_ms=1500.0,
            tokens=400,
            reference_accuracy=1.0,
        )
    )
    report: BenchReport = bench.generate_report()
    assert report.missing_backends
    assert "screen_cua" in report.missing_backends or "human" in report.missing_backends
    mp = next(s for s in report.stats if s.backend == BackendTag.MAGIC_POINTER.value)
    assert mp.success_rate == 1.0


def test_full_chain_privacy_to_ledger_to_repair() -> None:
    identity = {"process_name": "bank.exe", "title": "凭据确认", "window_class": None}
    assert AppBlacklist().is_blacklisted(identity)

    ledger = InteractionLedger()
    ledger.record(
        LedgerEntry(
            interaction_id="blocked-1",
            started_at_utc="2026-08-12T00:00:00Z",
            ended_at_utc=None,
            app_name="bank",
            turns=0,
            tokens_text=0,
            tokens_vision=0,
            succeeded=False,
            failure_type="permission_denied",
        )
    )
    suggestion = build_repair(failure_type="permission_denied", evidence_status=None)
    assert RepairAction.EXPLAIN_WHAT_FAILED in suggestion.actions
    assert RepairAction.ASK_USER in suggestion.actions
    assert "权限" in suggestion.title
