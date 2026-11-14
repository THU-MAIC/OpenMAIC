import { qrPngDataUrl } from '@/lib/export/qr-png';
import { ellipsizeShareText, wrapShareText } from './report-share-text';
import {
  reportShareCampaign,
  reportShareDestination,
  reportShareDisplayUrl,
  reportShareLayout,
  type ReportShareContent,
  type ShareTheme,
} from './report-share';

export const shareImageSize = [reportShareLayout.width, reportShareLayout.height] as const;
// No named CJK web font: the page declares `Noto Sans SC` over a whole
// self-hosted file (`@openmaic/renderer/picker-fonts.css`), and the load below
// would wait for that download, even for text with no Chinese in it. System
// CJK faces render the card at once.
const primaryFont = '"Inter Variable", system-ui, sans-serif';
const fallbackFont = 'system-ui, sans-serif';
async function loadImage(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** One fixed social card. Only its structured public data and theme affect rendering. */
export async function renderReportShareImage(
  content: ReportShareContent,
  theme: ShareTheme,
  t: (key: string) => string,
  locale = 'en-US',
): Promise<Blob> {
  const [width, height] = shareImageSize;
  const dark = theme === 'dark';
  const direction = locale.startsWith('ar') ? 'rtl' : 'ltr';
  const destination = reportShareDestination();
  const printedDestination = destination ? reportShareDisplayUrl(destination) : '';
  const background = reportShareCampaign.backgrounds[theme];
  const [logo, qr, artwork] = await Promise.all([
    loadImage('/openmaic-share-logo.png'),
    destination ? qrPngDataUrl(destination).then(loadImage) : null,
    background ? loadImage(background) : null,
  ]);
  const heading = t(
    content.completed ? 'pblV3.reportCopy.congratulations' : 'pblV3.share.achievement',
  );
  const workflow = content.workflow.map((id) => t(`pblV3.reportCopy.skillLabels.${id}`));
  let font = primaryFont;
  if (document.fonts) {
    try {
      // Wait only for faces needed by this image; unrelated page fonts cannot block saving.
      await document.fonts.load(
        `600 42px ${primaryFont}`,
        [
          content.title,
          printedDestination,
          ...content.concepts,
          heading,
          t('pblV3.share.workshop'),
          t('pblV3.share.entryLabel'),
          ...content.results.flatMap(({ title, description }) => [title, description]),
          ...workflow,
          t('pblV3.reportCopy.workflow'),
          t('pblV3.reportCopy.projectResults'),
          t('pblV3.share.conceptsLabel'),
          t('pblV3.share.invite'),
          t('pblV3.share.tagline'),
        ].join(' '),
      );
    } catch {
      // An errored FontFace can reject every later load. A system font keeps retries usable.
      font = fallbackFont;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image canvas unavailable');
  const ink = dark ? '#f5f2ff' : '#211c38';
  const muted = dark ? '#c3bbdc' : '#625b77';
  const accent = dark ? '#c3a5ff' : '#722ed1';
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, dark ? '#181125' : '#faf7ff');
  gradient.addColorStop(1, dark ? '#30204d' : '#e9dfff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  if (artwork) ctx.drawImage(artwork, 0, 0, width, height);
  function box(x: number, y: number, w: number, h: number, fill: string, radius = 24) {
    ctx!.fillStyle = fill;
    ctx!.beginPath();
    if (typeof ctx!.roundRect === 'function') ctx!.roundRect(x, y, w, h, radius);
    else {
      const r = Math.min(radius, w / 2, h / 2);
      ctx!.moveTo(x + r, y);
      ctx!.lineTo(x + w - r, y);
      ctx!.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx!.lineTo(x + w, y + h - r);
      ctx!.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx!.lineTo(x + r, y + h);
      ctx!.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx!.lineTo(x, y + r);
      ctx!.quadraticCurveTo(x, y, x + r, y);
      ctx!.closePath();
    }
    ctx!.fill();
  }
  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    color = ink,
    weight = 400,
    flow: CanvasDirection = 'ltr',
    align: CanvasTextAlign = 'left',
    maxWidth?: number,
  ) {
    ctx!.font = `${weight} ${size}px ${font}`;
    ctx!.fillStyle = color;
    ctx!.direction = flow;
    ctx!.textAlign = align;
    if (maxWidth === undefined) ctx!.fillText(value, x, y);
    else ctx!.fillText(value, x, y, maxWidth);
  }
  // Fixed text slots fit built-in copy; authored long titles remain bounded with an ellipsis.
  function layoutParagraph(
    value: string,
    w: number,
    size: number,
    maxLines: number,
    weight = 400,
    fit = false,
    flow: CanvasDirection = direction,
  ) {
    ctx!.direction = flow;
    const measure = (value: string) => ctx!.measureText(value).width;
    let lines: string[];
    do {
      ctx!.font = `${weight} ${size}px ${font}`;
      lines = wrapShareText(value, w, measure);
      if (!fit || lines.length <= maxLines || size <= 16) break;
      size--;
    } while (true);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines)
      visible[maxLines - 1] = ellipsizeShareText(visible[maxLines - 1] ?? '', w, measure);
    return { lines: visible, size, weight, flow, lineHeight: size * 1.45 };
  }
  function drawParagraph(
    { lines, size, weight, flow, lineHeight }: ReturnType<typeof layoutParagraph>,
    x: number,
    y: number,
    w: number,
    color: string,
  ) {
    lines.forEach((s, i) =>
      text(
        s,
        flow === 'rtl' ? x + w : x,
        y + i * lineHeight,
        size,
        color,
        weight,
        flow,
        flow === 'rtl' ? 'right' : 'left',
      ),
    );
    return y + Math.max(0, lines.length - 1) * lineHeight;
  }
  function paragraph(
    value: string,
    x: number,
    y: number,
    w: number,
    size: number,
    maxLines: number,
    color = ink,
    weight = 400,
    fit = false,
    flow: CanvasDirection = direction,
  ) {
    return drawParagraph(
      layoutParagraph(value, w, size, maxLines, weight, fit, flow),
      x,
      y,
      w,
      color,
    );
  }
  // Use the supplied official wordmark intact; no platform-font imitation.
  ctx.drawImage(logo, 64, 56, 344, 344 * (logo.naturalHeight / logo.naturalWidth));
  // A compact party-popper illustration uses vectors instead of emoji fonts.
  ctx.save();
  ctx.translate(1030, 92);
  ctx.rotate(-0.2);
  const cone = ctx.createLinearGradient(-40, 40, 28, -18);
  cone.addColorStop(0, dark ? '#8e60da' : '#722ed1');
  cone.addColorStop(1, dark ? '#d3b7ff' : '#c6a0f0');
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(-43, 43);
  ctx.lineTo(-26, -15);
  ctx.lineTo(29, 24);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-4, -18);
  ctx.quadraticCurveTo(0, -47, 22, -43);
  ctx.moveTo(26, -2);
  ctx.quadraticCurveTo(53, -26, 54, -2);
  ctx.stroke();
  for (const [x, y, color] of [
    [-40, -42, '#b78bff'],
    [33, -35, '#ffbe55'],
    [52, 27, '#8bcaad'],
  ] as const) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 7, 13);
  }
  ctx.restore();
  paragraph(t('pblV3.share.workshop'), 64, 178, width - 280, 28, 1, muted, 600, true);
  const headingEnd = paragraph(heading, 64, 254, width - 128, 54, 1, ink, 700, true);
  const titleEnd = paragraph(content.title, 64, headingEnd + 70, width - 128, 34, 2, muted, 500);

  const margin = 64;
  const bodyWidth = width - 2 * margin;
  const rtl = direction === 'rtl';
  const panel = dark ? '#ffffff0c' : '#ffffffa8';
  const tint = dark ? '#c3a5ff12' : '#722ed10a';
  const rule = dark ? '#ffffff16' : '#211c3812';
  const resultsY = destination ? 1108 : 1360;
  const sections: { height: number; draw: (top: number) => void }[] = [];
  const mirror = (x: number, w: number) => (rtl ? width - x - w : x);

  if (content.metrics.length) {
    const metricHeight = 108;
    sections.push({
      height: metricHeight,
      draw(top) {
        const w = (bodyWidth - 14 * (content.metrics.length - 1)) / content.metrics.length;
        content.metrics.forEach(([key, value], i) => {
          const x = mirror(margin + i * (w + 14), w);
          box(x, top, w, metricHeight, panel);
          text(
            value,
            rtl ? x + w - 24 : x + 24,
            top + 51,
            41,
            accent,
            700,
            'ltr',
            rtl ? 'right' : 'left',
          );
          paragraph(
            t(key === 'concepts' ? 'pblV3.share.conceptsLabel' : `pblV3.reportCopy.${key}`),
            x + 24,
            top + 83,
            w - 48,
            20,
            1,
            muted,
            500,
            true,
          );
        });
      },
    });
  }

  if (content.results.length) {
    const columns = Math.min(2, content.results.length);
    const gap = 16;
    const w = (bodyWidth - gap * (columns - 1)) / columns;
    const textGap = 22;
    function measureParagraph(layout: ReturnType<typeof layoutParagraph>) {
      const { lines, size, weight, flow, lineHeight } = layout;
      ctx!.font = `${weight} ${size}px ${font}`;
      ctx!.direction = flow;
      const first = ctx!.measureText(lines[0] ?? '');
      const last = ctx!.measureText(lines.at(-1) ?? '');
      const ascent = first.actualBoundingBoxAscent ?? size * 0.8;
      const descent = last.actualBoundingBoxDescent ?? size * 0.2;
      return { layout, ascent, height: ascent + (lines.length - 1) * lineHeight + descent };
    }
    const cards = content.results.map(({ title, description }) => {
      const heading = measureParagraph(layoutParagraph(title, w - 84, 29, 2, 700, true));
      const body = description
        ? measureParagraph(layoutParagraph(description, w - 48, 21, 2, 500, true))
        : null;
      return { heading, body, contentHeight: heading.height + (body ? textGap + body.height : 0) };
    });
    const rows = Array.from({ length: Math.ceil(cards.length / columns) }, (_, index) => {
      const items = cards.slice(index * columns, (index + 1) * columns);
      return {
        items,
        height: Math.max(132, ...items.map(({ contentHeight }) => contentHeight + 60)),
      };
    });
    sections.push({
      height: 42 + rows.reduce((height, row) => height + row.height + gap, -gap),
      draw(top) {
        paragraph(
          t('pblV3.reportCopy.projectResults'),
          margin,
          top + 24,
          bodyWidth,
          25,
          1,
          muted,
          600,
          true,
        );
        let y = top + 42;
        for (const { items, height } of rows) {
          items.forEach(({ heading, body, contentHeight }, column) => {
            const x = mirror(margin + column * (w + gap), w);
            box(x, y, w, height, panel, 20);
            const contentTop = y + (height - contentHeight) / 2;
            const marker = rtl ? x + w - 48 : x + 24;
            const markerY = contentTop + (heading.layout.size - 24) / 2;
            box(marker, markerY, 24, 24, tint, 8);
            ctx.strokeStyle = accent;
            ctx.lineWidth = 2.4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(marker + 6, markerY + 12);
            ctx.lineTo(marker + 10, markerY + 16);
            ctx.lineTo(marker + 18, markerY + 8);
            ctx.stroke();
            drawParagraph(
              heading.layout,
              rtl ? x + 24 : x + 60,
              contentTop + heading.ascent,
              w - 84,
              ink,
            );
            if (body) {
              drawParagraph(
                body.layout,
                x + 24,
                contentTop + heading.height + textGap + body.ascent,
                w - 48,
                muted,
              );
            }
          });
          y += height + gap;
        }
      },
    });
  }

  if (workflow.length) {
    const w = bodyWidth / workflow.length;
    ctx.font = `600 20px ${font}`;
    ctx.direction = direction;
    const labels = workflow.map((label) =>
      wrapShareText(label, w - 32, (value) => ctx.measureText(value).width).map((line) => ({
        line,
        width: ctx.measureText(line).width,
      })),
    );
    const h = Math.max(120, 80 + 24 * Math.max(...labels.map((lines) => lines.length)));
    sections.push({
      height: 42 + h,
      draw(top) {
        paragraph(
          t('pblV3.reportCopy.workflow'),
          margin,
          top + 24,
          bodyWidth,
          25,
          1,
          muted,
          600,
          true,
        );
        const y = top + 42;
        box(margin, y, bodyWidth, h, tint, 20);
        const centerY = y + 36;
        ctx.strokeStyle = dark ? '#c3a5ff30' : '#722ed12c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(margin + w / 2, centerY);
        ctx.lineTo(width - margin - w / 2, centerY);
        ctx.stroke();
        labels.forEach((lines, i) => {
          const x = mirror(margin + i * w, w);
          const center = x + w / 2;
          box(center - 17, centerY - 17, 34, 34, dark ? '#493667' : '#e2d1fa', 17);
          text(
            String(i + 1).padStart(2, '0'),
            center,
            centerY + 5,
            15,
            accent,
            700,
            'ltr',
            'center',
          );
          lines.forEach(({ line, width: lineWidth }, row) =>
            text(
              line,
              center + (rtl ? lineWidth : -lineWidth) / 2,
              y + 80 + row * 24,
              20,
              ink,
              600,
              direction,
              rtl ? 'right' : 'left',
            ),
          );
        });
      },
    });
  }

  if (content.concepts.length) {
    const gap = 12;
    let x = margin;
    let y = 42;
    let rowHeight = 0;
    ctx.font = `500 22px ${font}`;
    ctx.direction = direction;
    const measure = (value: string) => ctx.measureText(value).width;
    const chips = content.concepts.map((concept) => {
      const w = Math.min(bodyWidth, Math.ceil(measure(concept)) + 40);
      const lines = wrapShareText(concept, w - 40, measure);
      const h = 44 + Math.max(0, lines.length - 1) * 28;
      if (x + w > width - margin) {
        x = margin;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      const chip = { x: mirror(x, w), y, w, h, lines };
      x += w + gap;
      rowHeight = Math.max(rowHeight, h);
      return chip;
    });
    sections.push({
      height: y + rowHeight,
      draw(top) {
        paragraph(
          t('pblV3.share.conceptsLabel'),
          margin,
          top + 24,
          bodyWidth,
          25,
          1,
          muted,
          600,
          true,
        );
        for (const chip of chips) {
          box(chip.x, top + chip.y, chip.w, chip.h, panel, 14);
          chip.lines.forEach((line, i) =>
            text(
              line,
              rtl ? chip.x + chip.w - 20 : chip.x + 20,
              top + chip.y + 29 + i * 28,
              22,
              ink,
              500,
              direction,
              rtl ? 'right' : 'left',
            ),
          );
        }
      },
    });
  }

  // Keep the footer and campaign hit area fixed while fitting dense authored content above.
  const top = titleEnd + 56;
  const available = resultsY - top - 40;
  const sectionHeight = sections.reduce((height, section) => height + section.height, 0);
  const gaps = Math.max(0, sections.length - 1);
  const gap = Math.min(80, Math.max(26, (available - sectionHeight) / Math.max(1, gaps)));
  const scale = Math.min(1, available / (sectionHeight + gaps * gap));
  ctx.save();
  ctx.translate(((1 - scale) * width) / 2, top);
  ctx.scale(scale, scale);
  let offset = 0;
  for (const section of sections) {
    section.draw(offset);
    offset += section.height + gap;
  }
  ctx.restore();

  const { passed, tested, quizScore, quizTotal, decisions } = content.verification;
  const number = (value: string | number) =>
    direction === 'rtl' ? `\u2066${value}\u2069` : String(value);
  const receipts = [
    ...(tested > 0 && passed === tested ? [t('pblV3.share.testsPassed')] : []),
    ...(quizTotal > 0
      ? [`${t('pblV3.share.quizLabel')} ${number(`${quizScore}/${quizTotal}`)}`]
      : []),
    ...(decisions !== undefined && decisions > 0
      ? [`${t('pblV3.share.decisionsLabel')} ${number(decisions)}`]
      : []),
  ];
  if (receipts.length) {
    box(64, resultsY, width - 128, 76, dark ? '#c3a5ff12' : '#722ed10a', 20);
    const cellWidth = (width - 128) / receipts.length;
    receipts.forEach((receipt, i) => {
      paragraph(
        receipt,
        88 + i * cellWidth,
        resultsY + 46,
        cellWidth - 48,
        22,
        1,
        accent,
        600,
        true,
      );
      if (i > 0) {
        ctx.strokeStyle = rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(64 + i * cellWidth, resultsY + 20);
        ctx.lineTo(64 + i * cellWidth, resultsY + 56);
        ctx.stroke();
      }
    });
  }

  if (destination && qr) {
    const {
      x: inviteX,
      y: inviteY,
      width: inviteWidth,
      height: inviteHeight,
    } = reportShareLayout.campaign;
    box(inviteX, inviteY, inviteWidth, inviteHeight, panel);
    const qrSize = 156;
    // Leave the image's lower-right corner clear for the preview-only save control.
    ctx.drawImage(qr, width - 64 - qrSize - 48, inviteY + 20, qrSize, qrSize);
    const copyWidth = inviteWidth - qrSize - 96;
    paragraph(t('pblV3.share.invite'), 88, inviteY + 46, copyWidth, 30, 1, ink, 700, true);
    paragraph(t('pblV3.share.tagline'), 88, inviteY + 92, copyWidth, 22, 2, muted, 500, true);
    // Canvas fits the complete address into this slot; URLs must never be ellipsized.
    text(printedDestination, 88, inviteY + 150, 22, accent, 600, 'ltr', 'left', copyWidth);
    paragraph(t('pblV3.share.entryLabel'), 88, inviteY + 180, copyWidth, 15, 1, muted);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))),
      'image/png',
    ),
  );
}
