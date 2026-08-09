// @ts-nocheck -- legacy classic-script globals are preserved during the extension migration.
/* exported renderSettings */
/* ============================================================
   设置
   ------------------------------------------------------------
   骨架照 Codex 那套：左栏搜索 + 分组；右栏页头（标题 + 一句说明 +
   页级动作）→ 分节（小标题 + 可选节级动作）→ 行（标题 + 说明 + 控件）。

   一条硬规矩：**不让人手写规则**。凡是"多条配置"，一律做成
   可增删的列表，每行用选择器。写正则、写 `app | mode` 那种
   只有写代码的人受得了。
   ============================================================ */

/* 装机上真实存在的应用由主进程给；浏览器里预览时用这份兜底。 */
const APPS = [
  { id: 'chrome.exe',            name: 'Chrome',        icon: 'ic-window' },
  { id: 'Code.exe',              name: 'VS Code',       icon: 'ic-code' },
  { id: 'WeChat.exe',            name: '微信',          icon: 'ic-window' },
  { id: 'WindowsTerminal.exe',   name: 'Windows 终端',  icon: 'ic-term' },
  { id: 'EXCEL.EXE',             name: 'Excel',         icon: 'ic-file' },
  { id: 'Obsidian.exe',          name: 'Obsidian',      icon: 'ic-docs' },
  { id: '1Password.exe',         name: '1Password',     icon: 'ic-shield' },
  { id: 'Figma.exe',             name: 'Figma',         icon: 'ic-img' },
];

const READ_MODES = [
  ['auto',   '自动',       '先试结构层，读不到再用画面'],
  ['struct', '只用结构层', '拿不到就放弃，绝不猜'],
  ['pixel',  '只看画面',   '结构层读不出来的应用用这个'],
  ['off',    '完全不读',   '这个应用里它什么都看不到'],
];

const RISK = [
  ['read',  '读取'],
  ['write', '写入'],
  ['send',  '对外发送'],
  ['irrev', '不可逆操作'],
];

