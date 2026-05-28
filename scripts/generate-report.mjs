/**
 * OpenMAIC 项目改进报告 - PPT 生成脚本
 *
 * 运行方式: node scripts/generate-report.mjs
 * 输出: docs/OpenMAIC_Improvement_Report.pptx
 */

import PptxGenJS from 'pptxgenjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pptx = new PptxGenJS();

// 设置演示文稿属性
pptx.author = 'Kevin7012';
pptx.title = 'OpenMAIC 项目改进报告';
pptx.subject = 'TXT/DOCX 文件上传支持';
pptx.company = 'OpenMAIC';

// 定义颜色方案
const colors = {
  primary: '6366F1',    // 紫色
  secondary: '8B5CF6',  // 浅紫色
  accent: 'F59E0B',     // 橙色
  text: '1F2937',       // 深灰色
  muted: '6B7280',      // 中灰色
  white: 'FFFFFF',
  bgLight: 'F3F4F6',
};

// 定义布局
const TITLE_SLIDE_LAYOUT = 'title';
const CONTENT_SLIDE_LAYOUT = 'content';

// ==================== 封面页 ====================
const slide1 = pptx.addSlide({ background: { color: colors.primary } });
slide1.addText('OpenMAIC 项目改进报告', {
  x: 1, y: 2.5, w: 8, h: 1.2,
  fontSize: 44,
  bold: true,
  color: colors.white,
  align: 'center',
});
slide1.addText('支持 TXT 和 DOCX 文件上传', {
  x: 1, y: 4, w: 8, h: 0.6,
  fontSize: 24,
  color: colors.white,
  align: 'center',
});
slide1.addText('Kevin7012 | 2026年5月', {
  x: 1, y: 5, w: 8, h: 0.4,
  fontSize: 16,
  color: colors.white,
  align: 'center',
});

