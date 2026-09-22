'use strict';

const assert = require('node:assert');

const ChatHighlight = require('../electron/renderer/chat_highlight');

const TOKENS = [
  'plain', 'keyword', 'string', 'number', 'command', 'variable', 'comment', 'operator',
];
const SEEN = new Set();

const stripCR = (code) =>
  code.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

const check = (code, lang) => {
  const result = ChatHighlight.highlight(code, lang);
  const expected = stripCR(code);
  assert.strictEqual(result.length, expected.length,
    `one entry per line for ${JSON.stringify(code)}`);
  result.forEach((spans, index) => {
    assert.ok(Array.isArray(spans) && spans.length > 0, 'a line always yields at least one span');
    assert.ok(spans.every((span) => typeof span.text === 'string'), 'span text is a string');
    for (const span of spans) {
      assert.ok(TOKENS.includes(span.token), `unknown token ${span.token}`);
      SEEN.add(span.token);
    }
    assert.strictEqual(spans.map((span) => span.text).join(''), expected[index],
      `round trip of ${JSON.stringify(expected[index])}`);
  });
  return result;
};

const words = (code, lang) => {
  const out = [];
  for (const span of ChatHighlight.highlight(code, lang)[0]) {
    for (const piece of span.text.split(/\s+/)) {
      if (piece !== '') out.push([piece, span.token]);
    }
  }
  return out;
};

const tokenFor = (code, lang, text) => {
  const found = ChatHighlight.highlight(code, lang)[0].find((span) => span.text === text);
  assert.ok(found, `${JSON.stringify(text)} must survive as its own span in ${JSON.stringify(code)}`);
  return found.token;
};


const CORPUS = [
  ['', 'powershell'],
  ['', 'shell'],
  ['', 'plain'],
  [' ', 'shell'],
  ['\n', 'shell'],
  ['\n\n\n', 'powershell'],
  ['Write-Host "hello"', 'powershell'],
  ["Select-String 'it''s here'", 'powershell'],
  ['Get-ChildItem -Path C:\\tmp -Recurse', 'powershell'],
  ['$env:PATH = "C:\\bin"; Start-Sleep -Seconds 3.5 # wait', 'powershell'],
  ['if ($x -gt 5) { Write-Host $x } else { throw "no" }', 'powershell'],
  ['Invoke-WebRequest -Uri https://example.com -ErrorAction Stop', 'powershell'],
  ['foreach ($f in Get-ChildItem) { $f.Name }', 'powershell'],
  ['\t$name\t= 0x1f\n', 'powershell'],
  ['Write-Host "unterminated', 'powershell'],
  ['# 中文注释', 'powershell'],
  ['if [ -f x ]; then echo ok; fi', 'shell'],
  ['export PATH=$PATH:/opt/bin', 'shell'],
  ['FOO=bar ls -la | grep -i "x" | wc -l', 'shell'],
  ['curl -s https://x/y?a=1&b=2', 'shell'],
  ['echo ${VAR} $1 $# $?', 'shell'],
  ['npm install -g tsx && npm test', 'shell'],
  ['echo "a\\"b" \'c\\\'d\'', 'shell'],
  ['for f in *; do echo "$f"; done', 'shell'],
  ['case $x in a) echo 1;; esac', 'shell'],
  ['echo hi # trailing note', 'shell'],
  ['foo#bar', 'shell'],
  ['git commit -m "中文提交"', 'shell'],
  ['ls |\n  grep x |\n  wc -l', 'shell'],
  ['{ unterminated block', 'shell'],
  ['x = = = "unterminated ( [ {', 'plain'],
  ['anything at all', 'unknown-language'],
  ['', 'unknown-language'],
  ['', undefined],
];

for (const [code, lang] of CORPUS) check(code, lang);

const crlf = check('Write-Host hi\r\necho ok\r\n', 'powershell');
assert.deepStrictEqual(crlf.length, 3);
assert.deepStrictEqual(crlf[0].map((span) => span.text).join(''), 'Write-Host hi');
assert.ok(crlf.every((spans) => spans.every((span) => !span.text.includes('\r'))));

