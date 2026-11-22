import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  scanKnowledgeVault,
  type VaultNoteSummary,
  type VaultOverview,
} from './knowledge_vault';

export const DEFAULT_ATHENAEUM_DIR = 'D:\\Desktop\\Athenaeum';
export const DEFAULT_PERSISTENCE_DIR = 'D:\\Desktop\\Persistence';
export const ROADSHOW_CS336_COURSE_ID = 'stanford-cs336';
export const ROADSHOW_ARTIFACT_VERSION = 'cs336-swiglu-v1';

export interface LearnMaterialItem {
  id: string;
  title: string;
  path: string;
  kind: 'lecture' | 'assignment' | 'note' | 'code' | 'asset' | 'other';
  category: string;
  sizeBytes?: number;
}

export interface LearnDagNode {
  id: string;
  title: string;
  summary: string;
  phase: 'foundation' | 'mechanism' | 'code' | 'synthesis';
  status: 'mastered' | 'current' | 'stuck' | 'locked';
  prereqIds: string[];
  materialPaths?: string[];
  workedExampleTag?: string;
  lastAttemptNote?: string;
}

export interface LearnReaderProfile {
  mathLevel: 0 | 1 | 2 | 3;
  handsOnLevel: 0 | 1 | 2 | 3;
  longTermPrefs: Array<{date: string; pref: string; quote: string}>;
  densitySignals: Array<{
    date: string;
    doc: string;
    blockType: string;
    signal: 'verbose' | 'confused';
  }>;
  conceptStates: Record<
    string,
    {
      status: 'stuck' | 'mastered' | 'probed';
      lastAngle: string;
      evidence: string;
      updatedAt: string;
    }
  >;
}

export interface LearnAnnotationMark {
  id: string;
  type: 'hl' | 'note' | 'fb';
  fb?: 'confused' | 'verbose' | 'known';
  quote: string;
  section: string;
  note?: string;
  createdAt: string;
}

export interface LearnCheckinRecord {
  id: string;
  question: string;
  selectedIndex: number | null;
  selectedLabel: string;
  unsure: boolean;
  reasoningNote: string;
  nodeId?: string;
  createdAt: string;
}

export interface LearnDreamNudge {
  id: string;
  kind: 'unblock_stuck' | 'cross_bridge' | 'worked_trace' | 'code_bench';
  title: string;
  rationale: string;
  estimatedMinutes: number;
  launchPrompt: string;
  targetNodeId?: string;
}

export interface LearnDreamRecord {
  id: string;
  runAt: string;
  synthesizedInsights: string[];
  prunedNotes: string[];
  crossBridges: Array<{
    fromTitle: string;
    toTitle: string;
    toPath: string;
    insight: string;
  }>;
  nudges: LearnDreamNudge[];
  memoryFilePath: string;
}

export interface LearnCourse {
  id: string;
  title: string;
  subtitle: string;
  rootDir: string;
  vaultDir: string;
  materials: LearnMaterialItem[];
  dag: LearnDagNode[];
  profile: LearnReaderProfile;
  livingArtifact: {
    title: string;
    updatedAt: string;
    html: string;
    markdown: string;
    annotations: LearnAnnotationMark[];
    checkins: LearnCheckinRecord[];
  };
  dreamHistory: LearnDreamRecord[];
  updatedAt: string;
}

export interface LearnCourseSummary {
  id: string;
  title: string;
  subtitle: string;
  rootDir: string;
  vaultDir: string;
  materialCount: number;
  nodeCount: number;
  masteredCount: number;
  stuckCount: number;
  currentNodeTitle?: string;
  initialized: boolean;
  updatedAt: string;
}

export interface LearnCourseListResult {
  activeCourseId: string;
  courses: LearnCourseSummary[];
}

export interface LearnCourseStoreOptions {
  athenaeumDir?: string;
  persistenceDir?: string;
}

export interface NeuralNode {
  id: string;
  label: string;
  group: 'course' | 'vault' | 'concept' | 'code' | 'stuck';
  status?: 'mastered' | 'current' | 'stuck' | 'locked';
  degree: number;
  sourcePath?: string;
  excerpt?: string;
  courseId?: string;
}

export interface NeuralEdge {
  source: string;
  target: string;
  kind: 'prereq' | 'wikilink' | 'cross-bridge' | 'tag';
  label?: string;
}

export interface LearnNeuralGraph {
  nodes: NeuralNode[];
  edges: NeuralEdge[];
  stats: {
    totalNodes: number;
    courseNodes: number;
    vaultNodes: number;
    stuckNodes: number;
    crossLinks: number;
  };
}

export interface LearnCoursePromptSummary {
  courseTitle: string;
  currentNodeTitle: string;
  stuckConcepts: string[];
  recentAnnotations: Array<{
    type: string;
    fb?: string;
    quote: string;
    section: string;
    note?: string;
  }>;
  latestDreamInsights: string[];
}

interface LearnIndexFile {
  activeCourseId: string;
}

const IGNORED_ATHENAEUM_DIRS = new Set([
  '.git',
  '.obsidian',
  '.vscode',
  '.idea',
  'node_modules',
  '__pycache__',
  'agent-memory',
]);

const CODE_EXTS = new Set(['.py', '.ts', '.js', '.c', '.cpp', '.rs', '.sh']);
const ASSET_EXTS = new Set(['.png', '.jpg', '.jpeg', '.svg', '.webp']);
const MATERIAL_DIRS = ['lectures', 'assignments', 'notes', 'scripts'] as const;

const XRAY_HEAD_HTML = String.raw`<!-- ===== XRAY HEAD START ===== -->
<script>(function(){var t;try{t=localStorage.getItem('theme')}catch(e){}if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var q=location.search;if(/[?&]theme=dark/.test(q))t='dark';if(/[?&]theme=light/.test(q))t='light';document.documentElement.setAttribute('data-theme',t)})();</script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"></script>
<!-- ===== XRAY HEAD END ===== -->`;

const XRAY_PAGE_CSS = String.raw`/* ===== XRAY PAGE CSS START ===== */
:root{
  --bg:#FAF9F5;--surface-secondary:#F3F3F0;--surface-code:#F9F9F7;--surface-raised:#FFFFFF;
  --ink:#141413;--ink-secondary:#3D3D3A;--ink-tertiary:#73726C;
  --accent:#184F95;--accent-hover:#133E76;--accent-text:#184F95;--highlight:#EDECE8;--line:rgba(11,11,11,0.09);
  --bench:#F3F3F0;--mark:#EDECE8;--mark-note:#F3F3F0;
  --serif:"Anthropic Serif","Tiempos Text","Source Serif 4",Georgia,"Noto Serif SC",serif;
  --sans:"Anthropic Sans",-apple-system,"Segoe UI","Noto Sans SC",sans-serif;
  --mono:"Anthropic Mono","JetBrains Mono",Consolas,monospace;
}
[data-theme="dark"]{
  --bg:#212120;--surface-secondary:#262624;--surface-code:#262624;--surface-raised:#30302E;
  --ink:#FAF9F5;--ink-secondary:#C2C0B6;--ink-tertiary:#9C9A92;
  --accent:#6394E3;--accent-hover:#86ACEA;--accent-text:#86ACEA;--highlight:#3D3D3A;--line:#3D3D3A;
  --bench:#262624;--mark:#3D3D3A;--mark-note:#30302E;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:17px/1.78 var(--serif);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
#progress{position:fixed;top:0;left:0;height:2px;width:0;background:var(--accent);opacity:.38;z-index:20;transition:opacity .4s}
.top{position:fixed;top:12px;left:20px;z-index:15;display:flex;gap:16px;align-items:center}
.top button{all:unset;cursor:pointer;color:var(--ink-tertiary);font:16px var(--sans);position:relative;line-height:1}
.top button:hover,.top button:focus-visible{color:var(--ink)}
.top button.on{color:var(--accent)}
.top button.dirty::after{content:"";position:absolute;right:-5px;top:-2px;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.wrap{max-width:1560px;margin:0 auto;padding:56px 48px 120px;display:grid;grid-template-columns:224px minmax(0,1fr);gap:48px;align-items:start}
body.nav-hidden .wrap{grid-template-columns:minmax(0,1fr)}
body.nav-hidden .toc{display:none}
.toc{position:sticky;top:36px;font:13px/1.55 var(--sans)}
.toc a{color:var(--ink-tertiary);text-decoration:none;padding:4px 0 4px 10px;border-left:2px solid transparent;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.toc a.h3{padding-left:22px;font-size:12.5px}
.toc a:hover{color:var(--ink)}
.toc a.cur{color:var(--ink);border-left-color:var(--accent)}
main{min-width:0;position:relative}
main>p,main>ul,main>ol,main>h1,main>h2,main>h3,main>blockquote,.xr-sec>p,.xr-sec>ul,.xr-sec>ol,.xr-sec>blockquote,.xr-sec>h3,div.note,div.warn,.bench,.steps,.info,.tcap{max-width:var(--measure,88ch)}
h1{font-size:31px;line-height:1.28;font-weight:700;letter-spacing:-.015em;border-bottom:3px double var(--line);padding-bottom:14px;margin:0 0 18px}
h2{font-size:22px;line-height:1.38;font-weight:700;margin:64px 0 14px}
h3{font-size:18px;font-weight:700;margin:34px 0 8px}
a{color:var(--accent-text)}
.info{font:14.5px/1.7 var(--sans);color:var(--ink-secondary);margin:0 0 22px}
.info b{color:var(--ink);font-weight:600}
.info .k{display:inline-block;min-width:5.5em;color:var(--ink-tertiary)}
div.note,div.warn{padding:12px 18px;font-size:14.5px;line-height:1.7;margin:22px 0;border-left:3px solid var(--accent)}
div.note{background:var(--surface-secondary)}
div.warn{background:var(--surface-raised);border:1px solid var(--line);border-left:3px solid var(--ink-tertiary)}
div.note b:first-child,div.warn b:first-child{font-family:var(--sans);font-size:13px;letter-spacing:.04em;margin-right:.6em}
.bench{background:var(--bench);border:1px solid var(--line);padding:14px 20px;margin:22px 0;border-radius:6px}
.bench>p{margin:0 0 .7em}.bench>p:last-child{margin-bottom:0}
.steps{border-left:1px solid var(--line);padding-left:18px;margin:22px 0}
.steps .st{font:13px var(--mono);letter-spacing:.06em;color:var(--ink-tertiary);margin-top:14px}
.pill{font:13px var(--mono);background:var(--surface-secondary);border:1px solid var(--line);border-radius:4px;padding:0 6px}
.side{float:right;clear:right;width:220px;margin:4px -260px 10px 0;font:14px/1.6 var(--sans);color:var(--ink-tertiary)}
code{font:14px var(--mono);color:var(--accent-text)}
pre.code{background:var(--surface-code);border:1px solid var(--line);border-left:2px solid var(--ink-tertiary);padding:30px 18px 14px;font:13.5px/1.6 var(--mono);overflow:auto;position:relative;margin:0;border-radius:4px}
pre.code::before{content:attr(data-label);position:absolute;top:8px;left:18px;color:var(--ink-tertiary);font-size:12px}
pre.code .c{color:var(--ink-tertiary)} pre.code .n{color:var(--accent-text)}
details.code{margin:22px 0;max-width:100%}
details.code>summary{cursor:pointer;font:13.5px var(--mono);color:var(--ink-tertiary);list-style:none;padding:6px 0}
details.code>summary::before{content:"▸ ";}
details.code[open]>summary::before{content:"▾ ";}
details.code>summary:hover{color:var(--ink)}
table.t{border-collapse:collapse;font:14.5px/1.5 var(--sans);margin:18px 0;font-variant-numeric:tabular-nums}
table.t th,table.t td{padding:5px 14px;border-bottom:1px solid var(--line);text-align:right}
table.t th:first-child,table.t td:first-child{text-align:left}
table.t.left th,table.t.left td{text-align:left}
table.t th{color:var(--ink-tertiary);font-weight:500}
table.t tr.hl td{background:var(--highlight)}
.tcap{font-size:14px;color:var(--ink-tertiary);margin:-8px 0 26px}
figure.pf{margin:26px 0 8px}
figure.pf img{max-width:100%;display:block;border-radius:2px}
.katex{font-size:1.04em}
.xr-fold{all:unset;cursor:pointer;color:var(--ink-tertiary);font:12px var(--sans);width:18px;display:inline-block;margin-left:-22px;text-align:center;opacity:.35;transition:opacity .2s,transform .2s}
h2:hover .xr-fold,h3:hover .xr-fold,.xr-fold:focus-visible,.folded>.xr-fold{opacity:1}
.folded>.xr-fold{transform:rotate(-90deg)}
.xr-sec.closed{display:none}
.xr-m{color:inherit;border-radius:2px;padding:0 1px;cursor:context-menu}
.xr-hl{background:var(--mark)}
.xr-note{background:var(--mark-note)}
.xr-fb{background:none;text-decoration:underline dotted var(--ink-tertiary);text-underline-offset:4px}
.xr-fb[data-fb="confused"]{text-decoration:underline wavy var(--accent);text-decoration-thickness:1px}
.xr-m.flash{outline:2px solid var(--accent);outline-offset:1px}
.xr-ui{position:fixed;z-index:30;font:13.5px var(--sans);display:none}
.xr-bar{background:#141413;color:#FAF9F5;border:1px solid #3D3D3A;border-radius:7px;padding:4px 6px;white-space:nowrap}
.xr-bar button,.xr-menu button{all:unset;cursor:pointer;padding:3px 9px;border-radius:4px}
.xr-bar button:hover,.xr-bar button:focus-visible{background:#3D3D3A}
.xr-bar .sep{display:inline-block;width:1px;height:14px;background:#3D3D3A;vertical-align:middle;margin:0 3px}
.xr-bar .fb{display:none}.xr-bar.fbopen .fb{display:inline-block}.xr-bar.fbopen .fbbtn{display:none}
.xr-menu{background:var(--surface-raised);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px}
.xr-menu button:hover{background:var(--surface-secondary)}
.xr-toast{left:50%;bottom:34px;transform:translate(-50%,12px);opacity:0;background:var(--surface-raised);color:var(--ink-secondary);border:1px solid var(--line);border-radius:8px;padding:7px 16px;transition:opacity .25s,transform .35s cubic-bezier(.4,0,.2,1)}
.xr-toast.show{opacity:1;transform:translate(-50%,0)}
.xr-toast i{font-style:normal;color:var(--accent);margin-right:6px;display:inline-block}
.xr-margin{position:absolute;top:0;width:280px}
.xr-card{position:absolute;left:0;width:100%;background:var(--surface-raised);border:1px solid var(--line);border-left:2px solid var(--accent);border-radius:4px;padding:8px 12px 10px;font:13.5px/1.6 var(--sans);color:var(--ink-secondary)}
.xr-card::before{content:"";position:absolute;left:-26px;top:14px;width:24px;border-top:1px solid var(--accent);opacity:.6}
.xr-card .q{color:var(--ink-tertiary);font-size:12.5px;border-left:2px solid var(--line);padding-left:8px;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.xr-card textarea{all:unset;display:block;width:100%;min-height:1.6em;color:var(--ink);white-space:pre-wrap;word-break:break-word}
.xr-card.inline{position:relative;margin:10px 0 18px;max-width:88ch}
.xr-card.inline::before{display:none}
body.xr-annot main{cursor:text}
.mp-inline-checkin{max-width:var(--measure,88ch);margin:24px 0;padding:18px 20px;background:var(--surface-raised);border:1px solid var(--line);border-radius:8px;font-family:var(--sans)}
.mp-checkin-kicker{font:600 11.5px/1.4 var(--mono);letter-spacing:.08em;color:var(--ink-tertiary);margin:0 0 6px}
.mp-checkin-prompt{margin:0 0 14px;font:600 15.5px/1.55 var(--sans);color:var(--ink)}
.mp-checkin-options{display:flex;flex-direction:column;gap:8px;margin:0 0 12px}
.mp-checkin-opt{all:unset;box-sizing:border-box;display:block;width:100%;padding:9px 12px;border-radius:6px;border:1px solid var(--line);background:var(--surface-secondary);color:var(--ink-secondary);font:14px/1.5 var(--sans);cursor:pointer}
.mp-checkin-opt:hover,.mp-checkin-opt:focus-visible{border-color:var(--ink-tertiary);color:var(--ink)}
.mp-checkin-opt.is-selected{background:var(--highlight);border-color:var(--ink-tertiary);color:var(--ink);font-weight:600}
.mp-checkin-note{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);padding:8px 10px;font:13.5px/1.5 var(--sans);resize:vertical;margin:0 0 12px}
.mp-checkin-actions{display:flex;align-items:center;gap:12px}
.mp-checkin-submit{border:1px solid var(--ink);background:var(--ink);color:var(--bg);border-radius:6px;padding:7px 14px;font:500 13.5px var(--sans);cursor:pointer}
.mp-checkin-status{font:13px var(--sans);color:var(--ink-tertiary)}
@media (max-width:1100px){
  .wrap{grid-template-columns:minmax(0,1fr)}
  .toc{display:none;position:fixed;top:44px;left:16px;z-index:16;background:var(--surface-raised);border:1px solid var(--line);padding:12px 16px;max-height:70vh;overflow:auto;width:280px}
  body.nav-open .toc{display:block}
  .side{float:none;width:auto;margin:10px 0;padding-left:12px;border-left:2px solid var(--line)}
}
@media (max-width:640px){.wrap{padding:52px 20px 80px}h1{font-size:25px}body{font-size:16px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{.top,#progress,.xr-ui,.xr-fold{display:none!important}.xr-sec.closed{display:block}}
/* ===== XRAY PAGE CSS END ===== */`;

