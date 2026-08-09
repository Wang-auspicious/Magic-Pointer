'use strict';

// 引导小三角的贝塞尔飞行轨迹（Clicky 式指点）。
// 从光标旁沿二次贝塞尔弧线飞向 [POINT] 目标：起点和终点是给定的，
// 控制点在连线中点上方，所以轨迹是一条「先上挑再落下」的弧线。

const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert');

const source = fs.readFileSync('electron/renderer/overlay.ts', 'utf8');
// 从源码里抽出纯函数（overlay.js 是浏览器脚本，顶层不导出）
const match = source.match(/function guideFlightPoint[\s\S]*?\n}/);
if (!match) throw new Error('guideFlightPoint not found in overlay.js');
const sandbox = {};
vm.createContext(sandbox);
const fn = vm.runInContext(`(${match[0]})`, sandbox);

function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}

const from = { x: 100, y: 100 };
const to = { x: 400, y: 300 };
const ctrl = { x: 250, y: 90 }; // 中点上方的控制点 → 上挑弧线

// t=0 在起点，t=1 在终点
const p0 = fn(from, ctrl, to, 0);
const p1 = fn(from, ctrl, to, 1);
assert(near(p0.x, from.x) && near(p0.y, from.y), 't=0 必须落在起点');
assert(near(p1.x, to.x) && near(p1.y, to.y), 't=1 必须落在终点');

// 中间点比「直线中点」高（弧线上挑）——起点终点是 100→300，直线中点 200，
// 弧线中点必须显著低于它（y 越小越高）
const linearMidY = (from.y + to.y) / 2;
const pm = fn(from, ctrl, to, 0.5);
assert(pm.y < linearMidY - 30, `弧线中点应明显上挑：y=${pm.y} 直线中点=${linearMidY}`);

// 中点严格在连线的弧线一侧（x 在起点终点之间）
assert(pm.x > from.x && pm.x < to.x, '弧线中点 x 应在起点终点之间');

// t 单调推进时离终点单调变近
const d1 = dist(fn(from, ctrl, to, 0.25), to);
const d2 = dist(fn(from, ctrl, to, 0.75), to);
assert(d1 > d2, '越靠近 t=1 越接近终点');

// 无控制点（直线）时中点就是两端中点
const straight = fn({ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, 0.5);
assert(near(straight.x, 50) && near(straight.y, 50), '控制点在连线中点时退化为直线');

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

console.log('guide flight test ok');
