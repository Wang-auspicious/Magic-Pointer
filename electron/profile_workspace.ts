'use strict';

/* 画像默认工作区的单一读取点（对齐 app/agent_runtime/workspace_state.py
   read_workspace 的语义：<appRoot>/data/runtime/workspace.txt 里的路径存在
   才是默认工作区；未配置/路径消失 = 没有）。
   Stage 结果落对话时用它绑定工作区——否则划线问问题产生的对话没有
   workspaceRoot，被 sidebar_groups 按项目分组时直接过滤，用户永远看不到。 */

const fs = require('node:fs');
const path = require('node:path');

function profileWorkspaceRoot(appRoot: string): string {
  try {
    const stateFile = path.join(String(appRoot || ''), 'data', 'runtime', 'workspace.txt');
    const raw = fs.readFileSync(stateFile, 'utf-8').trim();
    if (raw && fs.existsSync(raw) && fs.statSync(raw).isDirectory()) return raw;
  } catch (_) {
    /* 未配置或读不到：没有默认工作区，调用方回落现有行为。 */
  }
  return '';
}

module.exports = { profileWorkspaceRoot };