const FIGKIT_TOKENS_CSS = String.raw`/* ===== FIGKIT TOKENS START ===== */
:root{
  --in:#1a6fa3;   --in-fill:#e2eff5;   --in-hi:#b5d8ec;
  --out:#9e5c00;  --out-fill:#f8ecd2;  --out-hi:#f0cf8a;
  --op:#0b7a5c;   --op-fill:#dcf2e8;   --op-hi:#a9e3cc;
  --norm:#7a6b00; --norm-fill:#f8f4cf; --norm-hi:#efe58a;
  --loss:#b34a06; --loss-fill:#f9e3d6; --loss-hi:#f1bd9c;
  --alt:#6a55c2;  --alt-fill:#ebe7f8;  --alt-hi:#cdc2f0;
  --param:#a8457c;
  --wire:#6e737b;
  --fig-ink:var(--ink);
  --stack-fill:#f2f0e8; --stack-line:#c9c6bb;
  --cell:#f0eee6; --cell-line:#c9c6bb;
}
[data-theme="dark"]{
  --in:#56b4e9;   --in-fill:#2a4455;   --in-hi:#3e6a88;
  --out:#e69f00;  --out-fill:#4e3e1b;  --out-hi:#755d29;
  --op:#35c79a;   --op-fill:#224842;   --op-hi:#2f6b5b;
  --norm:#f0e442; --norm-fill:#4e4a1b; --norm-hi:#77702a;
  --loss:#ff8a5c; --loss-fill:#4f2c1f; --loss-hi:#7a412b;
  --alt:#b4a2f0;  --alt-fill:#38334f;  --alt-hi:#544a7e;
  --param:#e4a0c8;
  --wire:#9aa0a8;
  --fig-ink:#e6e6e6;
  --stack-fill:#262624; --stack-line:#6e6e6e;
  --cell:#2e2e2e; --cell-line:#6e6e6e;
}
.r-in{--c:var(--in);--f:var(--in-fill);--h:var(--in-hi);color:var(--in)}
.r-out{--c:var(--out);--f:var(--out-fill);--h:var(--out-hi);color:var(--out)}
.r-op{--c:var(--op);--f:var(--op-fill);--h:var(--op-hi);color:var(--op)}
.r-norm{--c:var(--norm);--f:var(--norm-fill);--h:var(--norm-hi);color:var(--norm)}
.r-loss{--c:var(--loss);--f:var(--loss-fill);--h:var(--loss-hi);color:var(--loss)}
.r-alt{--c:var(--alt);--f:var(--alt-fill);--h:var(--alt-hi);color:var(--alt)}
.r-param{--c:var(--param);color:var(--param)}
.r-wire{--c:var(--wire);color:var(--wire)}
.fk-fig{margin:30px 0 10px;overflow-x:auto}
.fk{display:block;width:100%;height:auto;overflow:visible}
.fk text{font-family:"KaTeX_Main","Latin Modern Roman","CMU Serif","Noto Serif SC","Songti SC",serif;fill:var(--fig-ink);dominant-baseline:central}
.fk .mi{font-family:"KaTeX_Math","Latin Modern Math","CMU Serif",serif;font-style:italic}
.fk .tt{font-family:"KaTeX_Typewriter","Latin Modern Mono",Consolas,monospace}
.fk .bf{font-weight:700}
.fk [class*="r-"] text,.fk text[class*="r-"]{fill:var(--c)}
.fk tspan[class*="r-"]{fill:var(--c)}
.fk .blk>rect,.fk .node>circle{fill:var(--f);stroke:var(--c);stroke-width:1.5}
.fk .blk.on>rect,.fk .node.on>circle{fill:var(--h);stroke-width:2.8}
.fk .add>circle{fill:var(--norm-fill);stroke:var(--norm);stroke-width:1.4}
.fk .add>path{stroke:var(--norm);stroke-width:1.9;fill:none}
.fk .wire{fill:none;stroke:var(--wire);stroke-width:1.3}
.fk .wire[class*="r-"]{stroke:var(--c)}
.fk .head{fill:var(--wire)}
.fk .head[class*="r-"]{fill:var(--c)}
.fk .dot{fill:var(--wire)}
.fk .edge{stroke:var(--wire);stroke-width:1.2;opacity:.3}
.fk .edge.on{opacity:1}
.fk .stack{fill:var(--stack-fill);stroke:var(--stack-line);stroke-width:1.5}
.fk .pe>circle{fill:none;stroke:var(--wire);stroke-width:1.3}
.fk .pe>path{fill:none;stroke:var(--wire);stroke-width:1.3}
.fk .note{fill:var(--wire)}
.fk .param{fill:var(--param)}
.fk .cell text{fill:var(--fig-ink)}
.fk .cell>rect{fill:var(--cell);stroke:var(--cell-line);stroke-width:1}
.fk .cell.on>rect{fill:var(--h);stroke:var(--c);stroke-width:2.6}
.fk .hit{cursor:pointer}
.fk .lead{stroke:var(--c);stroke-width:1.3}
.fk foreignObject div{font-size:13.5px;color:var(--fig-ink);text-align:center;line-height:1.2}
.fk-ctl{display:flex;align-items:center;gap:14px;margin:6px 0 0;font:15px/1.5 "KaTeX_Main",Georgia,serif;color:var(--ink-tertiary);font-variant-numeric:tabular-nums}
.fk-ctl button{all:unset;cursor:pointer;color:var(--ink-tertiary);padding:0 2px}
.fk-ctl button:hover,.fk-ctl button:focus-visible{color:var(--ink)}
.fk-ctl .say{color:var(--ink-secondary)}
.fk-ctl input[type=range]{-webkit-appearance:none;appearance:none;width:220px;height:18px;background:transparent;cursor:pointer}
.fk-ctl input[type=range]::-webkit-slider-runnable-track{height:1px;background:var(--wire)}
.fk-ctl input[type=range]::-moz-range-track{height:1px;background:var(--wire)}
.fk-ctl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:var(--f,var(--bg,#FAF9F5));border:2px solid var(--c,var(--ink-secondary,#3D3D3A));transition:transform .15s}
.fk-ctl input[type=range]::-moz-range-thumb{width:11px;height:11px;border-radius:50%;background:var(--f,var(--bg,#FAF9F5));border:2px solid var(--c,var(--ink-secondary,#3D3D3A))}
.fk-ctl input[type=range]:hover::-webkit-slider-thumb,.fk-ctl input[type=range]:focus-visible::-webkit-slider-thumb{transform:scale(1.2)}
.fk-cap{margin:8px 0 34px;font-size:14px;color:var(--ink-tertiary);max-width:88ch}
.fk-cap b{font-weight:400;color:var(--ink-secondary);margin-right:.6em}
.fk .axis{stroke:var(--wire);stroke-width:1;fill:none}
.fk .tick{stroke:var(--wire);stroke-width:1}
.fk .curve{fill:none;stroke:var(--c,var(--wire));stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.fk .curve.thin{stroke-width:1.3}
.fk .curve.faint{stroke:var(--wire);stroke-width:1.1;opacity:.38}
.fk .curve.guide{stroke:var(--wire);stroke-width:1.1;stroke-dasharray:3 4}
.fk .pt{fill:var(--f,var(--bg));stroke:var(--c,var(--wire));stroke-width:1.9}
.fk .pt.solid{fill:var(--c,var(--wire))}
.fk .bar{fill:var(--f,var(--cell));stroke:var(--c,var(--cell-line));stroke-width:1.3;transition:fill .3s}
.fk .bar.on{fill:var(--h,var(--cell));stroke-width:2.4}
.fk .bar.faint{opacity:.35}
.fk .ref{stroke:var(--c,var(--wire));stroke-width:1.2}
@media (prefers-reduced-motion:reduce){.fk *{transition:none!important}}
/* ===== FIGKIT TOKENS END ===== */`;

