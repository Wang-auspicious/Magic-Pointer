(() => {
  type StudioViewId =
    | 'chat'
    | 'design'
    | 'stash'
    | 'artifacts'
    | 'settings'
    | 'projects'
    | 'scheduled'
    | 'customize'
    | 'chats'
    | 'designs'
    | 'personal';

  interface StudioView {
    id: StudioViewId;
    title: string;
    description: string;
    eyebrow: string;
    allowsDetail: boolean;
  }

  const STUDIO_VIEWS: readonly StudioView[] = Object.freeze([
    Object.freeze({
      id: 'personal',
      title: '工作回顾',
      description: '活动、文件足迹与每天的小结。',
      eyebrow: '个人记忆',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'chat',
      title: '对话',
      description: '围绕刚才指过的对象继续工作。',
      eyebrow: '进行中的工作',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'design',
      title: '设计',
      description: '从项目素材、可视化画布和设计产物开始。',
      eyebrow: '设计工作区',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'stash',
      title: '收藏箱',
      description: '整理本地保存的截图、文字与引用。',
      eyebrow: '本地收藏',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'artifacts',
      title: '产物',
      description: '查看、复用和导出已经生成的本地产物。',
      eyebrow: '本地产物',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'settings',
      title: '设置',
      description: '控制交互、模型、权限、隐私与外观。',
      eyebrow: '偏好设置',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'projects',
      title: '项目',
      description: '保存在本机的项目与对话。',
      eyebrow: '本地项目',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'scheduled',
      title: '定时任务',
      description: '每天关注真实材料并生成报告。',
      eyebrow: '定时工作',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'customize',
      title: '自定义',
      description: '技能、连接和本地 Harness 插件。',
      eyebrow: '自定义',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'chats',
      title: '对话与任务',
      description: '查看和组织本机的全部对话。',
      eyebrow: '本地任务',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'designs',
      title: '设计库',
      description: '设计产物、素材和设计系统。',
      eyebrow: '设计库',
      allowsDetail: false,
    }),
  ]);

  const VIEW_BY_ID = new Map(STUDIO_VIEWS.map(view => [view.id, view]));

  function normalizeView(value: unknown): StudioViewId {
    const id = String(value || '')
      .trim()
      .toLowerCase() as StudioViewId;
    return VIEW_BY_ID.has(id) ? id : 'chat';
  }

  function shellState(value: unknown) {
    const activeView = normalizeView(value);
    const view = VIEW_BY_ID.get(activeView)!;
    return Object.freeze({
      activeView,
      title: view.title,
      description: view.description,
      eyebrow: view.eyebrow,
      allowsDetail: view.allowsDetail,
    });
  }

  const StudioShell = {STUDIO_VIEWS, normalizeView, shellState};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StudioShell;
  }
  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {StudioShell?: typeof StudioShell}
    ).StudioShell = StudioShell;
  }
})();