assert.deepStrictEqual(
  ChatHighlight.highlight('a\rb', 'shell')[0].map((span) => span.text).join(''), 'a\rb');


assert.deepStrictEqual(words('if ($x) { }', 'powershell'),
  [['if', 'keyword'], ['(', 'operator'], ['$x', 'variable'], [')', 'operator'],
    ['{', 'operator'], ['}', 'operator']]);

for (const [code, keyword] of [
  ['elseif ($x) { }', 'elseif'],
  ['} else {', 'else'],
  ['try { } catch { } finally { }', 'try'],
  ['param($a)', 'param'],
  ['foreach ($f in $list) { }', 'foreach'],
  ['while ($true) { }', 'while'],
  ['switch ($x) { }', 'switch'],
  ['class Foo { }', 'class'],
  ['enum Color { Red }', 'enum'],
  ['begin { }', 'begin'],
  ['return $x', 'return'],
  ['throw "no"', 'throw'],
]) {
  check(code, 'powershell');
  assert.strictEqual(tokenFor(code, 'powershell', keyword), 'keyword', keyword);
}

assert.deepStrictEqual(words('if [ -f x ]; then echo ok; fi', 'shell'),
  [['if', 'keyword'], ['[', 'operator'], ['-f', 'command'], ['x', 'plain'], ['];', 'operator'],
    ['then', 'keyword'], ['echo', 'command'], ['ok', 'plain'],
    [';', 'operator'], ['fi', 'keyword']]);

for (const keyword of ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case',
  'esac', 'function']) {
  const code = `x; ${keyword} y`;
  check(code, 'shell');
  assert.strictEqual(tokenFor(code, 'shell', keyword), 'keyword', keyword);
}


assert.deepStrictEqual(words('export PATH=$PATH:/opt', 'shell'),
  [['export', 'command'], ['PATH', 'plain'], ['=', 'operator'], ['$PATH', 'variable'],
    [':', 'operator'], ['/opt', 'plain']]);
assert.strictEqual(tokenFor('local x=1', 'shell', 'local'), 'command');
assert.strictEqual(tokenFor('if ls; then local x=1; fi', 'shell', 'local'), 'command');
assert.strictEqual(tokenFor('x; fi', 'shell', 'fi'), 'keyword');
assert.deepStrictEqual(words('echo fi', 'shell'), [['echo', 'command'], ['fi', 'plain']]);
assert.deepStrictEqual(words('Write-Host hi', 'powershell'),
  [['Write-Host', 'command'], ['hi', 'plain']]);
assert.strictEqual(tokenFor('$x = Get-Item', 'powershell', 'Get-Item'), 'command');
assert.strictEqual(tokenFor('Write-Host hi -NoNewline', 'powershell', 'Write-Host'), 'command');
assert.strictEqual(tokenFor('Write-Host hi -NoNewline', 'powershell', 'hi'), 'command');


assert.strictEqual(tokenFor('Write-Host "hello world"', 'powershell', '"hello world"'), 'string');
assert.strictEqual(tokenFor("Write-Host 'hello world'", 'powershell', "'hello world'"), 'string');
assert.strictEqual(tokenFor('Write-Host "a\\"b"', 'powershell', '"a\\"b"'), 'string');
assert.strictEqual(tokenFor("Select-String 'a\\'b'", 'powershell', "'a\\'b'"), 'string');
assert.deepStrictEqual(
  ChatHighlight.highlight('Write-Host "never closed', 'powershell')[0].slice(2),
  [{ text: '"never closed', token: 'string' }]);
assert.deepStrictEqual(ChatHighlight.highlight('echo "a b" c', 'shell'),
  [[{ text: 'echo', token: 'command' }, { text: ' ', token: 'plain' },
    { text: '"a b"', token: 'string' }, { text: ' c', token: 'plain' }]]);


for (const literal of ['7000', '40', '3.5', '0x1f', '0X1F', '0']) {
  const code = `Start-Sleep -Seconds ${literal}`;
  check(code, 'powershell');
  assert.strictEqual(tokenFor(code, 'powershell', literal), 'number', literal);
}
assert.deepStrictEqual(words('echo 40 - 3', 'shell'),
  [['echo', 'command'], ['40', 'number'], ['-', 'operator'], ['3', 'number']]);