const XRAY_JS = String.raw`/* ===== XRAY JS START ===== */
var XRAY = (function () {
  'use strict';
  var EN = !/^zh/i.test(document.documentElement.lang || 'zh');
  var L = EN ? { hl: 'Highlight', note: 'Note', fb: 'Feedback', confused: 'Lost', verbose: 'Too long', known: 'Got it', undo: 'Undo', got: 'Feedback received', saved: 'Saved into this file', dl: 'Downloaded. Replace the old file with it', ph: 'Write a note or a question', toc: 'Contents', theme: 'Theme', pen: 'Annotate', save: 'Save annotations into this file', fold: 'Fold section' }
               : { hl: '划线', note: '笔记', fb: '反馈', confused: '不懂', verbose: '啰嗦', known: '已懂', undo: '撤销', got: '已收到反馈', saved: '已保存到这个文件', dl: '已下载，用它替换原文件即可', ph: '写笔记或问题', toc: '目录', theme: '明暗', pen: '标注', save: '保存标注到这个文件', fold: '收起本节' };
  var queue = [], SRC = '', state, dirty = false, handle = null, main, KEY = 'xray:' + decodeURIComponent(location.pathname);
  var SKIP = 'script,style,svg,.katex-mathml,.xr-ui,.xr-card,.xr-margin,textarea,button,.fk-ctl,.toc';

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return [].slice.call((r || document).querySelectorAll(s)); }
  function now() { return new Date().toISOString(); }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function snapshot() {
    var c = document.documentElement.cloneNode(true);
    c.removeAttribute('data-theme');
    $$('.xr-ui', c).forEach(function (n) { n.remove(); });
    SRC = '<!doctype html>\n' + c.outerHTML;
    var bad = [];
    $$('.fk-fig', c).forEach(function (h) { if (h.children.length) bad.push('#' + h.id); });
    if ($('.katex', c)) bad.push('.katex');
    if (bad.length) console.warn('[XRAY] content was generated before load; move it into XRAY.ready: ' + bad.join(' '));
  }
  function serialize() {
    var json = JSON.stringify(state).replace(/</g, '\\u003c');
    return SRC.replace(/(<script type="application\/json" id="xray-notes">)[\s\S]*?(<\/script>)/, function (_, a, b) { return a + json + b; });
  }

  function load() {
    var emb = {}; try { emb = JSON.parse($('#xray-notes').textContent); } catch (e) {}
    var loc = null; try { loc = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    state = emb; state.marks = state.marks || []; state.folds = state.folds || [];
    if (loc && loc.updated && (!emb.updated || loc.updated > emb.updated)) { state.marks = loc.marks || []; state.folds = loc.folds || []; state.updated = loc.updated; dirty = true; }
  }
  function changed() {
    state.updated = now(); dirty = true;
    try { localStorage.setItem(KEY, JSON.stringify({ updated: state.updated, marks: state.marks, folds: state.folds })); } catch (e) {}
    paintDirty(); autosave();
  }
  function paintDirty() { var b = $('#xrSave'); if (b) b.classList.toggle('dirty', dirty); }

  function idb(fn) {
    return new Promise(function (res) {
      try { var r = indexedDB.open('xray', 1); r.onupgradeneeded = function () { r.result.createObjectStore('h'); }; r.onsuccess = function () { var tx = r.result.transaction('h', 'readwrite'); fn(tx.objectStore('h'), res); }; r.onerror = function () { res(null); }; } catch (e) { res(null); }
    });
  }
  function getHandle() { return idb(function (s, res) { var q = s.get(KEY); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; }); }
  function putHandle(h) { return idb(function (s, res) { s.put(h, KEY); res(true); }); }
  function fileName() { return decodeURIComponent(location.pathname.split('/').pop() || 'xray.html'); }
  function write(h) {
    state.saved = now();
    return h.createWritable().then(function (w) { return w.write(serialize()).then(function () { return w.close(); }); })
      .then(function () { dirty = false; paintDirty(); });
  }
  var timer = null;
  function autosave() {
    if (!handle || !handle.queryPermission) return;
    clearTimeout(timer);
    timer = setTimeout(function () { handle.queryPermission({ mode: 'readwrite' }).then(function (p) { if (p === 'granted') write(handle).catch(function () {}); }); }, 800);
  }
  function save() {
    if (window.showSaveFilePicker) {
      var go = handle ? handle.requestPermission({ mode: 'readwrite' }).then(function (p) { if (p !== 'granted') throw 0; return handle; })
                      : window.showSaveFilePicker({ suggestedName: fileName(), types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }] });
      go.then(function (h) { handle = h; putHandle(h); return write(h); }).then(function () { toast(L.saved); })
        .catch(function () { if (handle) { handle = null; save(); } });
      return;
    }
    state.saved = now();
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([serialize()], { type: 'text/html' })); a.download = fileName();
    document.body.appendChild(a); a.click(); a.remove(); dirty = false; paintDirty(); toast(L.dl);
  }

  function nodes() {
    var out = [], w = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentNode && n.parentNode.closest && n.parentNode.closest(SKIP) ? 2 : 1; } });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function index() {
    var ns = nodes(), starts = [], s = 0, txt = '';
    ns.forEach(function (n) { starts.push(s); s += n.data.length; txt += n.data; });
    return { ns: ns, starts: starts, txt: txt };
  }
  function rangeOffsets(r, ix) {
    var a = -1, b = -1;
    ix.ns.forEach(function (n, k) {
      if (!r.intersectsNode(n)) return;
      var lo = n === r.startContainer ? r.startOffset : 0, hi = n === r.endContainer ? r.endOffset : n.data.length;
      if (hi <= lo) return;
      if (a < 0) a = ix.starts[k] + lo;
      b = ix.starts[k] + hi;
    });
    return a < 0 ? null : [a, b];
  }
  function wrap(a, b, m) {
    var ix = index(), first = null;
    ix.ns.forEach(function (n, k) {
      var s = ix.starts[k], e = s + n.data.length, lo = Math.max(a, s) - s, hi = Math.min(b, e) - s;
      if (hi <= lo) return;
      var mid = n.splitText(lo); mid.splitText(hi - lo);
      var el = document.createElement('mark');
      el.className = 'xr-m xr-' + m.type; el.setAttribute('data-id', m.id); if (m.fb) el.setAttribute('data-fb', m.fb);
      el.title = m.type === 'fb' ? L[m.fb] : '';
      mid.parentNode.replaceChild(el, mid); el.appendChild(mid);
      if (!first) first = el;
    });
    return first;
  }
  function anchor(m) {
    var ix = index(), best = -1, score = -1, i = ix.txt.indexOf(m.quote);
    while (i >= 0) {
      var p = ix.txt.slice(Math.max(0, i - m.prefix.length), i), q = ix.txt.slice(i + m.quote.length, i + m.quote.length + m.suffix.length), sc = 0;
      for (var k = 1; k <= p.length && p[p.length - k] === m.prefix[m.prefix.length - k]; k++) sc++;
      for (k = 0; k < q.length && q[k] === m.suffix[k]; k++) sc++;
      if (sc > score) { score = sc; best = i; }
      i = ix.txt.indexOf(m.quote, i + 1);
    }
    return best < 0 ? null : wrap(best, best + m.quote.length, m);
  }
  function section(el) {
    var h = null, n = el;
    while (n && n !== main) {
      var p = n.previousElementSibling;
      while (p) { if (/^H[23]$/.test(p.tagName)) { h = p; break; } if (p.classList && p.classList.contains('xr-sec')) { var hh = $$('h2,h3', p).pop(); if (hh) { h = hh; break; } } p = p.previousElementSibling; }
      if (h) break; n = n.parentNode;
    }
    return h ? h.textContent.replace(/^[▾▸]\s*/, '').trim() : '';
  }

  function add(type, fb) {
    var sel = getSelection(); if (!sel.rangeCount) return;
    var r = sel.getRangeAt(0), ix = index(), off = rangeOffsets(r, ix); if (!off) return;
    var m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type: type, quote: ix.txt.slice(off[0], off[1]), prefix: ix.txt.slice(Math.max(0, off[0] - 32), off[0]), suffix: ix.txt.slice(off[1], off[1] + 32), t: now() };
    if (fb) m.fb = fb;
    if (type === 'note') m.note = '';
    var el = wrap(off[0], off[1], m); if (!el) return;
    m.sec = section(el); state.marks.push(m); sel.removeAllRanges(); hideBar();
    if (type === 'note') { cards(); var ta = $('.xr-card[data-id="' + m.id + '"] textarea'); if (ta) ta.focus(); }
    if (type === 'fb') toast(L.got + ' · ' + L[fb]);
    changed();
  }
  function remove(id) {
    $$('mark.xr-m[data-id="' + id + '"]').forEach(function (el) { var p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); p.removeChild(el); p.normalize(); });
    state.marks = state.marks.filter(function (m) { return m.id !== id; });
    cards(); changed();
  }

  var margin;
  function cards() {
    $$('.xr-card').forEach(function (c) { c.remove(); });
    if (!margin) { margin = document.createElement('div'); margin.className = 'xr-margin'; main.appendChild(margin); }
    var notes = state.marks.some(function (m) { return m.type === 'note'; }), mw = main.getBoundingClientRect().width;
    var wide = notes && mw >= 960;
    main.style.setProperty('--measure', wide ? 'min(88ch, ' + (mw - 330) + 'px)' : '88ch');
    var probe = $('main > p, .xr-sec > p') || main, mr = main.getBoundingClientRect(), right = Math.min(probe.getBoundingClientRect().right - mr.left, mr.width);
    margin.style.left = (right + 30) + 'px'; margin.style.width = Math.min(300, mr.width - right - 36) + 'px';
    var y = 0;
    state.marks.filter(function (m) { return m.type === 'note'; }).map(function (m) { return { m: m, el: $('mark.xr-m[data-id="' + m.id + '"]') }; })
      .filter(function (x) { return x.el && !x.el.closest('.xr-sec.closed'); })
      .sort(function (a, b) { return a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top; })
      .forEach(function (x) {
      var m = x.m, el = x.el;
      var c = document.createElement('div'); c.className = 'xr-card' + (wide ? '' : ' inline'); c.setAttribute('data-id', m.id);
      c.innerHTML = '<div class="q">' + esc(m.quote) + '</div><textarea rows="1" placeholder="' + L.ph + '"></textarea>';
      var ta = c.querySelector('textarea'); ta.value = m.note || '';
      var fit = function () { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.addEventListener('input', function () { m.note = ta.value; fit(); changed(); });
      c.addEventListener('mouseenter', function () { $$('mark[data-id="' + m.id + '"]').forEach(function (n) { n.classList.add('flash'); }); });
      c.addEventListener('mouseleave', function () { $$('mark[data-id="' + m.id + '"]').forEach(function (n) { n.classList.remove('flash'); }); });
      if (wide) { var top = el.getBoundingClientRect().top - mr.top - 8; top = Math.max(top, y); c.style.top = top + 'px'; margin.appendChild(c); fit(); y = top + c.offsetHeight + 10; }
      else { var blk = el.closest('p,li,td,blockquote,div') || el; blk.parentNode.insertBefore(c, blk.nextSibling); fit(); }
    });
  }

  var bar, menu, toastEl;
  function ui() {
    bar = document.createElement('div'); bar.className = 'xr-ui xr-bar';
    bar.innerHTML = '<button data-a="hl">' + L.hl + '</button><span class="sep"></span><button data-a="note">' + L.note + '</button><span class="sep"></span><button class="fbbtn" data-a="fbopen">' + L.fb + ' ›</button>' +
      '<button class="fb" data-a="confused">' + L.confused + '</button><button class="fb" data-a="verbose">' + L.verbose + '</button><button class="fb" data-a="known">' + L.known + '</button>';
    bar.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bar.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a'); if (!a) return;
      if (a === 'fbopen') { bar.classList.add('fbopen'); return; }
      if (a === 'hl' || a === 'note') add(a); else add('fb', a);
    });
    menu = document.createElement('div'); menu.className = 'xr-ui xr-menu'; menu.innerHTML = '<button>' + L.undo + '</button>';
    toastEl = document.createElement('div'); toastEl.className = 'xr-ui xr-toast';
    document.body.appendChild(bar); document.body.appendChild(menu); document.body.appendChild(toastEl);
  }
  function hideBar() { bar.style.display = 'none'; bar.classList.remove('fbopen'); }
  function showBar() {
    if (!document.body.classList.contains('xr-annot')) return hideBar();
    var s = getSelection(); if (!s.rangeCount || s.isCollapsed) return hideBar();
    var r = s.getRangeAt(0), c = r.commonAncestorContainer; c = c.nodeType === 1 ? c : c.parentNode;
    if (!main.contains(c) || c.closest(SKIP) || !s.toString().trim()) return hideBar();
    var b = r.getBoundingClientRect(); bar.style.display = 'block';
    bar.style.left = Math.max(8, Math.min(innerWidth - bar.offsetWidth - 8, b.left + b.width / 2 - bar.offsetWidth / 2)) + 'px';
    bar.style.top = (b.top > 52 ? b.top - bar.offsetHeight - 8 : b.bottom + 8) + 'px';
  }
  function toast(msg) {
    toastEl.innerHTML = '<i>✓</i>' + esc(msg); toastEl.style.display = 'block';
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toastEl._t); toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); setTimeout(function () { toastEl.style.display = 'none'; }, 300); }, 1500);
  }

  function slug(s, i) { return 's' + i + '-' + s.toLowerCase().replace(/[^\w一-鿿]+/g, '-').slice(0, 40); }
  function sections() {
    var hs = $$('main > h2, main > h3');
    hs.forEach(function (h, i) { if (!h.id) h.id = slug(h.textContent, i); });
    ['H2', 'H3'].forEach(function (lv) {
      $$(lv === 'H2' ? 'main > h2' : 'main > h3, .xr-sec > h3').forEach(function (h) {
        var box = document.createElement('div'); box.className = 'xr-sec'; var n = h.nextSibling;
        while (n && !(n.nodeType === 1 && (/^H[12]$/.test(n.tagName) || (lv === 'H3' && n.tagName === 'H3')))) { var nx = n.nextSibling; box.appendChild(n); n = nx; }
        h.parentNode.insertBefore(box, h.nextSibling);
        var b = document.createElement('button'); b.className = 'xr-fold'; b.textContent = '▾'; b.title = L.fold; h.insertBefore(b, h.firstChild);
        b.addEventListener('click', function () { fold(h, !h.classList.contains('folded')); changed(); });
      });
    });
    state.folds.forEach(function (id) { var h = document.getElementById(id); if (h) fold(h, true); });
    var toc = $('.toc'); toc.innerHTML = '';
    hs.forEach(function (h) { var a = document.createElement('a'); a.href = '#' + h.id; a.className = h.tagName.toLowerCase(); a.textContent = h.textContent.replace(/^[▾▸]\s*/, ''); toc.appendChild(a); });
  }
  function fold(h, on) {
    h.classList.toggle('folded', on); var box = h.nextElementSibling; if (box && box.classList.contains('xr-sec')) box.classList.toggle('closed', on);
    state.folds = state.folds.filter(function (x) { return x !== h.id; }); if (on) state.folds.push(h.id);
    if (margin) cards();
  }
  function tocTrack() {
    var links = $$('.toc a'), hs = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
    var cur = 0; hs.forEach(function (h, i) { if (h && h.offsetParent && h.getBoundingClientRect().top < 120) cur = i; });
    links.forEach(function (a, i) { a.classList.toggle('cur', i === cur); });
  }

  function lint() {
    var out = [], Q = EN ? /\?|^(what|why|how|which|when|where)\b/i : /[？?]|什么|为什么|怎么|怎样|如何|哪|吗|呢/;
    $$('main h1, main h2, main h3').forEach(function (h) { var t = h.textContent.replace(/^[▾▸]\s*/, ''); if (Q.test(t)) out.push('heading reads as a question: ' + t); });
    var txt = index().txt, dash = (txt.match(/\u2014\u2014|\u2014/g) || []).length, quotes = (txt.match(EN ? /[“”]/g : /[“”「」]/g) || []).length;
    if (dash > 3) out.push('dashes in prose: ' + dash + ' (bold instead)');
    if (quotes > 6) out.push('quotation marks in prose: ' + quotes + ' (bold instead)');
    var md = $$('main p, main li, main td, main th').map(function (e) { return e.textContent; }).join('\n').match(/\*\*[^*\n]+\*\*|(^|\n)#{1,4} /g);
    if (md) out.push('markdown left in HTML (use <b>): ' + md.slice(0, 3).join(' | '));
    $$('.fk-fig').forEach(function (h) { if (!h.children.length) out.push('empty figure host #' + h.id); });
    if (!$('#xray-notes')) out.push('missing #xray-notes block');
    try { var d = JSON.parse($('#xray-notes').textContent).doc || {}; if (!d.title || !d.made) out.push('#xray-notes doc.title / doc.made empty'); } catch (e) { out.push('#xray-notes is not JSON'); }
    if (/[?&]lint/.test(location.search)) { var pre = document.createElement('pre'); pre.id = 'xr-lint'; pre.textContent = out.length ? out.join('\n') : 'XRAY.lint ok'; document.body.appendChild(pre); }
    out.forEach(function (m) { console.warn('[XRAY.lint] ' + m); });
    return out;
  }

  function boot() {
    snapshot(); load(); main = $('main');
    queue.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
    if (window.renderMathInElement) renderMathInElement(main, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }], trust: true, strict: false, macros: { '\\role': '\\htmlClass{r-#1}{#2}' }, ignoredTags: ['script', 'style', 'pre', 'svg', 'textarea'] });
    sections(); ui();
    state.marks.forEach(anchor);
    paintDirty();
    $('#xrNav').title = L.toc; $('#xrTheme').title = L.theme; $('#xrPen').title = L.pen; $('#xrSave').title = L.save;
    $('#xrNav').onclick = function () { document.body.classList.toggle(innerWidth <= 1100 ? 'nav-open' : 'nav-hidden'); setTimeout(cards, 50); };
    $('#xrTheme').onclick = function () { var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('theme', t); } catch (e) {} };
    var pen = $('#xrPen'), penOn = false; try { penOn = localStorage.getItem('xray:pen') === '1'; } catch (e) {}
    function setPen(on) { penOn = on; document.body.classList.toggle('xr-annot', on); pen.classList.toggle('on', on); try { localStorage.setItem('xray:pen', on ? '1' : '0'); } catch (e) {} if (!on) hideBar(); }
    setPen(penOn); pen.onclick = function () { setPen(!penOn); };
    $('#xrSave').onclick = save;
    $$('.toc a').forEach(function (a) { a.addEventListener('click', function () { document.body.classList.remove('nav-open'); var h = document.getElementById(a.getAttribute('href').slice(1)); var s = h && h.closest('.xr-sec.closed'); if (s) fold(s.previousElementSibling, false); }); });
    document.addEventListener('mouseup', function () { setTimeout(showBar, 0); });
    document.addEventListener('keyup', function (e) { if (e.shiftKey) showBar(); if (e.key === 'Escape') { hideBar(); menu.style.display = 'none'; } });
    document.addEventListener('mousedown', function (e) { if (!bar.contains(e.target)) hideBar(); if (!menu.contains(e.target)) menu.style.display = 'none'; });
    document.addEventListener('contextmenu', function (e) {
      var t = e.target.closest && e.target.closest('mark.xr-m, .xr-card'); if (!t) return;
      e.preventDefault(); var id = t.getAttribute('data-id');
      menu.style.display = 'block'; menu.style.left = Math.min(e.clientX, innerWidth - 90) + 'px'; menu.style.top = e.clientY + 'px';
      menu.querySelector('button').onclick = function () { menu.style.display = 'none'; remove(id); };
    });
    var prog = $('#progress'), pt = null;
    addEventListener('scroll', function () {
      var h = document.documentElement.scrollHeight - innerHeight; prog.style.width = (h > 0 ? scrollY / h * 100 : 0) + '%'; prog.style.opacity = '.38';
      clearTimeout(pt); pt = setTimeout(function () { prog.style.opacity = '0'; }, 1200); tocTrack(); hideBar();
    }, { passive: true });
    addEventListener('resize', function () { cards(); });
    tocTrack();
    getHandle().then(function (h) { handle = h; });
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () { cards(); if (/[?&]lint/.test(location.search)) { lint(); if (window.FK && FK.lint) FK.lint(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 0);

  return { ready: function (fn) { queue.push(fn); }, serialize: serialize, save: save, lint: lint, state: function () { return state; }, add: add, remove: remove };
})();
/* ===== XRAY JS END ===== */`;

