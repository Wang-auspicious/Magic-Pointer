const { spawn } = require('child_process');
const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','scripts/pointer_input_state.ps1'], { cwd: process.cwd(), windowsHide: true });
const KEYS = ['buttons','foregroundApp','foregroundHwnd','foregroundProcessId','isWindowMoving','scrollDelta','swallowingLeft','captureArmed'];
let buf = '', n = 0, bad = 0, last = null;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c; const lines = buf.split(/\r?\n/); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    n++;
    let o; try { o = JSON.parse(line); } catch (e) { bad++; console.log('BADJSON:', line.slice(0,200)); continue; }
    const k = Object.keys(o);
    if (k.join(',') !== KEYS.join(',')) { bad++; console.log('BADKEYS:', k.join(',')); }
    if (typeof o.buttons !== 'number' || typeof o.foregroundApp !== 'string' || typeof o.foregroundHwnd !== 'number' || typeof o.foregroundProcessId !== 'number' || typeof o.isWindowMoving !== 'boolean' || typeof o.scrollDelta !== 'number' || typeof o.swallowingLeft !== 'boolean' || typeof o.captureArmed !== 'boolean') { bad++; console.log('BADTYPES:', line.slice(0,200)); }
    last = o;
  }
});
setTimeout(() => { child.kill(); console.log('lines=' + n + ' malformed=' + bad); console.log('sample=' + JSON.stringify(last)); process.exit(bad ? 1 : 0); }, 4000);
