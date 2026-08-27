/**
 * Pro workbench product copy.
 *
 * This map is shared by i18next (see `live.ts`) and hook-free presentation
 * helpers, which is why it is TypeScript and not one more locale JSON: the
 * presentation table (`components/workbench/chat/tool-presentation.ts`), the
 * progress captions and the session store are pure functions with no hook to
 * read a language from, so they take a translator and this module can build one
 * synchronously.
 *
 * Two locales are written here — `workbenchEn` is the shape every other locale
 * is checked against, `workbenchZh` is its Chinese twin — and the remaining ten
 * are JSON overlays in `workbench-locales/`, merged by `workbenchResourceFor`
 * with English (or, for `zh-TW`, Simplified) underneath. So an untranslated key
 * degrades to a readable sentence rather than to `workbench.tool.label.x`, and
 * `tests/workbench/workbench-i18n.test.ts` holds the ten to the shape.
 */
import workbenchArSA from './workbench-locales/ar-SA.json' with { type: 'json' };
import workbenchDeDE from './workbench-locales/de-DE.json' with { type: 'json' };
import workbenchEsMX from './workbench-locales/es-MX.json' with { type: 'json' };
import workbenchFrFR from './workbench-locales/fr-FR.json' with { type: 'json' };
import workbenchJaJP from './workbench-locales/ja-JP.json' with { type: 'json' };
import workbenchKoKR from './workbench-locales/ko-KR.json' with { type: 'json' };
import workbenchPtBR from './workbench-locales/pt-BR.json' with { type: 'json' };
import workbenchRuRU from './workbench-locales/ru-RU.json' with { type: 'json' };
import workbenchViVN from './workbench-locales/vi-VN.json' with { type: 'json' };
import workbenchZhTW from './workbench-locales/zh-TW.json' with { type: 'json' };

