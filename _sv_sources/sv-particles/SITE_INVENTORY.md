# sv-particles 全站组件清单

- 站点: https://sv-particles.vercel.app
- 索引页: /particles(导航列出 11 个分类)
- 开源仓库: https://github.com/SikandarJODD/sv-particles(branch: master,最后推送 2026-07-12)
- 技术栈: SvelteKit + Svelte 5 + Tailwind CSS v4 + TypeScript(shadcn-svelte 体系,灵感来自 COSS UI Particles)
- 核对方式: sitemap.xml + 索引页 href + 逐页 HTTP 探测,并与仓库 master 的 data.ts 变体名交叉验证(一致)

## 分类与变体全清单(站点实际提供)

| 分类 | 站点页面 | 变体数 | 变体 |
|---|---|---|---|
| accordion | /particles/accordion | 4 | Basic · Multiple Panels · With One Panel · Controlled |
| alert-dialog | /particles/alert-dialog | 2 | Basic Alert Dialog · Alert Dialog with Bare Footer |
| avatars | /particles/avatars | 14 | Basic Avatar · Fallback Only · With Different Sizes · With Different Radii · Overlapping Avatar Group · Small/Large Overlapping Avatar Group · With User Icon Fallback · With Emerald/Muted Status Dot · Rounded With Emerald Status Dot · With (Rounded) Notification Badge · With Verify Badge |
| banner | /particles/banner | 12 | Banner 1–12 |
| button | /particles/button | 32 | Default/Outline/Secondary/Destructive/Ghost Button · Link · Link Button · Extra Small/Small/Large · Disabled · Icon/Small Icon/Large Icon · Button With Icon · Show More Less Toggle · Back Link Chevron · Card Style · Direction Pad Controls · Outline Like With Count · QR Code Signin · With Avatar · Pill · Get Started · Print · Message Notification · Cancel Save · Animated Status Dot · Copy Button · Copy With Feedback · Rotating Toggle · Hamburger Menu |
| data-table | /particles/data-table | 13 | Basic · Simple · Full · Sortable · Search · Filter · Pagination · Column Visibility · Frozen Column (+dropdown) · Sticky Column Dropdown · Sticky Horizontal |
| input | /particles/input | 13 | Basic · Disabled · File · With Label · Label+Required · Optional Label · Readonly · Pill Shaped · Button Using Group · Characters Remaining Count · Password w/ Strength Indicator · Password Toggle · Custom Border Background |
| input-group | /particles/input-group | 30 | Basic · Start/End Text · Start/End Icon · Start/End Tooltip · Keyboard Shortcut · Inner Label · Disabled · Loading Spinner(start/end/inner) · Textarea · Icon Button · Button · Badge · Badge+Menu · Mini Editor Group Toggle · Search · Clear Button · Search Input w/ Loader & Voice · Character Count · Password Strength · Code Snippet w/ Language Selector · Message Composer w/ Attachments · Chat Input w/ Voice & Send · Mimicking URL Bar · Keyboard Shortcut Search |
| input-otp | /particles/input-otp | 8 | Basic OTP · Separator · Field Label · Custom Sanitization · Auto Validation · Alpha Numeric · Placeholder Caret · Masked |
| menu | /particles/menu | 8 | Basic · Checkbox · Checkbox Items As Switches · Radio Group · Link · Group Labels · Nested · Close On Click |
| table | /particles/table | 11 | Basic · Images · No Horizontal Divider · Striped · Vertical Lines · Dense · Row Selection · Card · Vertical · Sticky Header · Unique |

## 未入索引但存在

- **/particles/tabs**(HTTP 200,未列入索引页/sitemap):Tab 1–12 共 12 个标签页变体
- **/particles/kbd**:404(仓库 master 已有 kbd 分类:Keyboard Shortcut;站点未部署该页)

## 许可证状态

**未发现任何开源许可证。** 全仓库无 LICENSE 文件(GitHub API license 字段为空)、package.json 无 license 字段、README 与站点页脚均无授权声明。默认版权全保留(All Rights Reserved),作者 Bhide Svelte(SikandarJODD)。如需在产品中直接复制代码,应先联系作者获得授权;在此之前仅可作视觉/交互参考。