// ==================== 目录页 ====================
const slide2 = pptx.addSlide();
slide2.addText('目录', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

const tocItems = [
  '1. 项目背景与目标',
  '2. 核心改进：多格式支持',
  '3. UI/国际化更新',
  '4. Bug 修复',
  '5. 构建修复',
  '6. 修改统计',
  '7. 提交与 PR 状态',
];
tocItems.forEach((item, i) => {
  slide2.addText(item, {
    x: 1, y: 1.5 + i * 0.7, w: 8, h: 0.6,
    fontSize: 20,
    color: colors.text,
  });
});

// ==================== 项目背景页 ====================
const slide3 = pptx.addSlide();
slide3.addText('1. 项目背景与目标', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide3.addText('OpenMAIC', {
  x: 0.5, y: 1.5, w: 9, h: 0.6,
  fontSize: 18, bold: true, color: colors.text,
});
slide3.addText('由清华大学团队开发的 AI 生成式课件系统，支持从教材、PDF 等文档自动生成交互式课堂。', {
  x: 0.5, y: 2.1, w: 9, h: 1,
  fontSize: 14, color: colors.muted,
});

slide3.addText('改进目标', {
  x: 0.5, y: 3.2, w: 9, h: 0.6,
  fontSize: 18, bold: true, color: colors.text,
});
slide3.addText('在原有仅支持 PDF 的基础上，新增 TXT 和 DOCX 两种常见文档格式的支持，提升系统易用性。', {
  x: 0.5, y: 3.8, w: 9, h: 1,
  fontSize: 14, color: colors.muted,
});

// ==================== 核心改进页 ====================
const slide4 = pptx.addSlide();
slide4.addText('2. 核心改进：多格式支持', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide4.addText('支持的文档格式', {
  x: 0.5, y: 1.5, w: 4.5, h: 0.5,
  fontSize: 16, bold: true, color: colors.text,
});
const formats = [
  '✓ PDF（原有功能，保留）',
  '✓ TXT（新增）',
  '✓ DOCX（新增）',
];
formats.forEach((f, i) => {
  slide4.addText(f, { x: 0.5, y: 2 + i * 0.5, w: 4.5, h: 0.4, fontSize: 14, color: colors.text });
});

slide4.addText('新增依赖', {
  x: 5, y: 1.5, w: 4.5, h: 0.5,
  fontSize: 16, bold: true, color: colors.text,
});
slide4.addText('mammoth@1.12.0', {
  x: 5, y: 2, w: 4.5, h: 0.4,
  fontSize: 14, color: colors.accent,
});
slide4.addText('用于 DOCX 文件的文本提取', {
  x: 5, y: 2.4, w: 4.5, h: 0.4,
  fontSize: 12, color: colors.muted, italic: true,
});

// ==================== 核心改进详情页 ====================
const slide5 = pptx.addSlide();
slide5.addText('2.1 技术架构', { x: 0.5, y: 0.5, w: 9, h: 0.6, fontSize: 24, bold: true, color: colors.primary });

slide5.addText('lib/document-parser.ts', {
  x: 0.5, y: 1.3, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});

const archItems = [
  'detectDocumentType() - 通过 MIME 类型和扩展名识别文件类型',
  'parseDocument() - 统一的文档解析入口（工厂模式）',
  'parseTxt() - TXT 解析：Buffer → UTF-8 字符串',
  'parseDocx() - DOCX 解析：使用 mammoth 提取纯文本',
  'parsePDF() - 复用原有的 PDF 解析逻辑',
];
archItems.forEach((item, i) => {
  slide5.addText(item, {
    x: 0.7, y: 1.9 + i * 0.55, w: 8.5, h: 0.45,
    fontSize: 12, color: colors.text,
  });
});

// ==================== UI/国际化页 ====================
const slide6 = pptx.addSlide();
slide6.addText('3. UI/国际化更新', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide6.addText('所有界面中的"PDF"相关文案改为通用的"文档"表述', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 14, color: colors.muted,
});

const i18nLangs = ['简体中文 (zh-CN)', '繁體中文 (zh-TW)', 'English (en-US)', '日本語 (ja-JP)', 'العربية (ar-SA)', 'Русский (ru-RU)'];
i18nLangs.forEach((lang, i) => {
  slide6.addText(lang, {
    x: 0.7, y: 2.2 + i * 0.6, w: 5, h: 0.4,
    fontSize: 12, color: colors.text,
  });
});

slide6.addText('✓ 6种语言同步更新', {
  x: 5.5, y: 2.2, w: 4, h: 0.4,
  fontSize: 12, color: colors.primary,
});

// ==================== UI 变更示例页 ====================
const slide7 = pptx.addSlide();
slide7.addText('3.1 UI 变更示例', { x: 0.5, y: 0.5, w: 9, h: 0.6, fontSize: 24, bold: true, color: colors.primary });

slide7.addText('原文案 → 新文案', {
  x: 0.5, y: 1.3, w: 9, h: 0.4,
  fontSize: 14, bold: true, color: colors.text,
});

const uiExamples = [
  '上传 PDF → 上传文档',
  '支持最大50MB的PDF文件 → 支持最大50MB的文档文件（PDF/TXT/DOCX）',
  '解析 PDF 文档 → 解析文档',
  '无法加载 PDF 文件 → 无法加载文档文件',
  'PDF 解析失败 → 文档解析失败',
  'PDF Parsing → Document Parsing',
];
uiExamples.forEach((ex, i) => {
  slide7.addText(ex, {
    x: 0.7, y: 1.9 + i * 0.5, w: 8.6, h: 0.4,
    fontSize: 11, color: colors.text,
  });
});

// ==================== Bug 修复页 ====================
const slide8 = pptx.addSlide();
slide8.addText('4. Bug 修复', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide8.addText('问题：场景 ID 重复', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide8.addText('当 AI 生成的大纲数量超过约10个时，会出现重复的 scene_3 等 ID，导致 React 渲染警告。', {
  x: 0.5, y: 2.1, w: 9, h: 0.8,
  fontSize: 13, color: colors.muted,
});

slide8.addText('修复方案', {
  x: 0.5, y: 3.2, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide8.addText('文件: app/generation-preview/components/visualizers.tsx:321', {
  x: 0.5, y: 3.8, w: 9, h: 0.4,
  fontSize: 13, color: colors.text,
});
slide8.addText('使用复合 key `${outline.id}-${i}` 替代单一的 `outline.id`', {
  x: 0.5, y: 4.3, w: 9, h: 0.5,
  fontSize: 13, color: colors.text,
});

// ==================== 构建修复页 ====================
const slide9 = pptx.addSlide();
slide5.addText('5. 构建修复', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide9.addText('问题描述', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide9.addText('rollup-plugin-typescript2@0.36.0 与 TypeScript 5.x 不兼容，导致项目构建失败。', {
  x: 0.5, y: 2.1, w: 9, h: 0.8,
  fontSize: 13, color: colors.muted,
});

slide9.addText('修复方案', {
  x: 0.5, y: 3.2, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide9.addText('packages/pptxgenjs/:', {
  x: 0.5, y: 3.8, w: 9, h: 0.4,
  fontSize: 14, bold: true, color: colors.text,
});
slide9.addText('• package.json: 替换为 @rollup/plugin-typescript@^12', {
  x: 0.7, y: 4.2, w: 8.5, h: 0.35,
  fontSize: 12, color: colors.text,
});
slide9.addText('• rollup.config.mjs: 更新插件配置', {
  x: 0.7, y: 4.55, w: 8.5, h: 0.35,
  fontSize: 12, color: colors.text,
});
slide9.addText('• tsconfig.json: 调整编译选项（module: ESNext, declaration: false）', {
  x: 0.7, y: 4.9, w: 8.5, h: 0.35,
  fontSize: 12, color: colors.text,
});

// ==================== 修改统计页 ====================
const slide10 = pptx.addSlide();
slide10.addText('6. 修改统计', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide10.addText('修改文件数：15 个', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 18, color: colors.text,
});
slide10.addText('新增代码行：211 行', {
  x: 0.5, y: 2.1, w: 9, h: 0.5,
  fontSize: 18, color: colors.text,
});
slide10.addText('删除代码行：80 行', {
  x: 0.5, y: 2.7, w: 9, h: 0.5,
  fontSize: 18, color: colors.text,
});
slide10.addText('净增行数：+131 行', {
  x: 0.5, y: 3.3, w: 9, h: 0.6,
  fontSize: 20, bold: true, color: colors.primary,
});

slide10.addText('主要文件变更', {
  x: 0.5, y: 4.2, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.text,
});
slide10.addText('lib/document-parser.ts (+104), components/generation/*.tsx (+32), API路由 (+43), i18n文件 (+14×6)', {
  x: 0.5, y: 4.8, w: 9, h: 0.6,
  fontSize: 11, color: colors.muted,
});

// ==================== Git 提交历史页 ====================
const slide11 = pptx.addSlide();
slide11.addText('7. Git 提交历史', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide11.addText('dev-modifications 分支', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});

const commits = [
  { hash: '5c6d6bb', msg: 'fix(pptxgenjs): replace rollup-plugin-typescript2...' },
  { hash: 'b1e968b', msg: 'feat: add support for TXT and DOCX file uploads' },
  { hash: '4c652ef', msg: 'fix: deduplicate scene key in outlines visualizer' },
];
commits.forEach((c, i) => {
  slide11.addText(c.hash, {
    x: 0.7, y: 2.2 + i * 0.8, w: 1.2, h: 0.4,
    fontSize: 11, color: colors.primary, bold: true,
  });
  slide11.addText(c.msg, {
    x: 2, y: 2.2 + i * 0.8, w: 7.3, h: 0.4,
    fontSize: 11, color: colors.text,
  });
});

// ==================== PR 状态页 ====================
const slide12 = pptx.addSlide();
slide12.addText('7. PR 状态', { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 32, bold: true, color: colors.primary });

slide12.addText('分支推送成功 ✓', {
  x: 0.5, y: 1.5, w: 9, h: 0.5,
  fontSize: 16, color: colors.primary,
});
slide12.addText('dev-modifications → Kevin7012/OpenMAIC', {
  x: 0.5, y: 2.1, w: 9, h: 0.4,
  fontSize: 13, color: colors.muted,
});

slide12.addText('Pull Request', {
  x: 0.5, y: 2.8, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide12.addText('https://github.com/Kevin7012/OpenMAIC/pull/1', {
  x: 0.5, y: 3.4, w: 9, h: 0.4,
  fontSize: 13, color: colors.text, underline: true,
});

slide12.addText('当前状态', {
  x: 0.5, y: 4.2, w: 9, h: 0.5,
  fontSize: 16, bold: true, color: colors.accent,
});
slide12.addText('• CI 检查：Lint 通过，TypeScript 通过，i18n 检查通过', {
  x: 0.7, y: 4.8, w: 8.5, h: 0.4,
  fontSize: 12, color: colors.text,
});
slide12.addText('• 待审核：等待上游维护者审核（需要至少 1 位有写权限的 reviewer 批准）', {
  x: 0.7, y: 5.2, w: 8.5, h: 0.4,
  fontSize: 12, color: colors.text,
});

// ==================== 总结页 ====================
const slide13 = pptx.addSlide({ background: { color: colors.primary } });
slide13.addText('总结', {
  x: 1, y: 1.5, w: 8, h: 1,
  fontSize: 36, bold: true, color: colors.white, align: 'center',
});
slide13.addText('• 新增 TXT/DOCX 文件支持，大幅提升易用性', {
  x: 1, y: 3, w: 8, h: 0.5,
  fontSize: 18, color: colors.white, align: 'center',
});
slide13.addText('• UI 文案通用化，支持 6 种语言', {
  x: 1, y: 3.6, w: 8, h: 0.5,
  fontSize: 18, color: colors.white, align: 'center',
});
slide13.addText('• 修复构建问题和 React key 重复警告', {
  x: 1, y: 4.2, w: 8, h: 0.5,
  fontSize: 18, color: colors.white, align: 'center',
});
slide13.addText('• PR 已提交，等待上游审核', {
  x: 1, y: 4.8, w: 8, h: 0.5,
  fontSize: 18, color: colors.white, align: 'center',
});

// ==================== 谢谢页 ====================
const slide14 = pptx.addSlide({ background: { color: colors.primary } });
slide14.addText('谢谢！', {
  x: 1, y: 2.5, w: 8, h: 1.5,
  fontSize: 48, bold: true, color: colors.white, align: 'center',
});
slide14.addText('GitHub: Kevin7012', {
  x: 1, y: 4.5, w: 8, h: 0.5,
  fontSize: 20, color: colors.white, align: 'center',
});

// 生成 PPT 文件
const outputPath = path.resolve(__dirname, '../docs/OpenMAIC_Improvement_Report.pptx');
pptx.writeFile({ fileName: outputPath })
  .then(() => {
    console.log(`PPT 报告已生成: ${outputPath}`);
  })
  .catch((err) => {
    console.error('生成失败:', err);
    process.exit(1);
  });