const FIGKIT_JS = String.raw`/* ===== FIGKIT JS START ===== */
var FK = (function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var S = { h: 60, gap: 15, gapDot: 18, rx: 4.6, add: 8.2, dot: 2.4, aL: 6, aW: 5.2,
            fs: 13, lh: 15.6, fsSmall: 12, fsIO: 15, lift: 60.8, stackPadX: 9.2, stackPadY: 78, pe: 13.2 };
  var W = { s: 33, m: 60, ffn: 73, l: 91, xl: 85 };
  var GREEK = { alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',eta:'η',theta:'θ',lambda:'λ',mu:'μ',pi:'π',sigma:'σ',tau:'τ',phi:'φ',psi:'ψ',omega:'ω',
    Delta:'Δ',Sigma:'Σ',Omega:'Ω',Phi:'Φ',in:'∈',times:'×',cdot:'·',to:'→',mapsto:'↦',top:'⊤',sum:'Σ',le:'≤',ge:'≥',approx:'≈',infty:'∞',odot:'⊙',oplus:'⊕',ldots:'…',partial:'∂',nabla:'∇' };
  var BB = { R:'ℝ', N:'ℕ', Z:'ℤ', E:'𝔼', C:'ℂ', Q:'ℚ' };
  var WORDS = /^(softmax|Attn|LN|exp|log|max|min|sin|cos|tanh|ReLU|GELU|SiLU|Linear|Sublayer|MLP|FFN|concat|diag|Var|argmax|sigmoid|Norm|RMSNorm|LayerNorm|Conv|Dropout|KL|CE|Loss|Attention)/;

  function el(tag, a, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in a) if (a[k] !== undefined && a[k] !== null) n.setAttribute(k, a[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function rich(t, src, fs) {
    var i = 0, base = 0;
    function grp() {
      if (src[i] === '{') { var d = 1, j = ++i; while (i < src.length && d) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; } return src.slice(j, i - 1); }
      if (src[i] === '\\') { var m = /^\\[A-Za-z]+/.exec(src.slice(i)); if (m) { i += m[0].length; return m[0]; } }
      return src[i++];
    }
    function emit(txt, cls, shift, size) {
      if (!txt) return;
      var a = { 'class': cls || null };
      var dy = shift - base; if (dy) a.dy = dy.toFixed(2);
      base = shift; if (size) a['font-size'] = size;
      el('tspan', a, t).textContent = txt;
    }
    function run(s, ctx) {
      var k = 0;
      while (k < s.length) {
        var c = s[k];
        if (c === '\\') {
          var m = /^\\([A-Za-z]+|.)/.exec(s.slice(k)); k += m[0].length; var cmd = m[1];
          var take = function () { src = s; i = k; var g = grp(); k = i; return g; };
          if (cmd === 'role' || cmd === 'htmlClass') { var r = take().replace(/^r-/, ''); run(take(), Object.assign({}, ctx, { role: 'r-' + r })); }
          else if (cmd === 'mathbf' || cmd === 'bm') run(take(), Object.assign({}, ctx, { font: 'bf' }));
          else if (cmd === 'mathrm' || cmd === 'text' || cmd === 'operatorname') run(take(), Object.assign({}, ctx, { font: 'rm' }));
          else if (cmd === 'texttt' || cmd === 'mathtt') run(take(), Object.assign({}, ctx, { font: 'tt' }));
          else if (cmd === 'mathbb') { var b = take(); emit(BB[b] || b, cls(ctx, 'rm'), ctx.shift, ctx.size); }
          else if (cmd === 'sqrt') { emit('√', cls(ctx, 'rm'), ctx.shift, ctx.size); run(take(), ctx); }
          else if (cmd === ',' || cmd === ';' || cmd === ' ' || cmd === 'quad') emit(cmd === 'quad' ? '\u2003' : '\u2009', null, ctx.shift, ctx.size);
          else if (cmd === '{' || cmd === '}') emit(cmd, cls(ctx, 'rm'), ctx.shift, ctx.size);
          else if (GREEK[cmd]) emit(GREEK[cmd], cls(ctx, /^[a-z]/.test(cmd) && cmd.length > 2 && 'alphabetagammadeltaepsilonetathetalambdamupisigmatauphipsiomega'.indexOf(cmd) >= 0 ? 'mi' : 'rm'), ctx.shift, ctx.size);
          else emit(cmd, cls(ctx, 'rm'), ctx.shift, ctx.size);
        } else if (c === '^' || c === '_') {
          k++; src = s; i = k; var g = grp(); k = i;
          var sz = (ctx.size || fs) * 0.72;
          var sh = (ctx.shift || 0) + (c === '^' ? -0.38 : 0.24) * (ctx.size || fs);
          run(g, Object.assign({}, ctx, { shift: sh, size: sz.toFixed(2) }));
        } else if (c === '{') {
          src = s; i = k; var gg = grp(); k = i; run(gg, ctx);
        } else if (c === ' ') { emit('\u2005', null, ctx.shift, ctx.size); k++; }
        else if (/[A-Za-z]/.test(c)) {
          var w = WORDS.exec(s.slice(k));
          if (w && ctx.font === 'mi') { emit(w[0], cls(ctx, 'rm'), ctx.shift, ctx.size); k += w[0].length; }
          else { emit(c, cls(ctx, ctx.font), ctx.shift, ctx.size); k++; }
        } else { emit(c, cls(ctx, 'rm'), ctx.shift, ctx.size); k++; }
      }
    }
    function cls(ctx, font) { return [font === 'rm' ? '' : font, ctx.role || ''].join(' ').trim() || null; }
    run(src, { font: 'mi', shift: 0, size: null, role: null });
    if (base) el('tspan', { dy: (-base).toFixed(2) }, t).textContent = '\u200B';
    return t;
  }

  function Fig(host, w, h, label) {
    host = typeof host === 'string' ? document.querySelector(host) : host;
    this.w = w; this.h = h; this.at = {};
    this.svg = el('svg', { 'class': 'fk', viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': label || '' }, host);
    this.svg.style.minWidth = Math.round(w * 0.82) + 'px';
    this.svg.style.maxWidth = Math.round(w * 1.1) + 'px';
    this.gS = el('g', {}, this.svg); this.gW = el('g', {}, this.svg); this.gB = el('g', {}, this.svg); this.gT = el('g', {}, this.svg);
  }
  var P = Fig.prototype;

  P.p = function (ref) {
    if (Array.isArray(ref)) return ref;
    var s = ref.split('.'), a = this.at[s[0]]; if (!a) throw new Error('FK: unknown id ' + s[0]);
    var side = s[1] || 'c';
    return side === 'l' ? [a.x - a.w / 2, a.y] : side === 'r' ? [a.x + a.w / 2, a.y] : side === 't' ? [a.x, a.y - a.h / 2] : side === 'b' ? [a.x, a.y + a.h / 2] : [a.x, a.y];
  };

  P.label = function (txt, x, y, o) {
    o = o || {};
    var t = el('text', { x: x, y: y, 'text-anchor': o.anchor || 'middle', 'font-size': o.size || S.fs, 'class': o.cls || null }, o.parent || this.gT);
    rich(t, txt, o.size || S.fs);
    return t;
  };

  P.box = function (id, o) {
    var w = typeof o.w === 'number' ? o.w : (W[o.w] || W.m), h = o.h || S.h;
    var g = el('g', { 'class': 'blk r-' + (o.role || 'op'), 'data-id': id }, this.gB);
    el('rect', { x: o.x - w / 2, y: o.y - h / 2, width: w, height: h, rx: S.rx }, g);
    var lines = String(o.text).split('\n'), y0 = o.y - (lines.length - 1) * S.lh / 2;
    lines.forEach(function (ln, k) { el('text', { x: o.x, y: y0 + k * S.lh, 'text-anchor': 'middle', 'font-size': S.fs }, g).textContent = ln; });
    if (o.param) this.label(o.param, o.x, o.y + h / 2 + 12, { size: S.fsSmall, cls: 'param' });
    this.at[id] = { x: o.x, y: o.y, w: w, h: h, kind: 'box', g: g };
    return g;
  };
  P.add = function (id, o) {
    var g = el('g', { 'class': 'add', 'data-id': id }, this.gB), r = S.add, a = r * 0.5;
    el('circle', { cx: o.x, cy: o.y, r: r }, g);
    el('path', { d: 'M' + (o.x - a) + ' ' + o.y + 'H' + (o.x + a) + 'M' + o.x + ' ' + (o.y - a) + 'V' + (o.y + a) }, g);
    this.at[id] = { x: o.x, y: o.y, w: 2 * r, h: 2 * r, kind: 'add', g: g };
  };
  P.dot = function (id, o) {
    el('circle', { 'class': 'dot', cx: o.x, cy: o.y, r: S.dot }, this.gB);
    this.at[id] = { x: o.x, y: o.y, w: 0, h: 0, kind: 'dot' };
  };
  P.wire = function (pts, o) {
    o = o || {}; var self = this;
    pts = pts.map(function (q) { return self.p(q); });
    var n = pts.length, a = pts[n - 2], b = pts[n - 1], arrow = o.arrow !== false;
    var dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
    var end = arrow ? [b[0] - dx * S.aL * 0.8, b[1] - dy * S.aL * 0.8] : b;
    var d = 'M' + pts.slice(0, n - 1).map(function (q) { return q[0] + ' ' + q[1]; }).join('L') + 'L' + end[0] + ' ' + end[1];
    var role = o.role ? ' r-' + o.role : '';
    var path = el('path', { d: d, 'class': 'wire' + role + (o.cls ? ' ' + o.cls : ''), 'data-pts': JSON.stringify(pts) }, this.gW);
    if (arrow) {
      var px = -dy, py = dx, L = S.aL, Wd = S.aW / 2;
      el('path', { 'class': 'head' + role, d: 'M' + b[0] + ' ' + b[1] + 'L' + (b[0] - dx * L + px * Wd) + ' ' + (b[1] - dy * L + py * Wd) + 'L' + (b[0] - dx * L - px * Wd) + ' ' + (b[1] - dy * L - py * Wd) + 'Z' }, this.gW);
    }
    return path;
  };
  P.row = function (y, x0, items) {
    var x = x0, prev = null, self = this;
    items.forEach(function (it, k) {
      var kind = it.add ? 'add' : it.dot ? 'dot' : 'box';
      var w = kind === 'add' ? 2 * S.add : kind === 'dot' ? 0 : (typeof it.w === 'number' ? it.w : (W[it.w] || W.m));
      if (k) x += it.gap !== undefined ? it.gap : (kind === 'dot' || (prev && prev.kind === 'dot')) ? S.gapDot : S.gap;
      var cx = x + w / 2;
      if (kind === 'box') self.box(it.id, { x: cx, y: y, w: w, role: it.role, text: it.box, param: it.param });
      else if (kind === 'add') self.add(it.id, { x: cx, y: y });
      else self.dot(it.id, { x: cx, y: y });
      if (prev && it.link !== false) self.wire([[prev.r, y], [x, y]], { arrow: kind !== 'dot' });
      x += w; prev = { kind: kind, r: x };
    });
    return x;
  };
  P.skip = function (from, to, side) {
    var a = this.p(from), b = this.p(to), up = side !== 'bottom', yy = a[1] + (up ? -S.lift : S.lift);
    this.wire([a, [a[0], yy], [b[0], yy], [b[0], b[1] + (up ? -S.add : S.add)]]);
  };
  P.stack = function (from, to, o) {
    o = o || {};
    var a = this.p(from + '.l'), b = this.p(to + '.r'), x0 = a[0] - S.stackPadX, x1 = b[0] + S.stackPadX;
    var y0 = a[1] - S.stackPadY, y1 = a[1] + S.stackPadY;
    el('rect', { 'class': 'stack', x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 11.5 }, this.gS);
    if (o.label) this.label(o.label, (x0 + x1) / 2, o.side === 'bottom' ? y1 + 14 : y0 - 13, { size: 13.5, cls: 'note' });
  };
  P.io = function (txt, o) {
    var len = o.len || 26.8, lines = txt.split('\n'), x, y, anchor;
    if (o.to) { var b = this.p(o.to + '.l'); this.wire([[b[0] - len, b[1]], b], { role: o.role }); x = b[0] - len - 8; y = b[1]; anchor = 'end'; }
    else { var a = this.p(o.from + '.r'); this.wire([a, [a[0] + len, a[1]]], { role: o.role }); x = a[0] + len + 8; y = a[1]; anchor = 'start'; }
    var self = this, y0 = y - (lines.length - 1) * 17 / 2 - (o.sub ? 7 : 0);
    lines.forEach(function (ln, k) { self.label('\\text{' + ln + '}', x, y0 + k * 17, { anchor: anchor, size: S.fsIO, cls: 'r-' + o.role }); });
    if (o.sub) this.label('\\text{' + o.sub + '}', x, y0 + lines.length * 17 - 2, { anchor: anchor, size: 12, cls: 'r-' + o.role });
  };
  P.note = function (txt, x, y, anchor) { return this.label(txt, x, y, { anchor: anchor || 'middle', size: S.fsSmall, cls: 'note' }); };
  P.math = function (src, x, y, anchor) { return this.label(src, x, y, { anchor: anchor || 'middle', size: 14 }); };
  P.light = function (ids) {
    var self = this;
    Object.keys(this.at).forEach(function (k) { var a = self.at[k]; if (a.g) a.g.classList.toggle('on', ids.indexOf(k) >= 0); });
  };

  function plot(host, o) {
    host = typeof host === 'string' ? document.querySelector(host) : host; host.innerHTML = '';
    var f = new Fig(host, o.w || 1000, o.h || 420, o.label);
    var m = Object.assign({ l: 76, r: 34, t: 30, b: 56 }, o.pad || {}), X0 = m.l, X1 = f.w - m.r, Y0 = f.h - m.b, Y1 = m.t;
    function axis(a, p0, p1) {
      var lg = !!a.log, lo = lg ? Math.log10(a.min) : a.min, hi = lg ? Math.log10(a.max) : a.max;
      return function (v) { var t = ((lg ? Math.log10(Math.max(v, 1e-300)) : v) - lo) / (hi - lo); return p0 + t * (p1 - p0); };
    }
    var X = axis(o.x, X0, X1), Y = axis(o.y, Y0, Y1), gA = el('g', {}, f.gS), items = {}, reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function ticks(a) {
      if (a.ticks) return a.ticks;
      var t = [];
      if (a.log) { for (var k = Math.ceil(Math.log10(a.min) - 1e-9); k <= Math.floor(Math.log10(a.max) + 1e-9); k++) t.push(Math.pow(10, k)); var s = Math.ceil(t.length / 8); return t.filter(function (_, i) { return i % s === 0; }); }
      var span = a.max - a.min, st = Math.pow(10, Math.floor(Math.log10(span / 5))); if (span / st > 10) st *= 2; if (span / st > 10) st *= 2.5;
      for (var v = Math.ceil(a.min / st - 1e-9) * st; v <= a.max + 1e-9; v += st) t.push(+v.toPrecision(12));
      return t;
    }
    function fmt(a, v) { return a.fmt ? a.fmt(v) : a.log ? '10^{' + Math.round(Math.log10(v)) + '}' : String(+v.toPrecision(6)); }
    if (!o.x.hide) {
      el('path', { 'class': 'axis', d: 'M' + X0 + ' ' + Y0 + 'H' + X1 }, gA);
      ticks(o.x).forEach(function (v) { var x = X(v); el('path', { 'class': 'tick', d: 'M' + x + ' ' + Y0 + 'v5' }, gA); f.label(fmt(o.x, v), x, Y0 + 17, { size: 12, cls: 'note' }); });
      if (o.x.label) f.label(o.x.label, X1, Y0 + 40, { anchor: 'end', size: 14 });
    }
    if (!o.y.hide) {
      el('path', { 'class': 'axis', d: 'M' + X0 + ' ' + Y0 + 'V' + Y1 }, gA);
      ticks(o.y).forEach(function (v) { var y = Y(v); el('path', { 'class': 'tick', d: 'M' + X0 + ' ' + y + 'h-5' }, gA); f.label(fmt(o.y, v), X0 - 9, y, { anchor: 'end', size: 12, cls: 'note' }); });
      if (o.y.label) f.label(o.y.label, X0 - 9, Y1 - 16, { anchor: 'start', size: 14 });
    }
    function cls(base, q) { return base + (q.role ? ' r-' + q.role : '') + (q.cls ? ' ' + q.cls : ''); }
    function inY(v) { var lo = Math.min(o.y.min, o.y.max), hi = Math.max(o.y.min, o.y.max), e = (hi - lo) * 1e-6; return isFinite(v) && v >= lo - e && v <= hi + e; }
    function path(pts) { var s = '', pen = false; pts.forEach(function (p) { if (!inY(p[1])) { pen = false; return; } s += (pen ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); pen = true; }); return s || 'M0 0'; }
    var raf = 0, tw = [];
    function step(now) {
      tw = tw.filter(function (t) {
        var k = Math.min(1, (now - t.t0) / 450), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        t.n.setAttribute('d', path(t.a.map(function (p, i) { return [p[0] + (t.b[i][0] - p[0]) * e, p[1] + (t.b[i][1] - p[1]) * e]; })));
        return k < 1;
      });
      raf = tw.length ? requestAnimationFrame(step) : 0;
    }
    var Q = { f: f, X: X, Y: Y, box: { x0: X0, x1: X1, y0: Y1, y1: Y0 } };
    Q.line = function (id, pts, q) {
      q = q || {}; var it = items[id];
      if (!it) { it = items[id] = { n: el('path', { 'class': cls('curve', q) }, q.under ? f.gS : f.gW), pts: null }; }
      else it.n.setAttribute('class', cls('curve', q));
      if (q.tween && it.pts && it.pts.length === pts.length && !reduce) { tw = tw.filter(function (t) { return t.n !== it.n; }); tw.push({ n: it.n, a: it.pts, b: pts, t0: performance.now() }); if (!raf) raf = requestAnimationFrame(step); }
      else it.n.setAttribute('d', path(pts));
      it.pts = pts; return it.n;
    };
    Q.dot = function (id, p, q) {
      q = q || {}; var it = items[id] || (items[id] = { n: el('circle', {}, f.gB) });
      it.n.setAttribute('class', cls('pt', q)); it.n.setAttribute('cx', X(p[0])); it.n.setAttribute('cy', Y(p[1])); it.n.setAttribute('r', q.r || 4.6);
      return it.n;
    };
    Q.text = function (id, txt, p, q) {
      q = q || {}; if (items[id]) items[id].n.remove();
      var n = f.label(txt, X(p[0]) + (q.dx || 0), Y(p[1]) + (q.dy || 0), { anchor: q.anchor || 'start', size: q.size || 13, cls: q.role ? 'r-' + q.role : q.cls || null });
      items[id] = { n: n }; return n;
    };
    Q.rect = function (id, a, b, q) {
      q = q || {}; var it = items[id] || (items[id] = { n: el('rect', {}, f.gB) });
      var x0 = Math.min(X(a[0]), X(b[0])), x1 = Math.max(X(a[0]), X(b[0])), y0 = Math.min(Y(a[1]), Y(b[1])), y1 = Math.max(Y(a[1]), Y(b[1]));
      it.n.setAttribute('class', cls('bar', q)); it.n.setAttribute('x', x0); it.n.setAttribute('y', y0); it.n.setAttribute('width', Math.max(0, x1 - x0)); it.n.setAttribute('height', Math.max(0, y1 - y0)); it.n.setAttribute('rx', q.rx === undefined ? 2 : q.rx);
      return it.n;
    };
    Q.vline = function (id, x, q) { q = q || {}; var it = items[id] || (items[id] = { n: el('path', {}, f.gW) }); it.n.setAttribute('class', cls('ref', q)); it.n.setAttribute('d', 'M' + X(x) + ' ' + Y(q.y0 === undefined ? o.y.min : q.y0) + 'V' + Y(q.y1 === undefined ? o.y.max : q.y1)); return it.n; };
    Q.hline = function (id, y, q) { q = q || {}; var it = items[id] || (items[id] = { n: el('path', {}, f.gW) }); it.n.setAttribute('class', cls('ref', q)); it.n.setAttribute('d', 'M' + X(q.x0 === undefined ? o.x.min : q.x0) + ' ' + Y(y) + 'H' + X(q.x1 === undefined ? o.x.max : q.x1)); return it.n; };
    Q.remove = function (id) { if (items[id]) { items[id].n.remove(); delete items[id]; } };
    Q.has = function (id) { return !!items[id]; };
    return Q;
  }

  function lint() {
    var out = [];
    document.querySelectorAll('svg.fk').forEach(function (svg, si) {
      var vb = svg.viewBox.baseVal, texts = [].slice.call(svg.querySelectorAll('text')).filter(function (t) { return t.textContent.trim(); });
      if (vb.width > 1260) out.push('fig' + si + ': viewBox width ' + vb.width + ' > 1260');
      function off(n) { var x = 0, y = 0; for (; n && n !== svg; n = n.parentNode) { var m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(n.getAttribute && n.getAttribute('transform') || ''); if (m) { x += +m[1]; y += +m[2]; } } return [x, y]; }
      var boxes = texts.map(function (t) { var b = t.getBBox(), o = off(t); return { t: t, x0: b.x + o[0], y0: b.y + o[1], x1: b.x + o[0] + b.width, y1: b.y + o[1] + b.height }; });
      boxes.forEach(function (b) {
        var fs = parseFloat(getComputedStyle(b.t).fontSize);
        if (fs < 11) out.push('fig' + si + ': text too small ' + fs.toFixed(1) + ' "' + b.t.textContent + '"');
        if (b.x0 < vb.x - 1 || b.y0 < vb.y - 1 || b.x1 > vb.x + vb.width + 1 || b.y1 > vb.y + vb.height + 1) out.push('fig' + si + ': out of bounds "' + b.t.textContent + '"');
      });
      for (var i = 0; i < boxes.length; i++) for (var j = i + 1; j < boxes.length; j++) {
        var a = boxes[i], c = boxes[j];
        if (a.x0 < c.x1 - 1 && c.x0 < a.x1 - 1 && a.y0 < c.y1 - 2 && c.y0 < a.y1 - 2) out.push('fig' + si + ': text overlap "' + a.t.textContent + '" × "' + c.t.textContent + '"');
      }
      svg.querySelectorAll('.blk').forEach(function (g) {
        var r = g.querySelector('rect').getBBox();
        g.querySelectorAll('text').forEach(function (t) { var b = t.getBBox(); if (b.x < r.x + 3 || b.x + b.width > r.x + r.width - 3) out.push('fig' + si + ': label overflows box "' + t.textContent + '"'); });
        if (g.querySelectorAll('text').length > 3) out.push('fig' + si + ': more than 3 lines in a box');
      });
      svg.querySelectorAll('.wire[data-pts]').forEach(function (p) {
        var po = off(p), pts = JSON.parse(p.getAttribute('data-pts')).map(function (q) { return [q[0] + po[0], q[1] + po[1]]; });
        boxes.forEach(function (b) {
          if (b.t.closest('.blk')) return;
          for (var k = 1; k < pts.length; k++) {
            var x0 = Math.min(pts[k - 1][0], pts[k][0]), x1 = Math.max(pts[k - 1][0], pts[k][0]), y0 = Math.min(pts[k - 1][1], pts[k][1]), y1 = Math.max(pts[k - 1][1], pts[k][1]);
            if (x0 < b.x1 - 1 && b.x0 + 1 < x1 + 0.01 && y0 < b.y1 - 1 && b.y0 + 1 < y1 + 0.01) { out.push('fig' + si + ': text on a wire "' + b.t.textContent + '"'); break; }
          }
        });
      });
      if (svg.querySelector('[filter],filter')) out.push('fig' + si + ': uses filter (glow/shadow): remove');
    });
    out.forEach(function (m) { console.warn('[FK.lint] ' + m); });
    if (!out.length) console.log('[FK.lint] ok');
    if (/[?&]lint/.test(location.search)) { var pre = document.createElement('pre'); pre.id = 'fk-lint'; pre.textContent = out.length ? out.join('\n') : 'FK.lint ok'; document.body.prepend(pre); }
    return out;
  }

  return { fig: function (h, w, hh, l) { var hs = typeof h === 'string' ? document.querySelector(h) : h; hs.innerHTML = ''; return new Fig(hs, w, hh, l); }, plot: plot, S: S, W: W, lint: lint, rich: rich };
})();
/* ===== FIGKIT JS END ===== */`;

