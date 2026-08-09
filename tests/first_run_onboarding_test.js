const assert = require('assert');
const fs = require('fs');

const main = fs.readFileSync('electron/main.js', 'utf8');
const onboarding = fs.readFileSync('electron/renderer/onboarding.html', 'utf8');

assert(main.includes('if (onboardingRequired && !captureMode) showOnboarding({}, { activate: true });'),
  'first visible launch opens the independent welcome surface');
assert(main.includes("else if (!startHidden) showDashboard({ view: 'general' }"),
  'ready launches continue to use the normal dashboard');
assert(main.includes("startPreflight({ source: 'onboarding' })"),
  'the welcome surface starts the real machine setup');
assert(main.includes('onboardingRequired = false;'), 'successful setup unlocks global input');
assert(onboarding.includes('id="onboarding-cancel"'), 'first-run setup has a visible exit path');
assert(onboarding.includes('不会重复执行这套初始化'), 'one-time behavior is explicit');

console.log('first-run onboarding test ok');