export const workbenchEn = {
  common: {
    loading: 'Loading',
    send: 'Send',
    backToWorkspace: 'Back to workspace',
  },
  launch: {
    createFailed: 'Could not create the task. Please try again.',
    unknownSkill: 'That skill is no longer available. Retrying without it.',
  },
  chat: {
    stopFailed: 'Could not stop. Please try again.',
    sendFailed: 'Could not send. Please try again.',
    elementRefsNotAccepted: 'The server is temporarily unavailable. Please try again shortly.',
    jumpToBottom: 'Jump to bottom',
    interruptPlaceholder: 'Add a note, then press Enter to send',
    continuePlaceholder: 'Say what to do next, then press Enter to send',
    refsNeedInstruction: 'Type an instruction for the selected elements',
    stopping: 'Stopping…',
    stoppingAria: 'Stopping',
    stop: 'Stop this build',
    waiting: 'Processing',
    emptyTitle: 'Start a new conversation',
    emptyHint: 'Describe the change you want, or use @ to name a classroom',
  },
  question: {
    waiting: 'Waiting for your answer',
    answered: 'Answered',
    revive: 'Return to answer form',
    multiHint: 'Select any that apply, then choose “Confirm”',
    other: 'Other…',
    keyHint: '↑↓ Select · Enter Confirm',
    placeholder: 'Write your answer',
    confirm: 'Confirm',
    submit: 'Submit',
    dismiss: 'Dismiss',
    /**
     * The transcript row while this question owns the composer: the form below
     * already shows the question and its options, so the row says where the
     * answer goes instead of repeating them.
     */
    inFormBelow: 'Answer it in the form below',
    /**
     * How several picked labels become one message. It ends up in the user's own
     * bubble, so it follows the language of the surface: a CJK enumeration
     * comma in Chinese, "A, B" everywhere else.
     */
    multiAnswerSeparator: ', ',
  },
  material: {
    maxSelected: 'You can select up to {{count}} materials at once',
    remove: 'Remove {{name}}',
    removeFailed: 'Remove failed upload',
    uploadFailed: 'Could not upload {{name}}. Please try again.',
  },
  /**
   * The installed skills, as the product names them.
   *
   * A built-in skill's `title:` frontmatter is its Chinese display name, and the
   * registry ships it to every locale — so the display name lives HERE, keyed by
   * the skill's own directory name (its `/handle`, the English contract that
   * never translates). The frontmatter stays the fallback: a user Skill has no
   * key, and neither does a built-in one whose copy has not landed yet.
   * `tests/workbench/workbench-i18n.test.ts` reconciles the skills directory
   * against this map, so a new built-in skill without a title here fails that
   * test rather than shipping one Chinese row in an English menu.
   *
   * `description` is NOT here on purpose: it is the model's selection contract
   * (the agent reads it to choose a skill), not product copy.
   */
  skill: {
    listFailed: 'Could not load the skill list',
    contentLoadFailed: 'Could not load the full Skill content',
    settings: {
      menuLabel: 'Skill settings',
      title: 'Skill settings',
      description:
        'Manage your skills: upload a zip to install one, download to share, remove what you no longer need.',
      upload: 'Upload skill',
      uploadZip: 'Upload a zip archive',
      uploadFolder: 'Upload a folder',
      officialDownload: 'OpenMAIC official skill',
      officialDownloadDesc:
        'Agent-guided SOP: import this skill into another agent workspace to get Live Demo classroom generation, local deployment, key configuration, classroom generation, and secondary development.',
      errNotZip: 'Only zip archives can be uploaded',
      errNoSkillMdZip: 'No SKILL.md found in the archive',
      errNoSkillMdFolder: 'No SKILL.md found in the folder',
      errNoName: 'The SKILL.md frontmatter is missing a name',
      errDuplicate: 'A skill named {{name}} already exists; rename it and retry',
      errTimeout: 'The upload timed out; please retry',
      errRejected: 'The server rejected this upload',
      retry: 'Retry',
      mySkills: 'My skills',
      builtinSkills: 'Built-in skills',
      emptyMySkills:
        'No skills of your own yet — upload a zip, or ask the agent in a chat to create one from history.',
      newUpload: 'new',
      refsNote: '· {{count}} reference docs',
      downloadLabel: 'Download',
      removeLabel: 'Delete',
      removeConfirm: 'Delete this skill? It will no longer be available in chats.',
      cancel: 'Cancel',
      confirmDelete: 'Delete',
    },
    title: {
      'build-personal-skill': 'Build a personal Skill',
      'curriculum-planner': 'Series planning',
      'stage-dsl': 'Classroom document structure',
      'deep-interactive': 'Deep interactive',
      'deep-research': 'Deep research',
      'k12-core-literacy-planning': 'K-12 core-literacy design',
      'learning-to-learn': 'Learning to Learn',
      'lecture-style': 'Masterclass lecture',
      'page-clone': 'Page clone',
      'pptx-import': 'PPT import',
      'pro-editing': 'Professional editing',
      'slide-craft': 'Page design',
      'slide-dsl': 'Page data model',
      'social-emotional-learning': 'Social-emotional learning (SEL)',
      'stage-design': 'Classroom design',
      'style-clone': 'Deck style clone',
      'teacher-style-clone': 'Teacher style',
      'understanding-by-design': 'Understanding by Design (UbD)',
      vocational: 'Vocational training',
      'workshop-style': 'Interactive workshop',
    },
  },
  thinking: {
    active: 'Thinking…',
    done: 'Thought',
    doneWithDuration: 'Thought for {{duration}}',
  },
  system: {
    technicalDetails: 'Technical details',
    repeated: 'Same notice appeared {{count}} times in a row',
    resumed: 'Continued from the interruption',
    recovering: 'Generation was interrupted and is recovering automatically',
    steerQueued: 'The agent will respond after finishing the current step',
    runFailed: 'This build failed',
    retryHint: 'Send another message to retry',
    stopped: 'This build was stopped',
    workerInterrupted:
      'Interrupted by a worker restart. This call produced no result; the agent will retry it if needed.',
    userStopped: 'Interrupted by stop. This call produced no result.',
  },
  tool: {
    errorSeparator: ': ',
    recoverySeparator: '; ',
    /** How a list of names (the roster's cast) is joined on one row. */
    listSeparator: ', ',
    group: {
      tools: '{{count}} tool calls',
      skills: '{{count}} skills',
      running: 'Running',
      error: 'Has errors',
      done: 'Completed',
    },
    section: {
      input: 'Input',
      error: 'Error',
      result: 'Raw result',
      outline: 'Outline',
      process: 'Process',
      truncated: 'Result too long; truncated',
    },
    pageType: {
      quiz: 'Quiz',
      practice: 'Practice',
      interactive: 'Interactive',
      slide: 'Slide',
    },
    label: {
      listMaterials: 'Check materials',
      extractMaterial: 'Extract material',
      waitMaterials: 'Wait for material extraction',
      readMaterial: 'Read material',
      useMaterialMedia: 'Use material media',
      searchMaterial: 'Search materials',
      clipAudio: 'Clip reference audio',
      registerVoice: 'Register cloned voice',
      listVoices: 'List available voices',
      webSearch: 'Search the web',
      fetchUrl: 'Fetch webpage',
      readFile: 'Read file',
      loadSkill: 'Load skill',
      createSkillSaved: 'Skill saved',
      createSkillFailed: 'Could not save skill',
      readSkill: 'Read skill source',
      patchSkill: 'Edit skill',
      searchClassrooms: 'Search classrooms',
      readClassroom: 'Read classroom',
      searchChats: 'Search chats',
      readChat: 'Read chat',
      generateOutline: 'Plan classroom',
      generateScene: 'Generate page',
      generateSceneOrder: 'Generate page {{order}}',
      duplicateScene: 'Duplicate page',
      generateActions: 'Generate narration',
      generateActionsOrder: 'Generate narration for page {{order}}',
      generateTts: 'Synthesize speech',
      generateTtsOrder: 'Synthesize speech for page {{order}}',
      generateImage: 'Generate illustration',
      generateVideo: 'Generate video',
      previewScene: 'Preview page',
      readCourse: 'Read classroom',
      patchCourse: 'Edit classroom',
      grepCourse: 'Search classroom',
      editDeck: 'Reorder pages',
      editPage: 'Edit page',
      listScenes: 'Check current classroom',
      generateRoster: 'Design classroom roles',
      setRoster: 'Set classroom roles',
      importPptx: 'Import PPT',
      askUser: 'Ask you to confirm',
      createFolder: 'Create folder',
      moveToFolder: 'Move to folder',
      listFolderCourses: 'View classroom library',
      createStage: 'Create classroom',
      renameStage: 'Rename classroom',
      readStageOutline: 'Read classroom outline',
    },
    chip: {
      seconds: '{{count}} sec',
      results: '{{count}} results',
      grepHits: '{{count}} hits',
      untrustedSource: 'Source is outside this session',
      availableInNewSession: 'Available in a new session',
      records: '{{count}} records',
      moreResults: 'More results available',
      pages: '{{count}} pages',
      constraintViolations: '{{count}} constraint violations',
      reusedOutline: 'Reused existing outline',
      reviseAsDirected: 'Revised as directed',
      pageOrder: 'Page {{order}}',
      duplicateExists: 'Copy already exists',
      actions: '{{count}} actions',
      voicedLines: '{{count}} lines voiced',
      unvoicedLines: '{{count}} lines without audio',
      synthesizedLines: '{{count}} lines synthesized',
      existingLines: '{{count}} lines already had audio',
      failedLines: '{{count}} lines failed',
      persistedPages: '{{count}} pages saved',
      missingPages: '{{count}} pages missing',
      roles: '{{count}} roles',
      noVoices: 'No voices available',
      notesPages: '{{count}} pages with speaker notes',
      sourceTruncated: 'Source had {{count}} pages; truncated',
      truncated: 'Truncated',
      options: '{{count}} options',
      courses: '{{count}} classrooms',
      allCourses: 'All classrooms',
      folderCourses: 'Classrooms in a folder',
      reusedCourse: 'Reused existing classroom',
      movedToFolder: 'Moved to folder',
    },
    error: {
      materialExtraction: 'Material extraction failed',
      listMaterials: 'Could not check materials',
      readMaterial: 'Could not read material',
      searchMaterial: 'Could not search materials',
      clipAudio: 'Could not clip reference audio',
      registerVoice: 'Could not register cloned voice',
      listVoices: 'Could not list available voices',
      webSearch: 'Search failed',
      fetchUrl: 'Could not fetch webpage',
      readFile: 'Could not read file',
      loadSkill: 'Could not load skill',
      createSkill: 'Skill was not saved',
      readSkill: 'Could not read the skill',
      patchSkill: 'Skill was not changed',
      historyRead: 'Could not read history',
      generateOutline: 'Could not plan the classroom',
      generateScene: 'Could not generate page {{order}}',
      duplicateScene: 'Could not duplicate page',
      generateActions: 'Could not generate narration',
      noTtsProvider: 'Speech synthesis is not configured, so this page still has no audio',
      generateTts: 'Could not synthesize speech',
      generateImage: 'Could not generate illustration',
      generateVideo: 'Could not generate video',
      previewScene: 'Could not generate page preview',
      readCourse: 'Could not read the classroom',
      patchCourse: 'Could not edit the classroom',
      grepCourse: 'Could not search the classroom',
      editPage: 'Could not apply the edit',
      listScenes: 'Could not read the classroom',
      roster: 'Could not set the classroom roles',
      importPptx: 'Could not import the PPT',
      askUser: 'Could not send this question',
      createFolder: 'Could not create the folder',
      moveToFolder: 'Could not move the classroom into the folder',
      listFolderCourses: 'Could not read the classroom library',
      createStage: 'Could not create the classroom',
      renameStage: 'Could not rename the classroom',
      readStageOutline: 'Could not read the classroom outline',
      generic: 'Tool call failed',
    },
    progress: {
      scene: {
        prep: 'Lock page',
        content: 'Write content',
        actions: 'Add actions',
        save: 'Save',
        aligning: 'Aligning this page',
        arrangingReturnedActions: 'Actions are ready; arranging them',
        arrangingActions: 'Arranging classroom actions',
        layingOutReturnedContent: 'Layout is ready; placing it on the page',
        draftingContent: 'Drafting page content',
        failed: 'Could not generate this page',
        done: 'Page saved',
      },
      outline: {
        read: 'Read brief',
        plan: 'Plan structure',
        write: 'Write outline',
        reading: 'Reading your brief',
        ordering: 'Organizing page order',
        planning: 'Planning classroom structure',
        failed: 'Could not plan the outline',
        done: 'Outline ready',
      },
    },
  },
} as const;

