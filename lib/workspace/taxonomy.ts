export interface CourseTaxonomyItem {
  id: string;
  label: string;
  description: string;
  keywords?: string[];
}

export const SUBJECT_CATEGORIES: CourseTaxonomyItem[] = [
  { id: 'chinese', label: '语文与阅读', description: '语言文字、文学阅读与表达' },
  { id: 'mathematics', label: '数学', description: '数与代数、几何、统计与建模' },
  { id: 'foreign-language', label: '外语', description: '英语及其他语言的综合学习' },
  { id: 'physics', label: '物理', description: '力学、电磁学、热学与现代物理' },
  { id: 'chemistry', label: '化学', description: '物质结构、反应规律与实验探究' },
  { id: 'biology', label: '生物与生命科学', description: '生命系统、遗传、生态与健康' },
  { id: 'civics', label: '道德与法治 / 思政', description: '公民素养、法治教育与思想政治' },
  { id: 'history', label: '历史', description: '中国史、世界史与历史解释' },
  { id: 'geography', label: '地理', description: '自然地理、人文地理与区域认知' },
  { id: 'computing', label: '信息科技 / 计算机', description: '数字技能、编程与计算思维' },
  { id: 'engineering', label: '通用技术 / 工程', description: '工程设计、技术实践与创造' },
  { id: 'arts', label: '艺术', description: '音乐、美术、戏剧与审美表达' },
  { id: 'physical-health', label: '体育与健康', description: '运动技能、体能与健康教育' },
  { id: 'practice', label: '劳动与综合实践', description: '劳动教育、跨学科与综合实践' },
  { id: 'vocational', label: '职业教育', description: '专业技能、实训与职业素养' },
  { id: 'higher-education', label: '高等教育 / 专业基础', description: '本科与成人教育专业基础课' },
];

export const EXTRACURRICULAR_CATEGORIES: CourseTaxonomyItem[] = [
  { id: 'science-exploration', label: '科学探索', description: '从现象出发理解科学世界' },
  { id: 'humanities-history', label: '人文历史', description: '人物、文明、思想与文化传统' },
  { id: 'society-citizenship', label: '社会与公民', description: '社会议题、公共生活与责任' },
  { id: 'language-culture', label: '语言与文化', description: '跨文化理解与语言兴趣' },
  { id: 'creative-arts', label: '艺术创作', description: '视觉、音乐、表演与创意表达' },
  { id: 'digital-ai', label: '数字素养与 AI', description: '人工智能、媒介与信息素养' },
  { id: 'maker-programming', label: '工程、创客与编程', description: '动手创造、程序设计与机器人' },
  { id: 'business-finance', label: '财经与商业', description: '经济常识、商业与财务素养' },
  { id: 'health-psychology', label: '健康与心理', description: '身心健康、关系与自我成长' },
  {
    id: 'nature-environment',
    label: '自然、生态与环境',
    description: '自然观察、生态系统与可持续发展',
  },
  { id: 'life-safety', label: '生活技能与安全', description: '日常生活、应急与安全教育' },
  { id: 'career', label: '职业启蒙与生涯发展', description: '职业认知、优势探索与生涯规划' },
  { id: 'hobbies', label: '兴趣、游戏与休闲', description: '兴趣发展、益智游戏与休闲知识' },
  { id: 'frontiers', label: '热点专题 / 前沿知识', description: '现实议题、科技进展与跨界新知' },
];

export const GRADE_BANDS = [
  '学前',
  '小学低年级',
  '小学高年级',
  '初中',
  '高中',
  '中职',
  '高职',
  '本科',
  '成人学习',
];

export const COURSE_TYPES = ['讲授课', '复习课', '实验课', '测验课', '项目课', '研学课'];

export function taxonomyForDomain(domain: 'subject' | 'extracurricular') {
  return domain === 'subject' ? SUBJECT_CATEGORIES : EXTRACURRICULAR_CATEGORIES;
}

export function findTaxonomyItem(idOrLabel?: string) {
  if (!idOrLabel) return undefined;
  return [...SUBJECT_CATEGORIES, ...EXTRACURRICULAR_CATEGORIES].find(
    (item) => item.id === idOrLabel || item.label === idOrLabel,
  );
}