assert.deepStrictEqual(words('sleep .5', 'shell'), [['sleep', 'command'], ['.5', 'number']]);


for (const code of ['Get-ChildItem', 'Set-Content x', 'Invoke-WebRequest -Uri u', 'Write-Host hi']) {
  const first = code.split(' ')[0];
  assert.strictEqual(tokenFor(code, 'powershell', first), 'command', first);
}
for (const code of ['ls', 'cd /tmp', 'git status', 'npm test', 'curl -s x']) {
  const first = code.split(' ')[0];
  assert.strictEqual(tokenFor(code, 'shell', first), 'command', first);
}
assert.strictEqual(tokenFor('Get-ChildItem -Recurse', 'powershell', '-Recurse'), 'command');
assert.strictEqual(tokenFor('Get-ChildItem --Path', 'powershell', '--Path'), 'command');
assert.strictEqual(tokenFor('ls -la', 'shell', '-la'), 'command');
assert.strictEqual(tokenFor('$x -ErrorAction Stop', 'powershell', '-ErrorAction'), 'command');


assert.strictEqual(tokenFor('Write-Host $env:PATH', 'powershell', '$env:PATH'), 'variable');
assert.strictEqual(tokenFor('Write-Host $name', 'powershell', '$name'), 'variable');
assert.strictEqual(tokenFor('echo $VAR', 'shell', '$VAR'), 'variable');
assert.strictEqual(tokenFor('echo ${VAR}', 'shell', '${VAR}'), 'variable');
assert.strictEqual(tokenFor('echo $1 $? $#', 'shell', '$1'), 'variable');
assert.deepStrictEqual(
  ChatHighlight.highlight('echo $', 'shell')[0].map((span) => span.text).join(''), 'echo $');


assert.deepStrictEqual(ChatHighlight.highlight('# a note', 'powershell'),
  [[{ text: '# a note', token: 'comment' }]]);
assert.deepStrictEqual(ChatHighlight.highlight('echo hi # a note', 'shell'),
  [[{ text: 'echo', token: 'command' }, { text: ' hi ', token: 'plain' },
    { text: '# a note', token: 'comment' }]]);
assert.deepStrictEqual(words('foo#bar', 'shell'), [['foo', 'command'], ['#bar', 'plain']]);
assert.deepStrictEqual(words('echo#x', 'shell'), [['echo', 'command'], ['#x', 'plain']]);


for (const operator of ['=', '+', '-', '*', '/', '|', '>', '<', '!', '?', ':', ',', ';', '(',
  ')', '{', '}', '[', ']']) {
  const code = `x ${operator} y`;
  check(code, 'shell');
  assert.strictEqual(tokenFor(code, 'shell', operator), 'operator', operator);
}
assert.deepStrictEqual(words('-lt x', 'powershell'), [['-lt', 'command'], ['x', 'plain']]);


assert.deepStrictEqual(ChatHighlight.highlight('echo 中文 # 中文注释', 'shell'),
  [[{ text: 'echo', token: 'command' }, { text: ' 中文 ', token: 'plain' },
    { text: '# 中文注释', token: 'comment' }]]);
assert.deepStrictEqual(
  ChatHighlight.highlight('# 中文注释', 'powershell'),
  [[{ text: '# 中文注释', token: 'comment' }]]);
check('Write-Host "中文"', 'powershell');


for (const lang of ['plain', 'python', '', 'POWERSHELL2', undefined, null]) {
  const code = 'if ($x) { "not highlighted" } # nope';
  const result = check(code, lang);
  assert.deepStrictEqual(result, [[{ text: code, token: 'plain' }]], `${lang} degrades to plain`);
}
assert.deepStrictEqual(ChatHighlight.highlight('a\nb', 'plain'),
  [[{ text: 'a', token: 'plain' }], [{ text: 'b', token: 'plain' }]]);


