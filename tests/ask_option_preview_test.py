import json

from app.agent_runtime.ask_todo_tools import register_ask_user_question
from app.agent_runtime.tool_registry import ToolRegistry
from app.agent_runtime.user_input import normalize_pending_input


def test_option_preview_survives_tool_and_pending_normalization(tmp_path):
    preview = '<button>Example</button>\n  aligned text'
    questions = [{'question': 'Which layout?', 'options': [
        {'label': 'Compact', 'description': 'Small', 'preview': preview}, {'label': 'Wide'}]}]
    registry = ToolRegistry()
    spec = register_ask_user_question(registry)
    result = registry.execute_tool('AskUser', {'questions': questions})
    assert not result.is_error
    pending = normalize_pending_input(json.loads(result.value))
    assert pending['questions'][0]['options'][0]['preview'] == preview
    assert 'preview' in spec.input_schema['properties']['questions']['items']['properties']['options']['items']['properties']
