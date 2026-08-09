// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
/* 图标精灵：1.5px 细描边、圆头、24×24 网格。studio 与 companion 共用。 */
document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" class="icon-sprite" aria-hidden="true"><defs>
<g id="i-base" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></g>
</defs>
<symbol id="ic-shake" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5 14.5 19l2-6 6-2z"/><path d="M4 8.5c-.9 1.9-.9 4.1 0 6M1.6 6.4c-1.5 3.2-1.5 7 0 10.2"/></symbol>
<symbol id="ic-crop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2.5v12a2 2 0 0 0 2 2h12"/><path d="M2.5 6.5h12a2 2 0 0 1 2 2v12"/></symbol>
<symbol id="ic-stroke" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13M4 12h9"/><path d="M3 17.5c2.5-2.2 5-2.2 7.5 0s5 2.2 7.5 0 3.5-1.6 5-.6"/></symbol>
<symbol id="ic-target" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="6.5" width="11" height="11" rx="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></symbol>
<symbol id="ic-timeline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><circle cx="7" cy="7" r="2"/><circle cx="7" cy="17" r="2"/><path d="M12 7h8M12 17h6"/></symbol>
<symbol id="ic-memory" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 6.2A6 6 0 0 0 12 17.5"/></symbol>
<symbol id="ic-stash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="13" height="12" rx="3"/><path d="M8 5h11a2 2 0 0 1 2 2v9"/></symbol>
<symbol id="ic-docs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="13" height="16" rx="2.5"/><path d="M4 6.5V19a2.5 2.5 0 0 0 2.5 2.5H16"/></symbol>
<symbol id="ic-spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c.4 4.4 4.6 8.6 9 9-4.4.4-8.6 4.6-9 9-.4-4.4-4.6-8.6-9-9 4.4-.4 8.6-4.6 9-9Z"/></symbol>
<symbol id="ic-pen" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5 19 8 9.5 17.5l-4.5 1 1-4.5z"/><path d="M4 21h16"/></symbol>
<symbol id="ic-plug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h9a5 5 0 0 1 5 5v9H10a5 5 0 0 1-5-5z"/><path d="M19 8.5h2.5a2 2 0 0 1 0 4H19"/></symbol>
<symbol id="ic-mcp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="8" height="8" rx="2"/><path d="M11 4v4M14 4v4M11 16v4M14 16v4M4 11h4M4 14h4M16 11h4M16 14h4"/></symbol>
<symbol id="ic-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5c3-4.3 6.2-6.5 9.5-6.5s6.5 2.2 9.5 6.5"/><circle cx="12" cy="13" r="3"/></symbol>
<symbol id="ic-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 4.5 6v6c0 4.4 3.1 8.2 7.5 9.2 4.4-1 7.5-4.8 7.5-9.2V6z"/><circle cx="12" cy="11" r="1.6"/><path d="M12 12.6V15"/></symbol>
<symbol id="ic-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="4"/><path d="M6.5 12h2.2l1.6-3.2 2.4 6 1.6-2.8h2.2"/></symbol>
<symbol id="ic-inject" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="18" height="8" rx="2.5"/><path d="M12 2v7M9 6.5l3 3 3-3"/></symbol>
<symbol id="ic-handoff" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.5 15 6l-2 6 2 6z"/><circle cx="19.5" cy="12" r="2.2"/></symbol>
<symbol id="ic-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10.5 11 17.5a4 4 0 0 1-5.7-5.7l7.5-7.5a2.7 2.7 0 0 1 3.8 3.8l-7.4 7.4a1.4 1.4 0 0 1-2-2l6.8-6.8"/></symbol>
<symbol id="ic-at" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.6"/><path d="M15.6 12v1.9a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.4 7"/></symbol>
<symbol id="ic-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></symbol>
<symbol id="ic-send" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></symbol>
<symbol id="ic-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5 12 15l6-5.5"/></symbol>
<symbol id="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M8.4 12.3 11 15l4.8-5.4"/></symbol>
<symbol id="ic-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="8.6"/></symbol>
<symbol id="ic-loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 3.4a8.6 8.6 0 1 1-6.1 2.5"/></symbol>
<symbol id="ic-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></symbol>
<symbol id="ic-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8.5 6.5 12 3l3.5 3.5"/><path d="M8.5 17.5 12 21l3.5-3.5"/><path d="M4 12h3M17 12h3"/></symbol>
<symbol id="ic-arrow-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5.5 11.5 6.5-6.5 6.5 6.5"/></symbol>
<symbol id="ic-stop" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2.4"/></symbol>
<symbol id="ic-redo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12a8.4 8.4 0 1 1-2.6-6.1"/><path d="M20.8 4.6v4h-4"/></symbol>
<symbol id="ic-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.6v2.2M12 19.2v2.2M4.6 12H2.4M21.6 12h-2.2M6.8 6.8 5.2 5.2M18.8 18.8l-1.6-1.6M17.2 6.8l1.6-1.6M5.2 18.8l1.6-1.6"/></symbol>
<symbol id="ic-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h4"/></symbol>
<symbol id="ic-code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 8.5 5 12l4 3.5M15 8.5l4 3.5-4 3.5"/></symbol>
<symbol id="ic-img" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l4.6-4.2 3.4 3 2.8-2.4 5.2 4.6"/></symbol>
<symbol id="ic-play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M10.3 9.2 15 12l-4.7 2.8z"/></symbol>
<symbol id="ic-term" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M7.5 10 10 12.2l-2.5 2.2M12.5 15h4"/></symbol>
<symbol id="ic-window" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M3 9h18"/></symbol>
<symbol id="ic-cursor" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l11.5 7-5 1.3-1.6 5z"/></symbol>
<symbol id="ic-search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></symbol>
<symbol id="ic-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></symbol>
<symbol id="ic-hist" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1L3.5 8.4"/><path d="M3.2 4.6v4h4M12 7.8V12l3 1.8"/></symbol>
<symbol id="ic-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h10v10M19 5 8 16M15 19H5V9"/></symbol>
<symbol id="ic-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.8v4.6M12 15.8v.2"/></symbol>
<symbol id="ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5h-9a3 3 0 0 0-3 3v9"/></symbol>
<symbol id="ic-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.5h7.8A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z"/></symbol>
<symbol id="ic-sliders" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/></symbol>
<symbol id="ic-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6l-.8 6.2 3.3 3.3H6.5l3.3-3.3z"/><path d="M12 12.5V21"/></symbol>
</svg>
`);

/* 烟雾滤镜：静态湍流 + 位移贴图。
   噪声本身不动（动它每帧都要重算，很贵），动的是底下那几层渐变——
   它们被湍流场推着走，看起来就是内部在翻滚，而不是一团色块在平移。 */
document.body.insertAdjacentHTML("afterbegin", `<svg width="0" height="0" class="icon-sprite" aria-hidden="true"><defs>
  <filter id="smoke-lg" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.014 0.022" numOctaves="3" seed="7" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="34" xChannelSelector="R" yChannelSelector="G" result="d"/>
    <feGaussianBlur in="d" stdDeviation="7"/>
  </filter>
  <filter id="smoke-sm" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.05 0.07" numOctaves="2" seed="3" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</defs></svg>`);
