import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(__dirname, '..');

test('LearnLab compiles mathematical expressions safely via pure AST with zero eval or new Function', () => {
  const labSrc = fs.readFileSync(
    path.join(ROOT, 'electron', 'renderer', 'learn_lab.ts'),
    'utf8',
  );
  assert.doesNotMatch(labSrc, /\beval\s*\(|new\s+Function\b/);

  const LearnLab = require('../electron/renderer/learn_lab');
  assert.equal(typeof LearnLab.evaluateExpression, 'function');
  assert.equal(typeof LearnLab.renderSvgMarkup, 'function');

  const quad = LearnLab.evaluateExpression('a * x^2 - b * x + 1', {
    a: 2,
    b: 3,
    x: 4,
  });
  assert.equal(quad, 2 * 16 - 3 * 4 + 1);

  const ratio = LearnLab.evaluateExpression(
    '(l12 - l22) * p2 / ((l21 - l11) * p1)',
    {l12: 1, l22: 0, l21: 3, l11: 0, p1: 0.5, p2: 0.5, x: 0},
  );
  assert.ok(Math.abs(ratio - 1 / 3) < 1e-9);

  const trig = LearnLab.evaluateExpression('exp(-x) * cos(pi * x) + abs(-2)', {
    x: 0,
  });
  assert.ok(Math.abs(trig - 3) < 1e-9);
});

test('LearnLab SVG curve geometry responds deterministically to parameter slider updates', () => {
  const LearnLab = require('../electron/renderer/learn_lab');
  const spec = {
    title: 'Bayes Decision Boundary',
    caption: 'Drag cost l21 to shift posterior threshold',
    xLabel: 'x',
    yLabel: 'Risk',
    xRange: [-2, 2],
    params: [
      {name: 'l21', label: 'Cost l21', min: 1, max: 5, step: 0.5, value: 1},
    ],
    curves: [
      {label: 'R(a1|x)', expr: 'l21 * (0.5 + 0.2 * x)', color: 'clay'},
      {label: 'R(a2|x)', expr: '1 - 0.2 * x', color: 'ink'},
    ],
  };

  const svgDefault = LearnLab.renderSvgMarkup(spec, {l21: 1});
  const svgShifted = LearnLab.renderSvgMarkup(spec, {l21: 4});
  assert.match(svgDefault, /<svg\b[^>]*viewBox="0 0 460 190"/);
  assert.match(svgDefault, /class="mp-learn-lab-curve/);
  assert.notEqual(svgDefault, svgShifted);
});

test('ChatMarkdown renders :::prereq, streaming-safe :::lab, and fade-ready marks with aligned block indices', () => {
  const ChatMarkdown = require('../electron/renderer/chat_markdown');
  const html = ChatMarkdown.render([
    ':::prereq',
    '先验分布 -> 后验概率 -> 最小风险准则',
    ':::',
    '',
    ':::card [concept] 最小条件风险',
    '==选择期望损失最小的动作== 是 [[Bayes 最优准则|全局风险下界保障]]。',
    ':::',
    '',
    ':::lab',
    '{"title":"Threshold","xRange":[-2,2],"params":[{"name":"k","label":"k","min":1,"max":5,"step":1,"value":2}],"curves":[{"label":"y","expr":"k*x"}]}',
    ':::',
  ].join('\n')).outerHTML;

  assert.match(html, /class="mp-learn-prereq-strip"[^>]*data-block-index="0"/);
  assert.match(html, /class="mp-learn-prereq-chip"[^>]*data-mp-learn-anchor="term"/);
  assert.match(html, /data-fade-target="true"/);
  assert.match(html, /class="mp-learn-lab-host"[^>]*data-block-index="2"/);
  assert.match(html, /data-learn-lab-complete="true"/);

  // Incomplete streaming :::lab must not throw
  const partialHtml = ChatMarkdown.render(
    ':::lab\n{"title":"Streaming Lab"',
  ).outerHTML;
  assert.match(partialHtml, /data-learn-lab-complete="false"/);
});
