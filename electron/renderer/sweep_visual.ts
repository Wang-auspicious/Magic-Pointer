// @ts-nocheck -- legacy WebGL classic-script behavior is preserved during the extension migration.
(function initSweepVisual(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MagicSweepVisual = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createSweepVisual() {
  'use strict';

  const MAX_POINTS = 64;
  const SWEEP_STYLE = Object.freeze({
    color: Object.freeze([0.145, 0.435, 0.82]),
    bodyOpacity: 0.72,
    bodyHalfWidthRatio: 0.34,
    edgeFeatherDip: 4.2,
    tailSoftnessBoostDip: 1.6,
    tailFloorOpacity: 0.22,
    maxPoints: MAX_POINTS,
  });

  const VERTEX_SHADER_SOURCE = [
    '#version 300 es',
    'in vec2 aPosition;',
    'uniform vec2 uResolution;',
    'void main() {',
    '  vec2 clip = vec2(',
    '    aPosition.x / uResolution.x * 2.0 - 1.0,',
    '    1.0 - aPosition.y / uResolution.y * 2.0',
    '  );',
    '  gl_Position = vec4(clip, 0.0, 1.0);',
    '}',
  ].join('\n');

  const FRAGMENT_SHADER_SOURCE = [
    '#version 300 es',
    'precision highp float;',
    '#define MAX_POINTS 64',
    'uniform vec2 uPoints[MAX_POINTS];',
    'uniform float uProgresses[MAX_POINTS];',
    'uniform int uPointCount;',
    'uniform float uBodyHalfWidth;',
    'uniform float uEdgeFeather;',
    'uniform float uTailSoftnessBoost;',
    'uniform float uTailFloor;',
    'uniform float uBaseOpacity;',
    'uniform float uOpacity;',
    'uniform vec3 uColor;',
    'out vec4 outColor;',
    '',
    'vec2 distanceToSegment(vec2 point, vec2 start, vec2 end) {',
    '  vec2 segment = end - start;',
    '  float denominator = max(dot(segment, segment), 0.0001);',
    '  float projection = clamp(dot(point - start, segment) / denominator, 0.0, 1.0);',
    '  return vec2(length(point - (start + segment * projection)), projection);',
    '}',
    '',
    'void main() {',
    '  if (uPointCount < 2) {',
    '    outColor = vec4(0.0);',
    '    return;',
    '  }',
    '',
    '  float minimumDistance = 100000.0;',
    '  float currentProgress = 0.0;',
    '  for (int index = 0; index < MAX_POINTS - 1; index += 1) {',
    '    if (index >= uPointCount - 1) break;',
    '    vec2 result = distanceToSegment(gl_FragCoord.xy, uPoints[index], uPoints[index + 1]);',
    '    float segmentProgress = mix(uProgresses[index], uProgresses[index + 1], result.y);',
    '    if (result.x < minimumDistance - 0.25) {',
    '      minimumDistance = result.x;',
    '      currentProgress = segmentProgress;',
    '    } else if (abs(result.x - minimumDistance) <= 0.75) {',
    '      currentProgress = max(currentProgress, segmentProgress);',
    '    }',
    '  }',
    '',
    '  float shapedProgress = pow(clamp(currentProgress, 0.0, 1.0), 0.72);',
    '  float tailRamp = mix(uTailFloor, 1.0, shapedProgress);',
    '  float edgeFeather = uEdgeFeather + uTailSoftnessBoost * (1.0 - shapedProgress);',
    '  float flatTopAlpha = 1.0 - smoothstep(',
    '    uBodyHalfWidth,',
    '    uBodyHalfWidth + edgeFeather,',
    '    minimumDistance',
    '  );',
    '  float alpha = uBaseOpacity * tailRamp * flatTopAlpha * uOpacity;',
    '  if (alpha <= 0.001) discard;',
    '  outColor = vec4(uColor * alpha, alpha);',
    '}',
  ].join('\n');

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
      total += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      );
    }
    return total;
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
    if (points.length <= 2) {
      return points.map((point) => ({ x: point.x, y: point.y }));
    }
    const result = [{ x: points[0].x, y: points[0].y }];
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[Math.max(0, index - 1)];
      const p1 = points[index];
      const p2 = points[index + 1];
      const p3 = points[Math.min(points.length - 1, index + 2)];
      const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 6));
      for (let step = 1; step <= steps; step += 1) {
        const point = catmullRomPoint(p0, p1, p2, p3, step / steps);
        const previous = result[result.length - 1];
        if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.1) {
          result.push(point);
        }
      }
    }
    return result;
  }

  function resamplePath(points, count) {
    if (points.length <= count) {
      return points.map((point) => ({ x: point.x, y: point.y }));
    }
    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      cumulative.push(cumulative[index - 1] + Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      ));
    }
    const total = cumulative[cumulative.length - 1];
    const result = [];
    let segmentIndex = 1;
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      const target = total * sampleIndex / (count - 1);
      while (segmentIndex < cumulative.length - 1 && cumulative[segmentIndex] < target) {
        segmentIndex += 1;
      }
      const beforeDistance = cumulative[segmentIndex - 1];
      const afterDistance = cumulative[segmentIndex];
      const span = Math.max(afterDistance - beforeDistance, 0.0001);
      const ratio = clamp((target - beforeDistance) / span, 0, 1);
      const before = points[segmentIndex - 1];
      const after = points[segmentIndex];
      result.push({
        x: before.x + (after.x - before.x) * ratio,
        y: before.y + (after.y - before.y) * ratio,
      });
    }
    return result;
  }

  function addArcProgress(points) {
    const total = Math.max(pathLength(points), 0.0001);
    let travelled = 0;
    return points.map((point, index) => {
      if (index > 0) {
        travelled += Math.hypot(
          point.x - points[index - 1].x,
          point.y - points[index - 1].y,
        );
      }
      return {
        x: point.x,
        y: point.y,
        progress: index === points.length - 1 ? 1 : clamp(travelled / total, 0, 1),
      };
    });
  }

  function sweepProfile(progress) {
    const shaped = Math.pow(clamp(progress, 0, 1), 0.72);
    return {
      color: SWEEP_STYLE.color,
      opacity: SWEEP_STYLE.tailFloorOpacity
        + (1 - SWEEP_STYLE.tailFloorOpacity) * shaped,
      edgeFeather: SWEEP_STYLE.edgeFeatherDip
        + SWEEP_STYLE.tailSoftnessBoostDip * (1 - shaped),
    };
  }

  function buildSdfPath(points, requestedWidth = 22) {
    const usable = usablePoints(points);
    if (usable.length < 2 || pathLength(usable) <= 0.1) return null;
    const smooth = smoothPath(usable);
    const sampled = resamplePath(smooth, MAX_POINTS);
    const samples = addArcProgress(sampled);
    const width = clamp(Number(requestedWidth) || 22, 8, 40);
    const bodyHalfWidth = clamp(width * SWEEP_STYLE.bodyHalfWidthRatio, 4.5, 8.5);
    const maximumRadius = bodyHalfWidth
      + SWEEP_STYLE.edgeFeatherDip
      + SWEEP_STYLE.tailSoftnessBoostDip
      + 2;
    const xs = samples.map((point) => point.x);
    const ys = samples.map((point) => point.y);
    return {
      mode: 'screen-space-path-sdf',
      samples,
      bodyHalfWidth,
      edgeFeather: SWEEP_STYLE.edgeFeatherDip,
      tailSoftnessBoost: SWEEP_STYLE.tailSoftnessBoostDip,
      tailFloorOpacity: SWEEP_STYLE.tailFloorOpacity,
      bounds: {
        left: Math.min(...xs) - maximumRadius,
        right: Math.max(...xs) + maximumRadius,
        top: Math.min(...ys) - maximumRadius,
        bottom: Math.max(...ys) + maximumRadius,
      },
    };
  }

  function buildSweepGeometry(points, requestedWidth = 22) {
    return buildSdfPath(points, requestedWidth);
  }

  function buildSweepSegments(points, requestedWidth = 22) {
    const path = buildSdfPath(points, requestedWidth);
    if (!path) return [];
    return path.samples.slice(1).map((point, index) => ({
      start: path.samples[index],
      end: point,
      progress: (path.samples[index].progress + point.progress) / 2,
      opacity: sweepProfile((path.samples[index].progress + point.progress) / 2).opacity,
    }));
  }

  function buildSweepRibbon(points, requestedWidth = 22) {
    return buildSdfPath(points, requestedWidth);
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
      this.vertexBuffer = null;
      this.positionAttribute = -1;
      this.locations = null;
      this.cssWidth = 1;
      this.cssHeight = 1;
      this.dpr = 1;
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
      this.positionAttribute = gl.getAttribLocation(this.program, 'aPosition');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.enableVertexAttribArray(this.positionAttribute);
      gl.vertexAttribPointer(this.positionAttribute, 2, gl.FLOAT, false, 0, 0);
      this.locations = {
        resolution: gl.getUniformLocation(this.program, 'uResolution'),
        points: gl.getUniformLocation(this.program, 'uPoints[0]'),
        progresses: gl.getUniformLocation(this.program, 'uProgresses[0]'),
        pointCount: gl.getUniformLocation(this.program, 'uPointCount'),
        bodyHalfWidth: gl.getUniformLocation(this.program, 'uBodyHalfWidth'),
        edgeFeather: gl.getUniformLocation(this.program, 'uEdgeFeather'),
        tailSoftnessBoost: gl.getUniformLocation(this.program, 'uTailSoftnessBoost'),
        tailFloor: gl.getUniformLocation(this.program, 'uTailFloor'),
        baseOpacity: gl.getUniformLocation(this.program, 'uBaseOpacity'),
        opacity: gl.getUniformLocation(this.program, 'uOpacity'),
        color: gl.getUniformLocation(this.program, 'uColor'),
      };
      gl.useProgram(this.program);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
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
      this.canvas.style.width = this.cssWidth + 'px';
      this.canvas.style.height = this.cssHeight + 'px';
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
      const paths = (Array.isArray(entries) ? entries : [])
        .slice(-8)
        .map((entry) => ({
          path: buildSdfPath(entry?.points, width),
          opacity: clamp(entry?.opacity == null ? 1 : Number(entry.opacity), 0, 1),
        }))
        .filter((entry) => entry.path && entry.opacity > 0.01);
      if (!paths.length) return;
      if (this.gl && !this.contextLost) this.renderWebGl(paths);
      else if (this.ctx) this.renderCanvas(paths);
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
      gl.uniform2f(locations.resolution, this.canvas.width, this.canvas.height);
      gl.uniform3fv(locations.color, SWEEP_STYLE.color);
      gl.uniform1f(locations.baseOpacity, SWEEP_STYLE.bodyOpacity);
      gl.uniform1f(locations.tailFloor, SWEEP_STYLE.tailFloorOpacity);

      for (const entry of entries) {
        const path = entry.path;
        const left = path.bounds.left;
        const right = path.bounds.right;
        const top = path.bounds.top;
        const bottom = path.bounds.bottom;
        const vertices = new Float32Array([
          left * this.dpr, top * this.dpr,
          right * this.dpr, top * this.dpr,
          left * this.dpr, bottom * this.dpr,
          left * this.dpr, bottom * this.dpr,
          right * this.dpr, top * this.dpr,
          right * this.dpr, bottom * this.dpr,
        ]);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(this.positionAttribute, 2, gl.FLOAT, false, 0, 0);

        const pointValues = new Float32Array(path.samples.length * 2);
        const progressValues = new Float32Array(path.samples.length);
        path.samples.forEach((point, index) => {
          pointValues[index * 2] = point.x * this.dpr;
          pointValues[index * 2 + 1] = (this.cssHeight - point.y) * this.dpr;
          progressValues[index] = point.progress;
        });

        this.setScissor(path.bounds);
        gl.uniform2fv(locations.points, pointValues);
        gl.uniform1fv(locations.progresses, progressValues);
        gl.uniform1i(locations.pointCount, path.samples.length);
        gl.uniform1f(locations.bodyHalfWidth, path.bodyHalfWidth * this.dpr);
        gl.uniform1f(locations.edgeFeather, path.edgeFeather * this.dpr);
        gl.uniform1f(locations.tailSoftnessBoost, path.tailSoftnessBoost * this.dpr);
        gl.uniform1f(locations.opacity, entry.opacity);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    renderCanvas(entries) {
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const entry of entries) {
        const samples = entry.path.samples;
        for (let index = 1; index < samples.length; index += 1) {
          const progress = (samples[index - 1].progress + samples[index].progress) / 2;
          const profile = sweepProfile(progress);
          const alpha = SWEEP_STYLE.bodyOpacity * profile.opacity * entry.opacity;
          const rgb = SWEEP_STYLE.color.map((component) => Math.round(component * 255));
          ctx.beginPath();
          ctx.moveTo(samples[index - 1].x, samples[index - 1].y);
          ctx.lineTo(samples[index].x, samples[index].y);
          ctx.lineWidth = entry.path.bodyHalfWidth * 2 + profile.edgeFeather * 1.2;
          ctx.strokeStyle = 'rgba(' + rgb.join(',') + ',' + (alpha * 0.34) + ')';
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(samples[index - 1].x, samples[index - 1].y);
          ctx.lineTo(samples[index].x, samples[index].y);
          ctx.lineWidth = entry.path.bodyHalfWidth * 2;
          ctx.strokeStyle = 'rgba(' + rgb.join(',') + ',' + alpha + ')';
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  return {
    SWEEP_STYLE,
    VERTEX_SHADER_SOURCE,
    FRAGMENT_SHADER_SOURCE,
    buildSdfPath,
    sweepProfile,
    buildSweepGeometry,
    buildSweepSegments,
    buildSweepRibbon,
    SweepRenderer,
  };
}));
