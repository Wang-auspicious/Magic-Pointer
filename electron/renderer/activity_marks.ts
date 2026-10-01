type MarkName = 'spark' | 'incognito' | 'reflectBroadcast';

interface MarkOptions {
  className?: string;
}

const MARKS = {
  // Neutral MP activity mark. The Claude clay asterisk is deliberately gone.
  spark: `<svg data-cds="Spark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle class="spark-track" cx="10" cy="10" r="7" opacity="0.28"></circle><circle class="spark-arc" cx="10" cy="10" r="7" stroke-dasharray="30 44"></circle></svg>`,
  incognito: `<svg width="100%" height="100%" viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg" class="group" aria-hidden="true" style="flex-shrink: 0;"><g class="group-hover:animate-[icon-ghost-look-around_2.4s_ease-in-out_infinite] group-active:animate-none"><path d="M6.99951 8.66672C7.5518 8.66672 7.99951 9.11443 7.99951 9.66672C7.9993 10.2188 7.55166 10.6667 6.99951 10.6667C6.44736 10.6667 5.99973 10.2188 5.99951 9.66672C5.99951 9.11443 6.44723 8.66672 6.99951 8.66672Z"></path><path d="M12.9995 8.66672C13.5518 8.66672 13.9995 9.11443 13.9995 9.66672C13.9993 10.2188 13.5517 10.6667 12.9995 10.6667C12.4474 10.6667 11.9997 10.2188 11.9995 9.66672C11.9995 9.11443 12.4472 8.66672 12.9995 8.66672Z"></path></g><path fill-rule="evenodd" clip-rule="evenodd" d="M10 2C14.326 2.00018 17.9998 5.67403 18 10V17.3123C17.9997 17.5427 17.8411 17.8079 17.6172 17.8623C17.3932 17.9165 17.1614 17.7456 17.0557 17.5408C16.7805 17.007 16.3658 16.5937 16.062 16.2878C15.7793 16.0034 15.4503 15.8338 14.9771 15.8337C14.2092 15.8339 13.4371 16.3862 12.9487 17.53C12.8701 17.7138 12.6887 17.8621 12.4888 17.8623C12.2888 17.8623 12.1076 17.7138 12.0288 17.53C11.5404 16.386 10.7674 15.8339 9.99951 15.8337C9.23161 15.8339 8.45959 16.386 7.97119 17.53C7.89253 17.7138 7.71118 17.8621 7.51123 17.8623C7.31122 17.8623 7.13006 17.7138 7.05127 17.53C6.56296 16.3862 5.78982 15.834 5.02197 15.8337C4.54861 15.8338 4.21974 16.0032 3.93701 16.2878C3.63309 16.5937 3.21952 17.0715 2.94434 17.6055C2.83865 17.8103 2.60589 17.9165 2.38184 17.8623C2.15801 17.8079 2.00033 17.6073 2 17.377V10C2.00018 5.67403 5.67403 2.00018 10 2ZM10 3C6.22631 3.00018 3.00018 6.22631 3 10V15.8633C3.0205 15.8414 3.20696 15.6049 3.22803 15.5837C3.67524 15.1336 4.251 14.8338 5.02197 14.8337C6.03838 14.8341 6.90232 15.4025 7.51025 16.2937C8.11828 15.4018 8.9824 14.8338 9.99951 14.8337C11.0163 14.8338 11.8798 15.4022 12.4878 16.2937C13.0959 15.4018 13.9601 14.8339 14.9771 14.8337C15.7481 14.8338 16.3247 15.1336 16.772 15.5837C16.772 15.5837 16.9796 15.812 17 15.8337V10C16.9998 6.22631 13.7737 3.00018 10 3Z"></path></svg>
`,
  reflectBroadcast: `<svg data-cds="Icon" width="100%" height="100%" viewBox="0 0 20 20" fill="currentColor" fill-rule="evenodd" stroke="none" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" class="shrink-0 text-secondary" aria-hidden="true" style="flex-shrink: 0; font-size: calc(1.25rem * var(--cds-rem-scale, 1));"><path d="M14.584 15.3008C14.9151 15.3011 15.1836 15.5692 15.1836 15.9004C15.1834 16.2314 14.9149 16.4996 14.584 16.5H5.41699C5.08575 16.5 4.81759 16.2316 4.81738 15.9004C4.81738 15.569 5.08562 15.3008 5.41699 15.3008H14.584ZM17.8994 12.4004C18.2308 12.4004 18.5 12.6686 18.5 13C18.5 13.3314 18.2308 13.5996 17.8994 13.5996H2.09961C1.76842 13.5994 1.5 13.3312 1.5 13C1.5 12.6688 1.76842 12.4006 2.09961 12.4004H17.8994ZM10 3.5C13.6449 3.5 16.5994 6.45471 16.5996 10.0996C16.5996 10.431 16.3314 10.6992 16 10.6992C15.6686 10.6992 15.4004 10.431 15.4004 10.0996C15.4002 7.11745 12.9822 4.69922 10 4.69922C7.01779 4.69922 4.59982 7.11745 4.59961 10.0996C4.59961 10.431 4.33137 10.6992 4 10.6992C3.66863 10.6992 3.40039 10.431 3.40039 10.0996C3.4006 6.45471 6.35505 3.5 10 3.5Z"></path></svg>
`,
};

function kebabName(mark: MarkName): string {
  return mark.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

function names(): MarkName[] {
  return (Object.keys(MARKS) as MarkName[]).sort();
}

function svg(name: string, options: MarkOptions = {}): string {
  if (!Object.hasOwn(MARKS, name)) {
    return '';
  }
  const mark = name as MarkName;
  const source = MARKS[mark];
  const className =
    typeof options.className === 'string' ? options.className : '';
  const merged = className
    ? `${kebabName(mark)} ${className}`
    : kebabName(mark);
  const tagEnd = source.indexOf('>');
  const head = source.slice(0, tagEnd);
  const open = head.indexOf('class="');
  const close = open === -1 ? -1 : head.indexOf('"', open + 7);
  const tag =
    close === -1
      ? `${head} class="${merged}"`
      : `${head.slice(0, close)} ${merged}${head.slice(close)}`;
  return tag + source.slice(tagEnd);
}

function spark(state: 'idle' | 'thinking' | 'writing' = 'idle'): string {
  const still = svg('spark');
  if (state === 'idle') {
    return still;
  }
  const duration = state === 'thinking' ? 1100 : 800;
  return `<span class="mp-spark-animation" data-cds="Spark" data-state="${state}" style="--spark-duration:${duration}ms" aria-hidden="true">${still}</span>`;
}

const ActivityMarks = {MARKS, names, svg, spark};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ActivityMarks;
}
if (typeof globalThis !== 'undefined') {
  (
    globalThis as typeof globalThis & {ActivityMarks?: typeof ActivityMarks}
  ).ActivityMarks = ActivityMarks;
}
if (typeof document !== 'undefined') {
  document.querySelectorAll('.mp-account-mark').forEach(node => {
    node.innerHTML = spark();
  });
}