assert.doesNotThrow(() => ChatHighlight.highlight(undefined, 'shell'));
assert.doesNotThrow(() => ChatHighlight.highlight(null, 'powershell'));
assert.deepStrictEqual(ChatHighlight.highlight(undefined, 'shell'),
  [[{ text: '', token: 'plain' }]]);
assert.deepStrictEqual(ChatHighlight.highlight(42, 'shell'), [[{ text: '42', token: 'number' }]]);
assert.doesNotThrow(() => ChatHighlight.langFor(undefined, undefined));
assert.strictEqual(ChatHighlight.langFor(undefined, undefined), 'plain');


const LANG_CASES = [
  [['pwsh', ''], 'powershell'],
  [['pwsh', 'ls'], 'powershell'],
  [['PowerShell', 'Get-ChildItem'], 'powershell'],
  [['run_command', 'Invoke-WebRequest -Uri https://x'], 'powershell'],
  [['run_command', 'Write-Host hi'], 'powershell'],
  [['run_command', 'echo $env:PATH'], 'powershell'],
  [['run_command', 'Get-ChildItem'], 'powershell'],
  [['run_command', 'Set-Item x'], 'powershell'],
  [['run_command', 'thing -ErrorAction Stop'], 'powershell'],
  [['bash', 'ls -la'], 'shell'],
  [['sh', 'ls'], 'shell'],
  [['shell', 'ls'], 'shell'],
  [['Bash', 'echo ok'], 'shell'],
  [['read_file', 'notes.md'], 'plain'],
  [['', ''], 'plain'],
  [['run_command', 'echo hello'], 'plain'],
  [['bash', 'Write-Host hi'], 'powershell'],
];
for (const [[toolName, command], expected] of LANG_CASES) {
  assert.strictEqual(ChatHighlight.langFor(toolName, command), expected,
    `${toolName} / ${command}`);
}
assert.strictEqual(ChatHighlight.langFor('run_command', 'git log --no-merges target-x'), 'plain');


const time = (label, code, lang) => {
  const started = process.hrtime.bigint();
  const result = ChatHighlight.highlight(code, lang);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.strictEqual(result.map((spans) => spans.map((span) => span.text).join('')).join('\n'), code,
    `${label} round trip`);
  assert.ok(elapsedMs < 1000, `${label} took ${elapsedMs.toFixed(1)}ms`);
  return elapsedMs;
};

const repeated = 'Write-Host "hi" -ForegroundColor Red -ErrorAction Stop; Get-Item $env:PATH | ';
const longMixed = repeated.repeat(Math.ceil(200000 / repeated.length));
assert.ok(longMixed.length >= 200000);
const longWord = 'a'.repeat(200000);
const longString = `"${'b'.repeat(200000)}`;
const longComment = `# ${'c'.repeat(200000)}`;
const longNumbers = '7000 '.repeat(40000);
const longOperators = '+'.repeat(200000);

time('200k mixed', longMixed, 'powershell');
time('200k single word', longWord, 'powershell');
time('200k string', longString, 'powershell');
time('200k comment', longComment, 'shell');
time('200k numbers', longNumbers, 'shell');
time('200k operators', longOperators, 'shell');
time('200k plain', longMixed, 'plain');


const ALPHABET = [
  'if', 'then', '$x', '$env:PATH', '-Flag', '"q"', "'s'", '#c', 'a', 'B', '7', '3.5', '0x1f',
  '=', '+', '-', '*', '/', '|', '>', '<', '!', '?', ':', ',', ';', '(', ')', '{', '}', '[', ']',
  ' ', '\t', '中', '文', '\\', '.', '`', '&', '@', '%', '_', '\n', '\r', 'Get-Item', 'ls', 'e$',
];
let seed = 20240917;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (let round = 0; round < 400; round += 1) {
  let code = '';
  const pieces = Math.floor(random() * 24);
  for (let piece = 0; piece < pieces; piece += 1) {
    code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  for (const lang of ['powershell', 'shell', 'plain', 'nope']) check(code, lang);
}

assert.deepStrictEqual([...SEEN].sort(), [...TOKENS].sort());

console.log('chat highlight test ok');