type LocaleShape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

export const workbenchZh = {
  common: { loading: '加载中', send: '发送', backToWorkspace: '返回工作台' },
  launch: {
    createFailed: '创建任务失败，请重试',
    unknownSkill: '这个 Skill 已不存在，正在移除它并重试',
  },
  chat: {
    stopFailed: '停止失败，请重试',
    sendFailed: '发送失败，请重试',
    elementRefsNotAccepted: '服务暂时不可用，请稍后重试。',
    jumpToBottom: '回到底部',
    interruptPlaceholder: '可以插话，回车发送',
    continuePlaceholder: '继续说点什么，回车发送',
    refsNeedInstruction: '输入对已选元素的指令后发送',
    stopping: '正在停止…',
    stoppingAria: '正在停止',
    stop: '停止本轮构建',
    waiting: '正在处理',
    emptyTitle: '开始一个新对话',
    emptyHint: '描述你想做的改动，或用 @ 指一门课堂',
  },
  question: {
    waiting: '等你回答',
    answered: '已回答',
    revive: '回到回答表单',
    multiHint: '可多选，选好后点「确认」',
    other: '其他…',
    keyHint: '↑↓ 选择 · Enter 确认',
    placeholder: '写下你的回答',
    confirm: '确认',
    submit: '提交',
    dismiss: '放弃',
    inFormBelow: '在下方表单里回答',
    multiAnswerSeparator: '、',
  },
  material: {
    maxSelected: '一次最多选择 {{count}} 个材料',
    remove: '移除 {{name}}',
    removeFailed: '移除上传失败材料',
    uploadFailed: '{{name}} 上传失败，请重试',
  },
  skill: {
    listFailed: 'Skill 列表加载失败',
    contentLoadFailed: 'Skill 正文加载失败',
    settings: {
      menuLabel: 'skill 设置',
      title: 'skill 设置',
      description: '管理你的 skill：上传 zip 安装新的，下载已有的，或删除不再需要的。',
      upload: '上传 skill',
      uploadZip: '上传 zip 包',
      uploadFolder: '上传文件夹',
      officialDownload: 'OpenMAIC官方skill',
      officialDownloadDesc:
        '智能体引导式 SOP：将该skill导入其他智能体工作台，即可实现Live Demo 课堂生成、本地部署、密钥配置、课堂生成与二次开发等内容。',
      errNotZip: '只能上传 zip 包',
      errNoSkillMdZip: '压缩包里找不到 SKILL.md',
      errNoSkillMdFolder: '文件夹里找不到 SKILL.md',
      errNoName: 'SKILL.md 的 frontmatter 缺少 name',
      errDuplicate: '已有名为 {{name}} 的 skill，请改名后重试',
      errTimeout: '上传超时，请重试',
      errRejected: '服务端拒绝了这次上传',
      retry: '重试',
      mySkills: '我的 skill',
      builtinSkills: '内置 skill',
      emptyMySkills: '还没有自己的 skill——上传一个 zip，或在对话里让 agent 从历史创建。',
      newUpload: '新上传',
      refsNote: '· 含 {{count}} 个参考文档',
      downloadLabel: '下载',
      removeLabel: '删除',
      removeConfirm: '确定删除这个 skill？对话中它将不再可用。',
      cancel: '取消',
      confirmDelete: '删除',
    },
    title: {
      'build-personal-skill': '创建专属 Skill',
      'curriculum-planner': '系列课规划',
      'stage-dsl': '课堂文档结构',
      'deep-interactive': '深度交互',
      'deep-research': '深度调研',
      'k12-core-literacy-planning': '核心素养教学设计',
      'learning-to-learn': '学会学习（Learning to Learn）',
      'lecture-style': '大师讲授',
      'page-clone': '页面克隆',
      'pptx-import': 'PPT 导入',
      'pro-editing': '专业编辑',
      'slide-craft': '页面设计',
      'slide-dsl': '页面数据结构',
      'social-emotional-learning': '社会情感学习（SEL）',
      'stage-design': '课堂设计',
      'style-clone': '名师复刻',
      'teacher-style-clone': '名师风格',
      'understanding-by-design': '理解本位设计（UbD）',
      vocational: '职业实训',
      'workshop-style': '互动工作坊',
    },
  },
  thinking: {
    active: '思考中…',
    done: '已思考',
    doneWithDuration: '已思考 {{duration}}',
  },
  system: {
    technicalDetails: '技术详情',
    repeated: '相同提示连续出现 {{count}} 次',
    resumed: '已从中断处继续生成',
    recovering: '生成暂时中断，正在自动恢复',
    steerQueued: 'agent 会在当前这一步做完后回应你',
    runFailed: '本轮生成失败',
    retryHint: '可以再说一句让它重试',
    stopped: '本轮生成已停止',
    workerInterrupted: '被 worker 重启打断，这次调用没有产生结果；agent 会在新一次尝试里按需重发。',
    userStopped: '已被停止打断，这次调用没有产生结果。',
  },
  tool: {
    errorSeparator: '：',
    recoverySeparator: '；',
    listSeparator: '、',
    group: {
      tools: '{{count}} 个工具调用',
      skills: '{{count}} 个 skill',
      running: '执行中',
      error: '有错误',
      done: '已完成',
    },
    section: {
      input: '入参',
      error: '错误',
      result: '结果原文',
      outline: '大纲',
      process: '过程',
      truncated: '结果过长，已截断',
    },
    pageType: { quiz: '测验', practice: '实训', interactive: '互动', slide: '图文' },
    label: {
      listMaterials: '检查材料',
      extractMaterial: '解析材料',
      waitMaterials: '等待材料解析',
      readMaterial: '读取材料',
      useMaterialMedia: '复用媒体素材',
      searchMaterial: '搜索材料',
      clipAudio: '截取参考音频',
      registerVoice: '注册克隆音色',
      listVoices: '查看可用音色',
      webSearch: '联网搜索',
      fetchUrl: '抓取网页',
      readFile: '读取文件',
      loadSkill: '加载 skill',
      createSkillSaved: '已保存 Skill',
      createSkillFailed: '保存 Skill 失败',
      readSkill: '读取 Skill 原文',
      patchSkill: '编辑 Skill',
      searchClassrooms: '搜索课堂',
      readClassroom: '读取课堂',
      searchChats: '搜索对话',
      readChat: '读取对话',
      generateOutline: '规划课堂',
      generateScene: '生成页面',
      generateSceneOrder: '生成第 {{order}} 页',
      duplicateScene: '复制页面',
      generateActions: '生成旁白',
      generateActionsOrder: '生成第 {{order}} 页旁白',
      generateTts: '合成语音',
      generateTtsOrder: '合成第 {{order}} 页语音',
      generateImage: '生成插图',
      generateVideo: '生成视频',
      previewScene: '预览页面',
      readCourse: '读取课堂',
      patchCourse: '编辑课堂',
      grepCourse: '搜索课堂',
      editDeck: '调整页序',
      editPage: '编辑页面',
      listScenes: '检查当前课堂',
      generateRoster: '设计课堂角色',
      setRoster: '设定课堂角色',
      importPptx: '导入 PPT',
      askUser: '向你确认',
      createFolder: '新建文件夹',
      moveToFolder: '归入文件夹',
      listFolderCourses: '查看课堂目录',
      createStage: '新建课堂',
      renameStage: '重命名课堂',
      readStageOutline: '读取课堂大纲',
    },
    chip: {
      seconds: '{{count}} 秒',
      results: '{{count}} 条结果',
      grepHits: '{{count}} 处命中',
      untrustedSource: '来源不在本会话内',
      availableInNewSession: '可在新会话调用',
      records: '{{count}} 条',
      moreResults: '还有下一页',
      pages: '{{count}} 页',
      constraintViolations: '{{count}} 处不满足约束',
      reusedOutline: '沿用已有大纲',
      reviseAsDirected: '按指示修订',
      pageOrder: '第 {{order}} 页',
      duplicateExists: '副本已存在',
      actions: '{{count}} 个动作',
      voicedLines: '{{count}} 句配了音',
      unvoicedLines: '{{count}} 句没配上音',
      synthesizedLines: '{{count}} 句已合成',
      existingLines: '{{count}} 句本来就有',
      failedLines: '{{count}} 句失败',
      persistedPages: '已落库 {{count}} 页',
      missingPages: '缺 {{count}} 页',
      roles: '{{count}} 位角色',
      noVoices: '没有可用音色',
      notesPages: '{{count}} 页带讲稿',
      sourceTruncated: '原文件 {{count}} 页，已截断',
      truncated: '已截断',
      options: '{{count}} 个选项',
      courses: '{{count}} 个课堂',
      allCourses: '全部课堂',
      folderCourses: '某个文件夹内',
      reusedCourse: '沿用已建课堂',
      movedToFolder: '已归入文件夹',
    },
    error: {
      materialExtraction: '材料解析失败',
      listMaterials: '检查材料失败',
      readMaterial: '读取材料失败',
      searchMaterial: '搜索材料失败',
      clipAudio: '参考音频没能截取',
      registerVoice: '克隆音色没能注册',
      listVoices: '可用音色没能列出',
      webSearch: '搜索失败',
      fetchUrl: '网页没能抓取',
      readFile: '读取失败',
      loadSkill: '加载失败',
      createSkill: 'Skill 未保存',
      readSkill: 'Skill 读取失败',
      patchSkill: 'Skill 未修改',
      historyRead: '历史记录读取失败',
      generateOutline: '课堂没能规划出来',
      generateScene: '第 {{order}} 页没有写成',
      duplicateScene: '页面没能复制',
      generateActions: '旁白没能生成',
      noTtsProvider: '这台部署没有配置语音合成，这一页仍然没有声音',
      generateTts: '语音没能合成',
      generateImage: '插图没能生成',
      generateVideo: '视频没能生成',
      previewScene: '页面截图没能生成',
      readCourse: '读取课堂失败',
      patchCourse: '课堂没能改好',
      grepCourse: '搜索课堂失败',
      editPage: '没有改成',
      listScenes: '读取课堂失败',
      roster: '课堂角色没能定下来',
      importPptx: 'PPT 没能导入',
      askUser: '这个问题没能发出',
      createFolder: '文件夹没能建好',
      moveToFolder: '课堂没能归入文件夹',
      listFolderCourses: '课堂目录没能读出来',
      createStage: '课堂没能建好',
      renameStage: '课堂没能改名',
      readStageOutline: '课堂大纲没能读出来',
      generic: '调用失败',
    },
    progress: {
      scene: {
        prep: '锁定页面',
        content: '写内容',
        actions: '配动作',
        save: '落库',
        aligning: '正在对齐这一页',
        arrangingReturnedActions: '动作稿已返回，正在编排',
        arrangingActions: '正在编排课堂动作',
        layingOutReturnedContent: '版式稿已返回，正在落版',
        draftingContent: '正在起草页面内容',
        failed: '这一页没有写成',
        done: '页面已落库',
      },
      outline: {
        read: '读需求',
        plan: '规划结构',
        write: '写出大纲',
        reading: '正在读你的需求',
        ordering: '正在整理页序',
        planning: '正在规划课堂结构',
        failed: '大纲没有规划出来',
        done: '大纲已就绪',
      },
    },
  },
} as const satisfies LocaleShape<typeof workbenchEn>;

