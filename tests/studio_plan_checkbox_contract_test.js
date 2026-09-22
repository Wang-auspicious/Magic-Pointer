'use strict';

const assert = require('node:assert');
const fs = require('node:fs');

const html = fs.readFileSync('electron/renderer/studio.html', 'utf8');
const source = fs.readFileSync('electron/renderer/studio.ts', 'utf8');
const css = fs.readFileSync('electron/renderer/chat_styles.css', 'utf8');
const railCss = fs.readFileSync('electron/renderer/plan_list.css', 'utf8');
const ChatView = require('../electron/renderer/chat_view');

assert(!html.includes('sv_motion.js'));
assert(!source.includes('SvMotion'));
assert(!source.includes('svMotionGlobals'));
assert(!html.includes('id="composer-plan"'), 'the durable plan no longer occupies the composer');
assert.match(html, /id="inspector-tasks"[^>]*><section id="project-plan"[^>]*><\/section><div id="project-tasks"/,
  'Plan has its own task rail section before background tasks');
assert(html.includes('href="plan_list.css"') && html.includes('src="plan_list.js"'),
  'the rail implementation and styles are loaded by the real Studio page');
assert(source.includes('composerPlan = PlanList.project(turns)'), 'opening a conversation restores its persisted plan');
assert(source.includes('composerPlan = PlanList.project(activeConversationTurns)'), 'external updates refresh the same durable plan');
assert(source.includes('PlanList.render(host, composerPlan,'));

const todo = ChatView.toolRowNode(ChatView.toolRowModel('Todo', JSON.stringify({ todos: [
  { content: 'Read source', status: 'completed' },
  { content: 'Verify change', status: 'in_progress' },
] }), { text: 'ok', isError: false }, 'todo-call'));
const markup = todo.outerHTML;
assert(markup.includes('class="mp-chat-todo-list"'), 'Todo details render a checklist instead of raw argument JSON');
assert(markup.includes('data-state="completed"') && markup.includes('Read source'));
assert(markup.includes('data-state="in_progress"') && markup.includes('Verify change'));
assert(markup.includes('data-call-id="todo-call"'), 'the plan rail can locate its source tool row');
assert.match(css, /\.mp-chat-todo-item\[data-state="completed"\] \.mp-chat-todo-label\s*\{[^}]*text-decoration:\s*line-through/s,
  'completed items in a Todo tool detail remain visibly completed');
assert.match(css, /\.mp-chat-todo-item\[data-state="in_progress"\] \.mp-chat-todo-check\s*\{[^}]*var\(--mp-clay\)/s);
assert.match(railCss, /\.mp-plan-row\s*\{[^}]*min-height:\s*28px/s);
assert.match(railCss, /\.mp-plan-track\s*\{[^}]*0 0 12px/s);
assert.match(railCss, /\.mp-plan-dot\s*\{[^}]*width:\s*6px/s);
const planRules = (railCss.match(/\.mp-plan[^{]*\{[^}]*\}/g) || []).join('\n');
assert(!/animation\s*:[^;}]*(?:infinite|pulse)/i.test(planRules),
  'plan state must not pulse forever');
assert(!/@keyframes\s+[^\s{]*plan[^\s{]*(?:pulse)?/i.test(railCss),
  'plan state must not regain a dedicated pulse animation');

console.log('studio plan checkbox contract ok');
