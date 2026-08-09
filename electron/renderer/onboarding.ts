// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
'use strict';

const api = window.magicPointerOnboarding;
const screenNames = ['welcome', 'progress', 'success', 'failure'];
const stages = new Map();
let stageOrder = [];
let running = false;

const stateLabels = {
  pending: '',
  running: '正在处理',
  pass: '完成',
  warn: '可稍后设置',
  needs_user: '需要确认',
  fail: '未通过',
  skipped: '已跳过',
};

function showScreen(name) {
  for (const screenName of screenNames) {
    const screen = document.querySelector(`.onboarding-screen[data-screen="${screenName}"]`);
    const active = screenName === name;
    screen.classList.toggle('is-active', active);
    screen.setAttribute('aria-hidden', String(!active));
  }
  document.documentElement.dataset.screen = name;
}

function appendLog(line) {
  const log = document.getElementById('onboarding-log');
  const next = `${log.textContent}${log.textContent ? '\n' : ''}${line}`;
  log.textContent = next.slice(-24000);
  log.scrollTop = log.scrollHeight;
}

function renderStages() {
  const list = document.getElementById('onboarding-stage-list');
  const rows = stageOrder.map((id) => {
    const stage = stages.get(id) || { id, title: id, state: 'pending' };
    const row = document.createElement('div');
    row.className = 'onboarding-stage';
    row.dataset.state = stage.state || 'pending';

    const dot = document.createElement('span');
    dot.className = 'onboarding-stage__dot';
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'onboarding-stage__title';
    title.textContent = stage.title || stage.id;
    const state = document.createElement('span');
    state.className = 'onboarding-stage__state';
    state.textContent = stateLabels[stage.state] || '';
    row.append(dot, title, state);
    return row;
  });
  list.replaceChildren(...rows);
}

function setProgress(percent) {
  const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const track = document.querySelector('.progress-track');
  track.setAttribute('aria-valuenow', String(safe));
  document.getElementById('onboarding-progress-fill').style.width = `${safe}%`;
}

function begin() {
  if (running) return;
  running = true;
  stageOrder = [];
  stages.clear();
  document.getElementById('onboarding-log').textContent = '';
  document.getElementById('onboarding-current-stage').textContent = '正在准备系统环境';
  document.getElementById('onboarding-step-count').textContent = '0 / 0 项';
  setProgress(0);
  renderStages();
  showScreen('progress');
  api.start();
}

function renderEvent(event = {}) {
  if (event.type === 'manifest') {
    stageOrder = Array.isArray(event.stages) ? event.stages.map((stage) => stage.id) : [];
    stages.clear();
    for (const stage of event.stages || []) stages.set(stage.id, { ...stage, state: 'pending' });
    document.getElementById('onboarding-step-count').textContent = `0 / ${stageOrder.length} 项`;
    renderStages();
    appendLog(`读取 ${stageOrder.length} 项本机设置`);
    return;
  }

  if (event.type === 'stage') {
    const previous = stages.get(event.id) || {};
    const next = { ...previous, ...event };
    stages.set(event.id, next);
    if (event.state === 'running') {
      document.getElementById('onboarding-current-stage').textContent = next.title || next.id;
      appendLog(`开始：${next.title || next.id}`);
    } else {
      appendLog(`${stateLabels[event.state] || event.state}：${next.title || next.id}${event.evidence ? ` · ${event.evidence}` : ''}`);
    }
    renderStages();
    return;
  }

  if (event.type === 'progress') {
    const completed = stageOrder.filter((id) => {
      const state = stages.get(id)?.state;
      return ['pass', 'warn', 'needs_user', 'fail', 'skipped'].includes(state);
    }).length;
    setProgress(event.percent);
    document.getElementById('onboarding-step-count').textContent = `${completed} / ${stageOrder.length} 项`;
    return;
  }

  if (event.type === 'complete') {
    running = false;
    setProgress(100);
    if (event.ready === true) {
      document.getElementById('onboarding-current-stage').textContent = '设置完成';
      document.getElementById('onboarding-step-count').textContent = `${stageOrder.length} / ${stageOrder.length} 项`;
      setTimeout(() => showScreen('success'), 280);
    } else {
      document.getElementById('onboarding-failure-copy').textContent =
        '有一项本机检查未通过。技术详情已经保留，可以直接重试。';
      setTimeout(() => showScreen('failure'), 180);
    }
    return;
  }

  if (event.type === 'cancelled') {
    running = false;
    return;
  }

  if (event.type === 'error') {
    running = false;
    appendLog(event.error || '初始化失败');
    document.getElementById('onboarding-failure-copy').textContent =
      '初始化意外中断。没有删除用户文件，重试会从安全检查重新开始。';
    showScreen('failure');
  }
}

document.getElementById('onboarding-start').addEventListener('click', begin);
document.getElementById('onboarding-retry').addEventListener('click', begin);
document.getElementById('onboarding-cancel').addEventListener('click', () => api.cancel());
document.getElementById('onboarding-failure-close').addEventListener('click', () => api.cancel());
document.getElementById('onboarding-continue').addEventListener('click', () => api.continue());
api.onShow((payload = {}) => showScreen(payload.screen || 'welcome'));
api.onPreflightEvent(renderEvent);
showScreen('welcome');