export type WorkbenchCopyKey = `workbench.${string}`;

export type WorkbenchTranslator = (
  key: WorkbenchCopyKey,
  options?: Record<string, unknown>,
) => string;

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

type WorkbenchResource = Record<string, unknown>;

/**
 * The other ten locales.
 *
 * `workbenchEn` is the shape and `workbenchZh` is its Chinese twin; every other
 * locale is a JSON overlay on one of those two, so a key that a locale has not
 * translated yet resolves to English (or, for `zh-TW`, to Simplified) instead of
 * to the key. Same precedence as i18next applies to `live-locales/*.json`, which
 * is what keeps the hook-free translator below and the React `t` in agreement.
 */
const localeOverrides: Record<string, WorkbenchResource> = {
  'zh-TW': workbenchZhTW,
  'ja-JP': workbenchJaJP,
  'ko-KR': workbenchKoKR,
  'de-DE': workbenchDeDE,
  'fr-FR': workbenchFrFR,
  'es-MX': workbenchEsMX,
  'pt-BR': workbenchPtBR,
  'ru-RU': workbenchRuRU,
  'ar-SA': workbenchArSA,
  'vi-VN': workbenchViVN,
};

function isRecord(value: unknown): value is WorkbenchResource {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeResource(base: WorkbenchResource, overlay: WorkbenchResource): WorkbenchResource {
  const result: WorkbenchResource = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] =
      isRecord(value) && isRecord(result[key])
        ? mergeResource(result[key] as WorkbenchResource, value)
        : value;
  }
  return result;
}

const resourceCache = new Map<string, WorkbenchResource>();

/**
 * The whole workbench copy map for one locale — the resource i18next registers
 * under `workbench.*` and the table the hook-free translator reads.
 */
export function workbenchResourceFor(locale: string): WorkbenchResource {
  const cached = resourceCache.get(locale);
  if (cached) return cached;
  const base: WorkbenchResource = locale.toLowerCase().startsWith('zh') ? workbenchZh : workbenchEn;
  const overlay = localeOverrides[locale];
  const resource = overlay ? mergeResource(base, overlay) : base;
  resourceCache.set(locale, resource);
  return resource;
}

/** Hook-free translator for pure presentation helpers and unit tests. */
export function createWorkbenchTranslator(locale: string): WorkbenchTranslator {
  const resource = workbenchResourceFor(locale);
  return (key, options) => {
    const path = key.replace(/^workbench\./, '').split('.');
    const value = readPath(resource, path);
    if (typeof value !== 'string') return key;
    return value.replace(/{{(\w+)}}/g, (_, name: string) => String(options?.[name] ?? ''));
  };
}

export const defaultWorkbenchTranslator = createWorkbenchTranslator('zh-CN');