const SETTINGS = [
  { group: '常用', pages: [

    { id: 'general', icon: 'ic-window', name: '通用',
      desc: '开机、后台、语言和更新。',
      sections: [
        { title: '运行', rows: [
          { k: 'general.autostart', t: 'toggle', label: '开机时启动',
            desc: '登录后静默驻留，不弹任何窗口。' },
          { k: 'general.keep_running', t: 'toggle', v: true, label: '关闭窗口后继续运行',
            desc: '关掉这个窗口不等于退出。它还在托盘里，划线和晃动照常可用。' },
          { k: 'general.lang', t: 'select', v: '跟随系统', opts: ['跟随系统', '简体中文', 'English'],
            label: '语言', desc: '' },
        ]},
        { title: '通知', rows: [
          { k: 'general.notify_done', t: 'toggle', v: true, label: '长任务完成时通知我',
            desc: '只在你已经切走、且任务超过 20 秒时才推。' },
          { k: 'general.notify_stash', t: 'toggle', v: true, label: '存进收藏箱时提示一下',
            desc: '在指针旁闪一下就消失，带一个「复制路径」。' },
          { k: 'general.notify_fail', t: 'toggle', v: true, label: '失败时一定通知',
            desc: '这一条建议别关——静默失败比失败更糟。' },
        ]},
        { title: '更新', action: { label: '检查更新' }, rows: [
          { k: '_update', t: 'status', label: '当前版本', desc: '上次检查 2026/08/06 11:46',
            value: '0.9.2 · 已是最新', tone: 'green' },
          { k: 'general.auto_update', t: 'toggle', v: true, label: '自动检查更新',
            desc: '只在运行时检查，不装常驻后台任务。' },
          { k: 'general.channel', t: 'select', v: '稳定', opts: ['稳定', '预览'],
            label: '更新通道', desc: '预览通道更早拿到修复，也更容易坏。' },
        ]},
        { title: '设置本身', rows: [
          { k: '_export', t: 'manage', label: '导出设置', desc: '存成一个文件，换机器时导回来。密钥不会被导出。', btn: '导出…' },
          { k: '_import', t: 'manage', label: '导入设置', desc: '', btn: '导入…' },
          { k: '_wizard', t: 'manage', label: '重跑首次向导', desc: '重新检查权限、模型和快捷键。', btn: '开始' },
        ]},
      ]},

    { id: 'appearance', icon: 'ic-img', name: '外观',
      desc: '主题、首屏背景和舞台上的动效。',
      sections: [
        { title: '主题', rows: [
          { k: 'appearance.theme', t: 'segment', v: '浅色', opts: ['浅色', '深色', '跟随系统'], label: '主题' },
          { k: 'appearance.material', t: 'select', v: 'Mica', opts: ['Mica', '不透明'],
            label: '窗口材质', desc: '持久窗口用 Mica；真模糊只留给指针旁那个临时浮层。' },
          { k: 'appearance.font_scale', t: 'select', v: '标准', opts: ['标准', '大', '更大'], label: '字号' },
        ]},
        { title: '首屏背景', rows: [
          { k: 'appearance.hero_mode', t: 'segment', v: '内置影像',
            opts: ['我的桌面壁纸', '内置影像', '自选文件'], label: '用什么当背景' },
          { k: 'appearance.hero_file', t: 'path', v: 'assets/media/hero.mp4',
            label: '文件', desc: '图片或短视频都行。会自动压暗、失焦，不会跟标题抢。' },
        ]},
        { title: '舞台', rows: [
          { k: 'appearance.sweep', t: 'toggle', v: true, label: '扫线动画',
            desc: '读取上下文时，把正在被读的那块高亮一下——你能看见它到底看了哪里。' },
          { k: 'appearance.capsule', t: 'select', v: '标准', opts: ['紧凑', '标准', '宽'], label: '胶囊宽度' },
        ]},
      ]},

    { id: 'shortcuts', icon: 'ic-inject', name: '键盘快捷键',
      desc: '全局快捷键。和别的软件撞了会标出来。',
      sections: [
        { title: '唤起', rows: [
          { k: 'sc.stage', t: 'hotkey', v: 'Alt + Space', label: '叫出指针旁的胶囊' },
          { k: 'sc.companion', t: 'hotkey', v: 'Alt + Shift + Space', label: '展开随行窗' },
          { k: 'sc.studio', t: 'hotkey', v: 'Alt + Shift + M', label: '打开这个窗口' },
        ]},
        { title: '采集', rows: [
          { k: 'sc.capture', t: 'hotkey', v: 'Win + Shift + S', label: '截图并存进收藏箱',
            desc: '接管系统截图；截完图和本地路径会同时在剪贴板里。' },
          { k: 'sc.clip', t: 'hotkey', v: '未设置', label: '录一段 3–5 秒的片段' },
          { k: 'sc.paste_path', t: 'hotkey', v: 'Ctrl + Shift + V', label: '粘贴最近一张图的路径' },
        ]},
        { title: '说话', rows: [
          { k: 'sc.push', t: 'hotkey', v: 'Ctrl + Space', label: '按住说话' },
          { k: 'sc.toggle_voice', t: 'hotkey', v: '未设置', label: '按一下开始、再按一下停止' },
        ]},
      ]},
  ]},

  { group: '唤起', pages: [

    { id: 'activation', icon: 'ic-shake', name: '唤醒与指向',
      desc: '平时它完全不可见。这里决定什么动作会把它叫出来。',
      sections: [
        { title: '入口', rows: [
          { k: 'act.wiggle', t: 'toggle', v: true, label: '晃动鼠标唤醒',
            desc: '快速来回晃两下，胶囊出现在指针旁边。' },
          { k: 'act.wiggle_sens', t: 'slider', v: 62, label: '晃动灵敏度',
            desc: '往左更不容易误触，往右更容易叫出来。' },
          { k: 'act.stroke', t: 'toggle', v: true, label: '划线选中',
            desc: '按住划过一段文字，就地问它。' },
          { k: 'act.hold', t: 'select', v: '240 ms', opts: ['180 ms', '240 ms', '320 ms'],
            label: '按多久算长按', desc: '短于这个时长按普通点击处理，不打扰你。' },
        ]},
        { title: '出现之后', rows: [
          { k: 'act.auto_read', t: 'toggle', v: true, label: '自动带上光标下的东西',
            desc: '省得你再选一次。' },
          { k: 'act.dismiss', t: 'select', v: '失去焦点就消失',
            opts: ['失去焦点就消失', '点别处才消失', '一直留着'], label: '什么时候收起' },
          { k: 'act.drift', t: 'toggle', v: true, label: '目标窗口被切走时暂停',
            desc: '长任务绑着当初那个窗口。窗口没了就停下来问你，绝不改到当前这个。' },
        ]},
        { title: '不打扰', rows: [
          { k: 'act.mute_fullscreen', t: 'toggle', v: true, label: '全屏时不出现',
            desc: '放视频、演示、打游戏的时候。' },
          { k: 'act.mute_apps', t: 'applist', label: '这些应用里不出现',
            desc: '', v: ['1Password.exe'] },
        ]},
      ]},

    { id: 'voice', icon: 'ic-mic', name: '语音',
      desc: '转写在本机完成。说出来的内容不会因为开了语音就多传一份。',
      sections: [
        { title: '麦克风', rows: [
          { k: 'voice.device', t: 'select', v: '系统默认', opts: ['系统默认'], label: '麦克风' },
          { k: 'voice.enabled', t: 'toggle', v: true, label: '语音输入' },
        ]},
        { title: '快慢取舍', rows: [
          { k: 'voice.resident', t: 'toggle', v: true, label: '让模型常驻',
            desc: '不常驻的话每次都要重新加载，实测第一句要等 4 秒多。常驻大约多占 700MB 内存。' },
          { k: 'voice.two_pass', t: 'toggle', v: true, label: '先出草稿再回填',
            desc: '你会先看到大致的字，一两秒后自动修正。比换个更小的模型划算。' },
        ]},
        { title: '它总是听错的词', action: { label: '+ 添加' }, rows: [
          { k: 'voice.glossary', t: 'termlist', label: '',
            desc: '写进来之后，它在对应的地方会优先按这个来。',
            v: [['Magic Pointer', '所有地方'], ['Context Packet', 'D:\\work\\repo']] },
        ]},
      ]},
  ]},

  { group: '感知', pages: [

    { id: 'capture', icon: 'ic-eye', name: '感知',
      desc: '它靠两条路看屏幕：一条是读窗口的结构，一条是看画面。结构层准，画面是兜底。',
      sections: [
        { title: '默认怎么读', rows: [
          { k: 'cap.mode', t: 'select', v: '自动', opts: READ_MODES.map((m) => m[1]),
            label: '读取方式', desc: '自动 = 先试结构层，读不到再看画面。看画面得到的结果会标出来。' },
          { k: 'cap.shot', t: 'toggle', v: true, label: '允许截屏',
            desc: '只在需要看画面时截，截完立刻用完就丢，除非你自己存进收藏箱。' },
          { k: 'cap.upload', t: 'toggle', v: false, label: '允许把画面发给模型',
            desc: '关掉之后画面只在本机处理。当前配的模型本来也读不了图。' },
          { k: 'cap.budget', t: 'select', v: '600 ms（推荐）',
            opts: ['200 ms（已证伪，别选）', '600 ms（推荐）', '900 ms'],
            label: '每次最多读多久',
            desc: '读结构层要跨进程，本身启动就要 175 毫秒。给 200 毫秒等于只剩 25 毫秒真正去读——实测四个常见窗口全部失败。' },
        ]},
        { title: '这些应用单独设', action: { label: '+ 添加应用' }, rows: [
          { k: 'cap.per_app', t: 'applist2', label: '',
            desc: '有些应用天生读不出结构（比如微信），给它单独指一条路更省事。',
            v: [['WeChat.exe', 'pixel'], ['WindowsTerminal.exe', 'struct']] },
        ]},
      ]},

    { id: 'privacy', icon: 'ic-shield', name: '隐私',
      desc: '哪些东西一进来就该被抹掉，哪些应用干脆别看。',
      sections: [
        { title: '自动遮蔽', rows: [
          { k: 'pv.redact', t: 'toggle', v: true, label: '遮住密码、密钥和银行卡号',
            desc: '在写进本地记录之前就遮，不是显示的时候才遮。' },
          { k: 'pv.redact_extra', t: 'select', v: '不额外遮',
            opts: ['不额外遮', '也遮邮箱和手机号', '也遮人名和地址'], label: '还要遮什么' },
        ]},
        { title: '这些应用完全不看', action: { label: '+ 添加应用' }, rows: [
          { k: 'pv.apps', t: 'applist', label: '',
            desc: '在这些应用里，它不读、不截、也不记。', v: ['1Password.exe'] },
        ]},
      ]},
  ]},

  { group: '行动', pages: [

    { id: 'permissions', icon: 'ic-shield', name: '权限',
      desc: '按后果分四档。越往下越不可逆，默认也越保守。',
      sections: [
        { title: '默认怎么办', rows: [
          { k: 'perm.read', t: 'select', v: '直接做', opts: ['直接做', '每次问我'],
            label: '读东西', desc: '看窗口内容、读选中的文字。' },
          { k: 'perm.write', t: 'select', v: '每次问我', opts: ['直接做', '每次问我'],
            label: '写东西', desc: '填进输入框、放进剪贴板。' },
          { k: 'perm.send', t: 'select', v: '每次问我', opts: ['每次问我', '一律不许'],
            label: '往外发', desc: '发邮件、发消息、提交表单。' },
          { k: 'perm.irrev', t: 'select', v: '问两次', opts: ['问两次', '一律不许'],
            label: '收不回来的事', desc: '删除、覆盖、直接改别人窗口里的内容。', danger: true },
        ]},
        { title: '已经给出去的授权', action: { label: '+ 添加' }, rows: [
          { k: 'perm.grants', t: 'grantlist', label: '',
            desc: '授权不跨应用、不跨项目、也不跨时间。到期自动收回。',
            v: [['send', 'Code.exe', 'D:\\work\\repo', '7 天']] },
        ]},
      ]},

    { id: 'capabilities', icon: 'ic-spark', name: '能力',
      desc: '它会做的那些事。只显示当前环境真的能执行的。',
      sections: [
        { title: '内置', rows: [
          { k: '_recipes', t: 'status', label: '内置动作', desc: '改写、翻译、汇总、加进日历、写回原处…',
            value: '39 条', tone: 'teal', action: '全部查看' },
          { k: 'cap.suggest', t: 'toggle', v: true, label: '推荐下一步',
            desc: '根据你指的东西给三个最可能的追问，不是固定那几个。' },
        ]},
        { title: '自动学到的', rows: [
          { k: 'cap.draft', t: 'toggle', v: true, label: '把重复做过的事存成模板',
            desc: '同一套流程做满三次才会生成草稿，而且生成后默认是关的，得你自己打开。' },
        ]},
      ]},

    { id: 'extensions', icon: 'ic-plug', name: '扩展', custom: 'ext',
      desc: '它会做的事、能借的工具、能进的应用，都在这里开关。',
      sections: [] },

    { id: 'connections', icon: 'ic-plug', name: '连接',
      desc: '外部的东西。每一个都要单独授权，也可以随时断开。',
      sections: [
        { title: '浏览器', rows: [
          { k: 'conn.devtools', t: 'toggle', v: true, label: '读浏览器里正在看的页面',
            desc: '只连你明确填的本机端口。页面地址和内容不会出现在任何状态摘要里。' },
          { k: 'conn.ports', t: 'portlist', label: '', desc: '只接受本机地址。',
            v: ['9222'] },
        ]},
        { title: '其他', rows: [
          { k: '_mcp', t: 'status', label: 'MCP 服务器', desc: '读你已经配好的那些，不额外要你再配一遍',
            value: '0 个', tone: 'muted', action: '管理' },
          { k: '_gh', t: 'status', label: 'GitHub', desc: '', value: '未连接', tone: 'muted', action: '连接' },
          { k: '_mail', t: 'status', label: '邮件与团队消息', desc: '发送永远要单独确认',
            value: '未连接', tone: 'muted', action: '连接' },
          { k: '_cal', t: 'status', label: '日历', desc: '在本机生成草稿；写入前检查冲突和时区',
            value: '本地可用', tone: 'green' },
        ]},
      ]},
  ]},

  { group: '智能', pages: [

    { id: 'models', icon: 'ic-mcp', name: '模型',
      desc: '同一个问题不一定要用同一个模型。',
      sections: [
        { title: '主力', action: { label: '测试连通性' }, rows: [
          { k: '_endpoint', t: 'status', label: 'DeepSeek · deepseek-v4-flash',
            desc: 'api.deepseek.com · Anthropic 协议 · 1M 上下文', value: '可用', tone: 'green' },
          { k: 'model.thinking', t: 'toggle', v: false, danger: true, label: '开启思考模式',
            desc: '这个端点必须关。开着会返回成功但正文是空的——看起来像没反应，其实是模型没说话。' },
          { k: 'model.max_out', t: 'select', v: '2k', opts: ['1k', '2k', '4k', '不限'],
            label: '一次最多写多少', desc: '在这个网关上，写得越长等得越久。' },
        ]},
        { title: '看图用的', action: { label: '+ 添加' }, rows: [
          { k: '_vision', t: 'status', label: '视觉模型',
            desc: '主力模型读不了图。没有它的话，截图和片段只能靠文字识别加窗口结构去还原。',
            value: '未配置', tone: 'amber', action: '去配置' },
        ]},
        { title: '分派', rows: [
          { k: 'model.route', t: 'toggle', v: true, label: '按任务自动挑',
            desc: '短问题走快的，长任务走强的。你在输入框右边随时可以改这一次用谁。' },
        ]},
      ]},

    { id: 'agents', icon: 'ic-handoff', name: '交接给别的 Agent',
      desc: '你电脑上已经装了的那些，可以直接把现场交过去，不用重新描述一遍。',
      sections: [
        { title: '本机发现', action: { label: '重新检测' }, rows: [
          { k: '_cc', t: 'status', label: 'Claude Code', desc: '按真实协议发现，不猜安装路径', value: '已发现', tone: 'green' },
          { k: '_codex', t: 'status', label: 'Codex', desc: '', value: '已发现', tone: 'green' },
        ]},
        { title: '交接内容', rows: [
          { k: 'agent.meta_only', t: 'toggle', v: true, label: '只读会话的基本信息',
            desc: '只看会话编号、目录和更新时间，不读也不展示里面的对话。' },
          { k: 'agent.reuse', t: 'toggle', v: true, label: '复用同一份现场',
            desc: '换个执行者不必重新描述窗口、对象和仓库。' },
        ]},
      ]},
  ]},

  { group: '归档', pages: [

    { id: 'stash', icon: 'ic-stash', name: '收藏箱',
      desc: '截图、复制的图和录的片段落到本地哪里，以及怎么自动归类。',
      sections: [
        { title: '落盘', action: { label: '打开文件夹' }, rows: [
          { k: 'stash.dir', t: 'path', v: '%LOCALAPPDATA%\\MagicPointer\\stash', label: '保存到' },
          { k: 'stash.hijack', t: 'toggle', v: true, label: '接管系统截图',
            desc: '按完 Win+Shift+S 就已经存好了，不用再找地方另存。' },
          { k: 'stash.clipboard', t: 'toggle', v: true, label: '同时把路径放进剪贴板',
            desc: '图还在剪贴板里，路径也在。终端里粘出来是路径，图片软件里粘出来是图——不用再切工具。' },
          { k: 'stash.burst', t: 'select', v: '2 分钟', opts: ['30 秒', '2 分钟', '10 分钟'],
            label: '多久算「一起进来的」', desc: '这个时间内连着存的东西，在画布上会被圈成一堆。' },
        ]},
        { title: '归类', rows: [
          { k: 'stash.autoclass', t: 'toggle', v: true, label: '自动分成灵感 / 交接 / 凭证 / 素材',
            desc: '分错了直接改，它会记住。' },
          { k: 'stash.describe', t: 'toggle', v: true, label: '给每一条写一句话',
            desc: '写的是你截的那个窗口里的那个元素叫什么，不是靠认字猜的。' },
        ]},
        { title: '片段', rows: [
          { k: 'stash.clip_len', t: 'select', v: '5 秒', opts: ['3 秒', '5 秒', '10 秒'], label: '默认录多久' },
          { k: 'stash.clip_fps', t: 'select', v: '12 帧', opts: ['8 帧', '12 帧', '15 帧'],
            label: '每秒几帧', desc: '12 帧足够看清界面动作，也让抽出来的关键帧不至于太多。' },
        ]},
      ]},

    { id: 'storage', icon: 'ic-docs', name: '存储',
      desc: '本地留多久，占了多少。',
      sections: [
        { title: '保留', rows: [
          { k: 'st.timeline', t: 'select', v: '30 天', opts: ['7 天', '30 天', '永久'], label: '时间线' },
          { k: 'st.stash', t: 'select', v: '永久', opts: ['90 天', '永久'],
            label: '收藏箱', desc: '过期只清索引，文件本身留在磁盘上。' },
          { k: 'st.artifacts', t: 'select', v: '永久', opts: ['30 天', '永久'], label: '产物' },
        ]},
        { title: '占用', rows: [
          { k: '_size', t: 'status', label: '当前', desc: '收藏箱 1.1 GB · 时间线 240 MB · 缓存 80 MB',
            value: '1.4 GB', tone: 'muted', action: '清理…' },
        ]},
      ]},

    { id: 'activity', icon: 'ic-timeline', name: '记录与审计',
      desc: '它做过什么，以及做成了没有。',
      sections: [
        { title: '记什么', rows: [
          { k: 'ac.stats', t: 'toggle', v: true, label: '记录使用统计', desc: '只在本机，不外发。' },
          { k: 'ac.receipts', t: 'toggle', v: true, label: '保留每次动作的回执',
            desc: '「已受理」只代表排上队了。真正的成功必须是回头读一遍确认过的。' },
        ]},
        { title: '导出', rows: [
          { k: '_audit', t: 'manage', label: '导出审计日志', desc: '给需要留档的场合。', btn: '导出…' },
        ]},
      ]},
  ]},

  { group: '关于', pages: [

    { id: 'diagnostics', icon: 'ic-pulse', name: '诊断',
      desc: '出问题时先看这里。都是真跑出来的数，不是写死的。',
      sections: [
        { title: '本机', action: { label: '全部重测' }, rows: [
          { k: '_py', t: 'status', label: 'Python 桥', desc: '1026 项测试通过', value: '正常', tone: 'green' },
          { k: '_node', t: 'status', label: 'Node 层', desc: '133 项测试通过', value: '正常', tone: 'green' },
          { k: '_uia', t: 'status', label: '窗口结构探针', desc: '冷启动 175 毫秒（20 次取中位数）',
            value: '正常', tone: 'green', action: '重测' },
          { k: '_voice', t: 'status', label: '语音', desc: '首句 p50 4.3 秒；开了常驻之后应降到 1 秒内',
            value: '偏慢', tone: 'amber' },
        ]},
        { title: '文件', rows: [
          { k: '_logs', t: 'manage', label: '日志', desc: '', btn: '打开文件夹' },
          { k: '_config', t: 'manage', label: '配置文件', desc: '高级用法。改坏了可以从这里恢复默认。', btn: '打开' },
        ]},
      ]},

    { id: 'about', icon: 'ic-spark', name: '关于',
      desc: '',
      sections: [
        { title: '', rows: [
          { k: '_ver', t: 'status', label: 'Magic Pointer', desc: '0.9.2 · Windows', value: '', tone: 'muted' },
          { k: '_lic', t: 'manage', label: '开源许可', desc: '', btn: '查看' },
          { k: '_feedback', t: 'manage', label: '反馈问题', desc: '会带上诊断信息，不带任何屏幕内容。', btn: '反馈…' },
        ]},
      ]},
  ]},
];

