import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {buildSystemPrompt, runAgent} from '../electron/runtime/agent';
import {EventSession} from '../electron/runtime/session';
import {ToolRegistry} from '../electron/runtime/tools';

test('the machine date in the Runtime prompt follows the same local day as activity reports', async context => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  context.after(() => {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  });
  context.mock.timers.enable({
    apis: ['Date'],
    now: Date.parse('2026-10-22T05:30:00Z'),
  });
  const root = await mkdtemp(join(tmpdir(), 'mp-local-day-'));
  const prompt = await buildSystemPrompt({userDataDir: root});
  assert(prompt.includes('本机日期 2026-10-21；'));
  assert(!prompt.includes('本机日期 2026-10-22；'));
});

test('a reopened session refreshes its frozen machine date before requesting the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mp-resumed-day-'));
  const session = await EventSession.open(root, 'old-day');
  await session.freezePrompt(
    'Retain this session instruction.\n\n本机日期 2020-01-01；平台 win32；工作区 未绑定项目目录。',
  );
  let requested = '';
  await runAgent({
    userDataDir: root,
    session,
    registry: new ToolRegistry(),
    model: async request => {
      requested = request.system;
      return {text: 'Done', tool_calls: []};
    },
  });
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert(requested.includes(`本机日期 ${today}；`));
  assert(requested.includes('Retain this session instruction.'));
  assert(!requested.includes('本机日期 2020-01-01；'));
  assert(requested.includes('公开图片资料优先 Search/Fetch'));
});
