import { describe, expect, it } from 'vitest';

import { detectDocumentStructureTransform } from '@/lib/document';
import type { DocumentArtifact } from '@/lib/document';

const context = {
  purpose: 'course-generation' as const,
  budget: { maxTextChars: 50_000, maxVisionImages: 20 },
};

describe('document structure transform', () => {
  it('preserves a provider-supplied outline', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'chapter', type: 'text', text: 'Provider chapter' }],
      assets: [],
      outline: [
        {
          id: 'provider-node',
          title: 'Provider chapter',
          level: 1,
          order: 1,
          blockIds: ['chapter'],
          confidence: 1,
          source: 'provider',
        },
      ],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);
    expect(output.status).toBe('skipped');
    expect(output.artifact.outline).toEqual(input.outline);
  });

  it('detects nested Markdown headings with offsets and parent relationships', async () => {
    const input: DocumentArtifact = {
      metadata: { fileName: 'book.md' },
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Safety\n\nIntroduction\n\n## Inspection\n\nCheck the machine.',
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline).toHaveLength(2);
    expect(output.artifact.outline?.[0]).toMatchObject({
      title: 'Safety',
      level: 1,
      blockIds: ['markdown'],
      startOffset: 0,
      source: 'heading',
    });
    expect(output.artifact.outline?.[0].endOffset).toBe(
      input.blocks[0].text?.indexOf('## Inspection'),
    );
    expect(output.artifact.outline?.[1]).toMatchObject({
      title: 'Inspection',
      level: 2,
      parentId: 'outline_1',
      blockIds: ['markdown'],
    });
    expect(output.artifact.outline?.[1].endOffset).toBe(input.blocks[0].text?.length);
  });

  it('stops a parent heading at the next child heading in the same block', async () => {
    const text = '# Intro\n\nOverview\n\n## Details\n\nSpecifics';
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'markdown', type: 'markdown', text }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.[0]).toMatchObject({
      startOffset: 0,
      endOffset: text.indexOf('## Details'),
    });
    expect(output.artifact.outline?.[1]).toMatchObject({
      startOffset: text.indexOf('## Details'),
      endOffset: text.length,
    });
  });

  it('assigns a level-skipping heading to the nearest shallower ancestor', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Root\n\nIntro\n\n### Deep section\n\nDetails',
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.[1]).toMatchObject({
      title: 'Deep section',
      level: 3,
      parentId: 'outline_1',
    });
  });

  it('uses explicit extractor heading metadata before text heuristics', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'title',
          type: 'layout',
          text: 'Machine Setup',
          pageNumber: 2,
          metadata: { headingLevel: 2, layoutType: 'heading' },
        },
        { id: 'body', type: 'text', text: 'Install the guard before startup.', pageNumber: 3 },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);
    expect(output.artifact.outline?.[0]).toMatchObject({
      title: 'Machine Setup',
      level: 2,
      pageStart: 2,
      pageEnd: 3,
      blockIds: ['title', 'body'],
      confidence: 1,
      source: 'provider',
    });
  });

  it('does not let unlevelled layout titles flatten richer Markdown headings', async () => {
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [
        {
          id: 'markdown',
          type: 'markdown',
          text: '# Root\n\nOverview\n\n## Child\n\nDetails',
        },
        {
          id: 'layout-title',
          type: 'layout',
          text: 'Root',
          metadata: { layoutType: 'title' },
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(
      output.artifact.outline?.map(({ title, level, source }) => ({ title, level, source })),
    ).toEqual([
      { title: 'Root', level: 1, source: 'heading' },
      { title: 'Child', level: 2, source: 'heading' },
    ]);
  });

  it('keeps numbered sections that are missing from partial provider headings', async () => {
    const articles = [
      '第一条 租赁标的',
      '第二条 租赁期限',
      '第三条 租金',
      '第四条 押金',
      '第五条 房屋交付',
      '第六条 使用要求',
      '第七条 维修责任',
      '第八条 转租限制',
      '第九条 费用承担',
      '第十条 房屋返还',
      '第十一条 提前解除',
      '第十二条 违约责任',
      '第十三条 通知送达',
      '第十四条 争议解决',
      '第十五条 合同生效',
      '第十六条 补充协议',
      '第十七条 合同份数',
      '第十八条 其他约定',
    ];
    const providerArticleIndexes = new Set([0, 1, 2, 3, 4, 5, 6, 15, 16, 17]);
    const input: DocumentArtifact = {
      metadata: { pageCount: 8, providerId: 'alidocmind' },
      blocks: [
        {
          id: 'document-text',
          type: 'markdown',
          text: ['# 房屋租赁合同', ...articles].join('\n\n'),
        },
        {
          id: 'provider-title',
          type: 'layout',
          text: '房屋租赁合同',
          pageNumber: 1,
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
        ...articles
          .map((title, index) => ({ title, index }))
          .filter(({ index }) => providerArticleIndexes.has(index))
          .map(({ title, index }) => ({
            id: `provider-article-${index + 1}`,
            type: 'layout' as const,
            text: title,
            pageNumber: Math.floor(index / 3) + 1,
            metadata: { layoutType: 'title', headingLevel: 2 },
          })),
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline).toHaveLength(19);
    expect(output.artifact.outline?.map((node) => node.title)).toEqual([
      '房屋租赁合同',
      ...articles,
    ]);
    expect(output.artifact.outline?.slice(8, 16).map((node) => node.source)).toEqual(
      Array(8).fill('heuristic'),
    );
    expect(output.artifact.outline?.slice(1).every((node) => node.level === 2)).toBe(true);
    expect(output.diagnostics?.[0].metadata).toMatchObject({
      strategy: 'hybrid',
      providerHeadingCount: 11,
      textHeadingCount: 19,
      matchedHeadingCount: 11,
      unmatchedTextHeadingCount: 8,
    });
    expect(output.diagnostics?.[1]).toMatchObject({
      severity: 'warning',
      metadata: { retainedTextHeadingCount: 8 },
    });
  });

  it('keeps distinct same-name provider sections when page numbers are unavailable', async () => {
    const input: DocumentArtifact = {
      metadata: {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      blocks: [
        {
          id: 'summary-1',
          type: 'layout',
          text: 'Summary',
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
        { id: 'body', type: 'layout', text: 'First summary body.' },
        {
          id: 'summary-2',
          type: 'layout',
          text: 'Summary',
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.map((node) => node.title)).toEqual(['Summary', 'Summary']);
  });

  it('removes a provider running title repeated across most document pages', async () => {
    const blocks: DocumentArtifact['blocks'] = [];
    for (let page = 1; page <= 4; page += 1) {
      blocks.push(
        {
          id: `running-${page}`,
          type: 'layout',
          text: 'Annual Report',
          pageNumber: page,
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
        {
          id: `section-${page}`,
          type: 'layout',
          text: `Section ${page}`,
          pageNumber: page,
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
      );
    }
    const input: DocumentArtifact = {
      metadata: { pageCount: 4 },
      blocks,
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.map((node) => node.title)).toEqual([
      'Section 1',
      'Section 2',
      'Section 3',
      'Section 4',
    ]);
    expect(output.diagnostics?.[0].metadata?.repeatedRunningHeadingsRemoved).toBe(4);
  });

  it('rejects sentence-like body paragraphs mislabeled as DOCX titles', async () => {
    const input: DocumentArtifact = {
      metadata: {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      blocks: [
        {
          id: 'heading',
          type: 'layout',
          text: 'Agreement Terms',
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
        {
          id: 'body-as-title',
          type: 'layout',
          text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod.',
          metadata: { layoutType: 'title', headingLevel: 1 },
        },
      ],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.map((node) => node.title)).toEqual(['Agreement Terms']);
  });

  it('creates bounded logical sections when no headings are available', async () => {
    const input: DocumentArtifact = {
      metadata: { fileName: 'plain.txt' },
      blocks: [{ id: 'plain', type: 'text', text: 'x'.repeat(25_000) }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline).toHaveLength(3);
    expect(output.artifact.outline?.map((node) => node.source)).toEqual([
      'logical',
      'logical',
      'logical',
    ]);
    expect(output.artifact.outline?.map((node) => [node.startOffset, node.endOffset])).toEqual([
      [0, 12_000],
      [12_000, 24_000],
      [24_000, 25_000],
    ]);
  });

  it('prefers a paragraph boundary over cutting a logical section mid-paragraph', async () => {
    const firstParagraph = 'a'.repeat(10_000);
    const secondParagraph = 'b'.repeat(4_000);
    const text = `${firstParagraph}\n\n${secondParagraph}`;
    const input: DocumentArtifact = {
      metadata: {},
      blocks: [{ id: 'plain', type: 'text', text }],
      assets: [],
    };

    const output = await detectDocumentStructureTransform.apply(input, context);

    expect(output.artifact.outline?.map((node) => [node.startOffset, node.endOffset])).toEqual([
      [0, firstParagraph.length + 2],
      [firstParagraph.length + 2, text.length],
    ]);
  });
});