/* ============================================================
   控件
   ============================================================ */

const TONE = { green: 'pill-green', amber: 'pill-amber', teal: 'pill-teal', muted: '' };
const appById = (id) => APPS.find((a) => a.id === id) || { id, name: id, icon: 'ic-window' };

function icon(id, cls = '') { return `<svg class="${cls}"><use href="#${id}"/></svg>`; }

function pickerApp(id) {
  const a = appById(id);
  return `<button class="picker" data-picker="app">${icon(a.icon)}${a.name}${icon('ic-chev', 'caret')}</button>`;
}
function pickerFrom(list, value) {
  const hit = list.find((o) => o[0] === value) || list[0];
  return `<button class="picker" data-picker="mode">${hit[1]}${icon('ic-chev', 'caret')}</button>`;
}

function ctrl(r) {
  switch (r.t) {
    case 'toggle':
      return `<button class="sw${r.v ? ' is-on' : ''}" role="switch" aria-checked="${!!r.v}" data-k="${r.k}"><span></span></button>`;
    case 'select':
      return `<button class="sel" data-k="${r.k}">${r.v || r.opts[0]}${icon('ic-chev')}</button>`;
    case 'segment':
      return `<span class="seg-toggle sm">${r.opts.map((o) => `<button class="${o === r.v ? 'is-on' : ''}">${o}</button>`).join('')}</span>`;
    case 'hotkey':
      return r.v && r.v !== '未设置'
        ? `<button class="hk" data-k="${r.k}">${r.v.split(' + ').map((x) => `<kbd>${x}</kbd>`).join('+')}</button>`
        : `<button class="hk is-off" data-k="${r.k}">未设置${icon('ic-pen')}</button>`;
    case 'slider':
      return '';   // 刻度条要占满一行，单独渲染，见 renderSettings
    case 'status':
      return `${r.value ? `<span class="pill ${TONE[r.tone] || ''}">${r.value}</span>` : ''}`
           + `${r.action ? `<button class="btn btn-quiet">${r.action}</button>` : ''}`;
    case 'manage':
      return `<button class="btn btn-quiet">${r.btn || '管理'}</button>`;
    case 'path':
      return `<button class="path" data-k="${r.k}"><code>${r.v}</code>${icon('ic-folder')}</button>`;
    default:
      return '';
  }
}

