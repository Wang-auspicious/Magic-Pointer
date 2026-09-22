import subprocess
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest

from app.agent_runtime import coding_tools as coding
from app.agent_runtime.apply_patch import apply_patch_text
from app.agent_runtime.tool_registry import Effect, ToolRegistry


def registry(root, **kwargs):
    result = ToolRegistry()
    coding.register_coding_tools(result, workspace_root=root, **kwargs)
    return result


def test_independent_agents_receive_file_contents(tmp_path):
    (tmp_path / 'a.txt').write_text('ORIGINAL')
    first, second = registry(tmp_path), registry(tmp_path)
    assert 'ORIGINAL' in first.execute_tool('Read', {'path': 'a.txt'}).value
    assert 'ORIGINAL' in second.execute_tool('Read', {'path': 'a.txt'}).value


def test_checkpoint_handles_do_not_overwrite_backup(tmp_path):
    path = tmp_path / 'a.txt'
    one, two = coding.FileCheckpointStore(tmp_path), coding.FileCheckpointStore(tmp_path)
    path.write_text('ORIGINAL')
    one.record(path, existed=True)
    path.write_text('SECOND')
    two.record(path, existed=True)
    path.write_text('THIRD')
    one.restore()
    assert path.read_text() == 'ORIGINAL'


def test_rewind_is_owned_by_task(tmp_path):
    first, second = registry(tmp_path), registry(tmp_path)
    assert not first.execute_tool('Write', {'path': 'a.txt', 'content': 'completed task'}).is_error
    second.execute_tool('Rewind', {})
    assert (tmp_path / 'a.txt').read_text() == 'completed task'


def test_failed_patch_does_not_consume_rewind_step(tmp_path):
    (tmp_path / 'a.txt').write_text('old\n')
    (tmp_path / 'b.txt').write_text('before\n')
    tools = registry(tmp_path)
    tools.execute_tool('Read', {'path': 'a.txt'})
    tools.execute_tool('Edit', {'path': 'a.txt', 'old_string': 'old', 'new_string': 'changed'})
    patch = '*** Begin Patch\n*** Update File: b.txt\n@@\n-missing\n+after\n*** End Patch'
    assert tools.execute_tool('Patch', {'patch': patch}).is_error
    tools.execute_tool('Rewind', {'steps': 1})
    assert (tmp_path / 'a.txt').read_text() == 'old\n'


def test_patch_prepares_all_targets_before_writing(tmp_path):
    (tmp_path / 'a.txt').write_text('old\n')
    (tmp_path / 'b.txt').write_text('before\n')
    patch = ('*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+changed\n'
             '*** Update File: b.txt\n@@\n-missing\n+after\n*** End Patch')
    assert registry(tmp_path).execute_tool('Patch', {'patch': patch}).is_error
    assert (tmp_path / 'a.txt').read_text() == 'old\n'


def test_patch_move_and_crlf_preservation(tmp_path):
    (tmp_path / 'a.txt').write_bytes(b'first\r\nsecond\r\n')
    patch = ('*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n'
             '@@\n-second\n+changed\n*** End Patch')
    apply_patch_text(patch, tmp_path)
    assert not (tmp_path / 'a.txt').exists()
    assert (tmp_path / 'b.txt').read_bytes() == b'first\r\nchanged\r\n'


@pytest.mark.parametrize('command', ['echo hello > a.txt', 'echo hello\npython change.py',
    'git branch -D work', 'git config user.name MP', 'git tag v1', 'git remote add origin URL',
    'find . -delete', 'date 2026-01-01', 'rg --pre change.py hello'])
def test_mutating_shell_forms_are_not_read(command):
    assert coding._classify_command_effect({'command': command}) is not Effect.READ


@pytest.mark.parametrize('command', ['git status --short', 'git branch --list', 'git config --get user.name',
    'git remote -v', 'git tag --list', 'rg needle app', 'echo hello'])
def test_read_shell_forms_remain_read(command):
    assert coding._classify_command_effect({'command': command}) is Effect.READ


def test_quoted_cd_and_conditional_cd(tmp_path):
    (tmp_path / 'My Folder').mkdir()
    space = coding.WorkspaceSpace(tmp_path)
    assert coding._resolve_cd_target('cd "My Folder"', tmp_path, space) == tmp_path / 'My Folder'
    assert coding._resolve_cd_target('false && cd "My Folder"', tmp_path, space) is None


def test_failed_shell_command_is_error(monkeypatch, tmp_path):
    monkeypatch.setattr(coding, '_run_shell', lambda *a, **k: subprocess.CompletedProcess(a, 2, '', 'build failed'))
    result = registry(tmp_path).execute_tool('Bash', {'command': 'build'})
    assert result.is_error
    assert 'exit=2' in result.error_message and 'build failed' in result.error_message


def test_long_line_is_fully_reachable(tmp_path):
    content = 'x' * 60000 + 'TAIL'
    (tmp_path / 'long.json').write_text(content)
    tools = registry(tmp_path)
    first = tools.execute_tool('Read', {'path': 'long.json', 'char_offset': 0, 'char_limit': 10000})
    assert not first.is_error
    tail = tools.execute_tool('Read', {'path': 'long.json', 'char_offset': 60000, 'char_limit': 10000})
    assert 'TAIL' in tail.value
    assert 'nextCharOffset' in first.value


def test_character_page_does_not_mark_unseen_line_range_as_read(tmp_path):
    (tmp_path / 'file.txt').write_text('one\ntwo\nthree')
    tools = registry(tmp_path)
    tools.execute_tool('Read', {'path': 'file.txt', 'char_offset': 0, 'char_limit': 3})
    later = tools.execute_tool('Read', {'path': 'file.txt'})
    assert 'three' in later.value
