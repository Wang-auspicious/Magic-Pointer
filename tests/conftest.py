import pytest


@pytest.fixture(scope="session", autouse=True)
def disable_implicit_live_jev():
    from app.desktop_actions import jev
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(jev, "opencode_key", lambda: "")
        patch.setattr(jev, "_selector", None)
        yield