/* ---- 列表型：一律可增删，绝不让人手写 ---- */
function listRows(r) {
  switch (r.t) {
    case 'applist':
      return (r.v || []).map((id) => `<div class="lrow">${pickerApp(id)}<span class="lgrow"></span>
        <button class="lx" title="移除">${icon('ic-x')}</button></div>`).join('');
    case 'applist2':
      return (r.v || []).map(([id, mode]) => {
        const m = READ_MODES.find((x) => x[0] === mode) || READ_MODES[0];
        return `<div class="lrow">${pickerApp(id)}<span class="lsep">用</span>${pickerFrom(READ_MODES, mode)}
          <small class="lhint">${m[2]}</small><span class="lgrow"></span>
          <button class="lx" title="移除">${icon('ic-x')}</button></div>`;
      }).join('');
    case 'termlist':
      return (r.v || []).map(([term, scope]) => `<div class="lrow">
        <input class="lin" value="${term}" spellcheck="false">
        <span class="lsep">用在</span>
        <button class="picker" data-picker="scope">${scope}${icon('ic-chev', 'caret')}</button>
        <span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`).join('');
    case 'grantlist':
      return (r.v || []).map(([risk, app, proj, ttl]) => {
        const label = (RISK.find((x) => x[0] === risk) || RISK[0])[1];
        return `<div class="lrow">
          <button class="picker">${label}${icon('ic-chev', 'caret')}</button>
          <span class="lsep">在</span>${pickerApp(app)}
          <span class="lsep">的</span><button class="picker">${proj}${icon('ic-chev', 'caret')}</button>
          <span class="lgrow"></span>
          <span class="lttl">${ttl}后到期</span>
          <button class="lx">${icon('ic-x')}</button></div>`;
      }).join('');
    case 'portlist':
      return (r.v || []).map((port) => `<div class="lrow">
        <span class="lfix">127.0.0.1 :</span><input class="lin lin-sm" value="${port}" inputmode="numeric">
        <span class="lgrow"></span><button class="lx">${icon('ic-x')}</button></div>`).join('');
    default: return null;
  }
}


