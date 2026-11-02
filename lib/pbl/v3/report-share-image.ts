import { qrPngDataUrl } from '@/lib/export/qr-png';
import { ellipsizeShareText, wrapShareText } from './report-share-text';
import {
  reportShareCampaign,
  type ReportShareContent,
  type ShareOrientation,
  type ShareTheme,
} from './report-share';

export const shareImageSizes = { landscape: [1600, 900], portrait: [1200, 1600] } as const;
const primaryFont = '"Inter Variable", "Noto Sans SC", system-ui, sans-serif';
const fallbackFont = 'system-ui, sans-serif';
async function loadImage(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Two fixed layouts; artwork can change without changing report data or the download path. */
export async function renderReportShareImage(
  content: ReportShareContent,
  orientation: ShareOrientation,
  theme: ShareTheme,
  t: (key: string) => string,
  locale = 'en-US',
): Promise<Blob> {
  const [width, height] = shareImageSizes[orientation];
  const dark = theme === 'dark';
  const portrait = orientation === 'portrait';
  const direction = locale.startsWith('ar') ? 'rtl' : 'ltr';
  const destination = reportShareCampaign.url || 'https://example.com/vibe-intro';
  const placeholder = !reportShareCampaign.url;
  const background = reportShareCampaign.backgrounds[orientation][theme];
  const [logo, qr, artwork] = await Promise.all([
    loadImage('/openmaic-mark.png'),
    qrPngDataUrl(destination).then(loadImage),
    background ? loadImage(background) : null,
  ]);
  const highlights = content.highlights.map((key) => t(`pblV3.share.conclusions.${key}`));
  let font = primaryFont;
  if (document.fonts) {
    try {
      // Wait only for faces needed by this image; unrelated page fonts cannot block saving.
      await document.fonts.load(
        `600 42px ${primaryFont}`,
        [
          content.title,
          ...content.concepts,
          ...highlights,
          ...content.skills.map((id) => t(`pblV3.reportCopy.skillLabels.${id}`)),
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
  }
  ctx.drawImage(logo, 64, 56, 68, 68);
  text('OpenMAIC', 148, 108, 46, ink, 700);
  paragraph(
    t('pblV3.share.eyebrow'),
    64,
    184,
    portrait ? width - 128 : 840,
    22,
    1,
    accent,
    600,
    true,
  );
  paragraph(
    t(content.completed ? 'pblV3.reportCopy.completedTitle' : 'pblV3.share.achievement'),
    64,
    250,
    portrait ? width - 128 : 840,
    48,
    1,
    ink,
    700,
    true,
  );
  paragraph(content.title, 64, 310, portrait ? width - 128 : 840, 32, 2, muted, 500);
  // Small vector confetti celebrates the receipt without relying on emoji fonts.
  for (const [x, y, color] of [
    [420, 75, '#b78bff'],
    [470, 105, '#ffbe55'],
    [500, 65, '#8bcaad'],
  ] as const) {
    ctx.fillStyle = color;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.4);
    ctx.fillRect(-4, -10, 8, 20);
    ctx.restore();
  }
  const inviteX = portrait ? 64 : 970;
  const inviteY = portrait ? 380 : 156;
  const inviteWidth = portrait ? width - 128 : width - inviteX - 64;
  box(inviteX, inviteY, inviteWidth, portrait ? 140 : 216, dark ? '#62409c' : '#dfc9ff');
  const qrSize = portrait ? 120 : 140;
  if (qr) ctx.drawImage(qr, inviteX + inviteWidth - qrSize - 20, inviteY + 16, qrSize, qrSize);
  const copyWidth = inviteWidth - qrSize - 64;
  paragraph(
    t('pblV3.share.invite'),
    inviteX + 24,
    inviteY + 40,
    copyWidth,
    portrait ? 26 : 24,
    portrait ? 1 : 2,
    ink,
    700,
    true,
  );
  paragraph(
    t('pblV3.share.tagline'),
    inviteX + 24,
    inviteY + (portrait ? 72 : 106),
    copyWidth,
    portrait ? 20 : 18,
    portrait ? 1 : 2,
    muted,
    500,
    true,
  );
  paragraph(
    destination,
    inviteX + 24,
    inviteY + (portrait ? 104 : 158),
    copyWidth,
    portrait ? 20 : 18,
    1,
    accent,
    600,
    false,
    'ltr',
  );
  if (placeholder)
    paragraph(
      t('pblV3.share.linkPlaceholder'),
      inviteX + 24,
      inviteY + (portrait ? 126 : 180),
      copyWidth,
      portrait ? 14 : 12,
      portrait ? 1 : 2,
      muted,
    );

  const metricsY = portrait ? 540 : 406;
  const columns = portrait ? 2 : 4;
  const cardWidth = (width - 128 - (columns - 1) * 8) / columns;
  content.metrics.forEach(([key, value], i) => {
    const x = 64 + (i % columns) * (cardWidth + 8);
    const y = metricsY + (portrait ? Math.floor(i / 2) * 136 : 0);
    box(x, y, cardWidth, portrait ? 120 : 144, dark ? '#ffffff12' : '#ffffffb8');
    text(
      value,
      direction === 'rtl' ? x + cardWidth - 24 : x + 24,
      y + (portrait ? 55 : 65),
      46,
      accent,
      700,
      'ltr',
      direction === 'rtl' ? 'right' : 'left',
    );
    paragraph(
      t(`pblV3.reportCopy.${key}`),
      x + 24,
      y + (portrait ? 94 : 111),
      cardWidth - 48,
      22,
      1,
      muted,
    );
  });
  const panel = dark ? '#ffffff0c' : '#ffffffa8';
  // Portrait has its own information hierarchy, rather than stretching the landscape layout.
  if (portrait) {
    box(64, 830, width - 128, 170, panel);
    paragraph(t('pblV3.reportCopy.skills'), 88, 871, width - 176, 22, 1, muted, 600, true);
    content.skills.forEach((id, i) => {
      const x = 88 + (i % 3) * 340;
      const y = 902 + Math.floor(i / 3) * 60;
      text('✓', direction === 'rtl' ? x + 304 : x, y, 22, accent, 700);
      paragraph(
        t(`pblV3.reportCopy.skillLabels.${id}`),
        direction === 'rtl' ? x : x + 32,
        y,
        292,
        20,
        2,
        ink,
        500,
        true,
      );
    });
    box(64, 1020, width - 128, 146, panel);
    paragraph(t('pblV3.reportCopy.concepts'), 88, 1055, width - 176, 22, 1, muted, 600, true);
    paragraph(content.concepts.join('  ·  '), 88, 1094, width - 176, 25, 2, ink, 500);
    paragraph(t('pblV3.share.highlights'), 64, 1208, width - 128, 22, 1, muted, 600, true);
  } else {
    paragraph(t('pblV3.reportCopy.skills'), 64, 602, width - 128, 21, 1, muted, 600, true);
    paragraph(
      content.skills.map((id) => t(`pblV3.reportCopy.skillLabels.${id}`)).join(' · '),
      64,
      642,
      width - 128,
      21,
      2,
      ink,
      500,
      true,
    );
  }
  const narrativeY = portrait ? 1254 : 710;
  const narrativeWidth = portrait ? width - 128 : width - 390;
  if (content.waiting) {
    paragraph(t('pblV3.share.waiting'), 64, narrativeY, narrativeWidth, 25, 2, muted);
  } else if (highlights.length) {
    highlights.forEach((value, i) =>
      paragraph(
        value,
        64,
        narrativeY + i * (portrait ? 80 : 37),
        narrativeWidth,
        portrait ? 26 : 23,
        portrait ? 2 : 1,
        ink,
        400,
        true,
      ),
    );
  } else {
    paragraph(
      content.concepts.join(' · ') || t('pblV3.share.factSummary'),
      64,
      narrativeY,
      narrativeWidth,
      25,
      2,
      ink,
    );
  }
  const { passed, tested, quizScore, quizTotal, decisions } = content.verification;
  // Keep numeric runs stable inside an RTL sentence without reversing URLs or branding.
  const number = (value: string | number) =>
    direction === 'rtl' ? `\u2066${value}\u2069` : String(value);
  const receipts = [
    ...(tested > 0 && passed === tested ? [t('pblV3.share.testsPassed')] : []),
    ...(quizTotal > 0
      ? [`${t('pblV3.share.quizLabel')} ${number(`${quizScore}/${quizTotal}`)}`]
      : []),
    ...(decisions !== undefined ? [`${t('pblV3.share.decisionsLabel')} ${number(decisions)}`] : []),
  ];
  paragraph(
    receipts.join('   ·   '),
    64,
    portrait ? 1420 : 790,
    narrativeWidth,
    20,
    1,
    accent,
    600,
  );
  paragraph(
    t('pblV3.share.factSummary'),
    64,
    portrait ? 1480 : 828,
    width - 128,
    portrait ? 30 : 26,
    1,
    accent,
    600,
    true,
  );
  text('OpenMAIC · Vibe Coding', 64, height - 44, 18, muted);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))),
      'image/png',
    ),
  );
}
