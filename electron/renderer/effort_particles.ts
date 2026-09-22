'use strict';

(() => {
  function mount(canvas: HTMLCanvasElement) {
    let frame = 0;
    let disposed = false;
    let lit = false;
    let initialized = false;
    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    let time = 0, previous = 0, envelope = 0, held = 0, lastBurst = -1, slot = 0;
    const times = new Float32Array(8).fill(-1000);
    const centers = new Float32Array(16);
    const gains = new Float32Array(8);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    const location = (name: string) => {
      if (!uniforms.has(name)) uniforms.set(name, gl!.getUniformLocation(program!, name));
      return uniforms.get(name)!;
    };
    const scalar = (name: string, value: number) => gl!.uniform1f(location(name), value);
    const rgba = (name: string, value: number[]) => gl!.uniform4fv(location(name), value);
    const colour = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const paint = (now: number) => {
      frame = 0;
      if (disposed || !gl || !program) return;
      const visible = canvas.getClientRects().length > 0 && !document.hidden;
      const active = lit && visible && !reduced.matches;
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) : 0;
      previous = now;
      time += delta;
      envelope = active ? Math.min(1, envelope + delta / 0.7) : Math.max(0, envelope - delta / 0.85);
      held = active ? held + delta : 0;
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(location('u_resolution'), width, height);
      const dark = getComputedStyle(canvas).colorScheme.includes('dark');
      gl.uniform3fv(location('u_fg'), colour(dark ? '#b897ff' : '#fbedf1'));
      gl.uniform3fv(location('u_fg2'), colour(dark ? '#ffffff' : '#c6c0f3'));
      rgba('u_charge0', [...(dark ? [0.62, 0.5, 0.92] : colour('#888edd')), 1]);
      rgba('u_charge1', [...(dark ? [0.35, 0.25, 0.6] : colour('#8964c4')), 1]);
      rgba('u_tintA', dark ? [0, 0, 0, 0] : [191 / 255, 214 / 255, 243 / 255, 0.28]);
      rgba('u_tintB', dark ? [0, 0, 0, 0] : [240 / 255, 188 / 255, 204 / 255, 0.28]);
      for (const [name, value] of Object.entries({
        u_bedFill: dark ? 0 : 1, u_chargeMax: dark ? 0.85 : 0.92,
        u_chargeRamp: dark ? 1.1 : 0.5, u_inkFloor: dark ? 0.08 : 0.28,
        u_inkCeil: dark ? 0.85 : 1, u_energyGain: dark ? 1 : 1.18,
        u_pos: 1, u_time: time, u_fade: visible && !reduced.matches ? envelope * envelope * (3 - 2 * envelope) : 0,
      })) scalar(name, value);
      if (active && time - lastBurst > 0.45) {
        times[slot] = time;
        centers[slot * 2] = (1 + (Math.random() - 0.5) * 0.08) * width;
        centers[slot * 2 + 1] = height * (0.35 + Math.random() * 0.3);
        gains[slot] = 0.85 * (0.45 + 0.55 * Math.min(held / 1.6, 1)) * (0.85 + Math.random() * 0.3);
        slot = (slot + 1) % 8;
        lastBurst = time;
      }
      gl.uniform1fv(location('u_burstTime[0]'), times);
      gl.uniform2fv(location('u_burstCenter[0]'), centers);
      gl.uniform1fv(location('u_burstGain[0]'), gains);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (visible && !reduced.matches && (active || envelope > 0)) frame = requestAnimationFrame(paint);
      else previous = 0;
    };
    const initialize = () => {
      if (disposed || initialized) return;
      initialized = true;
      const shaders = (globalThis as { EffortShaders?: { vertex: string; fragment: string } }).EffortShaders;
      if (!shaders) return;
      gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
      if (!gl) return;
      program = gl.createProgram();
      if (!program) return;
      for (const [type, source] of [[gl.VERTEX_SHADER, shaders.vertex], [gl.FRAGMENT_SHADER, shaders.fragment]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
      gl.useProgram(program);
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      scalar('u_seed', Math.random() * 512);
      gl.clearColor(0, 0, 0, 0);
      frame = requestAnimationFrame(paint);
    };
    const setMax = (value: boolean) => {
      lit = value;
      if (disposed || reduced.matches) return;
      if (!initialized && value) {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(initialize); });
      } else if (initialized && !frame) frame = requestAnimationFrame(paint);
    };
    const onVisibility = () => {
      if (document.hidden || reduced.matches) {
        cancelAnimationFrame(frame); frame = 0; envelope = 0; previous = 0;
        if (gl) gl.clear(gl.COLOR_BUFFER_BIT);
      } else setMax(lit);
    };
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onVisibility);
    return { setMax, dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onVisibility);
      if (gl) { gl.deleteProgram(program); gl.deleteBuffer(buffer); }
    } };
  }
  const EffortParticles = { mount };
  (globalThis as typeof globalThis & { EffortParticles: typeof EffortParticles }).EffortParticles = EffortParticles;
})();