/* 扩展页单独渲染：它不是「一行一个开关」，是一个可搜索的目录。 */
const EXT_TABS = [
  ['builtin', '内置动作', 39],
  ['mcp',     'MCP 服务器', 0],
  ['skills',  '技能', 51],
  ['apps',    '已接入的应用', 4],
];

const EXT_ITEMS = {
  builtin: [
    ['ic-pen',     '改写这段',   '按你给的方向重写选中的文字', 1, 'read'],
    ['ic-docs',    '压成三句',   '把一屏内容缩到能一眼看完', 1, 'read'],
    ['ic-inject',  '写回原处',   '把结果送回你划线的那个位置', 1, 'write'],
    ['ic-file',    '加进日历',   '识别时间和地点，先在本地生成草稿', 1, 'write'],
    ['ic-search',  '找出处',     '沿来源链一路回溯到最初那个对象', 1, 'read'],
    ['ic-handoff', '交给 Agent', '把现场原样交给 Claude Code 或 Codex', 1, 'send'],
  ],
  mcp: [],
  skills: [
    ['ic-spark', 'agent-reach',   '从十几个平台取内容，只取不加工', 1, 'read'],
    ['ic-code',  'brainstorming', '动手之前先把要做的事想清楚', 1, 'read'],
    ['ic-eye',   'ask-gemini',    '换一个模型再看一遍同一个问题', 0, 'send'],
  ],
  apps: [
    ['ic-code',   'VS Code',      '读文件、光标位置和选区', 1, 'read'],
    ['ic-term',   'Windows 终端', '读当前输出；写回走剪贴板', 1, 'write'],
    ['ic-window', 'Chrome',       '读页面结构，只连本机回环端口', 1, 'read'],
    ['ic-window', '微信',         '结构读不出来，只能看画面', 1, 'read'],
  ],
};

