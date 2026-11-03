import { qrPngDataUrl } from '@/lib/export/qr-png';
import { ellipsizeShareText, wrapShareText } from './report-share-text';
import { reportShareCampaign, type ReportShareContent, type ShareTheme } from './report-share';

export const shareImageSize = [1200, 1500] as const;
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
  const destination = reportShareCampaign.url || 'https://example.com/vibe-intro';
  const placeholder = !reportShareCampaign.url;
  const background = reportShareCampaign.backgrounds[theme];
  const [logo, qr, artwork] = await Promise.all([
    loadImage('/openmaic-mark.png'),
    qrPngDataUrl(destination).then(loadImage),
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
          ...content.concepts,
          heading,
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
  ) {
    ctx!.font = `${weight} ${size}px ${font}`;
    ctx!.fillStyle = color;
    ctx!.direction = flow;
    ctx!.textAlign = align;
    ctx!.fillText(value, x, y);
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
  ctx.drawImage(logo, 64, 56, 68, 68);
  text('OpenMAIC', 148, 108, 46, ink, 700);
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
  text('VIBE CODING', 64, 166, 18, accent, 600);
  const headingEnd = paragraph(heading, 64, 230, width - 128, 50, 2, ink, 700, true);
  const titleEnd = paragraph(content.title, 64, headingEnd + 70, width - 128, 34, 2, muted, 500);

  // The full invitation sits directly after the title, before the learner's factual results.
  const inviteY = titleEnd + 44,
    inviteWidth = width - 128,
    qrSize = 156;
  box(64, inviteY, inviteWidth, 214, dark ? '#62409c' : '#dfc9ff');
  if (qr) ctx.drawImage(qr, width - 64 - qrSize - 24, inviteY + 28, qrSize, qrSize);
  const copyWidth = inviteWidth - qrSize - 72;
  paragraph(t('pblV3.share.invite'), 88, inviteY + 46, copyWidth, 30, 1, ink, 700, true);
  paragraph(t('pblV3.share.tagline'), 88, inviteY + 92, copyWidth, 22, 2, muted, 500, true);
  paragraph(destination, 88, inviteY + 150, copyWidth, 22, 1, accent, 600, false, 'ltr');
  if (placeholder)
    paragraph(t('pblV3.share.linkPlaceholder'), 88, inviteY + 182, copyWidth, 14, 1, muted);

  // Existing factual sections retain their content and flow only when data exists.
  const panel = dark ? '#ffffff0c' : '#ffffffa8';
  let y = inviteY + 242;
  if (content.metrics.length) {
    const cardWidth = (width - 136) / 2;
    content.metrics.forEach(([key, value], i) => {
      const x = 64 + (i % 2) * (cardWidth + 8);
      const top = y + Math.floor(i / 2) * 128;
      box(x, top, cardWidth, 112, panel);
      text(
        value,
        direction === 'rtl' ? x + cardWidth - 24 : x + 24,
        top + 48,
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
        top + 84,
        cardWidth - 48,
        20,
        1,
        muted,
        500,
        true,
      );
    });
    y += Math.ceil(content.metrics.length / 2) * 128;
  }
  // Two open horizontal bands: a compact checklist followed by content-sized concept chips.
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
    const bodyTop = lowerTop + 70,
      rowHeight = Math.min(66, (1140 - bodyTop) / rows);
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
        rowHeight < 40 ? 24 : 26,
        1,
        ink,
        500,
        true,
      );
    });
  }
  if (content.concepts.length) {
    paragraph(t('pblV3.share.conceptsLabel'), 64, 1180, width - 128, 24, 1, muted, 600, true);
    const chipHeight = 50,
      gap = 14;
    let chipX = direction === 'rtl' ? width - 64 : 64,
      chipY = 1204;
    content.concepts.forEach((concept) => {
      ctx.font = `500 22px ${font}`;
      // At most six concepts; three maximum-width chips fit a row, so two rows stay above results.
      const chipWidth = Math.min(348, ctx.measureText(concept).width + 40);
      if (direction === 'rtl' ? chipX - chipWidth < 64 : chipX + chipWidth > width - 64) {
        chipX = direction === 'rtl' ? width - 64 : 64;
        chipY += chipHeight + gap;
      }
      const left = direction === 'rtl' ? chipX - chipWidth : chipX;
      box(left, chipY, chipWidth, chipHeight, dark ? '#ffffff0a' : '#ffffff80', 14);
      paragraph(concept, left + 20, chipY + 33, chipWidth - 40, 22, 1, ink, 500);
      chipX = direction === 'rtl' ? left - gap : left + chipWidth + gap;
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
    box(64, 1348, width - 128, 76, dark ? '#c3a5ff12' : '#722ed10a', 20);
    const cellWidth = (width - 128) / receipts.length;
    receipts.forEach((receipt, i) => {
      paragraph(receipt, 88 + i * cellWidth, 1394, cellWidth - 48, 22, 1, accent, 600, true);
      if (i > 0) {
        ctx.strokeStyle = rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(64 + i * cellWidth, 1368);
        ctx.lineTo(64 + i * cellWidth, 1404);
        ctx.stroke();
      }
    });
  }

  text('OpenMAIC · Vibe Coding', 64, height - 32, 18, muted);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))),
      'image/png',
    ),
  );
}
