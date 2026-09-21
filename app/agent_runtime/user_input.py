"""Structured AskUser requests and answers shared by the loop and durable session."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def normalize_questions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= 4:
        raise ValueError('questions must contain 1-4 questions')
    questions = []
    for raw in value:
        if not isinstance(raw, Mapping):
            raise ValueError('question must be an object')
        question = str(raw.get('question') or '').strip()
        if not question or len(question) > 1000:
            raise ValueError('question must contain 1-1000 characters')
        options = raw.get('options')
        if not isinstance(options, list) or not 2 <= len(options) <= 4:
            raise ValueError('options must contain 2-4 choices')
        choices = []
        for option in options:
            label = str(option.get('label') or '').strip() if isinstance(option, Mapping) else str(option).strip()
            if not label or len(label) > 200:
                raise ValueError('option label must contain 1-200 characters')
            choice = {'label': label}
            if isinstance(option, Mapping) and option.get('description'):
                choice['description'] = str(option['description']).strip()[:1000]
            choices.append(choice)
        if len({item['label'] for item in choices}) != len(choices):
            raise ValueError('option labels must be distinct')
        questions.append({'question': question, 'options': choices,
            'multiSelect': raw.get('multiSelect') is True,
            **({'header': str(raw['header']).strip()[:100]} if raw.get('header') else {})})
    if len({item['question'] for item in questions}) != len(questions):
        raise ValueError('question texts must be distinct')
    return questions


def normalize_pending_input(payload: Mapping[str, Any]) -> dict[str, Any]:
    questions = normalize_questions(payload.get('questions') or [{
        'question': payload.get('question'), 'options': payload.get('options'),
    }])
    pending: dict[str, Any] = {'question': questions[0]['question'],
        'options': [option['label'] for option in questions[0]['options']]}
    if payload.get('questions'):
        pending['questions'] = questions
    if payload.get('kind') == 'plan':
        plan = str(payload.get('plan') or '')
        if not plan.strip() or len(plan) > 32000:
            raise ValueError('invalid_plan')
        pending.update(kind='plan', tool='ExitPlanMode', plan=plan)
    if payload.get('kind') == 'permission' and str(payload.get('tool') or '').strip():
        pending.update(kind='permission', tool=str(payload['tool']).strip()[:64])
        if str(payload.get('prefix') or '').strip():
            pending['prefix'] = str(payload['prefix']).strip()[:160]
        if payload.get('harnessPermission') is True and isinstance(payload.get('action'), Mapping):
            pending['action'] = dict(payload['action'])
            pending['harnessPermission'] = True
            pending['actionPreview'] = str(payload.get('actionPreview') or '')
    if payload.get('requestId'):
        pending['requestId'] = str(payload['requestId'])
    return pending


def normalize_input_response(pending: Mapping[str, Any], response: Any) -> dict[str, Any]:
    if not isinstance(response, Mapping):
        raise ValueError('invalid_input_response')
    if pending.get('kind') in {'permission', 'plan'}:
        decision = response.get('decision')
        if decision not in {'once', 'grant', 'deny'}:
            raise ValueError('invalid_permission_decision')
        return {'decision': decision}
    questions = pending.get('questions') or [{'question': pending['question'], 'multiSelect': False}]
    answers = response.get('answers')
    if not isinstance(answers, Mapping) or set(answers) != {item['question'] for item in questions}:
        raise ValueError('answers_must_match_pending_questions')
    normalized: dict[str, Any] = {}
    skipped = []
    for question in questions:
        value = answers[question['question']]
        if question.get('multiSelect'):
            if not isinstance(value, list) or len(value) > 5:
                raise ValueError('multi_select_requires_answer_list')
            values = value
        else:
            if not isinstance(value, str):
                raise ValueError('single_select_requires_text')
            values = [value]
        if value in ([], ''):
            skipped.append(question['question'])
            normalized[question['question']] = value
            continue
        if any(not isinstance(item, str) or not item.strip() or len(item) > 4000 for item in values):
            raise ValueError('answer_must_contain_1_4000_characters')
        normalized[question['question']] = list(dict.fromkeys(item.strip() for item in values)) if question.get('multiSelect') else value.strip()
    return {'answers': normalized, **({'skippedQuestions': skipped} if skipped else {})}


def permission_rule(pending: Mapping[str, Any]) -> str:
    tool = str(pending.get('tool') or '').strip()
    prefix = str(pending.get('prefix') or '').strip()
    return f'{tool}({prefix})' if prefix else tool
