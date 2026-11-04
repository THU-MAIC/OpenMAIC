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
const primaryFont = '"Inter Variable", "Noto Sans SC", system-ui, sans-serif';
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
          ...content.skills.map((id) => t(`pblV3.share.skillLabels.${id}`)),
          t('pblV3.share.skillsMetric'),
          t('pblV3.share.skillsSection'),
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
    visible.forEach((s, i) =>
      text(
        s,
        flow === 'rtl' ? x + w : x,
        y + i * size * 1.45,
        size,
        color,
        weight,
        flow,
        flow === 'rtl' ? 'right' : 'left',
      ),
    );
    return y + Math.max(0, visible.length - 1) * size * 1.45;
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

  // Results lead the image. A configured invitation always stays at the bottom.
  const resultsY = destination ? 1108 : 1360;
  // Existing factual sections retain their content and flow only when data exists.
  const panel = dark ? '#ffffff0c' : '#ffffffa8';
  let y = titleEnd + 62;
  const metricStride = destination ? 128 : 156;
  const metricHeight = metricStride - 16;
  if (content.metrics.length) {
    const cardWidth = (width - 136) / 2;
    content.metrics.forEach(([key, value], i) => {
      const x = 64 + (i % 2) * (cardWidth + 8);
      const top = y + Math.floor(i / 2) * metricStride;
      box(x, top, cardWidth, metricHeight, panel);
      text(
        value,
        direction === 'rtl' ? x + cardWidth - 24 : x + 24,
        top + (destination ? 48 : 60),
        42,
        accent,
        700,
        'ltr',
        direction === 'rtl' ? 'right' : 'left',
      );
      paragraph(
        t(
          key === 'skills'
            ? 'pblV3.share.skillsMetric'
            : key === 'concepts'
              ? 'pblV3.share.conceptsLabel'
              : `pblV3.reportCopy.${key}`,
        ),
        x + 24,
        top + (destination ? 84 : 104),
        cardWidth - 48,
        20,
        1,
        muted,
        500,
        true,
      );
    });
    y += Math.ceil(content.metrics.length / 2) * metricStride;
  }
  // Size chips first so longer authored concepts can wrap without covering the checklist.
  const chipHeight = 50,
    gap = 14;
  const chips: { text: string; x: number; row: number; width: number }[] = [];
  let chipX = direction === 'rtl' ? width - 64 : 64,
    chipRow = 0;
  content.concepts.forEach((concept) => {
    ctx.font = `500 22px ${font}`;
    const chipWidth = Math.min(348, ctx.measureText(concept).width + 40);
    if (direction === 'rtl' ? chipX - chipWidth < 64 : chipX + chipWidth > width - 64) {
      chipX = direction === 'rtl' ? width - 64 : 64;
      chipRow++;
    }
    const left = direction === 'rtl' ? chipX - chipWidth : chipX;
    chips.push({ text: concept, x: left, row: chipRow, width: chipWidth });
    chipX = direction === 'rtl' ? left - gap : left + chipWidth + gap;
  });
  const conceptHeight = chips.length ? (chipRow + 1) * (chipHeight + gap) - gap : 0;
  const conceptsY = resultsY - 88 - conceptHeight;
  const lowerTop = y + 24;
  const rule = dark ? '#ffffff16' : '#211c3812';
  if (content.skills.length) {
    paragraph(
      t('pblV3.share.skillsSection'),
      64,
      lowerTop + 40,
      width - 128,
      24,
      1,
      muted,
      600,
      true,
    );
    const rows = Math.ceil(content.skills.length / 2);
    const bodyTop = lowerTop + 70;
    const rowHeight = Math.min(
      destination ? 66 : 104,
      ((chips.length ? conceptsY - 40 : resultsY - 40) - bodyTop) / rows,
    );
    const columnWidth = (width - 164) / 2;
    content.skills.forEach((id, i) => {
      const column = direction === 'rtl' ? 1 - (i % 2) : i % 2;
      const x = 64 + column * (columnWidth + 36);
      const center = bodyTop + (Math.floor(i / 2) + 0.5) * rowHeight;
      const markerX = direction === 'rtl' ? x + columnWidth - 20 : x + 20;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(markerX - 6, center);
      ctx.lineTo(markerX - 1, center + 5);
      ctx.lineTo(markerX + 8, center - 6);
      ctx.stroke();
      paragraph(
        t(`pblV3.share.skillLabels.${id}`),
        direction === 'rtl' ? x + 12 : x + 52,
        center + 9,
        columnWidth - 64,
        rowHeight < 40 ? 22 : 26,
        1,
        ink,
        500,
        true,
      );
    });
  }
  if (chips.length) {
    paragraph(t('pblV3.share.conceptsLabel'), 64, conceptsY, width - 128, 24, 1, muted, 600, true);
    chips.forEach((chip) => {
      const top = conceptsY + 24 + chip.row * (chipHeight + gap);
      box(chip.x, top, chip.width, chipHeight, dark ? '#ffffff0a' : '#ffffff80', 14);
      paragraph(chip.text, chip.x + 20, top + 33, chip.width - 40, 22, 1, ink, 500);
    });
  }
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
