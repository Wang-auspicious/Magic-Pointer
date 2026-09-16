const { spawn } = require('child_process');
const t0 = Date.now();
const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/pointer_input_state.ps1'], { cwd: process.cwd(), windowsHide: true });
let buf = '';
const gaps = [];
let prev = null;
let n = 0;
const start = process.hrtime.bigint();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/);
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const now = Number(process.hrtime.bigint() - start) / 1e6;
    if (prev !== null) gaps.push(now - prev);
    prev = now;
    n++;
  }
});
setTimeout(() => {
  child.kill();
  if (gaps.length) {
    const sorted = [...gaps].sort((a,b)=>a-b);
    const pct = (p) => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))];
    console.log('samples=' + n + ' over ' + (Date.now()-t0) + 'ms');
    console.log('gap p50=' + pct(0.5).toFixed(1) + ' p90=' + pct(0.9).toFixed(1) + ' p99=' + pct(0.99).toFixed(1) + ' max=' + sorted[sorted.length-1].toFixed(1));
    console.log('effective_hz=' + (1000/(gaps.reduce((a,b)=>a+b,0)/gaps.length)).toFixed(1));
  } else console.log('samples=' + n + ' (no gaps)');
  process.exit(0);
}, 8000);
