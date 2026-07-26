const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron', 'renderer', 'dashboard.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');

assert(html.includes('data-view-target="calendar"'));
assert(html.includes('id="calendar-view"'));
assert(html.includes('id="calendar-event-form"'));
assert(html.includes('id="calendar-events"'));
assert(html.includes('id="calendar-create"'));
assert(js.includes('calendarRequestState'));
assert(js.includes('calendarPreview'));
assert(js.includes('calendarCreate'));
assert(js.includes('calendarUndoCreate'));
assert(js.includes("payload.view === 'calendar'"));
assert(js.includes('conflictConfirmationArmed'));
assert(preload.includes('calendarRequestState'));
assert(preload.includes("'dashboard:calendar-create'"));
assert(main.includes("'scripts/calendar_bridge.py'"));
// Calendar drafts render as a stage card; the dashboard opens on the card's
// context action instead of a direct intentKind branch in the submit path.
assert(main.includes("id === 'open-calendar-draft' && parsed.calendarDraft"));
assert(main.includes("showDashboard({ view: 'calendar', calendarDraft"));
assert(css.includes('[hidden] { display: none !important; }'));
assert(!js.includes('innerHTML'));

console.log('calendar dashboard static test ok');
