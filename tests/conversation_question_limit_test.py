from scripts import conversation_bridge


def test_composer_question_limit_matches_runtime():
    result = conversation_bridge.answer_conversation('中' * 12000, [], {}, 'invalid-preset')
    assert '未知权限预设' in result['error'], 'a valid composer question must pass length validation'
    result = conversation_bridge.answer_conversation('中' * 12001, [], {}, 'invalid-preset')
    assert '12000' in result['error']
