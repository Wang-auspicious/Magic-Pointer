
from app.agent_runtime.memory import compact_messages
from app.agent_runtime.types import ORIGIN_DATA, AgentMessage, Role


def _msg(role, content, call_id=None):
    return AgentMessage(
        role=role,
        content=content,
        tool_call_id=call_id,
        name="t" if role is Role.TOOL else None,
        origin=ORIGIN_DATA,
    )


class Summarizer:
    def __init__(self, reply="SUMMARY"):
        self.reply = reply
        self.calls = 0
        self.sources: list[str] = []

    def __call__(self, source: str) -> str:
        self.calls += 1
        self.sources.append(source)
        return self.reply


def _history(n_duplicates: int = 12):
    rows = [_msg(Role.USER, "看一下这个目录")]
    for index in range(n_duplicates):
        rows.append(_msg(Role.ASSISTANT, "", call_id=f"c{index}"))
        rows.append(_msg(Role.TOOL, "x" * 900, call_id=f"c{index}"))
    rows.append(_msg(Role.USER, "那接下来呢"))
    rows.append(_msg(Role.ASSISTANT, "接下来我建议先看第二列"))
    rows.append(_msg(Role.USER, "好"))
    return rows


class TestDefaultIsUnchanged:
    def test_without_the_option_the_summarizer_still_runs(self):
        summarizer = Summarizer()
        compact_messages(_history(), summarizer)
        assert summarizer.calls == 1, "the default path must not change"

    def test_force_always_summarizes(self):
        summarizer = Summarizer()
        compact_messages(
            _history(),
            summarizer,
            force=True,
            model_free_below_chars=10**9,
        )
        assert summarizer.calls == 1, "an explicit force is an explicit ask"


class TestModelFreePath:
    def test_a_small_pruned_source_skips_the_summarizer(self):
        summarizer = Summarizer()
        compacted = compact_messages(
            _history(),
            summarizer,
            model_free_below_chars=10_000,
        )
        assert summarizer.calls == 0, "no model call when pruning already sufficed"
        before = sum(len(m.content or "") for m in _history())
        after = sum(len(m.content or "") for m in compacted)
        assert after < before

    def test_a_large_pruned_source_still_summarizes(self):
        summarizer = Summarizer()
        compact_messages(_history(), summarizer, model_free_below_chars=10)
        assert summarizer.calls == 1

    def test_the_result_is_lighter_than_the_input(self):
        original = _history()
        compacted = compact_messages(original, Summarizer(), model_free_below_chars=10_000)
        before = sum(len(m.content or "") for m in original)
        after = sum(len(m.content or "") for m in compacted)
        assert after < before

    def test_no_summary_is_fabricated(self):
        summarizer = Summarizer(reply="MODEL_WROTE_THIS")
        compacted = compact_messages(_history(), summarizer, model_free_below_chars=10_000)
        for message in compacted:
            assert "MODEL_WROTE_THIS" not in (message.content or "")

    def test_every_input_message_still_has_a_trace(self):
        original = _history()
        compacted = compact_messages(original, Summarizer(), model_free_below_chars=10_000)
        assert len(compacted) == len(original)

    def test_no_source_means_no_change_either_way(self):
        summarizer = Summarizer()
        rows = [_msg(Role.USER, "hi"), _msg(Role.ASSISTANT, "hello")]
        assert compact_messages(rows, summarizer, model_free_below_chars=10_000) == rows
        assert summarizer.calls == 0