const RISK_TAG = {
  read:  ['pill-indigo', '读取'],
  write: ['pill-amber', '写入'],
  send:  ['pill-terracotta', '对外发送'],
};

function renderExtensions(tab = 'builtin') {
  const list = EXT_ITEMS[tab] || [];
  const tabs = `<div class="ext-tabs">${EXT_TABS.map(([id, name, n]) =>
      `<button class="tab${id === tab ? ' is-on' : ''}" data-ext="${id}">${name} <em>${n}</em></button>`).join('')}
      <span class="lgrow"></span>
      <span class="set-search sm">${icon('ic-search')}<input placeholder="搜索…"></span>
    </div>`;
  const body = list.length
    ? `<div class="card ext-list">${list.map(([ic, name, desc, on, risk]) => {
        const [cls, label] = RISK_TAG[risk];
        return `<div class="ext-row">
          <span class="ext-ic">${icon(ic)}</span>
          <span class="ext-txt"><b>${name}</b><small>${desc}</small></span>
          <span class="pill ${cls} xs">${label}</span>
          <button class="sw${on ? ' is-on' : ''}" role="switch" aria-checked="${!!on}"><span></span></button>
        </div>`;
      }).join('')}</div>`
    : `<div class="card ext-empty">${icon('ic-plug')}
        <b>还没有连接任何 MCP 服务器</b>
        <small>它会读你已经配好的那些，不用在这里再配一遍。</small>
        <button class="btn btn-solid">去连接</button></div>`;
  return tabs + body;
}

