/**
 * Jupyter Notebook 导出核心工具
 */

import { buildExperimentCode } from './experiment-code';

export interface NotebookCell {
  cell_type: 'markdown' | 'code';
  metadata: Record<string, unknown>;
  source: string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

export interface JupyterNotebook {
  cells: NotebookCell[];
  metadata: {
    language_info: {
      name: string;
      version?: string;
    };
    kernelspec?: {
      display_name: string;
      language: string;
      name: string;
    };
    orig_nbformat: number;
  };
  nbformat: number;
  nbformat_minor: number;
}

export interface NotebookOutlineInput {
  title?: string;
  description?: string;
  keyPoints?: string[];
  widgetType?: string;
  widgetOutline?: { language?: string };
  interactiveConfig?: unknown;
}

function toCellSource(code: string): string[] {
  const lines = code.split('\n');
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

/**
 * 将课程/大纲数据转换为标准 .ipynb 格式
 */
export function buildJupyterNotebook(data: {
  title?: string;
  outlines?: NotebookOutlineInput[];
}): JupyterNotebook {
  const cells: NotebookCell[] = [];

  // 1. 顶部课程标题与简介 (Markdown Cell)
  cells.push({
    cell_type: 'markdown',
    metadata: {},
    source: [
      `# ${data.title || '交互式生成课程'}\n`,
      `*本课件由 OpenMAIC 多智能体交互课堂自动生成与导出*\n`,
      `本 Notebook 的实验代码只依赖 NumPy 与 Matplotlib；每个代码单元都可以独立运行。\n`,
      `---\n`,
    ],
  });

  // 2. 遍历大纲节点，分别生成说明单元格与代码/交互单元格
  if (data.outlines && data.outlines.length > 0) {
    data.outlines.forEach((item, index) => {
      const experiment = buildExperimentCode({
        title: item.title,
        description: item.description,
        keyPoints: item.keyPoints,
        widgetType: item.widgetType,
        language: item.widgetOutline?.language,
      });

      // 理论与指引 Cell：让学生在运行代码前知道实验目标、原理和判分契约。
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: [
          `## 第 ${index + 1} 节：${item.title || '章节'}\n`,
          `${item.description || '暂无描述'}\n`,
          `\n### 实验目标\n${experiment.objective}\n`,
          `\n### 原理说明\n${experiment.principle}\n`,
          `\n### 任务提示\n${experiment.task}\n`,
          `\n### 断言判分规则\n${experiment.assertionRules.map((rule) => `- ${rule}`).join('\n')}\n`,
        ],
      });

      // 实验交互代码 Cell：直接运行即可生成彩色时域/频域图表。
      cells.push({
        cell_type: 'code',
        metadata: { tags: ['experiment'] },
        execution_count: null,
        outputs: [],
        source: toCellSource(experiment.code),
      });

      // 练习与断言判分 Cell：保留 TODO，但提供可运行的默认骨架；学生
      // 修改算法后再次运行即可由 assert 判断是否满足实验契约。
      cells.push({
        cell_type: 'code',
        metadata: { tags: ['exercise', 'assertions'] },
        execution_count: null,
        outputs: [],
        source: toCellSource(experiment.exerciseCode),
      });
    });
  }

  return {
    cells,
    metadata: {
      language_info: {
        name: 'python',
        version: '3.10',
      },
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      orig_nbformat: 4,
    },
    nbformat: 4,
    nbformat_minor: 2,
  };
}

/**
 * 触发浏览器端下载 .ipynb 文件
 */
export function downloadNotebook(notebook: JupyterNotebook, filename = 'course.ipynb') {
  const jsonStr = JSON.stringify(notebook, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/x-ipynb+json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.ipynb') ? filename : `${filename}.ipynb`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
