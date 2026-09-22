import json

from app.desktop_actions import DesktopActionSession


class Driver:
    def __init__(self):
        self.clicked = False

    def click(self, *_args, **_kwargs):
        self.clicked = True


def session_fixture():
    driver = Driver()
    calls = []

    def elements(hwnd):
        calls.append(hwnd)
        return [{"index": 1, "role": "button", "name": "Ready" if driver.clicked else "Start",
                 "rect": [10, 10, 80, 40], "patterns": ["Invoke"]}]

    session = DesktopActionSession(driver=driver,
        windows_probe=lambda: [{"hwnd": 42, "window_id": "w-42", "title": "Test",
                                "pid": 7, "rect": [0, 0, 500, 400]}],
        elements_probe=elements, launcher=lambda app: {}, uia_act=lambda *args: {}, session_id="cu-fast")
    return session, calls


def test_observe_ui_emits_one_actionable_tree_instead_of_two_copies():
    session, _ = session_fixture()
    result = json.loads(session.observe_ui())
    assert result["outline"][0]["ref"] == "@e1"
    assert "elements" not in result


def test_wait_condition_and_returned_state_share_one_observation():
    session, calls = session_fixture()
    state = json.loads(session.observe_ui())["state_id"]
    calls.clear()
    waited = json.loads(session.wait_for(state, text="Start", timeout_ms=100))
    assert waited["found"] is True
    assert waited["state_id"] != state
    assert len(calls) == 1


def test_act_reuses_verified_successor_and_does_not_claim_unchecked_success():
    session, calls = session_fixture()
    state = json.loads(session.observe_ui())["state_id"]
    result = json.loads(session.act_ui(state, [{"action": "click", "ref": "@e1"}],
                                       expect={"text": "Ready", "timeout_ms": 100}))
    assert result["verification"]["found"] is True
    assert result["verification"]["state_id"] == result["state_id"]
    next_result = json.loads(session.act_ui(result["state_id"], [{"action": "click", "ref": "@e1"}]))
    assert next_result["verification"]["status"] == "unavailable"
    assert next_result["view"] == "full"
    assert next_result["outline"][0]["name"] == "Ready"
