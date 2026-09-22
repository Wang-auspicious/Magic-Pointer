from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def test_unusable_system_temp_fallback_isolates_real_pytest_processes():
    root = Path(__file__).resolve().parents[1]
    parent = root / '.pytest-tmp'
    parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='isolation-probe-', dir=parent) as directory:
        control = Path(directory)
        test_file = control / 'child_test.py'
        test_file.write_text('''import os, time
from pathlib import Path
def test_live_fixture(tmp_path):
    control = Path(os.environ['MP_TEST_TEMP_CONTROL'])
    assert tmp_path.parent.parent == control.parent, 'probe must exercise repository fallback'
    marker = tmp_path / (os.environ['MP_TEST_TEMP_ROLE'] + '.txt')
    marker.write_text('must survive another pytest session')
    if os.environ['MP_TEST_TEMP_ROLE'] == 'first':
        (control / 'ready').write_text(str(tmp_path))
        deadline = time.monotonic() + 30
        while not (control / 'release').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists(), 'a second pytest session deleted a live fixture'
''', encoding='utf-8')
        bootstrap = control / 'run.py'
        bootstrap.write_text('''import ast, os, pathlib, sys, tempfile
import pytest
root = pathlib.Path(sys.argv[1])
tree = ast.parse((root / 'conftest.py').read_text(encoding='utf-8'))
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'pytest_configure')
namespace = {'_ROOT': root, '_is_unusable': lambda path: True,
    '_default_basetemp_root': lambda: root, 'os': os, 'tempfile': tempfile}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(root / 'conftest.py'), 'exec'), namespace)
class Configure:
    @pytest.hookimpl(tryfirst=True)
    def pytest_configure(self, config):
        config.option.basetemp = None
        namespace['pytest_configure'](config)
raise SystemExit(pytest.main([sys.argv[2], '-q', '-p', 'no:cacheprovider'], plugins=[Configure()]))
''', encoding='utf-8')
        command = [sys.executable, str(bootstrap), str(root), str(test_file)]
        environment = {**os.environ, 'MP_TEST_TEMP_CONTROL': str(control), 'MP_TEST_TEMP_ROLE': 'first'}
        first = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
        try:
            deadline = time.monotonic() + 30
            while not (control / 'ready').exists() and first.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            assert (control / 'ready').exists(), 'first pytest did not create its fixture'
            second = subprocess.run(command, cwd=root, env={**environment, 'MP_TEST_TEMP_ROLE': 'second'},
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', timeout=30, check=False)
            assert second.returncode == 0, second.stdout
            (control / 'release').touch()
            output, _ = first.communicate(timeout=30)
            assert first.returncode == 0, output
        finally:
            if first.poll() is None:
                first.kill()
                first.communicate(timeout=10)