/* ============================================================
   渲染
   ============================================================ */

function renderSettings() {
  const nav = document.getElementById('set-nav');
  const body = document.getElementById('set-body');
  if (!nav || nav.childElementCount) return;

  const pages = SETTINGS.flatMap((g) => g.pages);

  nav.innerHTML = `<div class="set-search">${icon('ic-search')}<input placeholder="搜索设置…" id="set-q"></div>`
    + SETTINGS.map((g) => `<div class="set-group">${g.group}</div>`
      + g.pages.map((p) => `<button class="set-navitem${p === pages[0] ? ' is-on' : ''}" data-page="${p.id}">
          ${icon(p.icon)}<span>${p.name}</span></button>`).join('')).join('');

  body.innerHTML = pages.map((p, pi) => `<div class="set-page" data-page="${p.id}"${pi ? ' hidden' : ''}>
    <header class="set-head">
      <div><h1>${p.name}</h1>${p.desc ? `<p>${p.desc}</p>` : ''}</div>
    </header>
    ${p.custom === 'ext' ? renderExtensions() : ''}
    ${p.sections.map((sec) => {
      const plain = sec.rows.filter((r) => !listRows(r));
      const lists = sec.rows.filter((r) => listRows(r));
      return `<section class="set-section">
        ${sec.title || sec.action ? `<div class="set-sechead">
          <h2>${sec.title || ''}</h2>
          ${sec.action ? `<button class="btn btn-quiet sm">${sec.action.label}</button>` : ''}
        </div>` : ''}
        ${plain.filter((r) => r.t !== 'slider').length ? `<div class="card set-rows">${plain.filter((r) => r.t !== 'slider').map((r) => `
          <div class="set-row${r.danger ? ' is-danger' : ''}">
            <span class="set-label"><b>${r.label}</b>${r.desc ? `<small>${r.desc}</small>` : ''}</span>
            <span class="set-ctrl">${ctrl(r)}</span>
          </div>`).join('')}</div>` : ''}
        ${sec.rows.filter((r) => r.t === 'slider').map((r) => `<div class="set-slider">
          <div class="set-label"><b>${r.label}</b>${r.desc ? `<small>${r.desc}</small>` : ''}</div>
          <div class="tick" data-k="${r.k}" data-v="${r.v}"></div>
        </div>`).join('')}
        ${lists.map((r) => `<div class="card set-list">
          ${listRows(r)}
          ${(r.v || []).length ? '' : '<div class="lempty">还没有添加任何一条</div>'}
        </div>${r.desc ? `<p class="set-note">${r.desc}</p>` : ''}`).join('')}
      </section>`;
    }).join('')}
  </div>`).join('');
  // 滑杆的刻度要在 DOM 写完之后才能量宽度。放在这里而不是包一层函数，
  // 是因为改写一个函数声明本身在严格模式下就是错的。
  initTicks();
}