const ROADSHOW_CS336_FIGURE_SCRIPT = String.raw`XRAY.ready(function () {
  'use strict';
  if (!window.FK) { return; }

  (function () {
    var f = FK.fig('#figSwiGluFlow', 1000, 305, 'SwiGLU gating architecture and tensor shapes');
    f.dot('dSplit', { x: 165, y: 145 });
    f.io('x', { to: 'dSplit', role: 'in', len: 42 });
    f.note('(T, d)', 136, 125, 'middle');

    f.box('w1', { x: 270, y: 85, w: 76, role: 'op', text: 'Gate\nLinear', param: 'W_1' });
    f.box('silu', { x: 430, y: 85, w: 64, role: 'op', text: 'SiLU' });
    f.wire([[165, 145], [165, 85], 'w1.l']);
    f.wire(['w1.r', 'silu.l']);
    f.note('(T, d_{ff})', 352, 68, 'middle');

    f.box('w3', { x: 270, y: 205, w: 76, role: 'alt', text: 'Up\nLinear', param: 'W_3' });
    f.wire([[165, 145], [165, 205], 'w3.l']);
    f.note('(T, d_{ff})', 430, 187, 'middle');

    f.box('mul', { x: 555, y: 145, w: 46, h: 46, role: 'out', text: '⊙' });
    f.wire(['silu.r', [555, 85], 'mul.t']);
    f.wire(['w3.r', [555, 205], 'mul.b']);

    f.box('w2', { x: 725, y: 145, w: 80, role: 'op', text: 'Down\nLinear', param: 'W_2' });
    f.wire(['mul.r', 'w2.l']);
    f.note('(T, d_{ff})', 631, 127, 'middle');

    f.io('y', { from: 'w2', role: 'out', len: 50, sub: '(T, d)' });
    f.math('\\role{out}{y} = (\\mathrm{SiLU}(\\role{in}{x}\\role{param}{W_1}) \\odot \\role{in}{x}\\role{param}{W_3})\\role{param}{W_2}', 555, 278);

    ['w1', 'silu', 'w3', 'mul', 'w2'].forEach(function (id) {
      var item = f.at[id];
      if (item && item.g) {
        item.g.classList.add('hit');
        item.g.addEventListener('click', function () {
          var wasOn = item.g.classList.contains('on');
          f.light(wasOn ? [] : [id]);
        });
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { f.light([]); }
    });
  })();

  (function () {
    function alignTo(v, m) { return Math.ceil(v / m) * m; }
    function rawDim(d) { return Math.round((8 * d) / 3); }
    var ds = [];
    for (var d = 256; d <= 2048; d += 32) { ds.push(d); }

    var p = FK.plot('#figAlignPlot', {
      w: 1000,
      h: 380,
      label: 'SwiGLU hidden dimension alignment vs model width',
      pad: { l: 84, r: 44, t: 38, b: 58 },
      x: {
        min: 200,
        max: 2120,
        ticks: [256, 512, 768, 1024, 1280, 1536, 1792, 2048],
        label: '\\text{model width } d'
      },
      y: {
        min: 512,
        max: 6400,
        ticks: [1024, 2048, 3072, 4096, 5120, 6144],
        label: '\\role{op}{d_{\\mathrm{ff}}}'
      }
    });

    p.line('raw', ds.map(function (v) { return [v, rawDim(v)]; }), { cls: 'guide', under: true });
    p.line('a64', ds.map(function (v) { return [v, alignTo(rawDim(v), 64)]; }), { role: 'op' });
    p.line('a256', ds.map(function (v) { return [v, alignTo(rawDim(v), 256)]; }), { role: 'alt', cls: 'thin', under: true });

    p.text('lbl256', '\\text{align256}', [640, alignTo(rawDim(640), 256)], { anchor: 'end', dx: -14, dy: -22, size: 12.5, role: 'alt' });
    p.text('lbl64', '\\text{align64}', [1216, alignTo(rawDim(1216), 64)], { anchor: 'end', dx: -14, dy: -22, size: 12.5, role: 'op' });
    p.text('lblRaw', '8/3\\,d', [1792, rawDim(1792)], { anchor: 'start', dx: 14, dy: 24, size: 12.5, cls: 'note' });

    var ctl = document.getElementById('ctlAlign');
    if (!ctl) { return; }
    ctl.innerHTML = '<span>d</span><input type="range" min="256" max="2048" step="64" value="1024" aria-label="model width d"><span class="say"></span>';
    var inp = ctl.querySelector('input');
    var say = ctl.querySelector('.say');
    function draw(dVal) {
      var raw = rawDim(dVal);
      var d64 = alignTo(raw, 64);
      var d256 = alignTo(raw, 256);
      var tileUtil = ((raw / d64) * 100).toFixed(1);
      var deltaPct = (((d64 - raw) / raw) * 100).toFixed(1);
      var paramsM = ((3 * dVal * d64) / 1e6).toFixed(2);
      p.vline('curX', dVal, { y0: 512, y1: 6400 });
      p.dot('dotRaw', [dVal, raw], { role: 'wire', r: 3.6 });
      p.dot('dot64', [dVal, d64], { role: 'op', cls: 'solid', r: 5.5 });
      p.dot('dot256', [dVal, d256], { role: 'alt', r: 4.2 });
      say.textContent = 'd=' + dVal + ' · raw=' + raw + ' · align64=' + d64 + ' (+' + deltaPct + '%) · tile=' + tileUtil + '% · 3·d·d_ff=' + paramsM + 'M/layer';
    }
    inp.addEventListener('input', function () { draw(+inp.value); });
    draw(+inp.value);
  })();
});`;

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugifyCourseId(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'course';
}

function ensureSafeCourseId(courseId: string): string {
  const cleaned = slugifyCourseId(courseId);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error(`Invalid course id: ${courseId}`);
  }
  return cleaned;
}

export function learnCoursesRoot(userDataDir: string): string {
  return path.join(path.resolve(String(userDataDir || '.')), 'learn-courses');
}

function courseDirPath(userDataDir: string, courseId: string): string {
  return path.join(learnCoursesRoot(userDataDir), ensureSafeCourseId(courseId));
}

function courseJsonPath(userDataDir: string, courseId: string): string {
  return path.join(courseDirPath(userDataDir, courseId), 'course.json');
}

function indexJsonPath(userDataDir: string): string {
  return path.join(learnCoursesRoot(userDataDir), 'index.json');
}

function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, {recursive: true});
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {}
    throw error;
  }
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeIndexFile(userDataDir: string, activeCourseId: string): void {
  const payload: LearnIndexFile = {
    activeCourseId: ensureSafeCourseId(activeCourseId),
  };
  atomicWriteFileSync(indexJsonPath(userDataDir), JSON.stringify(payload, null, 2));
}

function readIndexFile(userDataDir: string): LearnIndexFile {
  const existing = readJsonSafe<LearnIndexFile>(indexJsonPath(userDataDir));
  if (existing && typeof existing.activeCourseId === 'string' && existing.activeCourseId.trim()) {
    return {activeCourseId: ensureSafeCourseId(existing.activeCourseId)};
  }
  return {activeCourseId: ROADSHOW_CS336_COURSE_ID};
}

export function saveLearnCourse(userDataDir: string, course: LearnCourse): LearnCourse {
  const safeId = ensureSafeCourseId(course.id);
  const nextCourse: LearnCourse = {
    ...course,
    id: safeId,
  };
  atomicWriteFileSync(
    courseJsonPath(userDataDir, safeId),
    JSON.stringify(nextCourse, null, 2),
  );
  return nextCourse;
}

function resolveVaultCourseDir(courseFolderName: string, persistenceDir: string): string {
  const normPersistence = path.resolve(String(persistenceDir || DEFAULT_PERSISTENCE_DIR));
  const candidates: string[] = [courseFolderName];
  if (/stanford\s+cs336/i.test(courseFolderName) || courseFolderName === ROADSHOW_CS336_COURSE_ID) {
    candidates.unshift('CS 336');
  }
  const stripped = courseFolderName.replace(/^Stanford\s+/i, '').trim();
  if (stripped && !candidates.includes(stripped)) {
    candidates.push(stripped);
  }
  for (const cand of candidates) {
    const joined = path.join(normPersistence, cand);
    if (fs.existsSync(joined)) {
      return joined;
    }
  }
  return path.join(normPersistence, candidates[0] || courseFolderName);
}

function extractReadableTitle(filePath: string, fallbackName: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.txt') {
    try {
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 700);
      const fmTitle = /^---\r?\n[\s\S]*?^title:\s*["']?([^\r\n"']+)["']?/m.exec(head);
      if (fmTitle && fmTitle[1].trim()) {
        return fmTitle[1].trim();
      }
      const h1 = /^#\s+(.+)$/m.exec(head);
      if (h1 && h1[1].trim()) {
        return h1[1].trim();
      }
    } catch {}
  }
  const stem = path.basename(fallbackName, ext);
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || fallbackName;
}

function inferMaterialKind(
  bucket: string,
  filePath: string,
): {kind: LearnMaterialItem['kind']; category: string} {
  const ext = path.extname(filePath).toLowerCase();
  if (ASSET_EXTS.has(ext)) {
    return {kind: 'asset', category: 'Asset'};
  }
  if (CODE_EXTS.has(ext)) {
    return {
      kind: 'code',
      category: bucket === 'scripts' ? 'Script' : bucket === 'lectures' ? 'Lecture Code' : 'Code',
    };
  }
  if (bucket === 'lectures') {
    return {kind: 'lecture', category: 'Lecture'};
  }
  if (bucket === 'assignments') {
    return {kind: 'assignment', category: 'Assignment'};
  }
  if (bucket === 'notes') {
    return {kind: 'note', category: 'Note'};
  }
  if (bucket === 'scripts') {
    return {kind: 'code', category: 'Script'};
  }
  if (ext === '.md' || ext === '.pdf') {
    return {kind: 'note', category: 'Note'};
  }
  return {kind: 'other', category: 'Resource'};
}

function collectUpToTwoLevels(
  baseDir: string,
  bucket: string,
  depth: number,
  out: Array<{bucket: string; filePath: string; sizeBytes?: number}>,
  maxScan: number,
): void {
  if (out.length >= maxScan || depth > 2 || !fs.existsSync(baseDir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, {withFileTypes: true});
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxScan) {
      return;
    }
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
      continue;
    }
    const full = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      collectUpToTwoLevels(full, bucket, depth + 1, out, maxScan);
    } else if (entry.isFile()) {
      let sizeBytes: number | undefined;
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {}
      out.push({bucket, filePath: full, sizeBytes});
    }
  }
}

export function scanCourseMaterials(
  rootDir: string,
  vaultCourseDir?: string,
): LearnMaterialItem[] {
  const candidates: Array<{bucket: string; filePath: string; sizeBytes?: number}> = [];
  const normRoot = rootDir ? path.resolve(rootDir) : '';
  const normVault = vaultCourseDir ? path.resolve(vaultCourseDir) : '';

  if (normRoot && fs.existsSync(normRoot)) {
    for (const bucket of MATERIAL_DIRS) {
      const subDir = path.join(normRoot, bucket);
      if (fs.existsSync(subDir)) {
        collectUpToTwoLevels(subDir, bucket, 1, candidates, 96);
      }
    }
  }

  if (normVault && normVault !== normRoot && fs.existsSync(normVault)) {
    for (const bucket of MATERIAL_DIRS) {
      const subDir = path.join(normVault, bucket);
      if (fs.existsSync(subDir)) {
        collectUpToTwoLevels(subDir, bucket, 1, candidates, 96);
      }
    }
  }

  const seenPaths = new Set<string>();
  const items: LearnMaterialItem[] = [];
  for (const entry of candidates) {
    if (items.length >= 48) {
      break;
    }
    const resolved = path.resolve(entry.filePath);
    if (seenPaths.has(resolved)) {
      continue;
    }
    seenPaths.add(resolved);
    const {kind, category} = inferMaterialKind(entry.bucket, resolved);
    const title = extractReadableTitle(resolved, path.basename(resolved));
    items.push({
      id: `mat-${items.length + 1}-${slugifyCourseId(path.basename(resolved))}`,
      title,
      path: resolved,
      kind,
      category,
      sizeBytes: entry.sizeBytes,
    });
  }
  return items;
}

function buildArtifactDocument(params: {
  title: string;
  source: string;
  madeDate: string;
  mainHtml: string;
  readyScript: string;
  versionComment?: string;
}): string {
  const notesJson = JSON.stringify({
    v: 1,
    doc: {
      title: params.title,
      source: params.source,
      made: params.madeDate,
      lang: 'zh',
    },
    marks: [],
    folds: [],
    updated: null,
    saved: null,
  }).replace(/</g, '\\u003c');

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(params.title)}</title>`,
    params.versionComment ? `<!-- ${params.versionComment} -->` : '',
    XRAY_HEAD_HTML,
    '<style>',
    XRAY_PAGE_CSS,
    FIGKIT_TOKENS_CSS,
    '</style>',
    '</head>',
    '<body>',
    '<div id="progress"></div>',
    '<header class="top"><button id="xrNav" title="目录">☰</button><button id="xrTheme" title="明暗">◐</button><button id="xrPen" title="标注">✎</button><button id="xrSave" title="保存标注到这个文件">⤓</button></header>',
    '<div class="wrap">',
    '<nav class="toc" aria-label="contents"></nav>',
    '<main id="doc">',
    params.mainHtml,
    '<!-- MP-LEMMA-END -->',
    '</main>',
    '</div>',
    `<script type="application/json" id="xray-notes">${notesJson}</script>`,
    '<script>',
    XRAY_JS,
    '</script>',
    '<script>',
    FIGKIT_JS,
    '</script>',
    '<script>',
    params.readyScript,
    '</script>',
    '</body>',
    '</html>',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRoadshowCs336LivingHtml(madeDate: string): string {
  const mainHtml = String.raw`<h1>SwiGLU 门控比与 64 对齐背后的显存和 Tensor Core 账本</h1>
<div class="info"><span class="k">课程</span><b>Stanford CS336 · Lecture 03</b><br><span class="k">代码</span><code>assignment1-basics/cs336_basics/nn.py</code><br><span class="k">核心洞见</span>把双矩阵扩成三矩阵后，隐藏维从 4d 压到 8/3 d 才能保住参数和算力预算，再向上凑 64 或 256 的倍数只为别让 GPU Tensor Core 空转半个 tile。</div>
<div class="note"><b>颜色</b>输入向量是 <span class="r-in">蓝色</span>，线性/门控变换是 <span class="r-op">绿色</span>，逐元素乘与输出是 <span class="r-out">琥珀</span>，权重参数是 <span class="r-param">粉色</span>，溢出与浪费是 <span class="r-loss">铁锈红</span>。</div>

<h2>双矩阵到三矩阵的参数账</h2>
<p>标准前馈网络只有两块权重矩阵：升维投影 $W_1 \in \mathbb{R}^{d \times 4d}$ 和降维投影 $W_2 \in \mathbb{R}^{4d \times d}$，单层前馈参数量固定为 $2 \times d \times 4d = 8d^2$。SwiGLU 为了引入乘法门控，把单一升维拆成两条并行投影：门控支路 <span class="pill r-param">W_1</span> 过 $\mathrm{SiLU}$ 激活，数值支路 <span class="pill r-param">W_3</span> 保持线性，两支逐元素相乘后再经过 <span class="pill r-param">W_2</span> 压回 $d$ 维。</p>
<p>一旦变成三块矩阵，每增加 1 维隐藏宽度就要多付 $3d$ 个参数。要把三矩阵的总参数量和 FLOPs 锁回标准前馈层的 $8d^2$ 预算，必须解出 $3 \cdot d \cdot d_{\mathrm{ff}} = 8d^2$，于是隐藏宽度从 $4d$ 压成 $\frac{8}{3}d \approx 2.67d$。</p>
<div class="fk-fig" id="figSwiGluFlow"></div>
<p class="tcap">图 1：SwiGLU 双分支门控数据流。点击任意计算框可单独高亮当前阶段。</p>

