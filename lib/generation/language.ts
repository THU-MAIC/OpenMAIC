export type SupportedGenerationLanguage = 'zh-CN' | 'en-US' | 'ru-RU';

export interface GenerationLanguageSpec {
  code: SupportedGenerationLanguage;
  englishName: string;
  nativeName: string;
  noImagesAvailableText: string;
  noneText: string;
  noImagesForSlideText: string;
  autoGenerateElementsText: string;
  slideFocusTitle: string;
  slideSpeechTitle: string;
  slideSpeechFallback: string;
  quizGuideTitle: string;
  quizGuideText: string;
  interactiveGuideTitle: string;
  interactiveGuideText: string;
  pblIntroTitle: string;
  pblIntroText: string;
}

const SPECS: Record<SupportedGenerationLanguage, GenerationLanguageSpec> = {
  'zh-CN': {
    code: 'zh-CN',
    englishName: 'Chinese',
    nativeName: '中文',
    noImagesAvailableText: '无可用图片',
    noneText: '无',
    noImagesForSlideText: '无可用图片，禁止插入任何 image 元素',
    autoGenerateElementsText: '（根据要点自动生成）',
    slideFocusTitle: '聚焦重点',
    slideSpeechTitle: '场景讲解',
    slideSpeechFallback: '请先关注这一页的核心要点。',
    quizGuideTitle: '测验引导',
    quizGuideText: '现在让我们来做一个小测验，检验一下学习成果。',
    interactiveGuideTitle: '交互引导',
    interactiveGuideText:
      '现在让我们通过交互式可视化来探索这个概念。请尝试操作页面中的元素，观察变化。',
    pblIntroTitle: 'PBL 项目介绍',
    pblIntroText:
      '现在让我们开始一个项目式学习活动。请选择你的角色，查看任务看板，开始协作完成项目。',
  },
  'en-US': {
    code: 'en-US',
    englishName: 'English',
    nativeName: 'English',
    noImagesAvailableText: 'No images available',
    noneText: 'None',
    noImagesForSlideText: 'No images available. Do not insert any image elements.',
    autoGenerateElementsText: '(generate automatically from the key points)',
    slideFocusTitle: 'Focus on the key point',
    slideSpeechTitle: 'Scene explanation',
    slideSpeechFallback: "Let's focus on the key ideas on this page first.",
    quizGuideTitle: 'Quiz guidance',
    quizGuideText: "Let's do a short quiz now to check what we have learned.",
    interactiveGuideTitle: 'Interactive guidance',
    interactiveGuideText:
      "Now let's explore this concept through an interactive visualization. Try the controls on the page and observe what changes.",
    pblIntroTitle: 'PBL project introduction',
    pblIntroText:
      "Now let's begin a project-based learning activity. Choose your role, review the task board, and start collaborating on the project.",
  },
  'ru-RU': {
    code: 'ru-RU',
    englishName: 'Russian',
    nativeName: 'Русский',
    noImagesAvailableText: 'Нет доступных изображений',
    noneText: 'Нет',
    noImagesForSlideText: 'Нет доступных изображений. Не вставляй элементы image.',
    autoGenerateElementsText: 'сгенерируй автоматически по ключевым пунктам',
    slideFocusTitle: 'Фокус на главном',
    slideSpeechTitle: 'Объяснение сцены',
    slideSpeechFallback: 'Сначала разберём ключевые идеи этой страницы.',
    quizGuideTitle: 'Введение к квизу',
    quizGuideText: 'Сейчас сделаем короткий квиз, чтобы проверить, что уже усвоили.',
    interactiveGuideTitle: 'Введение к интерактиву',
    interactiveGuideText:
      'Теперь давай разберём этот концепт через интерактивную визуализацию. Попробуй элементы управления на странице и посмотри, что меняется.',
    pblIntroTitle: 'Введение в PBL-проект',
    pblIntroText:
      'Теперь начинаем проектное задание. Выбери роль, посмотри на доску задач и приступай к совместной работе над проектом.',
  },
};

export function normalizeGenerationLanguage(language?: string): SupportedGenerationLanguage {
  const normalized = (language || '').trim().toLowerCase();

  if (normalized.startsWith('ru')) return 'ru-RU';
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized.startsWith('zh')) return 'zh-CN';

  return 'zh-CN';
}

export function getGenerationLanguageSpec(language?: string): GenerationLanguageSpec {
  return SPECS[normalizeGenerationLanguage(language)];
}

export function buildLanguageInstruction(language?: string): string {
  const spec = getGenerationLanguageSpec(language);

  return [
    `Output language must be ${spec.englishName} (${spec.nativeName}).`,
    `All natural-language text, titles, explanations, quiz text, hints, labels, and UI copy must be in ${spec.englishName}.`,
    spec.code === 'ru-RU'
      ? 'English is allowed only for code, SQL keywords, API field names, or other technical syntax that must remain unchanged.'
      : 'Keep technical syntax unchanged only when necessary.',
    spec.code === 'ru-RU'
      ? 'Never output Chinese.'
      : 'Do not switch to another language unless the user explicitly asks for it.',
  ].join(' ');
}
