const { spawn } = require('child_process');
const t0 = Date.now();
const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/pointer_input_state.ps1'], { cwd: process.cwd(), windowsHide: true });
let buf = '', first = null, n = 0;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split(/\r?\n/); buf = lines.pop() || '';
  for (const line of lines) { if (!line.trim()) continue; n++; if (first === null) first = Date.now() - t0; }
});
setTimeout(() => { child.kill(); console.log('first_line_ms=' + first + '  lines=' + n + '  elapsed=' + (Date.now()-t0)); process.exit(0); }, 7000);