/* ============================================================
   交互
   ============================================================ */

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.set-navitem');
  if (nav) {
    document.querySelectorAll('.set-navitem').forEach((n) => n.classList.remove('is-on'));
    nav.classList.add('is-on');
    document.querySelectorAll('.set-page').forEach((p) => { p.hidden = p.dataset.page !== nav.dataset.page; });
    document.getElementById('set-body').scrollTop = 0;
    return;
  }
  const sw = e.target.closest('.sw');
  if (sw) {
    const on = !sw.classList.contains('is-on');
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
    writeSetting(sw.dataset.k, on);
    return;
  }
  const lx = e.target.closest('.lx');
  if (lx) { lx.closest('.lrow').remove(); return; }

  const ext = e.target.closest('[data-ext]');
  if (ext) {
    const page = ext.closest('.set-page');
    page.querySelector('.ext-tabs').remove();
    page.querySelector('.ext-list, .ext-empty')?.remove();
    page.querySelector('.set-head').insertAdjacentHTML('afterend', renderExtensions(ext.dataset.ext));
    return;
  }
  const seg = e.target.closest('.seg-toggle.sm button');
  if (seg) {
    seg.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('is-on'));
    seg.classList.add('is-on');
    if (seg.textContent === '深色') setTheme('dark');
    if (seg.textContent === '浅色') setTheme('light');
    if (seg.textContent === '跟随系统') setTheme('system');
  }
});

/* 搜索：只过滤左栏，不重排右边——省得你一边打字一边页面在跳 */
document.addEventListener('input', (e) => {
  if (e.target.id !== 'set-q') return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.set-navitem').forEach((n) => {
    n.hidden = q ? !n.textContent.toLowerCase().includes(q) : false;
  });
  document.querySelectorAll('.set-group').forEach((g) => {
    let sib = g.nextElementSibling, any = false;
    while (sib && sib.classList.contains('set-navitem')) { if (!sib.hidden) any = true; sib = sib.nextElementSibling; }
    g.hidden = !any;
  });
});

function setTheme(theme) {
  document.documentElement.dataset.theme =
    theme === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
  writeSetting('appearance.theme', theme);
  window.magicPointerDashboard?.setTheme?.(theme);   // 主进程据此换系统按钮的颜色
}

function writeSetting(key, value) {
  const api = window.magicPointerDashboard;
  if (!api?.saveFabricSettings) return;
  const patch = {};
  key.split('.').reduce((o, part, i, arr) => (o[part] = i === arr.length - 1 ? value : {}), patch);
  api.saveFabricSettings(patch);
}


/* ============================================================
   刻度滑杆
   ------------------------------------------------------------
   40 根竖条。高度和深浅按「离手柄多远」衰减，手柄底下于是形成一道凹口——
   不看数字也知道自己抓在哪。拖动只改 height / opacity / left，不动布局。
   ============================================================ */

const TICKS = 40;

function paintTick(el, value) {
  const bars = el.querySelectorAll('i');
  const at = (value / 100) * (TICKS - 1);
  bars.forEach((b, i) => {
    const d = Math.abs(i - at) / TICKS;
    const fall = Math.min(1, d * 5.2);          // 凹口窄一点，抓点更明确
    b.style.height = (5 + fall * 29).toFixed(1) + 'px';
    b.style.opacity = (0.12 + fall * 0.72).toFixed(3);
  });
  const knob = el.querySelector('.tick-knob');
  if (knob) {
    knob.style.left = (14 + (el.clientWidth - 28) * (value / 100)).toFixed(1) + 'px';
    knob.firstChild.nodeValue = String(Math.round(value));
  }
  el.dataset.v = String(Math.round(value));
}

function initTicks() {
  document.querySelectorAll('.tick').forEach((el) => {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = Array.from({ length: TICKS }, () => '<i></i>').join('')
      + '<span class="tick-knob">' + el.dataset.v + '<em>灵敏度</em></span>';
    paintTick(el, Number(el.dataset.v));
    // 页面切换前它是隐藏的，clientWidth 为 0，气泡会贴在最左边。
    // 等真的有宽度了再重算一次。
    new ResizeObserver(() => paintTick(el, Number(el.dataset.v))).observe(el);

    const toValue = (clientX) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(100, ((clientX - r.left - 14) / (r.width - 28)) * 100));
    };
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      el.classList.add('is-grab');
      el.setPointerCapture(e.pointerId);
      paintTick(el, toValue(e.clientX));
    });
    el.addEventListener('pointermove', (e) => { if (dragging) paintTick(el, toValue(e.clientX)); });
    el.addEventListener('pointerup', () => {
      dragging = false;
      el.classList.remove('is-grab');
      writeSetting(el.dataset.k, Number(el.dataset.v));
    });
  });
}