<table class="t">
<tr><th>架构变体</th><th>隐藏维 $d_{\mathrm{ff}}$</th><th>矩阵数量</th><th>单层 FFN 参数量</th><th>$d=1024$ 实测宽度</th></tr>
<tr><td>Standard FFN (GELU/ReLU)</td><td>$4d$</td><td>2</td><td>$8d^2$</td><td>4096</td></tr>
<tr><td>Naive SwiGLU (未压缩)</td><td>$4d$</td><td>3</td><td><span class="r-loss">$12d^2$ (+50%)</span></td><td>4096</td></tr>
<tr class="hl"><td>SwiGLU (LLaMA 对齐 64)</td><td>$\lceil 8d/3 \rceil_{64}$</td><td>3</td><td>$\approx 8d^2$</td><td>2752</td></tr>
</table>
<p class="tcap">表 1：双矩阵与三矩阵前馈层的参数预算对照。</p>

<h2>绝不省略的 d=4 实数手算轨迹</h2>
<p>先抛开百万参数，用一个 token 的 4 维向量 <span class="pill r-in">x = [1.0, -0.5, 0.5, 0.0]</span> 走完 $d=4, d_{\mathrm{ff}}=6$ 的完整前向计算，亲眼看两条支路怎样互相关闭通道。</p>
<div class="steps">
<div class="st">step 1 · gate projection</div>
<p>门控投影 <span class="pill r-param">W_1</span> ($4 \times 6$) 各列分别为 $[1,0,1,0]^\top$、$[0,2,0,1]^\top$、$[1,-1,1,0]^\top$、$[0,0,0,1]^\top$、$[1,1,-1,0]^\top$、$[-1,0,1,0]^\top$，与输入点积得到门前数值：</p>
<p>$$g = x W_1 = [1.5,\ -1.0,\ 2.0,\ 0.0,\ 0.0,\ -0.5] \in \mathbb{R}^{1 \times 6}$$</p>

<div class="st">step 2 · silu activation</div>
<p>过 $\mathrm{SiLU}(z) = z \cdot \sigma(z)$。正值通道基本线性放行，负值通道被迅速压向零附近，零输入严格归零：</p>
<p>$$s = \mathrm{SiLU}(g) = [1.2264,\ -0.2689,\ 1.7616,\ 0.0000,\ 0.0000,\ -0.1888]$$</p>

<div class="st">step 3 · linear up projection</div>
<p>同一输入并行经过线性支路 <span class="pill r-param">W_3</span> ($4 \times 6$)，各列取 $[1,0,0,0]^\top$、$[0,1,1,0]^\top$、$[1,0,1,0]^\top$、$[0,2,0,1]^\top$、$[2,0,0,0]^\top$、$[0,0,2,1]^\top$：</p>
<p>$$v = x W_3 = [1.0,\ 0.0,\ 1.5,\ -1.0,\ 2.0,\ 1.0] \in \mathbb{R}^{1 \times 6}$$</p>

<div class="st">step 4 · elementwise gating</div>
<p>两路逐元素相乘 $h = s \odot v$。通道 1 被 $v_1 = 0$ 掐断，通道 3 虽然有 $v_3 = -1.0$ 却被零门控 $s_3 = 0$ 拦住，双向门控在此完成筛选：</p>
<p>$$h = [1.2264,\ 0.0000,\ 2.6424,\ 0.0000,\ 0.0000,\ -0.1888]$$</p>

<div class="st">step 5 · down projection</div>
<p>最后经 <span class="pill r-param">W_2</span> ($6 \times 4$) 投影回 $d=4$，各行取 $[0.5,0,0,0]$、$[0,1,0,0]$、$[0,0.5,0.5,0]$、$[0,0,1,0]$、$[0,0,0,1]$、$[0,0,-0.5,1]$，得到输出向量：</p>
<p>$$y = h W_2 = [0.6132,\ 1.3212,\ 1.4156,\ -0.1888] \in \mathbb{R}^{1 \times 4}$$</p>
</div>

<h2>隐藏维对齐 64 的硬件悬崖</h2>
<p>按 $\text{round}(8d/3)$ 算出来的数字往往很别扭。例如 $d=1024$ 时 $8d/3 \approx 2731$，是一个质数，既不能整除 GPU Tensor Core 常用的 $16 \times 16$ 瓦片，也不能整除 64 字节或 128 字节内存对齐边界。矩阵乘核函数只好在最后一个 tile 补零空算，白白拉低 SM 利用率。</p>
<p>拖动下方滑块切换模型宽度 <span class="pill r-in">d</span>，观察原始 $8d/3$ 直线、向上取整到 64 倍数的阶梯线与 256 倍数阶梯线之间的差额。</p>
<div class="fk-fig" id="figAlignPlot"></div>
<div class="fk-ctl r-op" id="ctlAlign"></div>
<p class="fk-cap">图 2：模型宽度与 SwiGLU 隐藏维对齐阶梯对照。拖动滑块实时读出 Tensor Core 64-tile 有效利用率和单层参数开销。</p>

<div class="bench"><p><b>实验台排查</b> 第一版把 SwiGLU 写进 46M TinyStories 模型时，若直接套用 d_ff = 4d，单步训练显存暴涨 34% 且吞吐跌 18%。最便宜的诊断是在前向传播前打印三块矩阵的总参数量 3 * d * d_ff 并对比标准 FFN 的 2 * d * 4d；补丁是锁死 d_ff = ceil_to_64(8 * d / 3)，代价是当 d 很小时（如 d=64 对齐后变成 192）参数略微上浮 12%。</p></div>

