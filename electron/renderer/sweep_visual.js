(function initSweepVisual(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MagicSweepVisual = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSweepVisual() {
  'use strict';

  const SWEEP_STYLE = Object.freeze({
    bodyColor: Object.freeze([0.184, 0.443, 0.82]),
    coreColor: Object.freeze([0.439, 0.647, 1.0]),
    haloColor: Object.freeze([0.58, 0.75, 1.0]),
    bodyAlpha: 0.46,
    coreAlpha: 0.045,
    haloAlpha: 0.085,
    headAlpha: 0.23,
    bodyHalfHeightRatio: 0.5,
    coreHalfHeightDip: 1.15,
    haloSigmaDip: 13.5,
    headSigmaDip: 15.5,
    tailFloorOpacity: 0.32,
    maxRenderSegments: 72,
  });

  const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 aPosition;
in float aCross;
in float aProgress;
uniform vec2 uResolution;
out float vCross;
out float vProgress;
void main() {
  vec2 clip = vec2(
    aPosition.x / uResolution.x * 2.0 - 1.0,
    1.0 - aPosition.y / uResolution.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vCross = aCross;
  vProgress = aProgress;
}`;

  const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;

uniform float uBodySigma;
uniform float uCoreSigma;
uniform float uHaloSigma;
uniform float uHeadSigma;
uniform float uTailFloor;
uniform float uOpacity;
uniform float uRenderHead;
uniform vec2 uHeadPosition;
uniform vec3 uBodyColor;
uniform vec3 uCoreColor;
uniform vec3 uHaloColor;
uniform float uBodyAlpha;
uniform float uCoreAlpha;
uniform float uHaloAlpha;
uniform float uHeadAlpha;

in float vCross;
in float vProgress;
out vec4 outColor;

void main() {
  vec2 point = vec2(gl_FragCoord.x, gl_FragCoord.y);
  if (uRenderHead > 0.5) {
    float headDistance = length(point - uHeadPosition);
    float headGaussian = exp(-(headDistance * headDistance)
      / (2.0 * uHeadSigma * uHeadSigma));
    float headAlpha = uHeadAlpha * headGaussian * uOpacity;
    outColor = vec4(uCoreColor * headAlpha, headAlpha);
    return;
  }

  float crossDistance = abs(vCross);
  float bodyGaussian = exp(-(crossDistance * crossDistance)
    / (2.0 * uBodySigma * uBodySigma));
  float coreGaussian = exp(-(crossDistance * crossDistance)
    / (2.0 * uCoreSigma * uCoreSigma));
  float haloGaussian = exp(-(crossDistance * crossDistance)
    / (2.0 * uHaloSigma * uHaloSigma));
  float pathProgress = clamp(vProgress, 0.0, 1.0);
  float tailRamp = mix(uTailFloor, 1.0, pow(pathProgress, 0.72));
  float startFade = smoothstep(-0.14, 0.0, vProgress);
  float headUnderlap = uHeadSigma * 0.62;
  float endFade = 1.0 - smoothstep(1.0,
    1.0 + min(0.16, headUnderlap / max(uHaloSigma * 10.0, 1.0)), vProgress);
  float longitudinalFade = startFade * endFade;

  float bodyAlpha = uBodyAlpha * bodyGaussian * tailRamp * longitudinalFade;
  float coreAlpha = uCoreAlpha * coreGaussian * tailRamp * longitudinalFade;
  float haloAlpha = uHaloAlpha * haloGaussian * tailRamp * longitudinalFade;
  float rawAlpha = bodyAlpha + coreAlpha + haloAlpha;
  float energyLimit = min(1.0, 0.72 / max(rawAlpha, 0.0001));
  float alpha = rawAlpha * energyLimit * uOpacity;
  vec3 premultiplied = (
    uBodyColor * bodyAlpha
    + uCoreColor * coreAlpha
    + uHaloColor * haloAlpha
  ) * energyLimit * uOpacity;
  outColor = vec4(premultiplied, alpha);
}`;

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function usablePoints(points) {
    return Array.isArray(points)
      ? points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      : [];
  }

  function pathLength(points) {
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
    }
    return total;
  }

  function evenlySpacedPath(points, spacing) {
    const result = [{ x: points[0].x, y: points[0].y }];
    let distanceUntilSample = spacing;
    let segmentStart = { x: points[0].x, y: points[0].y };

    for (let index = 1; index < points.length; index += 1) {
      const segmentEnd = { x: points[index].x, y: points[index].y };
      let segmentLength = Math.hypot(segmentEnd.x - segmentStart.x, segmentEnd.y - segmentStart.y);
      while (segmentLength >= distanceUntilSample && segmentLength > 0.001) {
        const ratio = distanceUntilSample / segmentLength;
        segmentStart = {
          x: segmentStart.x + (segmentEnd.x - segmentStart.x) * ratio,
          y: segmentStart.y + (segmentEnd.y - segmentStart.y) * ratio,
        };
        result.push(segmentStart);
        segmentLength = Math.hypot(segmentEnd.x - segmentStart.x, segmentEnd.y - segmentStart.y);
        distanceUntilSample = spacing;
      }
      distanceUntilSample -= segmentLength;
      segmentStart = segmentEnd;
    }

    const last = points[points.length - 1];
    if (Math.hypot(last.x - result[result.length - 1].x, last.y - result[result.length - 1].y) > 0.1) {
      result.push({ x: last.x, y: last.y });
    }
    return result;
  }

  function catmullRomPoint(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x)
        + (-p0.x + p2.x) * t
        + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
        + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y)
        + (-p0.y + p2.y) * t
        + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
        + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
    };
  }

  function smoothPath(points) {
    if (points.length <= 2) return points.map((point) => ({ x: point.x, y: point.y }));
    const result = [{ x: points[0].x, y: points[0].y }];
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[Math.max(0, index - 1)];
      const p1 = points[index];
      const p2 = points[index + 1];
      const p3 = points[Math.min(points.length - 1, index + 2)];
      const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 7));
      for (let step = 1; step <= steps; step += 1) {
        const point = catmullRomPoint(p0, p1, p2, p3, step / steps);
        const previous = result[result.length - 1];
        if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.1) result.push(point);
      }
    }
    return result;
  }

  function softenCorners(points) {
    if (points.length <= 2) return points.map((point) => ({ x: point.x, y: point.y }));
    const result = [{ x: points[0].x, y: points[0].y }];
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (index > 0) {
        result.push({
          x: from.x * 0.75 + to.x * 0.25,
          y: from.y * 0.75 + to.y * 0.25,
        });
      }
      if (index < points.length - 2) {
        result.push({
          x: from.x * 0.25 + to.x * 0.75,
          y: from.y * 0.25 + to.y * 0.75,
        });
      }
    }
    result.push({ x: points[points.length - 1].x, y: points[points.length - 1].y });
    return result;
  }

  function buildSweepGeometry(points, requestedWidth = 22) {
    const usable = usablePoints(points);
    if (usable.length < 2) return null;
    const first = usable[0];
    const last = usable[usable.length - 1];
    const width = clamp(Number(requestedWidth) || 22, 8, 40);
    const bodyHalfHeight = clamp(width * SWEEP_STYLE.bodyHalfHeightRatio, 4.5, 9);
    const start = { x: first.x, y: first.y };
    const end = { x: last.x, y: last.y };
    const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
    return {
      mode: 'freehand-sweep',
      start,
      end,
      length,
      bodyHalfHeight,
      coreHalfHeight: SWEEP_STYLE.coreHalfHeightDip,
      haloSigma: SWEEP_STYLE.haloSigmaDip,
      haloExtent: bodyHalfHeight + SWEEP_STYLE.haloSigmaDip * 2.8,
      headSigma: SWEEP_STYLE.headSigmaDip,
      tailFeather: clamp(length * 0.16, 18, 44),
    };
  }

  function tailOpacity(progress) {
    return SWEEP_STYLE.tailFloorOpacity
      + (1 - SWEEP_STYLE.tailFloorOpacity) * Math.pow(clamp(progress, 0, 1), 0.72);
  }

  function buildSweepRibbon(points, requestedWidth = 22) {
    const usable = usablePoints(points);
    if (usable.length < 2 || pathLength(usable) <= 0.1) return null;
    const softened = softenCorners(usable);
    const rawLength = pathLength(softened);
    const baseSpacing = clamp(rawLength / 34, 8, 18);
    let visualPath = smoothPath(evenlySpacedPath(softened, baseSpacing));
    if (visualPath.length > SWEEP_STYLE.maxRenderSegments - 2) {
      visualPath = evenlySpacedPath(
        visualPath,
        pathLength(visualPath) / (SWEEP_STYLE.maxRenderSegments - 2),
      );
    }
    if (visualPath.length < 2) return null;

    const geometry = buildSweepGeometry(visualPath, requestedWidth);
    const visualLength = pathLength(visualPath);
    let travelled = 0;
    const coreSamples = visualPath.map((point, index) => {
      if (index > 0) {
        travelled += Math.hypot(point.x - visualPath[index - 1].x, point.y - visualPath[index - 1].y);
      }
      return {
        x: point.x,
        y: point.y,
        progress: clamp(travelled / Math.max(visualLength, 0.1), 0, 1),
      };
    });
    const startDirection = normalizedDirection(coreSamples[0], coreSamples[1]);
    const endDirection = normalizedDirection(coreSamples[coreSamples.length - 2], coreSamples[coreSamples.length - 1]);
    const haloExtent = geometry.haloSigma * 2.55;
    const headUnderlap = geometry.headSigma * 0.62;
    const samples = [
      {
        x: coreSamples[0].x - startDirection.x * geometry.haloSigma,
        y: coreSamples[0].y - startDirection.y * geometry.haloSigma,
        progress: -0.14,
      },
      ...coreSamples,
      {
        x: coreSamples[coreSamples.length - 1].x + endDirection.x * (headUnderlap + geometry.haloSigma * 1.8),
        y: coreSamples[coreSamples.length - 1].y + endDirection.y * (headUnderlap + geometry.haloSigma * 1.8),
        progress: 1.16,
      },
    ];
    const vertices = [];
    const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
    for (let index = 0; index < samples.length; index += 1) {
      const previous = samples[Math.max(0, index - 1)];
      const current = samples[index];
      const next = samples[Math.min(samples.length - 1, index + 1)];
      const previousDirection = normalizedDirection(previous, current);
      const nextDirection = normalizedDirection(current, next);
      const turnDot = previousDirection.x * nextDirection.x + previousDirection.y * nextDirection.y;
      const miter = normalizedVector(
        -previousDirection.y - nextDirection.y,
        previousDirection.x + nextDirection.x,
      );
      const normal = miter.length > 0 ? miter : { x: -nextDirection.y, y: nextDirection.x };
      const turnScale = clamp(0.58 + 0.42 * ((turnDot + 1) / 2), 0.58, 1);
      const localExtent = Math.max(geometry.bodyHalfHeight * 2.15, haloExtent * turnScale);
      for (const side of [-1, 1]) {
        const x = samples[index].x + normal.x * localExtent * side;
        const y = samples[index].y + normal.y * localExtent * side;
        vertices.push(x, y, localExtent * side, samples[index].progress);
        bounds.left = Math.min(bounds.left, x);
        bounds.right = Math.max(bounds.right, x);
        bounds.top = Math.min(bounds.top, y);
        bounds.bottom = Math.max(bounds.bottom, y);
      }
    }
    return {
      mode: 'continuous-ribbon',
      samples,
      vertices,
      bounds,
      head: coreSamples[coreSamples.length - 1],
      bodyHalfHeight: geometry.bodyHalfHeight,
      coreHalfHeight: geometry.coreHalfHeight,
      haloSigma: geometry.haloSigma,
      headSigma: geometry.headSigma,
    };
  }

  function normalizedDirection(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    return length > 0.001 ? { x: dx / length, y: dy / length } : { x: 1, y: 0 };
  }

  function normalizedVector(x, y) {
    const length = Math.hypot(x, y);
    return length > 0.001 ? { x: x / length, y: y / length, length } : { x: 0, y: 0, length: 0 };
  }

  function buildSweepSegments(points, requestedWidth = 22) {
    const ribbon = buildSweepRibbon(points, requestedWidth);
    if (!ribbon) return [];
    const samples = ribbon.samples.filter((sample) => sample.progress >= 0 && sample.progress <= 1);
    const segments = [];
    for (let index = 1; index < samples.length; index += 1) {
      const geometry = buildSweepGeometry([samples[index - 1], samples[index]], requestedWidth);
      if (!geometry) continue;
      const progress = (samples[index - 1].progress + samples[index].progress) / 2;
      segments.push({ ...geometry, progress, opacity: tailOpacity(progress) });
    }
    return segments;
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(message);
  }

  function createProgram(gl) {
    const program = gl.createProgram();
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    const message = gl.getProgramInfoLog(program) || 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  class SweepRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = null;
      this.ctx = null;
      this.program = null;
      this.locations = null;
      this.attributes = null;
      this.vertexBuffer = null;
      this.dpr = 1;
      this.cssWidth = 1;
      this.cssHeight = 1;
      this.contextLost = false;
      this.initialize();
    }

    initialize() {
      if (!this.canvas) return;
      try {
        this.gl = this.canvas.getContext('webgl2', {
          alpha: true,
          antialias: false,
          depth: false,
          premultipliedAlpha: true,
          preserveDrawingBuffer: false,
          stencil: false,
        });
        if (this.gl) this.initializeWebGl();
      } catch {
        this.gl = null;
      }
      if (!this.gl) this.ctx = this.canvas.getContext('2d', { alpha: true });
    }

    initializeWebGl() {
      const gl = this.gl;
      this.program = createProgram(gl);
      this.vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      this.attributes = {
        position: gl.getAttribLocation(this.program, 'aPosition'),
        cross: gl.getAttribLocation(this.program, 'aCross'),
        progress: gl.getAttribLocation(this.program, 'aProgress'),
      };
      for (const location of Object.values(this.attributes)) gl.enableVertexAttribArray(location);
      this.locations = {};
      for (const name of [
        'uResolution', 'uBodySigma', 'uCoreSigma', 'uHaloSigma', 'uHeadSigma',
        'uTailFloor', 'uOpacity', 'uRenderHead', 'uHeadPosition', 'uBodyColor',
        'uCoreColor', 'uHaloColor', 'uBodyAlpha', 'uCoreAlpha', 'uHaloAlpha', 'uHeadAlpha',
      ]) this.locations[name] = gl.getUniformLocation(this.program, name);
      gl.useProgram(this.program);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.SCISSOR_TEST);
      this.canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        this.contextLost = true;
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this.initializeWebGl();
        this.resize(this.cssWidth, this.cssHeight, this.dpr);
      });
    }

    resize(width, height, dpr = 1) {
      this.cssWidth = Math.max(1, Number(width) || 1);
      this.cssHeight = Math.max(1, Number(height) || 1);
      this.dpr = Math.max(1, Number(dpr) || 1);
      this.canvas.width = Math.round(this.cssWidth * this.dpr);
      this.canvas.height = Math.round(this.cssHeight * this.dpr);
      this.canvas.style.width = `${this.cssWidth}px`;
      this.canvas.style.height = `${this.cssHeight}px`;
      if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.clear();
    }

    clear() {
      if (this.gl && !this.contextLost) {
        this.gl.scissor(0, 0, this.canvas.width, this.canvas.height);
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      } else if (this.ctx) {
        this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      }
    }

    render(entries, width = 22) {
      this.clear();
      const ribbons = (Array.isArray(entries) ? entries : [])
        .slice(-8)
        .map((entry) => ({
          ribbon: buildSweepRibbon(entry?.points, width),
          opacity: clamp(Number(entry?.opacity) || 0, 0, 1),
          head: entry?.head !== false,
        }))
        .filter((entry) => entry.ribbon && entry.opacity > 0.01);
      if (!ribbons.length) return;
      if (this.gl && !this.contextLost) this.renderWebGl(ribbons);
      else if (this.ctx) this.renderCanvas(ribbons);
    }

    uploadVertices(vertices) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(this.attributes.position, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribPointer(this.attributes.cross, 1, gl.FLOAT, false, 16, 8);
      gl.vertexAttribPointer(this.attributes.progress, 1, gl.FLOAT, false, 16, 12);
    }

    setScissor(bounds) {
      const left = clamp(bounds.left, 0, this.cssWidth);
      const right = clamp(bounds.right, 0, this.cssWidth);
      const top = clamp(bounds.top, 0, this.cssHeight);
      const bottom = clamp(bounds.bottom, 0, this.cssHeight);
      this.gl.scissor(
        Math.floor(left * this.dpr),
        Math.floor((this.cssHeight - bottom) * this.dpr),
        Math.max(1, Math.ceil((right - left) * this.dpr)),
        Math.max(1, Math.ceil((bottom - top) * this.dpr)),
      );
    }

    renderWebGl(entries) {
      const gl = this.gl;
      const locations = this.locations;
      gl.useProgram(this.program);
      gl.uniform2f(locations.uResolution, this.canvas.width, this.canvas.height);
      gl.uniform3fv(locations.uBodyColor, SWEEP_STYLE.bodyColor);
      gl.uniform3fv(locations.uCoreColor, SWEEP_STYLE.coreColor);
      gl.uniform3fv(locations.uHaloColor, SWEEP_STYLE.haloColor);
      gl.uniform1f(locations.uBodyAlpha, SWEEP_STYLE.bodyAlpha);
      gl.uniform1f(locations.uCoreAlpha, SWEEP_STYLE.coreAlpha);
      gl.uniform1f(locations.uHaloAlpha, SWEEP_STYLE.haloAlpha);
      gl.uniform1f(locations.uHeadAlpha, SWEEP_STYLE.headAlpha);
      gl.uniform1f(locations.uTailFloor, SWEEP_STYLE.tailFloorOpacity);

      for (const entry of entries) {
        const ribbon = entry.ribbon;
        this.setScissor(ribbon.bounds);
        this.uploadVertices(ribbon.vertices.map((value, index) => index % 4 === 3 ? value : value * this.dpr));
        gl.uniform1f(locations.uBodySigma, ribbon.bodyHalfHeight * this.dpr);
        gl.uniform1f(locations.uCoreSigma, ribbon.coreHalfHeight * this.dpr);
        gl.uniform1f(locations.uHaloSigma, ribbon.haloSigma * this.dpr);
        gl.uniform1f(locations.uHeadSigma, ribbon.headSigma * this.dpr);
        gl.uniform1f(locations.uOpacity, entry.opacity);
        gl.uniform1f(locations.uRenderHead, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, ribbon.samples.length * 2);

        if (entry.head) this.drawHead(ribbon, entry.opacity);
      }
    }

    drawHead(ribbon, opacity) {
      const gl = this.gl;
      const radius = ribbon.headSigma * 3.4;
      const left = ribbon.head.x - radius;
      const right = ribbon.head.x + radius;
      const top = ribbon.head.y - radius;
      const bottom = ribbon.head.y + radius;
      this.setScissor({ left, right, top, bottom });
      this.uploadVertices([
        left * this.dpr, top * this.dpr, 0, 1,
        right * this.dpr, top * this.dpr, 0, 1,
        left * this.dpr, bottom * this.dpr, 0, 1,
        right * this.dpr, bottom * this.dpr, 0, 1,
      ]);
      const locations = this.locations;
      gl.uniform1f(locations.uOpacity, opacity);
      gl.uniform1f(locations.uRenderHead, 1);
      gl.uniform2f(locations.uHeadPosition, ribbon.head.x * this.dpr,
        (this.cssHeight - ribbon.head.y) * this.dpr);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.uniform1f(locations.uRenderHead, 0);
    }

    renderCanvas(entries) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const entry of entries) {
        const ribbon = entry.ribbon;
        const samples = ribbon.samples.filter((sample) => sample.progress >= 0 && sample.progress <= 1);
        for (let index = 1; index < samples.length; index += 1) {
          const progress = (samples[index - 1].progress + samples[index].progress) / 2;
          const opacity = tailOpacity(progress) * entry.opacity;
          ctx.beginPath();
          ctx.moveTo(samples[index - 1].x, samples[index - 1].y);
          ctx.lineTo(samples[index].x, samples[index].y);
          ctx.lineWidth = ribbon.haloSigma * 2.8;
          ctx.strokeStyle = `rgba(148, 192, 255, ${SWEEP_STYLE.haloAlpha * opacity})`;
          ctx.stroke();
          ctx.lineWidth = ribbon.bodyHalfHeight * 2;
          ctx.strokeStyle = `rgba(47, 113, 209, ${SWEEP_STYLE.bodyAlpha * opacity})`;
          ctx.stroke();
        }
        if (entry.head) {
          const head = ctx.createRadialGradient(
            ribbon.head.x, ribbon.head.y, 0,
            ribbon.head.x, ribbon.head.y, ribbon.headSigma * 3,
          );
          head.addColorStop(0, `rgba(112, 165, 255, ${SWEEP_STYLE.headAlpha * entry.opacity})`);
          head.addColorStop(1, 'rgba(112, 165, 255, 0)');
          ctx.fillStyle = head;
          ctx.fillRect(
            ribbon.head.x - ribbon.headSigma * 3,
            ribbon.head.y - ribbon.headSigma * 3,
            ribbon.headSigma * 6,
            ribbon.headSigma * 6,
          );
        }
      }
      ctx.restore();
    }
  }

  return {
    SWEEP_STYLE,
    VERTEX_SHADER_SOURCE,
    FRAGMENT_SHADER_SOURCE,
    buildSweepGeometry,
    buildSweepSegments,
    buildSweepRibbon,
    SweepRenderer,
  };
}));

