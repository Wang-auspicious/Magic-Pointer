'use strict';

declare global {
  interface LearnTreeHooks {
    getConversation(): MagicPointerConversation | null;
    getEffort(): string;
    openDeckInInspector(): void;
    openConversationById(id: string): void;
    refreshConversation(id: string): Promise<void>;
    onMainLemmasChanged?(): void;
  }

  interface LearnTreeController {
    init(hooks: LearnTreeHooks): void;
    mountConversation(
      streamEl: HTMLElement,
      conversation: MagicPointerConversation | null | undefined,
    ): void;
    renderHud(
      hudEl: HTMLElement | null,
      conversation: MagicPointerConversation | null | undefined,
      streamEl: HTMLElement | null,
    ): void;
    renderDeck(
      hostEl: HTMLElement | null,
      conversation: MagicPointerConversation | null | undefined,
    ): void;
    renderMainComposerLemmas(hostEl: HTMLElement | null): void;
    formatQuestionWithMainLemmas(question: string): string;
    hasDockedBranches(
      conversation: MagicPointerConversation | null | undefined,
    ): boolean;
  }

  var LearnTree: LearnTreeController | undefined;
}

(() => {
  type LearnHooks = LearnTreeHooks;

  interface RectLike {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width?: number;
    height?: number;
  }

  interface PopoverState {
    conversationId: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    anchor: MagicPointerLearnAnchor;
    rect: RectLike;
    fromSelection: boolean;
  }

  interface LiveBranchStream {
    requestId: string;
    branchId: string;
    turnIndex: number;
    answer: string;
    thinking: string;
  }

  type CdsIconName =
    | 'caret-right'
    | 'caret-down'
    | 'arrow-up-right'
    | 'arrow-left'
    | 'arrow-up'
    | 'arrow-split'
    | 'git-branch'
    | 'link'
    | 'edit'
    | 'warning'
    | 'x'
    | 'book'
    | 'expand'
    | 'grip';

  interface SvgIconSpec {
    mode: 'fill' | 'stroke';
    paths: readonly string[];
    circles?: ReadonlyArray<{cx: number; cy: number; r: number}>;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LEMMA_MIME = 'application/x-mp-learn-lemma';
  const BRANCH_MIME = 'application/x-mp-learn-branch';
  const SPARK_PATH_D =
    'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z';

  // Exact Claude Desktop 4.23118 20x20 CDS vector paths
  const CDS_ICONS_20: Readonly<Record<CdsIconName, SvgIconSpec>> = {
    'caret-right': {
      mode: 'fill',
      paths: [
        'M7.08 5.42Q6.92 5.24 6.92 5Q6.92 4.76 7.08 4.58Q7.26 4.42 7.5 4.42Q7.74 4.42 7.92 4.58L12.92 9.58Q13.08 9.76 13.08 10Q13.08 10.24 12.92 10.42L7.92 15.42Q7.74 15.58 7.5 15.58Q7.26 15.58 7.08 15.42Q6.92 15.24 6.92 15Q6.92 14.76 7.08 14.58L11.68 10Z',
      ],
    },
    'caret-down': {
      mode: 'fill',
      paths: [
        'M4.58 7.92Q4.42 7.74 4.42 7.5Q4.42 7.26 4.58 7.08Q4.76 6.92 5 6.92Q5.24 6.92 5.42 7.08L10 11.68L14.58 7.08Q14.76 6.92 15 6.92Q15.24 6.92 15.42 7.08Q15.58 7.26 15.58 7.5Q15.58 7.74 15.42 7.92L10.42 12.92Q10.24 13.08 10 13.08Q9.76 13.08 9.58 12.92Z',
      ],
    },
    'arrow-up-right': {
      mode: 'stroke',
      paths: ['M4.625 15.375L15.375 4.625M15.375 11.696L15.375 4.625L8.304 4.625'],
    },
    'arrow-left': {
      mode: 'fill',
      paths: [
        'M16.38 9.42Q16.62 9.42 16.79 9.59Q16.96 9.76 16.96 10Q16.96 10.24 16.79 10.41Q16.62 10.58 16.38 10.58H4V9.42ZM9.42 14.58Q9.58 14.76 9.58 15Q9.58 15.24 9.42 15.42Q9.24 15.58 9 15.58Q8.76 15.58 8.58 15.42L3.58 10.42Q3.42 10.24 3.42 10Q3.42 9.76 3.58 9.58L8.58 4.58Q8.76 4.42 9 4.42Q9.24 4.42 9.42 4.58Q9.58 4.76 9.58 5Q9.58 5.24 9.42 5.42L4.82 10Z',
      ],
    },
    'arrow-up': {
      mode: 'fill',
      paths: [
        'M10.58 16.38Q10.58 16.62 10.41 16.79Q10.24 16.96 10 16.96Q9.76 16.96 9.59 16.79Q9.42 16.62 9.42 16.38V4H10.58ZM5.42 9.42Q5.24 9.58 5 9.58Q4.76 9.58 4.58 9.42Q4.42 9.24 4.42 9Q4.42 8.76 4.58 8.58L9.58 3.58Q9.76 3.42 10 3.42Q10.24 3.42 10.42 3.58L15.42 8.58Q15.58 8.76 15.58 9Q15.58 9.24 15.42 9.42Q15.24 9.58 15 9.58Q14.76 9.58 14.58 9.42L10 4.82Z',
      ],
    },
    'arrow-split': {
      mode: 'fill',
      paths: [
        'M2.62 10.58Q2.38 10.58 2.21 10.41Q2.04 10.24 2.04 10Q2.04 9.76 2.21 9.59Q2.38 9.42 2.62 9.42L7.04 9.4L7.42 9.36Q7.7 9.3 7.96 9.14L8.26 8.9L13.96 3.22L14.78 4.04L9.04 9.76L8.58 10.14Q8.16 10.38 7.68 10.5L7.1 10.58ZM14.96 7.62Q14.96 7.86 14.79 8.04Q14.62 8.22 14.38 8.22Q14.14 8.22 13.96 8.04Q13.78 7.86 13.78 7.62V4.22H10.38Q10.14 4.22 9.96 4.04Q9.78 3.86 9.78 3.62Q9.78 3.38 9.96 3.21Q10.14 3.04 10.38 3.04H14.38Q14.62 3.04 14.79 3.21Q14.96 3.38 14.96 3.62ZM9.46 12.28Q9.28 12.12 9.28 11.87Q9.28 11.62 9.46 11.46Q9.62 11.28 9.87 11.28Q10.12 11.28 10.28 11.46L14.78 15.96L13.96 16.78ZM13.78 12.38Q13.78 12.14 13.96 11.96Q14.14 11.78 14.38 11.78Q14.62 11.78 14.79 11.96Q14.96 12.14 14.96 12.38V16.38Q14.96 16.62 14.79 16.79Q14.62 16.96 14.38 16.96H10.38Q10.14 16.96 9.96 16.79Q9.78 16.62 9.78 16.38Q9.78 16.14 9.96 15.96Q10.14 15.78 10.38 15.78H13.78Z',
      ],
    },
    'git-branch': {
      mode: 'fill',
      paths: [
        'M7.96 5.5Q7.96 6.18 7.62 6.73Q7.28 7.28 6.73 7.62Q6.18 7.96 5.5 7.96Q4.82 7.96 4.27 7.62Q3.72 7.28 3.38 6.73Q3.04 6.18 3.04 5.5Q3.04 4.82 3.38 4.27Q3.72 3.72 4.27 3.38Q4.82 3.04 5.5 3.04Q6.18 3.04 6.73 3.38Q7.28 3.72 7.62 4.27Q7.96 4.82 7.96 5.5ZM6.78 5.5Q6.78 4.98 6.4 4.6Q6.02 4.22 5.5 4.22Q4.98 4.22 4.6 4.6Q4.22 4.98 4.22 5.5Q4.22 6.02 4.6 6.4Q4.98 6.78 5.5 6.78Q6.02 6.78 6.4 6.4Q6.78 6.02 6.78 5.5ZM16.96 5.5Q16.96 6.18 16.62 6.73Q16.28 7.28 15.73 7.62Q15.18 7.96 14.5 7.96Q13.82 7.96 13.27 7.62Q12.72 7.28 12.38 6.73Q12.04 6.18 12.04 5.5Q12.04 4.82 12.38 4.27Q12.72 3.72 13.27 3.38Q13.82 3.04 14.5 3.04Q15.18 3.04 15.73 3.38Q16.28 3.72 16.62 4.27Q16.96 4.82 16.96 5.5ZM15.78 5.5Q15.78 4.98 15.4 4.6Q15.02 4.22 14.5 4.22Q13.98 4.22 13.6 4.6Q13.22 4.98 13.22 5.5Q13.22 6.02 13.6 6.4Q13.98 6.78 14.5 6.78Q15.02 6.78 15.4 6.4Q15.78 6.02 15.78 5.5ZM7.96 14.5Q7.96 15.18 7.62 15.73Q7.28 16.28 6.73 16.62Q6.18 16.96 5.5 16.96Q4.82 16.96 4.27 16.62Q3.72 16.28 3.38 15.73Q3.04 15.18 3.04 14.5Q3.04 13.82 3.38 13.27Q3.72 12.72 4.27 12.38Q4.82 12.04 5.5 12.04Q6.18 12.04 6.73 12.38Q7.28 12.72 7.62 13.27Q7.96 13.82 7.96 14.5ZM6.78 14.5Q6.78 13.98 6.4 13.6Q6.02 13.22 5.5 13.22Q4.98 13.22 4.6 13.6Q4.22 13.98 4.22 14.5Q4.22 15.02 4.6 15.4Q4.98 15.78 5.5 15.78Q6.02 15.78 6.4 15.4Q6.78 15.02 6.78 14.5ZM4.92 7.38H6.08V10Q6.08 10.24 5.91 10.41Q5.74 10.58 5.5 10.58Q5.26 10.58 5.09 10.41Q4.92 10.24 4.92 10ZM4.92 10Q4.92 9.76 5.09 9.59Q5.26 9.42 5.5 9.42Q5.74 9.42 5.91 9.59Q6.08 9.76 6.08 10V12.62H4.92ZM5.5 10.58Q5.26 10.58 5.09 10.41Q4.92 10.24 4.92 10Q4.92 9.76 5.09 9.59Q5.26 9.42 5.5 9.42L12.8 9.4L13.2 9.32Q13.64 9.14 13.82 8.7L13.9 8.3L13.92 7.38H15.08L15.06 8.38L15.02 8.76L14.9 9.14Q14.54 10.04 13.64 10.4L13.26 10.52L12.88 10.56Z',
      ],
    },
    link: {
      mode: 'fill',
      paths: [
        'M10.52 5.98Q10.36 6.16 10.11 6.16Q9.86 6.16 9.7 5.98Q9.52 5.82 9.52 5.57Q9.52 5.32 9.7 5.16L10.74 4.1Q11.28 3.58 11.94 3.31Q12.6 3.04 13.31 3.04Q14.02 3.04 14.69 3.31Q15.36 3.58 15.9 4.1Q16.42 4.64 16.69 5.31Q16.96 5.98 16.96 6.69Q16.96 7.4 16.69 8.06Q16.42 8.72 15.9 9.26L13.56 11.6Q12.98 12.18 12.2 12.46Q11.42 12.74 10.6 12.64Q9.78 12.56 9.08 12.13Q8.38 11.7 7.92 11Q7.8 10.8 7.85 10.56Q7.9 10.32 8.1 10.2Q8.3 10.06 8.54 10.11Q8.78 10.16 8.9 10.36Q9.54 11.36 10.72 11.48Q11.9 11.6 12.72 10.76L15.06 8.42Q15.54 7.94 15.71 7.31Q15.88 6.68 15.71 6.05Q15.54 5.42 15.06 4.94Q14.58 4.46 13.95 4.29Q13.32 4.12 12.69 4.29Q12.06 4.46 11.58 4.94ZM9.48 14.02Q9.64 13.84 9.89 13.84Q10.14 13.84 10.3 14.02Q10.48 14.18 10.48 14.43Q10.48 14.68 10.3 14.84L9.26 15.9Q8.72 16.42 8.06 16.69Q7.4 16.96 6.69 16.96Q5.98 16.96 5.31 16.69Q4.64 16.42 4.1 15.9Q3.58 15.36 3.31 14.69Q3.04 14.02 3.04 13.31Q3.04 12.6 3.31 11.94Q3.58 11.28 4.1 10.74L6.44 8.4Q7.02 7.82 7.8 7.54Q8.58 7.26 9.4 7.36Q10.22 7.44 10.92 7.87Q11.62 8.3 12.08 9Q12.2 9.2 12.15 9.44Q12.1 9.68 11.9 9.8Q11.7 9.94 11.46 9.89Q11.22 9.84 11.1 9.64Q10.46 8.64 9.28 8.52Q8.1 8.4 7.28 9.24L4.94 11.58Q4.46 12.06 4.29 12.69Q4.12 13.32 4.29 13.95Q4.46 14.58 4.94 15.06Q5.42 15.54 6.05 15.71Q6.68 15.88 7.31 15.71Q7.94 15.54 8.42 15.06Z',
      ],
    },
    edit: {
      mode: 'fill',
      paths: [
        'M7.64 16.04 4.34 16.92 4.06 16.94Q4 16.94 3.91 16.93Q3.82 16.92 3.74 16.88Q3.3 16.72 3.12 16.26Q3.08 16.18 3.07 16.09Q3.06 16 3.06 15.92L3.08 15.66L3.96 12.36L4.18 11.66L4.44 11.22L4.56 11.08L11.86 3.76L12.22 3.48Q12.86 3.04 13.64 3.04Q14.42 3.04 15.08 3.48L15.24 3.6L16.24 4.58L16.54 4.92Q16.96 5.58 16.96 6.36Q16.96 7.14 16.54 7.78L16.4 7.96L9.32 15.06L8.78 15.56L8.34 15.82ZM7.34 14.9 7.78 14.78 8.1 14.6 15 7.72 15.56 7.14Q15.78 6.78 15.78 6.35Q15.78 5.92 15.56 5.58L15 5L14.42 4.44Q14.06 4.2 13.64 4.2Q13.22 4.2 12.88 4.44L12.78 4.5L5.44 11.84L5.24 12.16L4.22 15.92L4.2 15.84L4.16 15.8L4.08 15.78ZM10.56 5.88 11.38 5.06 14.94 8.6 14.12 9.44Z',
      ],
    },
    warning: {
      mode: 'fill',
      paths: [
        'M16.46 11.2Q16.84 11.8 17.12 12.27Q17.4 12.74 17.58 13.12Q17.78 13.54 17.88 13.86Q17.92 14.04 17.95 14.22Q17.98 14.4 17.96 14.6Q17.86 15.76 16.92 16.46V16.44Q16.76 16.56 16.59 16.64Q16.42 16.72 16.24 16.78Q15.92 16.86 15.46 16.92Q15.04 16.96 14.49 16.96Q13.94 16.96 13.24 16.96H6.76Q6.06 16.96 5.51 16.96Q4.96 16.96 4.54 16.92Q4.08 16.86 3.76 16.78Q3.58 16.72 3.41 16.64Q3.24 16.56 3.08 16.44V16.46Q2.14 15.76 2.04 14.6Q2.04 14.4 2.06 14.22Q2.08 14.04 2.12 13.86Q2.22 13.54 2.42 13.12Q2.6 12.74 2.88 12.27Q3.16 11.8 3.54 11.2L6.78 5.94Q7.12 5.38 7.39 4.95Q7.66 4.52 7.9 4.2L8.4 3.64Q8.52 3.52 8.66 3.42Q8.8 3.32 8.98 3.26Q10 2.8 11.02 3.26Q11.2 3.32 11.34 3.42Q11.48 3.52 11.6 3.64L12.1 4.2Q12.34 4.52 12.61 4.95Q12.88 5.38 13.22 5.94ZM15.46 11.8 12.22 6.54 11.18 4.9 10.82 4.5 10.56 4.32Q10 4.08 9.44 4.32L9.18 4.5L8.82 4.9L7.78 6.54L4.54 11.8Q4.18 12.4 3.91 12.85Q3.64 13.3 3.48 13.64L3.26 14.18L3.22 14.5Q3.26 15.14 3.78 15.5L4.08 15.64L4.66 15.74Q5.04 15.78 5.56 15.79Q6.08 15.8 6.76 15.8H13.24Q13.92 15.8 14.44 15.79Q14.96 15.78 15.34 15.74L15.92 15.64L16.22 15.5Q16.74 15.14 16.78 14.5L16.74 14.18L16.52 13.64Q16.36 13.3 16.09 12.85Q15.82 12.4 15.46 11.8ZM9.42 7.62Q9.42 7.38 9.59 7.21Q9.76 7.04 10 7.04Q10.24 7.04 10.41 7.21Q10.58 7.38 10.58 7.62V10.38Q10.58 10.62 10.41 10.79Q10.24 10.96 10 10.96Q9.76 10.96 9.59 10.79Q9.42 10.62 9.42 10.38ZM10.38 13Q10.38 13.16 10.26 13.26Q10.16 13.38 10 13.38Q9.84 13.38 9.74 13.26Q9.62 13.16 9.62 13Q9.62 12.84 9.74 12.74Q9.84 12.62 10 12.62Q10.16 12.62 10.26 12.74Q10.38 12.84 10.38 13Z',
      ],
    },
    x: {
      mode: 'stroke',
      paths: ['M14.5 5.5L5.5 14.5M14.5 14.5L5.5 5.5'],
    },
    book: {
      mode: 'stroke',
      paths: [
        'M3 4.5L7 4.5C8.657 4.5 10 5.843 10 7.5L10 17C9.701 16.104 8.863 15.5 7.919 15.5L3 15.5C2.724 15.5 2.5 15.276 2.5 15L2.5 5C2.5 4.724 2.724 4.5 3 4.5Z',
        'M17 4.5L13 4.5C11.343 4.5 10 5.843 10 7.5L10 17C10.299 16.104 11.137 15.5 12.081 15.5L17 15.5C17.276 15.5 17.5 15.276 17.5 15L17.5 5C17.5 4.724 17.276 4.5 17 4.5Z',
      ],
    },
    expand: {
      mode: 'stroke',
      paths: [
        'M12.5 3.5H16.5V7.5',
        'M7.5 16.5H3.5V12.5',
        'M16.5 3.5L11.5 8.5',
        'M3.5 16.5L8.5 11.5',
      ],
    },
    grip: {
      mode: 'fill',
      paths: [],
      circles: [
        {cx: 7, cy: 5.5, r: 1.1},
        {cx: 13, cy: 5.5, r: 1.1},
        {cx: 7, cy: 10, r: 1.1},
        {cx: 13, cy: 10, r: 1.1},
        {cx: 7, cy: 14.5, r: 1.1},
        {cx: 13, cy: 14.5, r: 1.1},
      ],
    },
  };

  let hooks: LearnHooks | null = null;
  let initialized = false;
  let highlightedBranchId = '';
  let glossPopover: HTMLElement | null = null;
  let glossTimer: ReturnType<typeof setTimeout> | null = null;
  let inquiryPopover: HTMLElement | null = null;
  let popoverState: PopoverState | null = null;
  let dockDropzone: HTMLElement | null = null;

  // Per root-turn focus shift target: key = `${conversationId}:${rootTurnIndex}` -> focused branchId
  const focusShiftByRoot = new Map<string, string>();
  // Per composer lemma chips: key = branchId or '__main__'
  const composerLemmas = new Map<string, MagicPointerLearnLemmaRef[]>();
  const liveStreams = new Map<string, LiveBranchStream>();
  const lastBranchStreamText = new WeakMap<HTMLElement, string>();

  function getActivityMarksApi(): {
    spark?: (
      state: 'idle' | 'thinking' | 'writing' | 'waiting',
      options?: {size?: number | string; color?: string; className?: string},
    ) => string;
  } | null {
    const g = globalThis as unknown as {
      ActivityMarks?: {
        spark?: (
          state: 'idle' | 'thinking' | 'writing' | 'waiting',
          options?: {size?: number | string; color?: string; className?: string},
        ) => string;
      };
    };
    if (g.ActivityMarks) {
      return g.ActivityMarks;
    }
    if (typeof require === 'function') {
      try {
        return require('./activity_marks');
      } catch {
        return null;
      }
    }
    return null;
  }

  function getStreamSmootherApi(): {
    tokenizeWordsForFade?: (delta: string) => string[];
  } | null {
    const g = globalThis as unknown as {
      StreamSmoother?: {
        tokenizeWordsForFade?: (delta: string) => string[];
      };
    };
    if (g.StreamSmoother) {
      return g.StreamSmoother;
    }
    if (typeof require === 'function') {
      try {
        return require('./stream_smoother');
      } catch {
        return null;
      }
    }
    return null;
  }

  function prefersReducedMotion(): boolean {
    if (
      typeof document !== 'undefined' &&
      document.documentElement?.getAttribute?.('data-reduce-motion') === 'true'
    ) {
      return true;
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
    ) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  }

  function streamingStatusNode(): HTMLElement {
    const row = el('div', 'mp-learn-streaming-status');
    row.setAttribute('role', 'status');
    row.setAttribute('data-streaming', 'true');
    const sparkHost = el('span', 'mp-learn-streaming-spark');
    sparkHost.setAttribute('aria-hidden', 'true');
    const marks = getActivityMarksApi();
    const markup =
      marks && typeof marks.spark === 'function'
        ? marks.spark('thinking', {color: 'var(--mp-clay, #d97757)'})
        : '';
    if (markup && 'innerHTML' in sparkHost) {
      sparkHost.innerHTML = markup;
    }
    if (!sparkHost.children?.length) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('data-cds', 'Spark');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('fill', 'var(--mp-clay, #d97757)');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', SPARK_PATH_D);
      svg.appendChild(path);
      sparkHost.appendChild(svg);
    }
    row.append(sparkHost, el('span', 'mp-learn-streaming-label', '正在推导…'));
    return row;
  }

  function applyBranchWordFade(
    markdownRoot: HTMLElement,
    prevText: string,
    nextText: string,
  ): void {
    if (
      prefersReducedMotion() ||
      typeof document === 'undefined' ||
      typeof document.createElement !== 'function' ||
      typeof document.createDocumentFragment !== 'function' ||
      typeof document.createTextNode !== 'function' ||
      !prevText ||
      !nextText.startsWith(prevText) ||
      nextText.length <= prevText.length ||
      nextText.length - prevText.length > 240
    ) {
      return;
    }
    const delta = nextText.slice(prevText.length);
    let cursor: Node | null = markdownRoot.lastElementChild || markdownRoot;
    while (cursor && cursor.lastChild) {
      if (
        typeof HTMLElement !== 'undefined' &&
        cursor instanceof HTMLElement &&
        (cursor.tagName === 'PRE' ||
          cursor.tagName === 'CODE' ||
          cursor.classList?.contains?.('katex'))
      ) {
        return;
      }
      cursor = cursor.lastChild;
    }
    if (!cursor || cursor.nodeType !== 3) {
      return;
    }
    const value = cursor.nodeValue || '';
    const trimmedDelta = delta.trimEnd();
    const matchedDelta = value.endsWith(delta)
      ? delta
      : trimmedDelta && value.endsWith(trimmedDelta)
        ? trimmedDelta
        : '';
    if (
      !matchedDelta ||
      !cursor.parentNode ||
      typeof cursor.parentNode.replaceChild !== 'function'
    ) {
      return;
    }
    const head = value.slice(0, value.length - matchedDelta.length);
    const smoother = getStreamSmootherApi();
    const words =
      smoother && typeof smoother.tokenizeWordsForFade === 'function'
        ? smoother.tokenizeWordsForFade(matchedDelta)
        : (matchedDelta.match(/\S+\s*|\s+/g) ?? [matchedDelta]);
    const frag = document.createDocumentFragment();
    if (head) {
      frag.appendChild(document.createTextNode(head));
    }
    for (const word of words) {
      const span = document.createElement('span');
      span.className = 'mp-stream-word-in';
      span.textContent = word;
      frag.appendChild(span);
    }
    cursor.parentNode.replaceChild(frag, cursor);
  }

  function patchStreamingAnswerBody(
    bodyEl: HTMLElement,
    answerText: string,
  ): void {
    const prevText = lastBranchStreamText.get(bodyEl) || '';
    const current = bodyEl.querySelector<HTMLElement>('.mp-chat-markdown');
    if (current && prevText === answerText) {
      return;
    }
    const next = renderMarkdownNode(answerText);
    if (
      !current ||
      typeof current.childNodes === 'undefined' ||
      typeof next.childNodes === 'undefined'
    ) {
      bodyEl.replaceChildren(next);
      lastBranchStreamText.set(bodyEl, answerText);
      return;
    }
    const blocks = Array.from(next.childNodes);
    blocks.forEach((block, index) => {
      const existing = current.childNodes[index];
      if (!existing) {
        current.appendChild(block);
      } else {
        const existingMarkup =
          (existing as Element).outerHTML ?? existing.textContent;
        const nextMarkup = (block as Element).outerHTML ?? block.textContent;
        if (
          existing.nodeType !== block.nodeType ||
          existingMarkup !== nextMarkup
        ) {
          current.insertBefore(block, existing);
          if (typeof (existing as ChildNode).remove === 'function') {
            (existing as ChildNode).remove();
          } else if (existing.parentNode) {
            existing.parentNode.removeChild(existing);
          }
        }
      }
    });
    while (current.childNodes.length > blocks.length) {
      const last = current.lastChild;
      if (!last) {
        break;
      }
      if (typeof (last as ChildNode).remove === 'function') {
        (last as ChildNode).remove();
      } else {
        current.removeChild(last);
      }
    }
    applyBranchWordFade(current, prevText, answerText);
    lastBranchStreamText.set(bodyEl, answerText);
  }

  function getDataApi(): typeof Data | undefined {
    const g = globalThis as unknown as {Data?: typeof Data};
    if (g.Data) {
      return g.Data;
    }
    return typeof Data !== 'undefined' ? Data : undefined;
  }

  function getMarkdownApi(): typeof ChatMarkdown | undefined {
    const g = globalThis as unknown as {ChatMarkdown?: typeof ChatMarkdown};
    if (g.ChatMarkdown) {
      return g.ChatMarkdown;
    }
    return typeof ChatMarkdown !== 'undefined' ? ChatMarkdown : undefined;
  }

  function getLearnLabApi(): LearnLabController | null {
    if (typeof LearnLab !== 'undefined' && LearnLab) {
      return LearnLab;
    }
    const g = globalThis as unknown as {LearnLab?: LearnLabController};
    return g?.LearnLab || null;
  }

  function escapeCssSelectorValue(raw: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(raw);
    }
    return raw.replace(/["\\]/g, '\\$&');
  }

  function isElementNode(node: unknown): node is HTMLElement {
    return Boolean(
      node &&
        typeof node === 'object' &&
        'tagName' in node &&
        typeof (node as HTMLElement).closest === 'function',
    );
  }

  function closestElement(
    node: unknown,
    selector: string,
  ): HTMLElement | null {
    if (isElementNode(node)) {
      return node.closest(selector);
    }
    if (
      node &&
      typeof node === 'object' &&
      'parentElement' in node &&
      isElementNode((node as {parentElement?: unknown}).parentElement)
    ) {
      return (node as {parentElement: HTMLElement}).parentElement.closest(
        selector,
      );
    }
    return null;
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function cdsIcon(name: CdsIconName, size = 14): SVGElement {
    const spec = CDS_ICONS_20[name];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute(
      'class',
      `mp-learn-icon ${spec.mode === 'fill' ? 'is-fill' : 'is-stroke'}`,
    );
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    if (spec.mode === 'fill') {
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('stroke', 'none');
    } else {
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.35');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
    }
    for (const d of spec.paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (spec.mode === 'stroke') {
        path.setAttribute('vector-effect', 'non-scaling-stroke');
      }
      svg.appendChild(path);
    }
    if (spec.circles) {
      for (const item of spec.circles) {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', String(item.cx));
        circle.setAttribute('cy', String(item.cy));
        circle.setAttribute('r', String(item.r));
        svg.appendChild(circle);
      }
    }
    return svg;
  }

  function iconLabelButton(options: {
    icon: CdsIconName;
    label?: string;
    className?: string;
    title?: string;
    iconSize?: number;
  }): HTMLButtonElement {
    const btn = el('button', options.className);
    btn.type = 'button';
    if (options.title) {
      btn.title = options.title;
      btn.setAttribute('aria-label', options.title);
    }
    btn.appendChild(cdsIcon(options.icon, options.iconSize ?? 13));
    if (options.label) {
      btn.appendChild(el('span', '', options.label));
    }
    return btn;
  }

  function renderMarkdownNode(markdown: string): HTMLElement {
    const api = getMarkdownApi();
    if (api && typeof api.render === 'function') {
      const rendered = api.render(markdown || '');
      if (isElementNode(rendered)) {
        return rendered;
      }
    }
    const fallback = el('div', 'mp-chat-markdown');
    fallback.textContent = markdown || '';
    return fallback;
  }

  function branchSummaryForLemma(branch: MagicPointerLearnBranch): string {
    if (branch.insightSummary && branch.insightSummary.trim()) {
      return branch.insightSummary.trim();
    }
    const lastSettled = [...(branch.turns || [])]
      .reverse()
      .find(turn => String(turn.answer || '').trim());
    if (!lastSettled) {
      return branch.anchor.snippet || branch.title;
    }
    return String(lastSettled.answer || '')
      .replace(/:::card[^\n]*\n?/g, '')
      .replace(/:::\s*$/gm, '')
      .replace(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g, '$1')
      .replace(/==([^=\n]+)==/g, '$1')
      .trim()
      .slice(0, 600);
  }

  function kindBadgeText(kind: MagicPointerLearnAnchor['kind']): string {
    if (kind === 'term') {
      return 'concept';
    }
    if (kind === 'math') {
      return 'formula';
    }
    if (kind === 'card') {
      return 'section';
    }
    return 'excerpt';
  }

  const PRIORITY_OPTIONS: ReadonlyArray<{
    value: 'P1' | 'P2' | 'P3';
    label: string;
    title: string;
  }> = [
    {value: 'P1', label: 'P1', title: '核心优先：先解决这一疑问'},
    {value: 'P2', label: 'P2', title: '待厘清：下一步处理'},
    {value: 'P3', label: 'P3', title: '延伸拓展：稍后再看'},
  ];

  function normalizePriority(raw: unknown): 'P1' | 'P2' | 'P3' | '' {
    const upper = String(raw || '').trim().toUpperCase();
    if (upper === 'P1' || upper === 'HIGH') {
      return 'P1';
    }
    if (upper === 'P2' || upper === 'MEDIUM') {
      return 'P2';
    }
    if (upper === 'P3' || upper === 'LOW') {
      return 'P3';
    }
    return '';
  }

  function priorityRank(raw: unknown): number {
    const p = normalizePriority(raw);
    if (p === 'P1') {
      return 0;
    }
    if (p === 'P2') {
      return 1;
    }
    if (p === 'P3') {
      return 2;
    }
    return 3;
  }

  function nextPriorityValue(raw: unknown): string {
    const p = normalizePriority(raw);
    if (!p) {
      return 'P1';
    }
    if (p === 'P1') {
      return 'P2';
    }
    if (p === 'P2') {
      return 'P3';
    }
    return '';
  }

  function sortBranchesByPriority(
    branches: readonly MagicPointerLearnBranch[],
  ): MagicPointerLearnBranch[] {
    return branches
      .map((branch, index) => ({
        branch,
        index,
        rank: priorityRank(branch.anchor?.priority),
      }))
      .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
      .map(item => item.branch);
  }

  function extractSelectionTextClean(
    range: Range,
    fallbackText = '',
  ): string {
    const cleanFallback = String(fallbackText || '').trim();
    if (typeof range.cloneContents !== 'function') {
      const direct =
        typeof range.toString === 'function' ? String(range.toString()).trim() : '';
      return direct && direct !== '[object Object]' ? direct : cleanFallback;
    }
    const frag = range.cloneContents();
    if (frag && typeof frag.querySelectorAll === 'function') {
      frag
        .querySelectorAll('.katex-mathml, .mp-learn-math-ask-pill')
        .forEach(node => node.remove());
    }
    return (
      String(frag?.textContent || '')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim() || cleanFallback
    );
  }

  function getConceptGraphApi(): ConceptGraphController | null {
    if (typeof ConceptGraph !== 'undefined' && ConceptGraph) {
      return ConceptGraph;
    }
    const g =
      typeof globalThis !== 'undefined'
        ? (globalThis as unknown as {ConceptGraph?: ConceptGraphController})
        : null;
    return g?.ConceptGraph || null;
  }

  function cleanFormulaLabel(tex: string): string {
    const graphApi = getConceptGraphApi();
    const normalized = graphApi
      ? graphApi.cleanFormulaText(tex)
      : String(tex || '')
          .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)')
          .replace(/\\omega(?![A-Za-z])/g, 'ω')
          .replace(/\\alpha(?![A-Za-z])/g, 'α')
          .replace(/\\lambda(?![A-Za-z])/g, 'λ')
          .replace(/\\theta(?![A-Za-z])/g, 'θ')
          .replace(/\\sigma(?![A-Za-z])/g, 'σ')
          .replace(/\\ge|\\geq(?![A-Za-z])/g, '≥')
          .replace(/\\le|\\leq(?![A-Za-z])/g, '≤')
          .replace(/\\mid(?![A-Za-z])/g, '|')
          .replace(/_\{?1\}?/g, '₁')
          .replace(/_\{?2\}?/g, '₂')
          .replace(/_\{?21\}?/g, '₂₁')
          .replace(/_\{?11\}?/g, '₁₁')
          .replace(/_\{?12\}?/g, '₁₂')
          .replace(/_\{?22\}?/g, '₂₂')
          .replace(/[{}]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
    if (!normalized) {
      return '公式';
    }
    return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
  }

  let returnFlashTimer: ReturnType<typeof setTimeout> | null = null;
  function jumpToSourceAnchor(branch: MagicPointerLearnBranch): boolean {
    if (typeof document === 'undefined') {
      return false;
    }
    const turnNode = document.querySelector<HTMLElement>(
      `.mp-chat-flow-item[data-turn-index="${String(branch.parentTurnIndex)}"]`,
    );
    if (!turnNode) {
      return false;
    }
    const scopeContainers = branch.parentBranchId
      ? Array.from(
          turnNode.querySelectorAll<HTMLElement>(
            `.mp-learn-branch-card[data-branch-id="${escapeCssSelectorValue(branch.parentBranchId)}"] .mp-chat-markdown`,
          ),
        )
      : rootMarkdownContainersForTurn(turnNode);
    const blockIdx = branch.anchor?.blockIndex;
    const targetBlock =
      typeof blockIdx === 'number' && Number.isInteger(blockIdx) && blockIdx >= 0
        ? findScopedBlock(scopeContainers, blockIdx)
        : scopeContainers[0] || turnNode;
    const target = targetBlock || scopeContainers[0] || turnNode;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({behavior: 'smooth', block: 'center'});
    }
    document
      .querySelectorAll('.is-learn-return-flash')
      .forEach(node => node.classList.remove('is-learn-return-flash'));
    target.classList.add('is-learn-return-flash');
    if (returnFlashTimer !== null) {
      clearTimeout(returnFlashTimer);
    }
    returnFlashTimer = setTimeout(() => {
      target.classList.remove('is-learn-return-flash');
      returnFlashTimer = null;
    }, 1800);
    return true;
  }

  function applyUserHighlightsToContainer(
    container: HTMLElement,
    highlights: MagicPointerLearnUserHighlight[],
  ): void {
    if (!highlights.length || typeof document.createTreeWalker !== 'function') {
      return;
    }
    const filterShowText =
      typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
    const walker = document.createTreeWalker(container, filterShowText);
    const textNodes: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      if (
        parent &&
        !parent.closest('code, pre, .katex, .mp-learn-user-mark, button')
      ) {
        textNodes.push(current as Text);
      }
      current = walker.nextNode();
    }
    for (const hl of highlights) {
      const quote = String(hl.quote || '').trim();
      if (!quote) {
        continue;
      }
      for (const node of textNodes) {
        const val = node.nodeValue || '';
        const idx = val.indexOf(quote);
        if (idx < 0 || !node.parentNode) {
          continue;
        }
        const before = val.slice(0, idx);
        const after = val.slice(idx + quote.length);
        const mark = el('mark', 'mp-learn-user-mark', quote);
        mark.dataset.highlightId = hl.id;
        mark.title = '点击移除荧光笔标注';
        const frag = document.createDocumentFragment();
        if (before) {
          frag.appendChild(document.createTextNode(before));
        }
        frag.appendChild(mark);
        if (after) {
          frag.appendChild(document.createTextNode(after));
        }
        node.parentNode.replaceChild(frag, node);
        break;
      }
    }
  }

  function lemmasForKey(key: string): MagicPointerLearnLemmaRef[] {
    return composerLemmas.get(key) || [];
  }

  function addLemmaToKey(key: string, lemma: MagicPointerLearnLemmaRef): void {
    const list = [...lemmasForKey(key)];
    if (!list.some(item => item.branchId === lemma.branchId)) {
      list.push(lemma);
      composerLemmas.set(key, list);
    }
    if (key === '__main__') {
      hooks?.onMainLemmasChanged?.();
    }
  }

  function removeLemmaFromKey(key: string, branchId: string): void {
    const list = lemmasForKey(key).filter(item => item.branchId !== branchId);
    if (list.length) {
      composerLemmas.set(key, list);
    } else {
      composerLemmas.delete(key);
    }
    if (key === '__main__') {
      hooks?.onMainLemmasChanged?.();
    }
  }

  function renderLemmaStrip(strip: HTMLElement, key: string): void {
    strip.replaceChildren();
    for (const lemma of lemmasForKey(key)) {
      const chip = el('span', 'mp-learn-lemma-chip');
      chip.appendChild(cdsIcon('link', 12));
      chip.appendChild(el('span', '', `引理：${lemma.title}`));
      const rm = iconLabelButton({
        icon: 'x',
        title: '移除引理引用',
        iconSize: 11,
      });
      rm.addEventListener('click', () => {
        removeLemmaFromKey(key, lemma.branchId);
        renderLemmaStrip(strip, key);
      });
      chip.appendChild(rm);
      strip.appendChild(chip);
    }
  }

  function bindLemmaDropTarget(
    box: HTMLElement,
    lemmaKey: string,
    strip?: HTMLElement,
  ): void {
    box.addEventListener('dragover', ev => {
      if (ev.dataTransfer?.types.includes(LEMMA_MIME)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        box.classList.add('is-lemma-drop-target');
      }
    });
    box.addEventListener('dragleave', () => {
      box.classList.remove('is-lemma-drop-target');
    });
    box.addEventListener('drop', ev => {
      box.classList.remove('is-lemma-drop-target');
      const raw = ev.dataTransfer?.getData(LEMMA_MIME);
      if (!raw) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const parsed = JSON.parse(raw) as MagicPointerLearnLemmaRef;
        if (parsed?.branchId && parsed?.title) {
          addLemmaToKey(lemmaKey, parsed);
          if (strip) {
            renderLemmaStrip(strip, lemmaKey);
          }
        }
      } catch {
        /* ignore malformed drag payload */
      }
    });
  }

  function depthOfBranch(
    branch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): number {
    let depth = 1;
    let cursor: MagicPointerLearnBranch | undefined = branch;
    const seen = new Set<string>();
    while (cursor?.parentBranchId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentBranchId);
      if (cursor) {
        depth += 1;
      }
    }
    return depth;
  }

  function rootTurnOfBranch(
    branch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): number {
    let cursor: MagicPointerLearnBranch = branch;
    const seen = new Set<string>();
    while (cursor.parentBranchId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = byId.get(cursor.parentBranchId);
      if (!parent) {
        break;
      }
      cursor = parent;
    }
    return cursor.parentTurnIndex;
  }

  function countDescendants(
    branchId: string,
    all: MagicPointerLearnBranch[],
  ): number {
    let count = 0;
    for (const item of all) {
      if (item.parentBranchId === branchId) {
        count += 1 + countDescendants(item.id, all);
      }
    }
    return count;
  }

  async function submitBranchPrompt(params: {
    conversationId: string;
    branchId?: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    anchor?: MagicPointerLearnAnchor;
    question: string;
    lemmaKey: string;
  }): Promise<void> {
    const trimmed = params.question.trim();
    if (!trimmed) {
      return;
    }
    const dataApi = getDataApi();
    if (!dataApi) {
      return;
    }
    const lemmaRefs = [...lemmasForKey(params.lemmaKey)];
    composerLemmas.delete(params.lemmaKey);
    const requestId = `learn-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const result = await dataApi.learnSend({
      conversationId: params.conversationId,
      branchId: params.branchId,
      parentBranchId: params.parentBranchId,
      parentTurnIndex: params.parentTurnIndex,
      anchor: params.anchor,
      question: trimmed,
      lemmaRefs,
      requestId,
      effort: hooks?.getEffort() || 'high',
    });
    if (result?.branchId) {
      liveStreams.delete(String(result.branchId));
      const conv =
        (result.conversation as MagicPointerConversation | undefined) ||
        hooks?.getConversation();
      if (conv?.branches) {
        const byId = new Map(conv.branches.map(b => [b.id, b] as const));
        const created = byId.get(String(result.branchId));
        if (created && !created.docked) {
          const depth = depthOfBranch(created, byId);
          if (depth >= 3 && created.parentBranchId) {
            const rootTurn = rootTurnOfBranch(created, byId);
            focusShiftByRoot.set(
              `${params.conversationId}:${rootTurn}`,
              created.parentBranchId,
            );
          }
        }
      }
    }
    await hooks?.refreshConversation(params.conversationId);
  }

  function buildBranchFollowupComposer(options: {
    conversationId: string;
    branchId: string;
    parentBranchId: string | null;
    parentTurnIndex: number;
    placeholder: string;
    runningRequestId?: string;
  }): HTMLElement {
    const lemmaKey = options.branchId;
    const wrap = el('div', 'mp-learn-composer');

    const strip = el('div', 'mp-learn-lemma-strip');
    renderLemmaStrip(strip, lemmaKey);
    wrap.appendChild(strip);
    bindLemmaDropTarget(wrap, lemmaKey, strip);

    const row = el('div', 'mp-learn-composer-row');
    const input = el('textarea', 'mp-learn-composer-input');
    input.rows = 1;
    input.placeholder = options.placeholder;
    const sendBtn = iconLabelButton({
      icon: 'arrow-up',
      label: '追问',
      className: 'mp-learn-composer-send',
      title: '发送追问',
      iconSize: 12,
    });
    sendBtn.disabled = true;

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim();
    });
    const triggerSend = () => {
      if (!input.value.trim()) {
        return;
      }
      const text = input.value;
      input.value = '';
      sendBtn.disabled = true;
      void submitBranchPrompt({
        conversationId: options.conversationId,
        branchId: options.branchId,
        parentBranchId: options.parentBranchId,
        parentTurnIndex: options.parentTurnIndex,
        question: text,
        lemmaKey,
      });
    };
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        triggerSend();
      }
    });
    sendBtn.addEventListener('click', triggerSend);
    row.appendChild(input);

    if (options.runningRequestId) {
      const stopBtn = iconLabelButton({
        icon: 'x',
        label: '停止',
        className: 'mp-learn-composer-stop',
        title: '停止推导',
        iconSize: 12,
      });
      stopBtn.addEventListener('click', () => {
        void getDataApi()?.learnStop({
          branchId: options.branchId,
          requestId: options.runningRequestId,
        });
      });
      row.appendChild(stopBtn);
    } else {
      row.appendChild(sendBtn);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function insertElementAfter(
    referenceNode: HTMLElement,
    newNode: HTMLElement,
  ): void {
    const parent = referenceNode.parentNode;
    if (!parent) {
      return;
    }
    parent.insertBefore(newNode, referenceNode.nextSibling);
  }

  function findScopedBlock(
    containers: HTMLElement[],
    blockIndex: number,
  ): HTMLElement | null {
    const attrSelector = `[data-block-index="${String(blockIndex)}"]`;
    for (const md of containers) {
      const direct = md.querySelector(attrSelector);
      if (isElementNode(direct)) {
        return direct;
      }
    }
    return null;
  }

  function mountBranchesByAnchorBlock(options: {
    conversation: MagicPointerConversation;
    branches: MagicPointerLearnBranch[];
    allBranches: MagicPointerLearnBranch[];
    byId: Map<string, MagicPointerLearnBranch>;
    markdownContainers: HTMLElement[];
    fallbackContainer: HTMLElement;
    visualIndent: number;
    inDeck: boolean;
  }): void {
    const {
      conversation,
      branches,
      allBranches,
      byId,
      markdownContainers,
      fallbackContainer,
      visualIndent,
      inDeck,
    } = options;
    const inlineGroups = new Map<
      number,
      {blockEl: HTMLElement; branches: MagicPointerLearnBranch[]}
    >();
    const fallbackBranches: MagicPointerLearnBranch[] = [];

    for (const branch of branches) {
      const blockIndex = branch.anchor?.blockIndex;
      if (
        !inDeck &&
        typeof blockIndex === 'number' &&
        Number.isInteger(blockIndex) &&
        blockIndex >= 0
      ) {
        const targetBlock = findScopedBlock(markdownContainers, blockIndex);
        if (targetBlock) {
          const existing = inlineGroups.get(blockIndex);
          if (existing) {
            existing.branches.push(branch);
          } else {
            inlineGroups.set(blockIndex, {
              blockEl: targetBlock,
              branches: [branch],
            });
          }
          continue;
        }
      }
      fallbackBranches.push(branch);
    }

    for (const [blockIndex, group] of inlineGroups) {
      const host = el('section', 'mp-learn-tree-host mp-learn-inline-subtree');
      host.dataset.treeOverflowMode = 'focus-shift';
      host.dataset.anchorBlock = String(blockIndex);
      for (const branch of group.branches) {
        host.appendChild(
          renderBranchSubtree({
            conversation,
            branch,
            allBranches,
            byId,
            visualIndent,
            inDeck,
          }),
        );
      }
      insertElementAfter(group.blockEl, host);
    }

    if (fallbackBranches.length) {
      const host = el('section', 'mp-learn-tree-host');
      host.dataset.treeOverflowMode = 'focus-shift';
      for (const branch of fallbackBranches) {
        host.appendChild(
          renderBranchSubtree({
            conversation,
            branch,
            allBranches,
            byId,
            visualIndent,
            inDeck,
          }),
        );
      }
      fallbackContainer.appendChild(host);
    }
  }

  function renderBranchSubtree(options: {
    conversation: MagicPointerConversation;
    branch: MagicPointerLearnBranch;
    allBranches: MagicPointerLearnBranch[];
    byId: Map<string, MagicPointerLearnBranch>;
    visualIndent: number;
    inDeck: boolean;
  }): HTMLElement {
    const {conversation, branch, allBranches, byId, visualIndent, inDeck} =
      options;
    const row = el('div', 'mp-learn-node-row');
    row.style.setProperty(
      '--mp-learn-indent',
      String(inDeck ? 0 : visualIndent),
    );
    row.dataset.branchId = branch.id;

    if (!inDeck) {
      const spine = el('button', 'mp-learn-spine');
      spine.type = 'button';
      spine.title = branch.collapsed ? '展开此支线' : '折叠此支线';
      spine.setAttribute('aria-label', spine.title);
      spine.addEventListener('click', () => {
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: !branch.collapsed,
        });
      });
      row.appendChild(spine);
    }

    // Docked portal line in main stream
    if (branch.docked && !inDeck) {
      const subCount = countDescendants(branch.id, allBranches);
      const pill = el('div', 'mp-learn-portal-pill');
      const main = el('div', 'mp-learn-portal-main');
      main.appendChild(cdsIcon('arrow-up-right', 13));
      main.appendChild(el('span', 'mp-learn-kind-tag', '对照台'));
      main.appendChild(el('span', 'mp-learn-capsule-title', branch.title));
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-summary',
          `${branch.turns.length} 轮${subCount ? ` · ${subCount} 子支` : ''}`,
        ),
      );
      main.addEventListener('click', () => {
        highlightedBranchId = branch.id;
        hooks?.openDeckInInspector();
      });
      const actions = el('div', 'mp-learn-pill-actions');
      const locateBtn = iconLabelButton({
        icon: 'arrow-up-right',
        label: '定位',
        title: '在对照台定位',
        iconSize: 12,
      });
      locateBtn.addEventListener('click', () => {
        highlightedBranchId = branch.id;
        hooks?.openDeckInInspector();
      });
      const recallBtn = iconLabelButton({
        icon: 'arrow-left',
        label: '收回',
        title: '收回原位',
        iconSize: 12,
      });
      recallBtn.addEventListener('click', () => {
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: false,
        });
      });
      actions.append(locateBtn, recallBtn);
      pill.append(main, actions);
      row.appendChild(pill);
      return row;
    }

    // Collapsed 1-line summary
    if (branch.collapsed && !inDeck) {
      const subCount = countDescendants(branch.id, allBranches);
      const capsule = el('div', 'mp-learn-capsule');
      const main = el('div', 'mp-learn-capsule-main');
      main.appendChild(cdsIcon('caret-right', 14));
      main.appendChild(
        el('span', 'mp-learn-kind-tag', kindBadgeText(branch.anchor.kind)),
      );
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-title',
          `${branch.title} (${branch.turns.length}轮${subCount ? `+${subCount}` : ''})`,
        ),
      );
      main.appendChild(
        el(
          'span',
          'mp-learn-capsule-summary',
          branch.insightSummary || branchSummaryForLemma(branch).slice(0, 80),
        ),
      );
      main.addEventListener('click', () => {
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: false,
        });
      });
      const actions = el('div', 'mp-learn-pill-actions');
      const jumpBtn = iconLabelButton({
        icon: 'arrow-up',
        label: '原句',
        title: '回到提问所对应的原文句子',
        iconSize: 12,
      });
      jumpBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        jumpToSourceAnchor(branch);
      });
      actions.appendChild(jumpBtn);
      const editSummaryBtn = iconLabelButton({
        icon: 'edit',
        label: '批注',
        title: '编辑一句话批注',
        iconSize: 12,
      });
      editSummaryBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        const next =
          typeof window !== 'undefined' && typeof window.prompt === 'function'
            ? window.prompt(
                '提炼一句你的顿悟批注（折叠时展示）：',
                branch.insightSummary || '',
              )
            : null;
        if (next !== null) {
          void getDataApi()?.learnPatch({
            conversationId: conversation.id,
            action: 'update-branch',
            branchId: branch.id,
            insightSummary: next,
          });
        }
      });
      const expandBtn = iconLabelButton({
        icon: 'caret-down',
        label: '展开',
        title: '展开支线',
        iconSize: 12,
      });
      expandBtn.addEventListener('click', () => {
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: false,
        });
      });
      actions.append(editSummaryBtn, expandBtn);
      capsule.append(main, actions);
      row.appendChild(capsule);
      return row;
    }

    // Expanded Subtree (borderless margin note)
    const card = el(
      'article',
      'mp-learn-branch-card' +
        (highlightedBranchId === branch.id ? ' is-highlighted' : ''),
    );
    card.dataset.branchId = branch.id;

    const head = el('header', 'mp-learn-branch-head');
    head.draggable = true;
    head.title = '拖拽至对照台并排查看，或拖入输入框作引理引用';
    head.addEventListener('dragstart', ev => {
      const lemma: MagicPointerLearnLemmaRef = {
        branchId: branch.id,
        title: branch.title,
        summary: branchSummaryForLemma(branch),
      };
      ev.dataTransfer?.setData(LEMMA_MIME, JSON.stringify(lemma));
      ev.dataTransfer?.setData(
        BRANCH_MIME,
        JSON.stringify({conversationId: conversation.id, branchId: branch.id}),
      );
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'copyMove';
      }
      if (!inDeck) {
        dockDropzone?.classList.add('is-visible');
      }
    });
    head.addEventListener('dragend', () => {
      dockDropzone?.classList.remove('is-visible', 'is-over');
    });

    const titleRow = el('div', 'mp-learn-branch-title-row');
    if (!inDeck) {
      const collapseBtn = iconLabelButton({
        icon: 'caret-down',
        className: 'mp-learn-collapse-btn',
        title: '折叠此支线',
        iconSize: 13,
      });
      collapseBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          collapsed: true,
        });
      });
      titleRow.appendChild(collapseBtn);
    } else {
      titleRow.appendChild(cdsIcon('grip', 12));
    }
    titleRow.appendChild(
      el('span', 'mp-learn-kind-tag', kindBadgeText(branch.anchor.kind)),
    );
    const branchPriority = normalizePriority(branch.anchor?.priority);
    const priorityBtn = el(
      'button',
      `mp-learn-priority${branchPriority ? ` is-set is-${branchPriority.toLowerCase()}` : ''}`,
      branchPriority || '标优先',
    );
    priorityBtn.type = 'button';
    priorityBtn.title = branchPriority
      ? `当前优先级 ${branchPriority}，点击切换以安排处理顺序`
      : '设置疑惑优先级（P1/P2/P3）';
    priorityBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      void getDataApi()?.learnPatch({
        conversationId: conversation.id,
        action: 'update-branch',
        branchId: branch.id,
        priority: nextPriorityValue(branch.anchor?.priority),
      });
    });
    titleRow.appendChild(priorityBtn);
    const actualDepth = depthOfBranch(branch, byId);
    titleRow.appendChild(
      el('span', 'mp-learn-branch-title', `L${actualDepth} · ${branch.title}`),
    );
    head.appendChild(titleRow);

    const tools = el('div', 'mp-learn-branch-tools');
    const backBtn = iconLabelButton({
      icon: 'arrow-up',
      label: '回到原句',
      title: '回到提问所对应的原文位置',
      iconSize: 12,
    });
    backBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      jumpToSourceAnchor(branch);
    });
    tools.appendChild(backBtn);
    const citeBtn = iconLabelButton({
      icon: 'link',
      label: '引理',
      title: '附加到主输入框作为引理引用',
      iconSize: 12,
    });
    citeBtn.addEventListener('click', () => {
      addLemmaToKey('__main__', {
        branchId: branch.id,
        title: branch.title,
        summary: branchSummaryForLemma(branch),
      });
    });
    tools.appendChild(citeBtn);

    if (!inDeck) {
      const focusBtn = iconLabelButton({
        icon: 'expand',
        label: '聚焦',
        title: '聚焦此支线为当前左边界',
        iconSize: 12,
      });
      focusBtn.addEventListener('click', () => {
        const rootTurn = rootTurnOfBranch(branch, byId);
        focusShiftByRoot.set(`${conversation.id}:${rootTurn}`, branch.id);
        rerenderActive();
      });
      tools.appendChild(focusBtn);

      const dockBtn = iconLabelButton({
        icon: 'arrow-up-right',
        label: '对照台',
        title: '拆到右侧并排对照台',
        iconSize: 12,
      });
      dockBtn.addEventListener('click', async () => {
        highlightedBranchId = branch.id;
        await getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: true,
        });
        hooks?.openDeckInInspector();
      });
      tools.appendChild(dockBtn);
    } else {
      const undockBtn = iconLabelButton({
        icon: 'arrow-left',
        label: '收回',
        title: '收回原位',
        iconSize: 12,
      });
      undockBtn.addEventListener('click', () => {
        void getDataApi()?.learnPatch({
          conversationId: conversation.id,
          action: 'update-branch',
          branchId: branch.id,
          docked: false,
        });
      });
      tools.appendChild(undockBtn);
    }

    const promoteBtn = iconLabelButton({
      icon: 'git-branch',
      label: '独立会话',
      title: '升级为侧栏独立会话',
      iconSize: 12,
    });
    promoteBtn.addEventListener('click', async () => {
      const res = await getDataApi()?.learnPatch({
        conversationId: conversation.id,
        action: 'promote-branch',
        branchId: branch.id,
      });
      if (res?.ok && res.conversation?.id) {
        hooks?.openConversationById(String(res.conversation.id));
      }
    });
    tools.appendChild(promoteBtn);

    head.appendChild(tools);
    card.appendChild(head);

    const turnsHost = el('div', 'mp-learn-branch-turns');
    const live = liveStreams.get(branch.id);
    const branchHighlights = (conversation.userHighlights || []).filter(
      item => item.branchId === branch.id,
    );

    (branch.turns || []).forEach((turn, turnIdx) => {
      const turnWrap = el('div', 'mp-learn-branch-turn');
      turnWrap.dataset.branchId = branch.id;
      turnWrap.dataset.turnIndex = String(turnIdx);

      const qLine = el('div', 'mp-learn-branch-q', String(turn.question || ''));
      turnWrap.appendChild(qLine);

      const isStreamingThisTurn =
        turn.outcome === '进行中' ||
        (live !== undefined && live.turnIndex === turnIdx);
      const effectiveAnswer =
        live && live.turnIndex === turnIdx && live.answer
          ? live.answer
          : String(turn.answer || '');

      const aWrap = el('div', 'mp-learn-branch-a');
      aWrap.dataset.branchAnswerBody = `${branch.id}:${turnIdx}`;
      let renderedMd: HTMLElement | null = null;
      if (effectiveAnswer.trim()) {
        renderedMd = renderMarkdownNode(effectiveAnswer);
        applyUserHighlightsToContainer(
          renderedMd,
          branchHighlights.filter(item => item.turnIndex === turnIdx),
        );
        aWrap.appendChild(renderedMd);
        getLearnLabApi()?.hydrate(renderedMd);
        lastBranchStreamText.set(aWrap, effectiveAnswer);
      } else if (isStreamingThisTurn) {
        aWrap.appendChild(streamingStatusNode());
      } else if (turn.failed && turn.error) {
        const errRow = el('div', 'mp-learn-streaming-status is-error');
        errRow.appendChild(cdsIcon('warning', 13));
        errRow.appendChild(el('span', 'mp-learn-error-text', String(turn.error)));
        if (turn.question && turn.question.trim()) {
          const retryBtn = el('button', 'mp-learn-branch-retry', '重试');
          retryBtn.type = 'button';
          retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            void submitBranchPrompt({
              conversationId: conversation.id,
              branchId: branch.id,
              parentBranchId: branch.parentBranchId,
              parentTurnIndex: branch.parentTurnIndex,
              anchor: branch.anchor,
              question: String(turn.question || '').trim(),
              lemmaKey: `branch:${branch.id}`,
            }).finally(() => {
              retryBtn.disabled = false;
            });
          });
          errRow.appendChild(retryBtn);
        }
        aWrap.appendChild(errRow);
      }
      turnWrap.appendChild(aWrap);

      const childBranches = allBranches.filter(
        candidate =>
          candidate.parentBranchId === branch.id &&
          candidate.parentTurnIndex === turnIdx,
      );
      if (childBranches.length) {
        mountBranchesByAnchorBlock({
          conversation,
          branches: childBranches,
          allBranches,
          byId,
          markdownContainers: renderedMd ? [renderedMd] : [],
          fallbackContainer: turnWrap,
          visualIndent: 1,
          inDeck,
        });
      }

      turnsHost.appendChild(turnWrap);
    });

    card.appendChild(turnsHost);

    const anyTurnRunning =
      live !== undefined ||
      (branch.turns || []).some(turn => turn.outcome === '进行中');
    card.appendChild(
      buildBranchFollowupComposer({
        conversationId: conversation.id,
        branchId: branch.id,
        parentBranchId: branch.parentBranchId,
        parentTurnIndex: branch.parentTurnIndex,
        placeholder: `在「${branch.title.slice(0, 24)}」继续追问…`,
        runningRequestId: anyTurnRunning
          ? live?.requestId || branch.id
          : undefined,
      }),
    );

    row.appendChild(card);
    return row;
  }

  function renderFocusShiftBar(
    conversation: MagicPointerConversation,
    rootTurnIndex: number,
    focusedBranch: MagicPointerLearnBranch,
    byId: Map<string, MagicPointerLearnBranch>,
  ): HTMLElement {
    const chain: MagicPointerLearnBranch[] = [];
    let cursor: MagicPointerLearnBranch | undefined = focusedBranch;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parentBranchId
        ? byId.get(cursor.parentBranchId)
        : undefined;
    }

    const key = `${conversation.id}:${rootTurnIndex}`;
    const bar = el('nav', 'mp-learn-focus-bar');
    bar.setAttribute('aria-label', '分支聚焦层级导航');

    const crumbs = el('div', 'mp-learn-focus-crumbs');
    const rootBtn = iconLabelButton({
      icon: 'book',
      label: '主干',
      className: 'mp-learn-focus-crumb',
      title: '返回主干视图',
      iconSize: 12,
    });
    rootBtn.addEventListener('click', () => {
      focusShiftByRoot.delete(key);
      rerenderActive();
    });
    crumbs.appendChild(rootBtn);

    chain.forEach((node, idx) => {
      crumbs.appendChild(el('span', '', '/'));
      const btn = el(
        'button',
        'mp-learn-focus-crumb' + (idx === chain.length - 1 ? ' is-current' : ''),
        node.title.slice(0, 28),
      );
      btn.type = 'button';
      btn.addEventListener('click', () => {
        focusShiftByRoot.set(key, node.id);
        rerenderActive();
      });
      crumbs.appendChild(btn);
    });

    const actions = el('div', 'mp-learn-focus-actions');
    const upBtn = iconLabelButton({
      icon: 'arrow-left',
      label: '上层',
      title: '返回上层',
      iconSize: 12,
    });
    upBtn.addEventListener('click', () => {
      if (focusedBranch.parentBranchId) {
        focusShiftByRoot.set(key, focusedBranch.parentBranchId);
      } else {
        focusShiftByRoot.delete(key);
      }
      rerenderActive();
    });
    const resetBtn = el('button', '', '展开全树');
    resetBtn.type = 'button';
    resetBtn.addEventListener('click', () => {
      focusShiftByRoot.delete(key);
      rerenderActive();
    });
    actions.append(upBtn, resetBtn);
    bar.append(crumbs, actions);
    return bar;
  }

  function rootMarkdownContainersForTurn(item: HTMLElement): HTMLElement[] {
    return Array.from(
      item.querySelectorAll<HTMLElement>('.mp-chat-markdown'),
    ).filter(md => !md.closest('.mp-learn-tree-host'));
  }

  const resolutionByConvo = new Map<string, 'overview' | 'standard' | 'deep'>();
  const fadingByConvo = new Map<string, boolean>();

  function projectSidenotesForMarkdown(rootMd: Element): void {
    if (typeof rootMd.querySelectorAll !== 'function') {
      return;
    }
    rootMd.querySelectorAll('.mp-learn-sidenote-gutter').forEach(elNode => {
      elNode.remove();
    });
    rootMd.querySelectorAll<HTMLElement>('[data-block-index]').forEach(blockEl => {
      const terms = Array.from(
        blockEl.querySelectorAll<HTMLElement>('.mp-learn-term[data-mp-learn-gloss]'),
      ).slice(0, 2);
      if (!terms.length) {
        return;
      }
      const gutter = el('aside', 'mp-learn-sidenote-gutter');
      gutter.setAttribute('aria-label', '边注');
      for (const termEl of terms) {
        const title = termEl.dataset.mpLearnTerm || termEl.textContent || '';
        const gloss = termEl.dataset.mpLearnGloss || '';
        if (!gloss.trim()) {
          continue;
        }
        const item = el('div', 'mp-learn-sidenote-item');
        item.appendChild(el('strong', '', cleanFormulaLabel(title)));
        item.appendChild(el('span', '', gloss.trim()));
        gutter.appendChild(item);
      }
      if (gutter.children.length > 0) {
        blockEl.appendChild(gutter);
      }
    });
  }

  function applyFadeGrade(
    conversationId: string,
    info: {blockIndex?: number; label: string; status: 'verified' | 'gap'},
    hudEl: HTMLElement | null,
    streamEl: HTMLElement | null,
  ): void {
    const conv = hooks?.getConversation();
    if (!conv || conv.id !== conversationId) {
      return;
    }
    const turnIdx = Math.max(0, (conv.turns?.length || 1) - 1);
    const nodeId =
      typeof info.blockIndex === 'number' && Number.isInteger(info.blockIndex)
        ? `t${turnIdx}:b${info.blockIndex}`
        : `fade:${info.label.slice(0, 32)}`;
    const dataApi = getDataApi();
    if (dataApi) {
      void dataApi
        .learnPatch({
          conversationId,
          action: 'set-mastery',
          nodeId,
          title: info.label,
          status: info.status,
          note: info.status === 'verified' ? '挖空自测通过' : '挖空自测需重看',
        })
        .then(res => {
          const nextConv = (res?.conversation as MagicPointerConversation | undefined) || conv;
          renderHud(hudEl, nextConv, streamEl);
          return hooks?.refreshConversation(conversationId);
        });
    }
  }

  function renderHud(
    hudEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
    streamEl: HTMLElement | null,
  ): void {
    if (!hudEl) {
      return;
    }
    const hasAssistantAnswer = Boolean(
      conversation?.turns?.some(t => String(t.answer || '').trim()),
    );
    if (!conversation || conversation.workMode !== 'learn' || !hasAssistantAnswer) {
      hudEl.hidden = true;
      if (streamEl?.dataset) {
        delete streamEl.dataset.learnResolution;
      }
      return;
    }
    hudEl.hidden = false;
    hudEl.innerHTML = '';

    const convId = conversation.id;
    const resolution = resolutionByConvo.get(convId) || 'standard';
    const fadingOn = fadingByConvo.get(convId) === true;
    if (streamEl?.dataset) {
      streamEl.dataset.learnResolution = resolution;
    }

    const graphApi = getConceptGraphApi();
    const topology = graphApi ? graphApi.extractTopology(conversation) : null;
    const total = topology?.summary.total ?? 0;
    const verified = topology?.summary.verified ?? 0;
    const pct = total > 0 ? Math.round((verified / total) * 100) : 0;

    const left = el('div', 'mp-learn-hud-left');
    const mastery = el('div', 'mp-learn-hud-mastery');
    mastery.appendChild(el('span', '', `掌握 ${verified}/${total}`));
    const bar = el('span', 'mp-learn-hud-bar');
    const fill = el('span', 'mp-learn-hud-bar-fill');
    if (fill.style) {
      fill.style.width = `${pct}%`;
    }
    bar.appendChild(fill);
    mastery.appendChild(bar);
    left.appendChild(mastery);

    const resGroup = el('div', 'mp-learn-hud-segment');
    const resOptions: ReadonlyArray<{id: 'overview' | 'standard' | 'deep'; label: string}> = [
      {id: 'overview', label: '概览'},
      {id: 'standard', label: '精读'},
      {id: 'deep', label: '深挖'},
    ];
    for (const opt of resOptions) {
      const btn = el('button', 'mp-learn-hud-btn', opt.label);
      btn.type = 'button';
      if (resolution === opt.id) {
        btn.classList.add('is-on');
      }
      btn.setAttribute('aria-pressed', String(resolution === opt.id));
      btn.addEventListener('click', () => {
        resolutionByConvo.set(convId, opt.id);
        if (streamEl?.dataset) {
          streamEl.dataset.learnResolution = opt.id;
        }
        renderHud(hudEl, hooks?.getConversation() || conversation, streamEl);
      });
      resGroup.appendChild(btn);
    }
    left.appendChild(resGroup);

    const right = el('div', 'mp-learn-hud-right');
    const fadeBtn = el('button', 'mp-learn-hud-pill', '挖空自测');
    fadeBtn.type = 'button';
    fadeBtn.setAttribute('aria-pressed', String(fadingOn));
    fadeBtn.title = '切换主动回忆挖空遮罩';
    fadeBtn.addEventListener('click', () => {
      const next = !(fadingByConvo.get(convId) === true);
      fadingByConvo.set(convId, next);
      if (streamEl) {
        getLearnLabApi()?.applyFadeMode(streamEl, next, info =>
          applyFadeGrade(convId, info, hudEl, streamEl),
        );
      }
      renderHud(hudEl, hooks?.getConversation() || conversation, streamEl);
    });
    right.appendChild(fadeBtn);

    const deckBtn = el('button', 'mp-learn-hud-pill', '图谱 · 学习台');
    deckBtn.type = 'button';
    deckBtn.addEventListener('click', () => {
      hooks?.openDeckInInspector();
    });
    right.appendChild(deckBtn);

    hudEl.appendChild(left);
    hudEl.appendChild(right);
  }

  function mountConversation(
    streamEl: HTMLElement,
    conversation: MagicPointerConversation | null | undefined,
  ): void {
    if (!conversation) {
      return;
    }
    const allBranches = Array.isArray(conversation.branches)
      ? conversation.branches
      : [];
    const byId = new Map(allBranches.map(b => [b.id, b] as const));
    const userHighlights = Array.isArray(conversation.userHighlights)
      ? conversation.userHighlights
      : [];

    const turnNodes = streamEl.querySelectorAll<HTMLElement>(
      '.mp-chat-flow-item[data-turn-index]',
    );
    turnNodes.forEach(item => {
      const turnIndex = Number(item.dataset.turnIndex);
      if (!Number.isInteger(turnIndex)) {
        return;
      }

      // Clean previous mounts before applying highlights and mounting subtrees
      item.querySelectorAll('.mp-learn-tree-host').forEach(hostEl => {
        hostEl.remove();
      });

      const rootMarkdowns = rootMarkdownContainersForTurn(item);
      const turnHighlights = userHighlights.filter(
        hl => !hl.branchId && hl.turnIndex === turnIndex,
      );
      for (const rootMd of rootMarkdowns) {
        applyUserHighlightsToContainer(rootMd, turnHighlights);
        getLearnLabApi()?.hydrate(rootMd);
        projectSidenotesForMarkdown(rootMd);
      }

      const directChildren = allBranches.filter(
        b => b.parentBranchId === null && b.parentTurnIndex === turnIndex,
      );
      if (!directChildren.length) {
        return;
      }

      const focusKey = `${conversation.id}:${turnIndex}`;
      const focusedId = focusShiftByRoot.get(focusKey);
      const focusedBranch = focusedId ? byId.get(focusedId) : undefined;
      if (
        focusedBranch &&
        !focusedBranch.docked &&
        rootTurnOfBranch(focusedBranch, byId) === turnIndex
      ) {
        const host = el('section', 'mp-learn-tree-host');
        host.dataset.treeOverflowMode = 'focus-shift';
        host.appendChild(
          renderFocusShiftBar(conversation, turnIndex, focusedBranch, byId),
        );
        host.appendChild(
          renderBranchSubtree({
            conversation,
            branch: focusedBranch,
            allBranches,
            byId,
            visualIndent: 0,
            inDeck: false,
          }),
        );
        item.appendChild(host);
        return;
      }

      mountBranchesByAnchorBlock({
        conversation,
        branches: directChildren,
        allBranches,
        byId,
        markdownContainers: rootMarkdowns,
        fallbackContainer: item,
        visualIndent: 1,
        inDeck: false,
      });
    });
    const resMode = resolutionByConvo.get(conversation.id);
    if (resMode && streamEl.dataset) {
      streamEl.dataset.learnResolution = resMode;
    }
    if (fadingByConvo.get(conversation.id) === true) {
      getLearnLabApi()?.applyFadeMode(streamEl, true, info =>
        applyFadeGrade(
          conversation.id,
          info,
          typeof document !== 'undefined'
            ? document.getElementById('learn-hud')
            : null,
          streamEl,
        ),
      );
    }
  }

  function renderDeck(
    hostEl: HTMLElement | null,
    conversation: MagicPointerConversation | null | undefined,
  ): void {
    if (!hostEl) {
      return;
    }
    hostEl.replaceChildren();
    const wrap = el('div', 'mp-learn-deck');
    const head = el('header', 'mp-learn-deck-header');
    const titleBox = el('div');
    titleBox.appendChild(el('strong', '', '并排学习对照台'));
    titleBox.appendChild(
      el(
        'p',
        '',
        '将主对话中深层发散的支线拖到这里并排对照推导，可继续分叉。',
      ),
    );
    head.appendChild(titleBox);
    wrap.appendChild(head);

    const allBranches = conversation?.branches || [];
    const docked = allBranches.filter(b => b.docked);
    if (!conversation || !docked.length) {
      wrap.appendChild(
        el(
          'div',
          'mp-learn-deck-empty',
          '暂无停靠支线。在支线工具栏点击「对照台」或拖拽标题栏到此区域即可并排固定。',
        ),
      );
      hostEl.appendChild(wrap);
      return;
    }

    const byId = new Map(allBranches.map(b => [b.id, b] as const));
    for (const branch of sortBranchesByPriority(docked)) {
      wrap.appendChild(
        renderBranchSubtree({
          conversation,
          branch,
          allBranches,
          byId,
          visualIndent: 0,
          inDeck: true,
        }),
      );
    }
    hostEl.appendChild(wrap);

    if (highlightedBranchId) {
      const targetCard = wrap.querySelector<HTMLElement>(
        `.mp-learn-branch-card[data-branch-id="${escapeCssSelectorValue(highlightedBranchId)}"]`,
      );
      if (targetCard && typeof targetCard.scrollIntoView === 'function') {
        targetCard.scrollIntoView({behavior: 'smooth', block: 'nearest'});
      }
      setTimeout(() => {
        highlightedBranchId = '';
        targetCard?.classList.remove('is-highlighted');
      }, 1800);
    }
  }

  function rerenderActive(): void {
    const conv = hooks?.getConversation() || null;
    const stream = document.getElementById('stream');
    if (stream && conv) {
      mountConversation(stream, conv);
    }
    const deckHost = document.getElementById('learn-deck-host');
    if (deckHost) {
      renderDeck(deckHost, conv);
    }
  }

  function hideGlossPopover(): void {
    if (glossTimer !== null) {
      clearTimeout(glossTimer);
      glossTimer = null;
    }
    if (glossPopover) {
      glossPopover.hidden = true;
    }
  }

  function showGlossPopover(anchorEl: HTMLElement): void {
    const gloss = anchorEl.dataset.mpLearnGloss;
    const term = anchorEl.dataset.mpLearnTerm || anchorEl.textContent || '';
    if (!gloss) {
      return;
    }
    if (!glossPopover) {
      glossPopover = el('div', 'mp-learn-gloss-popover');
      document.body.appendChild(glossPopover);
    }
    glossPopover.replaceChildren(
      el('strong', '', term),
      el('div', '', gloss),
      el('small', '', '点击此处可深入追问'),
    );
    glossPopover.hidden = false;
    const rect = anchorEl.getBoundingClientRect();
    const viewW = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
    const viewH = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    const popW = glossPopover.offsetWidth || 260;
    const popH = glossPopover.offsetHeight || 64;
    const top =
      rect.top - popH - 8 >= 8
        ? rect.top - popH - 8
        : Math.min(viewH - popH - 8, rect.bottom + 8);
    const left = Math.min(viewW - popW - 12, Math.max(12, rect.left));
    glossPopover.style.top = `${Math.round(top)}px`;
    glossPopover.style.left = `${Math.round(left)}px`;
  }

  function placeLearnPopover(
    rect: RectLike,
    popupSize: {width: number; height: number},
    viewport: {width: number; height: number},
  ): {left: number; top: number; placement: 'below' | 'above'} {
    const margin = 12;
    const gap = 8;
    const width = Math.max(1, popupSize.width || 320);
    const height = Math.max(1, popupSize.height || 100);
    const maxLeft = Math.max(margin, viewport.width - margin - width);
    const maxTop = Math.max(margin, viewport.height - margin - height);
    const left = Math.round(Math.min(Math.max(rect.left, margin), maxLeft));

    const belowTop = rect.bottom + gap;
    if (belowTop + height <= viewport.height - margin) {
      return {left, top: Math.round(belowTop), placement: 'below'};
    }
    const aboveTop = rect.top - gap - height;
    if (aboveTop >= margin) {
      return {left, top: Math.round(aboveTop), placement: 'above'};
    }
    const clampedTop = Math.round(Math.min(Math.max(belowTop, margin), maxTop));
    return {
      left,
      top: clampedTop,
      placement: clampedTop < rect.top ? 'above' : 'below',
    };
  }

  function hideInquiryPopover(): void {
    popoverState = null;
    if (inquiryPopover) {
      inquiryPopover.hidden = true;
    }
  }

  function ensureInquiryPopover(): HTMLElement {
    if (inquiryPopover) {
      return inquiryPopover;
    }
    inquiryPopover = el('div', 'mp-learn-popover');
    inquiryPopover.hidden = true;
    inquiryPopover.setAttribute('role', 'dialog');
    inquiryPopover.setAttribute('aria-label', '局部深入追问');
    document.body.appendChild(inquiryPopover);
    return inquiryPopover;
  }

  function openInquiryPopover(
    nextState: PopoverState,
    options: {focusInput: boolean},
  ): void {
    hideGlossPopover();
    popoverState = nextState;
    const pop = ensureInquiryPopover();
    pop.replaceChildren();

    const head = el('div', 'mp-learn-popover-head');
    const meta = el('div', 'mp-learn-popover-meta');
    meta.appendChild(
      el('span', 'mp-learn-popover-kind', kindBadgeText(nextState.anchor.kind)),
    );
    meta.appendChild(
      el('span', 'mp-learn-popover-label', nextState.anchor.label.slice(0, 60)),
    );
    const closeBtn = iconLabelButton({
      icon: 'x',
      className: 'mp-learn-popover-close',
      title: '关闭追问浮层',
      iconSize: 13,
    });
    closeBtn.addEventListener('click', () => {
      hideInquiryPopover();
    });
    head.append(meta, closeBtn);
    pop.appendChild(head);

    if (
      nextState.anchor.snippet &&
      nextState.anchor.snippet !== nextState.anchor.label
    ) {
      pop.appendChild(
        el(
          'div',
          'mp-learn-popover-snippet',
          nextState.anchor.snippet.slice(0, 240),
        ),
      );
    }
    if (nextState.anchor.gloss) {
      pop.appendChild(
        el('div', 'mp-learn-popover-gloss', nextState.anchor.gloss),
      );
    }

    const toggleClass = (node: Element, cls: string, on: boolean) => {
      if (on) {
        node.classList.add(cls);
      } else {
        node.classList.remove(cls);
      }
    };
    const priorityRow = el('div', 'mp-learn-popover-priority');
    priorityRow.appendChild(el('span', 'mp-learn-popover-priority-label', '先处理？'));
    let selectedPriority = normalizePriority(nextState.anchor.priority);
    const priButtons: HTMLButtonElement[] = [];
    for (const opt of PRIORITY_OPTIONS) {
      const pBtn = el('button', 'mp-learn-priority-opt', opt.label);
      pBtn.type = 'button';
      pBtn.title = opt.title;
      pBtn.setAttribute('aria-pressed', String(selectedPriority === opt.value));
      toggleClass(pBtn, 'is-on', selectedPriority === opt.value);
      pBtn.addEventListener('mousedown', ev => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      pBtn.addEventListener('click', () => {
        selectedPriority = selectedPriority === opt.value ? '' : opt.value;
        nextState.anchor.priority = selectedPriority || undefined;
        for (const candidate of priButtons) {
          const active = candidate.textContent === selectedPriority;
          toggleClass(candidate, 'is-on', active);
          candidate.setAttribute('aria-pressed', String(active));
        }
      });
      priButtons.push(pBtn);
      priorityRow.appendChild(pBtn);
    }
    pop.appendChild(priorityRow);

    const row = el('div', 'mp-learn-popover-row');
    const input = el('input', 'mp-learn-popover-input');
    input.type = 'text';
    input.placeholder = '输入针对此处的具体疑问…';
    const submitBtn = iconLabelButton({
      icon: 'arrow-up',
      label: '追问',
      className: 'mp-learn-popover-submit',
      title: '发送追问',
      iconSize: 12,
    });
    submitBtn.disabled = true;

    input.addEventListener('input', () => {
      submitBtn.disabled = !input.value.trim();
    });

    const triggerSubmit = () => {
      const current = popoverState;
      const question = input.value.trim();
      if (!current || !question) {
        return;
      }
      hideInquiryPopover();
      if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        window.getSelection()?.removeAllRanges?.();
      }
      void submitBranchPrompt({
        conversationId: current.conversationId,
        parentBranchId: current.parentBranchId,
        parentTurnIndex: current.parentTurnIndex,
        anchor: current.anchor,
        question,
        lemmaKey: '__popover__',
      });
    };

    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.isComposing) {
        ev.preventDefault();
        triggerSubmit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        hideInquiryPopover();
      }
    });
    submitBtn.addEventListener('click', triggerSubmit);
    row.appendChild(input);

    if (nextState.fromSelection) {
      const markBtn = iconLabelButton({
        icon: 'edit',
        label: '高亮',
        className: 'mp-learn-popover-highlight',
        title: '保存荧光笔标注',
        iconSize: 12,
      });
      markBtn.addEventListener('mousedown', ev => {
        ev.preventDefault();
        ev.stopPropagation();
      });
      markBtn.addEventListener('click', () => {
        const current = popoverState;
        hideInquiryPopover();
        if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
          window.getSelection()?.removeAllRanges?.();
        }
        if (!current) {
          return;
        }
        void getDataApi()?.learnPatch({
          conversationId: current.conversationId,
          action: 'toggle-highlight',
          branchId: current.parentBranchId,
          turnIndex: current.parentTurnIndex,
          quote: current.anchor.snippet,
        });
      });
      row.appendChild(markBtn);
    }

    row.appendChild(submitBtn);
    pop.appendChild(row);
    pop.hidden = false;

    const viewW = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200;
    const viewH = typeof window !== 'undefined' ? window.innerHeight || 800 : 800;
    const placed = placeLearnPopover(
      nextState.rect,
      {width: pop.offsetWidth || 340, height: pop.offsetHeight || 110},
      {width: viewW, height: viewH},
    );
    pop.style.top = `${placed.top}px`;
    pop.style.left = `${placed.left}px`;
    pop.dataset.placement = placed.placement;

    if (options.focusInput) {
      input.focus();
    }
  }

  function resolveTurnContext(target: unknown): {
    parentBranchId: string | null;
    parentTurnIndex: number;
    blockIndex?: number;
  } | null {
    if (!target) {
      return null;
    }
    const branchTurn = closestElement(target, '.mp-learn-branch-turn');
    const rootTurn = closestElement(target, '.mp-chat-flow-item[data-turn-index]');
    if (!branchTurn && !rootTurn) {
      return null;
    }

    let blockIndex: number | undefined;
    const blockEl = closestElement(target, '[data-block-index]');
    if (blockEl) {
      const md = closestElement(blockEl, '.mp-chat-markdown');
      const validScope = branchTurn
        ? md && closestElement(md, '.mp-learn-branch-turn') === branchTurn
        : md &&
          !closestElement(md, '.mp-learn-branch-turn') &&
          closestElement(md, '.mp-chat-flow-item[data-turn-index]') === rootTurn;
      if (validScope) {
        const parsed = Number(blockEl.dataset.blockIndex);
        if (Number.isInteger(parsed) && parsed >= 0) {
          blockIndex = parsed;
        }
      }
    }

    if (branchTurn?.dataset.branchId) {
      return {
        parentBranchId: branchTurn.dataset.branchId,
        parentTurnIndex: Number(branchTurn.dataset.turnIndex) || 0,
        ...(blockIndex !== undefined ? {blockIndex} : {}),
      };
    }
    if (rootTurn) {
      return {
        parentBranchId: null,
        parentTurnIndex: Number(rootTurn.dataset.turnIndex) || 0,
        ...(blockIndex !== undefined ? {blockIndex} : {}),
      };
    }
    return null;
  }

  function resolveClickedAnchor(
    targetEl: HTMLElement,
    blockIndex?: number,
  ): {triggerEl: HTMLElement; anchor: MagicPointerLearnAnchor} | null {
    const explicit = targetEl.closest('[data-mp-learn-anchor]');
    if (isElementNode(explicit)) {
      const kindRaw = explicit.dataset.mpLearnAnchor;
      if (kindRaw === 'term') {
        const term =
          explicit.dataset.mpLearnTerm || explicit.textContent?.trim() || '概念';
        return {
          triggerEl: explicit,
          anchor: {
            kind: 'term',
            label: term,
            snippet: term,
            ...(explicit.dataset.mpLearnGloss
              ? {gloss: explicit.dataset.mpLearnGloss}
              : {}),
            ...(blockIndex !== undefined ? {blockIndex} : {}),
          },
        };
      }
      if (kindRaw === 'math') {
        const tex =
          explicit.dataset.mpLearnTex || explicit.textContent?.trim() || '';
        return {
          triggerEl: explicit,
          anchor: {
            kind: 'math',
            label: cleanFormulaLabel(tex),
            snippet: tex,
            ...(blockIndex !== undefined ? {blockIndex} : {}),
          },
        };
      }
      const label = explicit.dataset.mpLearnLabel || '章节分块';
      return {
        triggerEl: explicit,
        anchor: {
          kind: 'card',
          label,
          snippet: explicit.dataset.mpLearnSnippet || label,
          ...(explicit.dataset.mpLearnCategory
            ? {priority: explicit.dataset.mpLearnCategory}
            : {}),
          ...(blockIndex !== undefined ? {blockIndex} : {}),
        },
      };
    }

    const katexEl = targetEl.closest('.katex');
    if (isElementNode(katexEl)) {
      const texHolder = katexEl.closest('[data-mp-learn-tex]');
      const tex =
        (isElementNode(texHolder) ? texHolder.dataset.mpLearnTex : undefined) ||
        katexEl.querySelector('annotation')?.textContent ||
        katexEl.textContent?.trim() ||
        '公式';
      return {
        triggerEl: katexEl,
        anchor: {
          kind: 'math',
          label: cleanFormulaLabel(tex),
          snippet: tex,
          ...(blockIndex !== undefined ? {blockIndex} : {}),
        },
      };
    }

    const markEl = targetEl.closest('.mp-learn-mark');
    if (isElementNode(markEl)) {
      const text = markEl.textContent?.trim() || '重点标注';
      return {
        triggerEl: markEl,
        anchor: {
          kind: 'selection',
          label: text.slice(0, 48),
          snippet: text,
          ...(blockIndex !== undefined ? {blockIndex} : {}),
        },
      };
    }

    return null;
  }

  function hasNonZeroRect(rect: RectLike | null | undefined): rect is RectLike {
    if (!rect) {
      return false;
    }
    return rect.right > rect.left || rect.bottom > rect.top;
  }

  function init(initHooks: LearnHooks): void {
    hooks = initHooks;
    if (initialized) {
      return;
    }
    initialized = true;

    // 1. Dock Dropzone on right edge when tearing off a branch
    dockDropzone = el('div', 'mp-learn-dock-dropzone');
    const dropTitle = el('div', '');
    dropTitle.appendChild(cdsIcon('arrow-up-right', 15));
    dropTitle.appendChild(el('span', '', ' 松手停靠到右侧对照台'));
    dockDropzone.append(
      dropTitle,
      el('small', '', '主干保留定位入口，右侧满宽并排推导'),
    );
    document.body.appendChild(dockDropzone);

    const handleDockDrop = (ev: DragEvent) => {
      const raw = ev.dataTransfer?.getData(BRANCH_MIME);
      if (!raw) {
        return;
      }
      ev.preventDefault();
      dockDropzone?.classList.remove('is-visible', 'is-over');
      try {
        const parsed = JSON.parse(raw) as {
          conversationId?: string;
          branchId?: string;
        };
        if (parsed.conversationId && parsed.branchId) {
          highlightedBranchId = parsed.branchId;
          void getDataApi()
            ?.learnPatch({
              conversationId: parsed.conversationId,
              action: 'update-branch',
              branchId: parsed.branchId,
              docked: true,
            })
            .then(() => {
              hooks?.openDeckInInspector();
            });
        }
      } catch {
        /* ignore malformed drop payload */
      }
    };

    for (const target of [
      dockDropzone,
      document.getElementById('project-inspector'),
    ]) {
      if (!target) {
        continue;
      }
      target.addEventListener('dragover', ev => {
        if (ev.dataTransfer?.types.includes(BRANCH_MIME)) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'move';
          dockDropzone?.classList.add('is-over');
        }
      });
      target.addEventListener('dragleave', () => {
        dockDropzone?.classList.remove('is-over');
      });
      target.addEventListener('drop', handleDockDrop);
    }

    // 2. Main Studio Composer drop target for Lemma References
    const mainComposer =
      document.getElementById('composer-form') ||
      document.getElementById('composer');
    if (mainComposer) {
      bindLemmaDropTarget(
        mainComposer,
        '__main__',
        document.getElementById('composer-lemma-strip') || undefined,
      );
    }

    // 3. Hover Micro-Gloss Tooltip delegation
    document.addEventListener('mouseover', ev => {
      const target = isElementNode(ev.target)
        ? ev.target.closest<HTMLElement>('.mp-learn-term[data-mp-learn-gloss]')
        : null;
      if (!target) {
        return;
      }
      if (glossTimer !== null) {
        clearTimeout(glossTimer);
      }
      glossTimer = setTimeout(() => showGlossPopover(target), 260);
    });
    document.addEventListener('mouseout', ev => {
      const related = isElementNode(ev.relatedTarget) ? ev.relatedTarget : null;
      if (related?.closest('.mp-learn-term[data-mp-learn-gloss]')) {
        return;
      }
      hideGlossPopover();
    });

    // 4. Contextual Click delegation on term / mark / card-ask / KaTeX / user-mark
    document.addEventListener('click', ev => {
      const target = isElementNode(ev.target) ? ev.target : null;
      if (!target) {
        return;
      }
      if (inquiryPopover && inquiryPopover.contains(target)) {
        return;
      }

      const userMark = target.closest<HTMLElement>('.mp-learn-user-mark');
      if (userMark?.dataset.highlightId) {
        const conv = hooks?.getConversation();
        if (conv) {
          void getDataApi()?.learnPatch({
            conversationId: conv.id,
            action: 'toggle-highlight',
            highlightId: userMark.dataset.highlightId,
            turnIndex: 0,
            quote: '',
          });
        }
        return;
      }

      // Do not hijack click if user dragged to select text
      const activeSel =
        typeof window !== 'undefined' && typeof window.getSelection === 'function'
          ? window.getSelection()
          : null;
      if (activeSel && !activeSel.isCollapsed && activeSel.toString().trim()) {
        return;
      }

      const ctx = resolveTurnContext(target);
      const conv = hooks?.getConversation();
      if (!conv || !ctx) {
        hideInquiryPopover();
        return;
      }

      const resolved = resolveClickedAnchor(target, ctx.blockIndex);
      if (!resolved) {
        hideInquiryPopover();
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();

      openInquiryPopover(
        {
          conversationId: conv.id,
          parentBranchId: ctx.parentBranchId,
          parentTurnIndex: ctx.parentTurnIndex,
          anchor: resolved.anchor,
          rect: resolved.triggerEl.getBoundingClientRect(),
          fromSelection: false,
        },
        {focusInput: true},
      );
    });

    // 5. Text Selection Contextual Inquiry Popover inside [data-block-index]
    document.addEventListener('mouseup', ev => {
      if (
        inquiryPopover &&
        ev.target &&
        typeof inquiryPopover.contains === 'function' &&
        inquiryPopover.contains(ev.target as Node)
      ) {
        return;
      }
      setTimeout(() => {
        const sel =
          typeof window !== 'undefined' && typeof window.getSelection === 'function'
            ? window.getSelection()
            : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          return;
        }
        const range = sel.getRangeAt(0);
        const quote = extractSelectionTextClean(range, sel.toString());
        if (quote.length < 2 || quote.length > 600) {
          return;
        }
        const common = range.commonAncestorContainer;
        const mdHost = closestElement(common, '.mp-chat-markdown');
        if (!mdHost) {
          return;
        }
        const conv = hooks?.getConversation();
        const ctx = resolveTurnContext(common);
        if (!conv || !ctx) {
          return;
        }
        const rangeRect = range.getBoundingClientRect();
        const blockEl = closestElement(common, '[data-block-index]');
        const rect = hasNonZeroRect(rangeRect)
          ? rangeRect
          : blockEl
            ? blockEl.getBoundingClientRect()
            : {left: 120, right: 240, top: 120, bottom: 144};

        openInquiryPopover(
          {
            conversationId: conv.id,
            parentBranchId: ctx.parentBranchId,
            parentTurnIndex: ctx.parentTurnIndex,
            anchor: {
              kind: 'selection',
              label: quote.slice(0, 48),
              snippet: quote,
              ...(ctx.blockIndex !== undefined ? {blockIndex: ctx.blockIndex} : {}),
            },
            rect,
            fromSelection: true,
          },
          {focusInput: false},
        );
      }, 15);
    });

    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && popoverState) {
        hideInquiryPopover();
      }
    });

    // 6. Live Token Streaming inside Branch Subtrees
    getDataApi()?.onLearnProgress(payload => {
      const branchId = String(payload?.branchId || '');
      const turnIndex = Number(payload?.turnIndex ?? 0);
      if (!branchId) {
        return;
      }
      liveStreams.set(branchId, {
        requestId: String(payload.requestId || ''),
        branchId,
        turnIndex,
        answer: String(payload.answer || ''),
        thinking: String(payload.thinking || ''),
      });
      const selector = `[data-branch-answer-body="${escapeCssSelectorValue(`${branchId}:${turnIndex}`)}"]`;
      document.querySelectorAll<HTMLElement>(selector).forEach(bodyEl => {
        const answerText = String(payload.answer || '');
        if (answerText.trim()) {
          patchStreamingAnswerBody(bodyEl, answerText);
        } else if (!bodyEl.querySelector('.mp-learn-streaming-status')) {
          bodyEl.replaceChildren(streamingStatusNode());
        }
      });
    });
  }

  function consumeMainComposerLemmas(): MagicPointerLearnLemmaRef[] {
    const items = [...lemmasForKey('__main__')];
    composerLemmas.delete('__main__');
    hooks?.onMainLemmasChanged?.();
    return items;
  }

  function formatQuestionWithMainLemmas(question: string): string {
    const items = consumeMainComposerLemmas();
    if (!items.length) {
      return question;
    }
    const tail = items
      .map(ref => `[引用并行支线「${ref.title}」的结论]\n${ref.summary}`)
      .join('\n\n');
    return `${question}\n\n---\n${tail}`;
  }

  function renderMainComposerLemmas(hostEl: HTMLElement | null): void {
    if (!hostEl) {
      return;
    }
    renderLemmaStrip(hostEl, '__main__');
  }

  const LearnTreeApi = {
    init,
    mountConversation,
    renderHud,
    renderDeck,
    renderMainComposerLemmas,
    formatQuestionWithMainLemmas,
    hasDockedBranches(
      conversation: MagicPointerConversation | null | undefined,
    ): boolean {
      return Boolean(conversation?.branches?.some(b => b.docked));
    },
    __test: {
      placeLearnPopover,
      hideInquiryPopover,
      cleanFormulaLabel,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = LearnTreeApi;
  }
  (
    globalThis as unknown as {LearnTree?: typeof LearnTreeApi}
  ).LearnTree = LearnTreeApi;
})();