<details class="code"><summary>代码 · cs336_basics/swiglu.py</summary><pre class="code" data-label="swiglu.py"><span class="c"># 向上凑 64 倍数：避免 8/3 * d 出现质数宽度导致 Tensor Core 末尾 tile 空转</span>
<span class="n">def</span> ceil_to_64(value: int) -&gt; int:
    return ((value + 63) // 64) * 64


class SwiGLU(nn.Module):
    def __init__(self, d_model: int, d_ff: int | None = None) -&gt; None:
        super().__init__()
        raw_ff = int((8 * d_model) / 3)
        hidden = d_ff if d_ff is not None else ceil_to_64(raw_ff)
        <span class="c"># 三矩阵严格保持无 bias，省显存并避免长序列数值漂移</span>
        self.w1 = nn.Linear(d_model, hidden, bias=False)  <span class="c"># (d_model, d_ff)</span>
        self.w3 = nn.Linear(d_model, hidden, bias=False)  <span class="c"># (d_model, d_ff)</span>
        self.w2 = nn.Linear(hidden, d_model, bias=False)  <span class="c"># (d_ff, d_model)</span>

    def forward(self, x: torch.Tensor) -&gt; torch.Tensor:
        gate = F.silu(self.w1(x))     <span class="c"># (B, T, d_ff)</span>
        up = self.w3(x)               <span class="c"># (B, T, d_ff)</span>
        return self.w2(gate * up)     <span class="c"># (B, T, d_model)</span></pre></details>

<h2>当场验证你的直觉</h2>
<section class="mp-inline-checkin" data-checkin-id="cs336-swiglu-q1" data-node-id="swiglu-alignment">
  <div class="mp-checkin-kicker">CHECK-IN · 3.1</div>
  <p class="mp-checkin-prompt">如果把 LLaMA 风格的 SwiGLU 隐藏维从 8/3 d 强行改回标准 FFN 的 4d，最先在训练里暴露什么症状？</p>
  <div class="mp-checkin-options" role="radiogroup" aria-label="CHECK-IN 3.1">
    <button type="button" class="mp-checkin-opt" data-option-index="0">A. 激活值与参数量同时上涨约 50%，单步显存与算力明显超支</button>
    <button type="button" class="mp-checkin-opt" data-option-index="1">B. SiLU 门控分支会自动把多余维度清零，显存基本不变</button>
    <button type="button" class="mp-checkin-opt" data-option-index="2">C. 只影响词表嵌入层权重共享，前馈层参数量不变</button>
    <button type="button" class="mp-checkin-opt" data-option-index="3">D. Tensor Core 无法处理 4d 矩阵，前向直接报维度错误</button>
    <button type="button" class="mp-checkin-opt mp-checkin-unsure" data-option-index="-1" data-unsure="true">我不太确定 / 先跳过</button>
  </div>
  <textarea class="mp-checkin-note" rows="2" placeholder="写下你的判断依据或卡住的地方"></textarea>
  <div class="mp-checkin-actions">
    <button type="button" class="mp-checkin-submit">提交核对</button>
    <span class="mp-checkin-status"></span>
  </div>
</section>`;

  return buildArtifactDocument({
    title: 'SwiGLU 门控比与 64 对齐背后的显存和 Tensor Core 账本',
    source: 'Stanford CS336 · Lecture 03',
    madeDate,
    mainHtml,
    readyScript: ROADSHOW_CS336_FIGURE_SCRIPT,
    versionComment: `MP-ARTIFACT-VERSION:${ROADSHOW_ARTIFACT_VERSION}`,
  });
}

function buildRoadshowCs336Markdown(): string {
  return [
    '# SwiGLU 门控比与 64 对齐背后的显存和 Tensor Core 账本',
    '',
    '- 课程：Stanford CS336 · Lecture 03',
    '- 代码：`assignment1-basics/cs336_basics/nn.py`',
    '- 核心洞见：把双矩阵扩成三矩阵后，隐藏维从 `4d` 压到 `8/3 d` 才能保住参数和算力预算，再向上凑 64 或 256 的倍数只为别让 GPU Tensor Core 空转半个 tile。',
    '',
    '## 双矩阵到三矩阵的参数账',
    '- 标准 FFN：`2 * d * (4d) = 8d^2` 参数。',
    '- SwiGLU 三矩阵：`3 * d * d_ff = 8d^2 => d_ff = 8/3 d`。',
    '',
    '## 绝不省略的 d=4 实数手算轨迹',
    '- 输入 `x = [1.0, -0.5, 0.5, 0.0]`',
    '- `g = x W_1 = [1.5, -1.0, 2.0, 0.0, 0.0, -0.5]`',
    '- `SiLU(g) = [1.2264, -0.2689, 1.7616, 0.0000, 0.0000, -0.1888]`',
    '- `v = x W_3 = [1.0, 0.0, 1.5, -1.0, 2.0, 1.0]`',
    '- `h = SiLU(g) * v = [1.2264, 0.0000, 2.6424, 0.0000, 0.0000, -0.1888]`',
    '- `y = h W_2 = [0.6132, 1.3212, 1.4156, -0.1888]`',
    '',
    '## 隐藏维对齐 64 的硬件悬崖',
    '- `d_ff = ceil_to_64(round(8 * d / 3))` 兼顾参数守恒与 Tensor Core 瓦片利用率。',
    '',
  ].join('\n');
}

function buildGenericCourseStarterHtml(
  courseTitle: string,
  materials: LearnMaterialItem[],
  madeDate: string,
): string {
  const safeTitle = escapeHtml(courseTitle);
  const itemsHtml = materials.length
    ? `<ul>${materials
        .slice(0, 8)
        .map(m => `<li><b>${escapeHtml(m.category)}</b> ${escapeHtml(m.title)}</li>`)
        .join('')}</ul>`
    : '<p>当前课程目录暂未扫描到讲义文件，可在右侧随时导入或开始提问。</p>';

  const mainHtml = `<h1>${safeTitle} 核心机制与实验台导读</h1>
<div class="info"><span class="k">课程</span><b>${safeTitle}</b><br><span class="k">核心洞见</span>先对齐最前置的张量形状、系统边界与最小可验证实例，再展开完整代码与实验排查。</div>
<h2>课程资料索引</h2>
${itemsHtml}
<h2>当前学习切入点</h2>
<p>选中任意讲义或代码片段开启标注与 Side Chat 追问，确认后的核心直觉可一键固化为本页引理。</p>`;

  return buildArtifactDocument({
    title: `${courseTitle} 核心机制导读`,
    source: courseTitle,
    madeDate,
    mainHtml,
    readyScript: "XRAY.ready(function () { 'use strict'; });",
  });
}

function buildRoadshowCs336Dag(): LearnDagNode[] {
  return [
    {
      id: 'bpe-tokenization',
      title: 'Byte-Level BPE 分词',
      summary:
        '从 UTF-8 256 基础字节出发，用正则预分词锁死词边界后再按频次贪心归并，消除 OOV 并在序列长度与词表大小间折中。',
      phase: 'foundation',
      status: 'mastered',
      prereqIds: [],
      materialPaths: ['lectures/L01-overview-tokenization.md', 'assignments/A1-basics.md'],
      workedExampleTag: 'GPT-2 正则预切分 + 字节合并表',
    },
    {
      id: 'prenorm-rmsnorm',
      title: 'Pre-Norm 与 RMSNorm 梯度高速路',
      summary:
        '把归一化移到子层输入前保留 x_L = x_0 + Σ Sublayer 的恒等残差通路，并用去均值的 RMSNorm 省去一次 HBM 均值归约。',
      phase: 'foundation',
      status: 'mastered',
      prereqIds: ['bpe-tokenization'],
      materialPaths: ['lectures/L03-architectures.md'],
      workedExampleTag: '56 层深网梯度范数对比',
    },
    {
      id: 'swiglu-alignment',
      title: 'SwiGLU 门控与 8/3 d 对齐 64',
      summary:
        '从双矩阵标准 FFN 扩成三矩阵门控单元时，隐藏维压缩到 8/3 d 保住 8d² 参数预算，再向上对齐 64/256 倍数喂饱 Tensor Core tile。',
      phase: 'mechanism',
      status: 'current',
      prereqIds: ['prenorm-rmsnorm'],
      materialPaths: [
        'lectures/L03-architectures.md',
        'notes/learn-cs336/code/model/transformer.py',
      ],
      workedExampleTag: 'd=4, T=2 全量张量手算',
    },
    {
      id: 'rope-extrapolation',
      title: 'RoPE 旋转位置编码与长程衰减',
      summary:
        '按二维子空间旋转 Q 与 K，让点积只依赖相对位移 m-n；高低频基底分别负责局部精排与长距衰减。',
      phase: 'mechanism',
      status: 'stuck',
      prereqIds: ['prenorm-rmsnorm'],
      materialPaths: [
        'lectures/L03-architectures.md',
        'notes/learn-cs336/code/model/transformer.py',
      ],
      workedExampleTag: '2D 二维向量旋转夹角手算',
      lastAttemptNote: '复数指数推导卡在欧拉角频率衰减；下次改用 2D 箭头旋转几何',
    },
    {
      id: 'flashattention-tiling',
      title: 'FlashAttention2 IO 感知分块与 Online Softmax',
      summary:
        '避免把 T×T 注意力矩阵写回 HBM，用分块循环与在线最大值和分母重标定把全部累加留在片上 SRAM。',
      phase: 'code',
      status: 'locked',
      prereqIds: ['swiglu-alignment', 'rope-extrapolation'],
      materialPaths: [
        'lectures/L06-kernels-triton.md',
        'notes/learn-cs336/code/systems/flash_attention.py',
      ],
      workedExampleTag: '2-tile Online Softmax 缩放因子更新',
    },
    {
      id: 'adamw-memory-accounting',
      title: 'AdamW 显存账与混合精度梯度裁剪',
      summary:
        '在 BF16 训练里精确核算权重、梯度、FP32 主权重与 m/v 一二阶矩的 16 Bytes/param 显存占账，防止权重衰减耦合与梯度爆炸。',
      phase: 'code',
      status: 'locked',
      prereqIds: ['flashattention-tiling'],
      materialPaths: [
        'lectures/L02-pytorch-resource-accounting.md',
        'notes/learn-cs336/code/training/optimizer.py',
      ],
      workedExampleTag: '46M TinyStories 训练显存四项拆账',
    },
    {
      id: 'scaling-laws-wsd',
      title: 'Chinchilla IsoFLOP 与 WSD 学习率调度',
      summary:
        '在固定 6ND 算力预算下平衡参数 N 与数据量 D，并用 Warmup-Stable-Decay 让退火阶段无缝接续长上下文扩展。',
      phase: 'synthesis',
      status: 'locked',
      prereqIds: ['adamw-memory-accounting'],
      materialPaths: ['lectures/L09-scaling-laws-1.md', 'lectures/L11-scaling-laws-2.md'],
      workedExampleTag: 'IsoFLOP 抛物线谷底 N* 拟合',
    },
  ];
}

function buildGenericCourseDag(
  courseTitle: string,
  materials: LearnMaterialItem[],
): LearnDagNode[] {
  const lectureMat = materials.find(m => m.kind === 'lecture');
  const assignMat = materials.find(m => m.kind === 'assignment');
  const codeMat = materials.find(m => m.kind === 'code');
  return [
    {
      id: 'foundation-overview',
      title: `${courseTitle} 基础概念与边界`,
      summary: '梳理课程核心问题设定、关键约束与基础抽象。',
      phase: 'foundation',
      status: 'current',
      prereqIds: [],
      materialPaths: lectureMat ? [lectureMat.path] : undefined,
    },
    {
      id: 'mechanism-core',
      title: '核心机制与手算推演',
      summary: '通过最小规模具体实例验证状态转移、复杂度或数学不变量。',
      phase: 'mechanism',
      status: 'locked',
      prereqIds: ['foundation-overview'],
      materialPaths: assignMat ? [assignMat.path] : undefined,
    },
    {
      id: 'code-implementation',
      title: '工程实现与实验台诊断',
      summary: '结合源码核对边界条件、性能瓶颈与最小代价诊断路径。',
      phase: 'code',
      status: 'locked',
      prereqIds: ['mechanism-core'],
      materialPaths: codeMat ? [codeMat.path] : undefined,
    },
  ];
}

function summarizeCourseObject(course: LearnCourse, initialized = true): LearnCourseSummary {
  const currentNode =
    course.dag.find(n => n.status === 'current') ||
    course.dag.find(n => n.status === 'stuck') ||
    course.dag[0];
  return {
    id: course.id,
    title: course.title,
    subtitle: course.subtitle,
    rootDir: course.rootDir,
    vaultDir: course.vaultDir,
    materialCount: course.materials.length,
    nodeCount: course.dag.length,
    masteredCount: course.dag.filter(n => n.status === 'mastered').length,
    stuckCount: course.dag.filter(n => n.status === 'stuck').length,
    currentNodeTitle: currentNode?.title,
    initialized,
    updatedAt: course.updatedAt,
  };
}

export function discoverAthenaeumCourses(
  athenaeumDir = DEFAULT_ATHENAEUM_DIR,
  persistenceDir = DEFAULT_PERSISTENCE_DIR,
): LearnCourseSummary[] {
  const normAthenaeum = path.resolve(String(athenaeumDir || DEFAULT_ATHENAEUM_DIR));
  const normPersistence = path.resolve(String(persistenceDir || DEFAULT_PERSISTENCE_DIR));
  const entries = new Map<string, LearnCourseSummary>();

  if (fs.existsSync(normAthenaeum)) {
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(normAthenaeum, {withFileTypes: true});
    } catch {
      dirEntries = [];
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith('.') || IGNORED_ATHENAEUM_DIRS.has(entry.name)) {
        continue;
      }
      const id = ensureSafeCourseId(entry.name);
      const rootDir = path.join(normAthenaeum, entry.name);
      const vaultDir = resolveVaultCourseDir(entry.name, normPersistence);
      const isCs336 = id === ROADSHOW_CS336_COURSE_ID;
      entries.set(id, {
        id,
        title: entry.name,
        subtitle: isCs336
          ? '大语言模型从零构建 · Architectures, Kernels & Scaling'
          : 'Athenaeum 课程知识库',
        rootDir,
        vaultDir,
        materialCount: 0,
        nodeCount: isCs336 ? 7 : 3,
        masteredCount: isCs336 ? 2 : 0,
        stuckCount: isCs336 ? 1 : 0,
        currentNodeTitle: isCs336 ? 'SwiGLU 门控与 8/3 d 对齐 64' : `${entry.name} 基础概念与边界`,
        initialized: false,
        updatedAt: '',
      });
    }
  }

  if (!entries.has(ROADSHOW_CS336_COURSE_ID)) {
    entries.set(ROADSHOW_CS336_COURSE_ID, {
      id: ROADSHOW_CS336_COURSE_ID,
      title: 'Stanford CS336',
      subtitle: '大语言模型从零构建 · Architectures, Kernels & Scaling',
      rootDir: path.join(normAthenaeum, 'Stanford CS336'),
      vaultDir: resolveVaultCourseDir('Stanford CS336', normPersistence),
      materialCount: 0,
      nodeCount: 7,
      masteredCount: 2,
      stuckCount: 1,
      currentNodeTitle: 'SwiGLU 门控与 8/3 d 对齐 64',
      initialized: false,
      updatedAt: '',
    });
  }

  return Array.from(entries.values()).sort((a, b) => {
    if (a.id === ROADSHOW_CS336_COURSE_ID) {
      return -1;
    }
    if (b.id === ROADSHOW_CS336_COURSE_ID) {
      return 1;
    }
    return a.title.localeCompare(b.title);
  });
}

export function ensureRoadshowCs336Course(
  userDataDir: string,
  options?: LearnCourseStoreOptions,
): LearnCourse {
  const athenaeumDir = path.resolve(options?.athenaeumDir || DEFAULT_ATHENAEUM_DIR);
  const persistenceDir = path.resolve(options?.persistenceDir || DEFAULT_PERSISTENCE_DIR);
  const rootDir = path.join(athenaeumDir, 'Stanford CS336');
  const vaultDir = resolveVaultCourseDir('Stanford CS336', persistenceDir);
  const nowIso = new Date().toISOString();
  const madeDate = nowIso.slice(0, 10);
  const materials = scanCourseMaterials(rootDir, vaultDir);

  const filePath = courseJsonPath(userDataDir, ROADSHOW_CS336_COURSE_ID);
  const existing = readJsonSafe<LearnCourse>(filePath);

  if (existing && existing.id === ROADSHOW_CS336_COURSE_ID) {
    const versionTag = `MP-ARTIFACT-VERSION:${ROADSHOW_ARTIFACT_VERSION}`;
    const hasCurrentHtml =
      typeof existing.livingArtifact?.html === 'string' &&
      existing.livingArtifact.html.includes(versionTag) &&
      existing.livingArtifact.html.includes('<main id="doc">');

    const nextCourse: LearnCourse = {
      ...existing,
      rootDir: existing.rootDir || rootDir,
      vaultDir: existing.vaultDir || vaultDir,
      materials: materials.length > 0 ? materials : existing.materials || [],
      dag: Array.isArray(existing.dag) && existing.dag.length > 0 ? existing.dag : buildRoadshowCs336Dag(),
      profile: existing.profile || {
        mathLevel: 2,
        handsOnLevel: 2,
        longTermPrefs: [],
        densitySignals: [],
        conceptStates: {},
      },
      livingArtifact: {
        title:
          existing.livingArtifact?.title ||
          'SwiGLU 门控比与 64 对齐背后的显存和 Tensor Core 账本',
        updatedAt: existing.livingArtifact?.updatedAt || nowIso,
        html: hasCurrentHtml
          ? existing.livingArtifact.html
          : buildRoadshowCs336LivingHtml(madeDate),
        markdown:
          existing.livingArtifact?.markdown || buildRoadshowCs336Markdown(),
        annotations: Array.isArray(existing.livingArtifact?.annotations)
          ? existing.livingArtifact.annotations
          : [],
        checkins: Array.isArray(existing.livingArtifact?.checkins)
          ? existing.livingArtifact.checkins
          : [],
      },
      dreamHistory: Array.isArray(existing.dreamHistory) ? existing.dreamHistory : [],
      updatedAt: existing.updatedAt || nowIso,
    };

    if (!hasCurrentHtml || (!existing.materials?.length && materials.length > 0)) {
      saveLearnCourse(userDataDir, nextCourse);
    }
    if (!fs.existsSync(indexJsonPath(userDataDir))) {
      writeIndexFile(userDataDir, ROADSHOW_CS336_COURSE_ID);
    }
    return nextCourse;
  }

  const seeded: LearnCourse = {
    id: ROADSHOW_CS336_COURSE_ID,
    title: 'Stanford CS336',
    subtitle: '大语言模型从零构建 · Architectures, Kernels & Scaling',
    rootDir,
    vaultDir,
    materials,
    dag: buildRoadshowCs336Dag(),
    profile: {
      mathLevel: 2,
      handsOnLevel: 2,
      longTermPrefs: [
        {
          date: madeDate,
          pref: '先给几何画面或小规模具体张量数值，再落回通用矩阵公式',
          quote: '带 d=4 的数字走一遍我才能看出来哪里省了显存',
        },
      ],
      densitySignals: [],
      conceptStates: {
        'RoPE 外推频率基底': {
          status: 'stuck',
          lastAngle: '纯复数矩阵代数推导',
          evidence: '标注不懂：为什么高频旋转对管近处、低频管远处？',
          updatedAt: nowIso,
        },
        'Pre-Norm 梯度恒等通路': {
          status: 'mastered',
          lastAngle: '展开 x_L = x_0 + sum Sublayer',
          evidence: '完成 Check-in 并准确写出无衰减主干原因',
          updatedAt: nowIso,
        },
      },
    },
    livingArtifact: {
      title: 'SwiGLU 门控比与 64 对齐背后的显存和 Tensor Core 账本',
      updatedAt: nowIso,
      html: buildRoadshowCs336LivingHtml(madeDate),
      markdown: buildRoadshowCs336Markdown(),
      annotations: [],
      checkins: [],
    },
    dreamHistory: [],
    updatedAt: nowIso,
  };

  saveLearnCourse(userDataDir, seeded);
  if (!fs.existsSync(indexJsonPath(userDataDir))) {
    writeIndexFile(userDataDir, ROADSHOW_CS336_COURSE_ID);
  }
  return seeded;
}

export function listLearnCourses(
  userDataDir: string,
  options?: LearnCourseStoreOptions,
): LearnCourseListResult {
  const cs336 = ensureRoadshowCs336Course(userDataDir, options);
  const index = readIndexFile(userDataDir);
  const discovered = discoverAthenaeumCourses(
    options?.athenaeumDir,
    options?.persistenceDir,
  );
  const byId = new Map<string, LearnCourseSummary>();

  for (const item of discovered) {
    byId.set(item.id, item);
  }

  const root = learnCoursesRoot(userDataDir);
  if (fs.existsSync(root)) {
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(root, {withFileTypes: true});
    } catch {
      dirEntries = [];
    }
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const courseData = readJsonSafe<LearnCourse>(
        path.join(root, entry.name, 'course.json'),
      );
      if (courseData && courseData.id) {
        byId.set(courseData.id, summarizeCourseObject(courseData, true));
      }
    }
  }

  byId.set(cs336.id, summarizeCourseObject(cs336, true));

  const courses = Array.from(byId.values()).sort((a, b) => {
    if (a.id === index.activeCourseId) {
      return -1;
    }
    if (b.id === index.activeCourseId) {
      return 1;
    }
    if (a.id === ROADSHOW_CS336_COURSE_ID) {
      return -1;
    }
    if (b.id === ROADSHOW_CS336_COURSE_ID) {
      return 1;
    }
    if (a.initialized !== b.initialized) {
      return a.initialized ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });

  const activeCourseId = byId.has(index.activeCourseId)
    ? index.activeCourseId
    : ROADSHOW_CS336_COURSE_ID;

  return {activeCourseId, courses};
}

export function getLearnCourse(
  userDataDir: string,
  courseId: string,
  options?: LearnCourseStoreOptions,
): LearnCourse | null {
  const safeId = ensureSafeCourseId(courseId);
  if (safeId === ROADSHOW_CS336_COURSE_ID) {
    return ensureRoadshowCs336Course(userDataDir, options);
  }

  const existing = readJsonSafe<LearnCourse>(courseJsonPath(userDataDir, safeId));
  if (existing) {
    if (
      (!existing.materials || existing.materials.length === 0) &&
      existing.rootDir &&
      fs.existsSync(existing.rootDir)
    ) {
      existing.materials = scanCourseMaterials(existing.rootDir, existing.vaultDir);
      saveLearnCourse(userDataDir, existing);
    }
    return existing;
  }

  const discovered = discoverAthenaeumCourses(
    options?.athenaeumDir,
    options?.persistenceDir,
  );
  const match = discovered.find(c => c.id === safeId);
  if (!match) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const materials = scanCourseMaterials(match.rootDir, match.vaultDir);
  const created: LearnCourse = {
    id: match.id,
    title: match.title,
    subtitle: match.subtitle,
    rootDir: match.rootDir,
    vaultDir: match.vaultDir,
    materials,
    dag: buildGenericCourseDag(match.title, materials),
    profile: {
      mathLevel: 2,
      handsOnLevel: 2,
      longTermPrefs: [],
      densitySignals: [],
      conceptStates: {},
    },
    livingArtifact: {
      title: `${match.title} 核心机制导读`,
      updatedAt: nowIso,
      html: buildGenericCourseStarterHtml(match.title, materials, nowIso.slice(0, 10)),
      markdown: `# ${match.title} 核心机制导读\n\n已索引 ${materials.length} 份课程资料。\n`,
      annotations: [],
      checkins: [],
    },
    dreamHistory: [],
    updatedAt: nowIso,
  };

  return saveLearnCourse(userDataDir, created);
}

export function setActiveLearnCourse(
  userDataDir: string,
  courseId: string,
  options?: LearnCourseStoreOptions,
): {activeCourseId: string; course: LearnCourse | null} {
  const course = getLearnCourse(userDataDir, courseId, options);
  if (!course) {
    return {activeCourseId: readIndexFile(userDataDir).activeCourseId, course: null};
  }
  writeIndexFile(userDataDir, course.id);
  return {activeCourseId: course.id, course};
}

export function recordAnnotationFeedback(
  userDataDir: string,
  courseId: string,
  mark: Omit<LearnAnnotationMark, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
    blockType?: string;
  },
  options?: LearnCourseStoreOptions,
): LearnCourse | null {
  const course = getLearnCourse(userDataDir, courseId, options);
  if (!course) {
    return null;
  }

  const createdAt = mark.createdAt || new Date().toISOString();
  const nextMark: LearnAnnotationMark = {
    id: mark.id || `m-${randomUUID().slice(0, 8)}`,
    type: mark.type,
    fb: mark.fb,
    quote: String(mark.quote || '').trim(),
    section: String(mark.section || '').trim(),
    note: mark.note !== undefined ? String(mark.note) : undefined,
    createdAt,
  };

  const existingIdx = course.livingArtifact.annotations.findIndex(
    a => a.id === nextMark.id,
  );
  if (existingIdx >= 0) {
    course.livingArtifact.annotations[existingIdx] = nextMark;
  } else {
    course.livingArtifact.annotations.push(nextMark);
  }

  const conceptKey = (nextMark.section || nextMark.quote).trim().slice(0, 64) || '当前概念';
  if (nextMark.type === 'fb' && nextMark.fb === 'confused') {
    course.profile.conceptStates[conceptKey] = {
      status: 'stuck',
      lastAngle: nextMark.section || '当前推导',
      evidence: nextMark.note
        ? `${nextMark.quote.slice(0, 96)}（${nextMark.note.slice(0, 96)}）`
        : `标注不懂：${nextMark.quote.slice(0, 120)}`,
      updatedAt: createdAt,
    };
  } else if (nextMark.type === 'fb' && nextMark.fb === 'known') {
    course.profile.conceptStates[conceptKey] = {
      status: 'mastered',
      lastAngle: nextMark.section || '当前推导',
      evidence: `标注已懂：${nextMark.quote.slice(0, 120)}`,
      updatedAt: createdAt,
    };
  } else if (nextMark.type === 'fb' && nextMark.fb === 'verbose') {
    course.profile.densitySignals.push({
      date: createdAt.slice(0, 10),
      doc: course.livingArtifact.title,
      blockType: mark.blockType || nextMark.section || 'prose',
      signal: 'verbose',
    });
  } else if (nextMark.type === 'note' && nextMark.note && !course.profile.conceptStates[conceptKey]) {
    course.profile.conceptStates[conceptKey] = {
      status: 'probed',
      lastAngle: nextMark.section || '笔记追问',
      evidence: nextMark.note.slice(0, 120),
      updatedAt: createdAt,
    };
  }

  course.livingArtifact.updatedAt = createdAt;
  course.updatedAt = createdAt;
  return saveLearnCourse(userDataDir, course);
}

