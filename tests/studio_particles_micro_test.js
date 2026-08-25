'use strict';

/* sv-particles 微交互契约。
   ⚠️ 许可证状态:sv-particles 仓库无 LICENSE(默认 All Rights Reserved),
   因此本批不逐字复制其源码;仅采用不受版权保护的数值参数(旋转角/缓动/时长),
   实现为自有代码,并在 THIRD_PARTY_NOTICES.md 登记"批量采用需作者授权"。 */

const assert = require('node:assert');
const fs = require('node:fs');

const css = fs.readFileSync('electron/renderer/sv.css', 'utf8');
const chat = fs.readFileSync('electron/renderer/dsh_chat.ts', 'utf8');

/* rotating-toggle 参数:加号旋 135°,弹性曲线 cubic-bezier(0.68,-0.6,0.32,1.6),500ms */
assert.match(css, /\.dshw-add\[aria-expanded='true'\] svg\s*\{[^}]*rotate\(135deg\)/s,
  'composer + rotates to 135deg while its menu is open');
assert.match(css, /\.dshw-add svg\s*\{[^}]*transition:[^\n;}]*transform\s+500ms\s+cubic-bezier\(0\.68,\s*-0\.6,\s*0\.32,\s*1\.6\)|\.dshw-add svg\s*\{[^}]*transition:[^\n;}]*500ms[^\n;}]*cubic-bezier\(0\.68,\s*-0\.6/s,
  '+ rotation rides the springy bezier from the source');

/* copy-with-feedback 参数:成功反馈 2 秒后回弹(dsh_chat.ts 原为 1000ms) */
assert.match(chat.replace(/\s+/g, ' '), /window\.setTimeout\(\(\) => \{[^}]*\}, 2000\)/,
  'copy check feedback reverts after 2000ms like the source');

console.log('studio_particles_micro_contract ok');