function sanitizeLemmaHeading(rawTitle: string): string {
  const cleaned = String(rawTitle || '补充引理')
    .replace(/[？?]/g, '')
    .replace(/^(什么|为什么|怎么|怎样|如何)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '补充引理';
}

export function promoteSideChatLemma(
  userDataDir: string,
  courseId: string,
  input: {title: string; quote?: string; insight: string; section?: string},
  options?: LearnCourseStoreOptions,
): LearnCourse | null {
  const course = getLearnCourse(userDataDir, courseId, options);
  if (!course) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const safeHeading = escapeHtml(sanitizeLemmaHeading(input.title));
  const safeInsight = escapeHtml(String(input.insight || '').trim());
  const safeSection = input.section ? escapeHtml(String(input.section).trim()) : '';
  const safeQuote = input.quote ? escapeHtml(String(input.quote).trim()) : '';

  const metaParts: string[] = [];
  if (safeSection) {
    metaParts.push(`<span>关联小节：${safeSection}</span>`);
  }
  if (safeQuote) {
    metaParts.push(`<span>原句锚点：<code>${safeQuote}</code></span>`);
  }
  const metaHtml = metaParts.length > 0 ? `<p>${metaParts.join(' · ')}</p>` : '';
  const lemmaBlock = [
    `<h3>${safeHeading}</h3>`,
    `<div class="note"><b>已固化引理</b>${metaHtml}<p>${safeInsight}</p></div>`,
  ].join('\n');

  const html = course.livingArtifact.html || '';
  if (html.includes('<!-- MP-LEMMA-END -->')) {
    course.livingArtifact.html = html.replace(
      '<!-- MP-LEMMA-END -->',
      `${lemmaBlock}\n<!-- MP-LEMMA-END -->`,
    );
  } else if (html.includes('</main>')) {
    course.livingArtifact.html = html.replace(
      '</main>',
      `${lemmaBlock}\n<!-- MP-LEMMA-END -->\n</main>`,
    );
  } else {
    course.livingArtifact.html = `${html}\n${lemmaBlock}\n<!-- MP-LEMMA-END -->`;
  }

  const mdParts = [`### ${sanitizeLemmaHeading(input.title)}`];
  if (input.section) {
    mdParts.push(`> 关联小节：${input.section}`);
  }
  if (input.quote) {
    mdParts.push(`> 原句：${input.quote}`);
  }
  mdParts.push(String(input.insight || '').trim());
  course.livingArtifact.markdown = `${course.livingArtifact.markdown.trim()}\n\n${mdParts.join('\n')}\n`;
  course.livingArtifact.updatedAt = nowIso;
  course.updatedAt = nowIso;

  return saveLearnCourse(userDataDir, course);
}

export function recordCourseCheckin(
  userDataDir: string,
  courseId: string,
  checkin: Omit<LearnCheckinRecord, 'id' | 'createdAt'>,
  options?: LearnCourseStoreOptions,
): LearnCourse | null {
  const course = getLearnCourse(userDataDir, courseId, options);
  if (!course) {
    return null;
  }

  const createdAt = new Date().toISOString();
  const record: LearnCheckinRecord = {
    id: `chk-${randomUUID().slice(0, 8)}`,
    question: String(checkin.question || '').trim(),
    selectedIndex: checkin.selectedIndex,
    selectedLabel: String(checkin.selectedLabel || '').trim(),
    unsure: Boolean(checkin.unsure),
    reasoningNote: String(checkin.reasoningNote || '').trim(),
    nodeId: checkin.nodeId,
    createdAt,
  };
  course.livingArtifact.checkins.push(record);

  const targetNode = record.nodeId
    ? course.dag.find(n => n.id === record.nodeId)
    : course.dag.find(n => n.status === 'current');

  if (targetNode) {
    const attemptSummary = record.unsure
      ? `暂跳过核对：${record.question.slice(0, 48)}${record.reasoningNote ? ` · ${record.reasoningNote}` : ''}`
      : `选择「${record.selectedLabel}」${record.reasoningNote ? ` · ${record.reasoningNote}` : ''}`;
    targetNode.lastAttemptNote = attemptSummary;

    const markedConfused = course.livingArtifact.annotations.some(
      a =>
        a.fb === 'confused' &&
        (a.section === targetNode.title ||
          a.quote.includes(targetNode.title) ||
          targetNode.title.includes(a.section)),
    );
    if (!record.unsure && !markedConfused) {
      course.profile.conceptStates[targetNode.title] = {
        status: 'mastered',
        lastAngle: 'Check-in 直觉核对',
        evidence: attemptSummary,
        updatedAt: createdAt,
      };
    } else if (record.unsure && !course.profile.conceptStates[targetNode.title]) {
      course.profile.conceptStates[targetNode.title] = {
        status: 'stuck',
        lastAngle: 'Check-in 标为不确定',
        evidence: attemptSummary,
        updatedAt: createdAt,
      };
    }
  }

  course.livingArtifact.updatedAt = createdAt;
  course.updatedAt = createdAt;
  return saveLearnCourse(userDataDir, course);
}

function tokenizeCourseTerms(text: string): string[] {
  const lower = String(text || '').toLowerCase();
  const ascii = lower.match(/[a-z0-9][a-z0-9_.-]{1,24}/g) || [];
  const cjk = lower.match(/[\u4e00-\u9fff]{2,8}/g) || [];
  const stop = new Set(['the', 'and', 'with', 'for', 'from', 'into', 'this', 'that', 'behind']);
  const out = new Set<string>();
  for (const t of ascii) {
    if (!stop.has(t) && t.length >= 2) {
      out.add(t);
    }
  }
  for (const t of cjk) {
    out.add(t);
  }
  return Array.from(out);
}

const DOMAIN_BRIDGE_KEYWORDS = [
  'swiglu',
  'rmsnorm',
  'prenorm',
  'pre-norm',
  'rope',
  'flashattention',
  'adamw',
  'chinchilla',
  'isoflop',
  'wsd',
  'bpe',
  'tokenizer',
  'transformer',
  'attention',
  'kv cache',
  'kv-cache',
  'microcompact',
  'compact',
  'context',
  'queryengine',
  'scaling',
  'softmax',
  'cs336',
  '显存',
  '旋转位置编码',
  '归一化',
  '注意力',
  '分词',
  '对齐',
];

function scoreVaultNoteAgainstCourse(
  note: VaultNoteSummary,
  course: LearnCourse,
): {score: number; bestNodeId: string; matchedTerms: string[]} {
  const haystack = `${note.title} ${note.relativePath} ${note.tags.join(' ')} ${note.excerpt}`.toLowerCase();
  let bestScore = 0;
  let bestNodeId = course.dag[0]?.id || '';
  const matched = new Set<string>();

  for (const node of course.dag) {
    let nodeScore = 0;
    const nodeTerms = tokenizeCourseTerms(`${node.id} ${node.title} ${node.summary}`);
    for (const term of nodeTerms) {
      if (haystack.includes(term)) {
        nodeScore += term.length >= 4 ? 6 : 3;
        matched.add(term);
      }
    }
    if (nodeScore > bestScore) {
      bestScore = nodeScore;
      bestNodeId = node.id;
    }
  }

  let extraScore = 0;
  for (const kw of DOMAIN_BRIDGE_KEYWORDS) {
    if (haystack.includes(kw)) {
      extraScore += 3;
      matched.add(kw);
    }
  }
  if (note.relativePath.toLowerCase().includes('cs 336') || note.relativePath.toLowerCase().includes('cs336')) {
    extraScore += 5;
  }

  return {
    score: bestScore + extraScore,
    bestNodeId,
    matchedTerms: Array.from(matched).slice(0, 4),
  };
}

export function buildLearnNeuralGraph(
  userDataDir: string,
  options?: {courseId?: string; persistenceDir?: string; athenaeumDir?: string},
): LearnNeuralGraph {
  const persistenceDir = path.resolve(options?.persistenceDir || DEFAULT_PERSISTENCE_DIR);
  const athenaeumDir = path.resolve(options?.athenaeumDir || DEFAULT_ATHENAEUM_DIR);
  const index = readIndexFile(userDataDir);
  const targetId = options?.courseId || index.activeCourseId || ROADSHOW_CS336_COURSE_ID;
  const course =
    getLearnCourse(userDataDir, targetId, {athenaeumDir, persistenceDir}) ||
    ensureRoadshowCs336Course(userDataDir, {athenaeumDir, persistenceDir});

  const nodesMap = new Map<string, NeuralNode>();
  const edges: NeuralEdge[] = [];
  const edgeKeys = new Set<string>();

  const addNode = (node: NeuralNode): void => {
    if (!nodesMap.has(node.id)) {
      nodesMap.set(node.id, node);
    }
  };
  const addEdge = (edge: NeuralEdge): void => {
    if (!nodesMap.has(edge.source) || !nodesMap.has(edge.target)) {
      return;
    }
    if (edge.source === edge.target) {
      return;
    }
    const key = `${edge.source}->${edge.target}:${edge.kind}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  // 1. Course DAG nodes
  for (const dagNode of course.dag) {
    const firstMaterial = dagNode.materialPaths?.[0];
    const resolvedMat = firstMaterial
      ? course.materials.find(m => m.path.replace(/\\/g, '/').endsWith(firstMaterial))
      : undefined;
    addNode({
      id: `course:${dagNode.id}`,
      label: dagNode.title,
      group: dagNode.status === 'stuck' ? 'stuck' : 'course',
      status: dagNode.status,
      degree: 0,
      sourcePath: resolvedMat?.path || firstMaterial,
      excerpt: dagNode.summary,
      courseId: course.id,
    });
  }
  for (const dagNode of course.dag) {
    for (const prereqId of dagNode.prereqIds) {
      addEdge({
        source: `course:${prereqId}`,
        target: `course:${dagNode.id}`,
        kind: 'prereq',
        label: '前置',
      });
    }
  }

  // 2. Stuck concept nodes from reader profile
  for (const [conceptName, state] of Object.entries(course.profile.conceptStates)) {
    if (state.status !== 'stuck') {
      continue;
    }
    const alreadyInDag = course.dag.some(
      n => n.title === conceptName || n.title.includes(conceptName) || conceptName.includes(n.title),
    );
    if (alreadyInDag && course.dag.some(n => n.status === 'stuck')) {
      continue;
    }
    const conceptId = `concept:${slugifyCourseId(conceptName)}`;
    addNode({
      id: conceptId,
      label: conceptName,
      group: 'stuck',
      status: 'stuck',
      degree: 0,
      excerpt: state.evidence,
      courseId: course.id,
    });
    const matchedDag =
      course.dag.find(n => n.status === 'stuck') ||
      course.dag.find(n => n.status === 'current') ||
      course.dag[0];
    if (matchedDag) {
      addEdge({
        source: conceptId,
        target: `course:${matchedDag.id}`,
        kind: 'cross-bridge',
        label: '卡点',
      });
    }
  }

  // 3. Key code/assignment materials (up to 4)
  const codeMaterials = course.materials
    .filter(m => m.kind === 'code' || m.kind === 'assignment')
    .slice(0, 4);
  for (const mat of codeMaterials) {
    const codeNodeId = `code:${slugifyCourseId(mat.id)}`;
    addNode({
      id: codeNodeId,
      label: mat.title,
      group: 'code',
      degree: 0,
      sourcePath: mat.path,
      courseId: course.id,
    });
    const matchedDag =
      course.dag.find(n =>
        (n.materialPaths || []).some(p =>
          mat.path.replace(/\\/g, '/').endsWith(p.replace(/\\/g, '/')),
        ),
      ) ||
      course.dag.find(n => n.status === 'current') ||
      course.dag[0];
    if (matchedDag) {
      addEdge({
        source: codeNodeId,
        target: `course:${matchedDag.id}`,
        kind: 'tag',
        label: mat.category,
      });
    }
  }

  // 4. Vault notes from Persistence (+ course vaultDir if separate)
  const vaultOverviews: VaultOverview[] = [];
  if (fs.existsSync(persistenceDir)) {
    vaultOverviews.push(scanKnowledgeVault(persistenceDir));
  }
  if (
    course.vaultDir &&
    path.resolve(course.vaultDir) !== persistenceDir &&
    !path.resolve(course.vaultDir).startsWith(persistenceDir + path.sep) &&
    fs.existsSync(course.vaultDir)
  ) {
    vaultOverviews.push(scanKnowledgeVault(course.vaultDir));
  }

  const allVaultNotes: VaultNoteSummary[] = [];
  const seenFilePaths = new Set<string>();
  for (const ov of vaultOverviews) {
    for (const note of ov.notes) {
      const resolved = path.resolve(note.filePath);
      if (!seenFilePaths.has(resolved)) {
        seenFilePaths.add(resolved);
        allVaultNotes.push(note);
      }
    }
  }

  const scoredNotes = allVaultNotes
    .map(note => ({
      note,
      ...scoreVaultNoteAgainstCourse(note, course),
    }))
    .sort((a, b) => b.score - a.score || b.note.links.length - a.note.links.length);

  const maxVaultBudget = Math.max(0, 36 - nodesMap.size);
  const chosenVault = scoredNotes
    .filter(item => item.score > 0 || item.note.links.length > 0)
    .slice(0, Math.min(16, maxVaultBudget));

  const vaultIdByKey = new Map<string, string>();
  const chosenWithIds: Array<{
    id: string;
    note: VaultNoteSummary;
    bestNodeId: string;
    matchedTerms: string[];
    score: number;
  }> = [];

  for (const item of chosenVault) {
    const vId = `vault:${item.note.relativePath}`;
    addNode({
      id: vId,
      label: item.note.title,
      group: 'vault',
      degree: 0,
      sourcePath: item.note.filePath,
      excerpt: item.note.excerpt,
    });
    vaultIdByKey.set(item.note.title.toLowerCase(), vId);
    vaultIdByKey.set(
      path.basename(item.note.relativePath, '.md').toLowerCase(),
      vId,
    );
    chosenWithIds.push({id: vId, ...item});
  }

  for (const item of chosenWithIds) {
    for (const link of item.note.links) {
      const targetVaultId = vaultIdByKey.get(link.toLowerCase());
      if (targetVaultId) {
        addEdge({
          source: item.id,
          target: targetVaultId,
          kind: 'wikilink',
        });
      }
    }
    if (item.score > 0 && item.bestNodeId) {
      addEdge({
        source: item.id,
        target: `course:${item.bestNodeId}`,
        kind: 'cross-bridge',
        label: item.matchedTerms[0] || 'bridge',
      });
    }
  }

  // Also preserve explicit cross-bridges discovered in dreamHistory
  for (const dream of course.dreamHistory.slice(-3)) {
    for (const bridge of dream.crossBridges) {
      const targetVaultId =
        chosenWithIds.find(
          v =>
            path.resolve(v.note.filePath) === path.resolve(bridge.toPath) ||
            v.note.title === bridge.toTitle,
        )?.id || vaultIdByKey.get(bridge.toTitle.toLowerCase());
      const sourceDag =
        course.dag.find(n => n.title === bridge.fromTitle) ||
        course.dag.find(n => n.status === 'current') ||
        course.dag[0];
      if (targetVaultId && sourceDag) {
        addEdge({
          source: targetVaultId,
          target: `course:${sourceDag.id}`,
          kind: 'cross-bridge',
          label: 'dream-bridge',
        });
      }
    }
  }

  // 5. Sibling Athenaeum courses (up to 5)
  const siblingBudget = Math.max(0, Math.min(5, 44 - nodesMap.size));
  const siblings = discoverAthenaeumCourses(athenaeumDir, persistenceDir)
    .filter(c => c.id !== course.id)
    .slice(0, siblingBudget);

  for (const sib of siblings) {
    const sibId = `athenaeum:${sib.id}`;
    addNode({
      id: sibId,
      label: sib.title,
      group: 'course',
      degree: 0,
      sourcePath: sib.rootDir,
      excerpt: sib.subtitle,
      courseId: sib.id,
    });
    const lowerTitle = sib.title.toLowerCase();
    const targetDag =
      lowerTitle.includes('dlsys') || lowerTitle.includes('15-442')
        ? course.dag.find(n => n.id === 'flashattention-tiling') || course.dag[0]
        : lowerTitle.includes('6.s081') || lowerTitle.includes('cs144')
          ? course.dag.find(n => n.id === 'adamw-memory-accounting') || course.dag[0]
          : lowerTitle.includes('6.s184') || lowerTitle.includes('cs285')
            ? course.dag.find(n => n.id === 'scaling-laws-wsd') || course.dag[0]
            : course.dag[0];
    if (targetDag) {
      addEdge({
        source: sibId,
        target: `course:${targetDag.id}`,
        kind: 'cross-bridge',
        label: '课程关联',
      });
    }
  }

  for (const edge of edges) {
    const src = nodesMap.get(edge.source);
    const dst = nodesMap.get(edge.target);
    if (src) {
      src.degree += 1;
    }
    if (dst) {
      dst.degree += 1;
    }
  }

  const nodes = Array.from(nodesMap.values());
  const stats = {
    totalNodes: nodes.length,
    courseNodes: nodes.filter(n => n.group === 'course').length,
    vaultNodes: nodes.filter(n => n.group === 'vault').length,
    stuckNodes: nodes.filter(n => n.group === 'stuck').length,
    crossLinks: edges.filter(
      e => e.kind === 'cross-bridge' || e.kind === 'wikilink',
    ).length,
  };

  return {nodes, edges, stats};
}

export function summarizeCourseForPrompt(
  course: LearnCourse,
): LearnCoursePromptSummary {
  const currentNode =
    course.dag.find(n => n.status === 'current') ||
    course.dag.find(n => n.status === 'stuck') ||
    course.dag[0];

  const stuckConcepts = Object.entries(course.profile.conceptStates)
    .filter(([, s]) => s.status === 'stuck')
    .map(([name]) => name);

  for (const node of course.dag) {
    if (node.status === 'stuck' && !stuckConcepts.includes(node.title)) {
      stuckConcepts.push(node.title);
    }
  }

  const recentAnnotations = course.livingArtifact.annotations
    .slice(-5)
    .map(a => ({
      type: a.type,
      fb: a.fb,
      quote: a.quote.slice(0, 120),
      section: a.section,
      note: a.note ? a.note.slice(0, 140) : undefined,
    }));

  const latestDream = course.dreamHistory[course.dreamHistory.length - 1];
  const latestDreamInsights = latestDream
    ? latestDream.synthesizedInsights.slice(0, 5)
    : [];

  return {
    courseTitle: course.title,
    currentNodeTitle: currentNode?.title || '',
    stuckConcepts,
    recentAnnotations,
    latestDreamInsights,
  };
}
