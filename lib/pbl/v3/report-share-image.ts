import { qrPngDataUrl } from '@/lib/export/qr-png';
import {
  reportShareCampaign,
  type ReportShareContent,
  type ShareOrientation,
  type ShareTheme,
} from './report-share';

export const shareImageSizes = { landscape: [1600, 900], portrait: [1200, 1600] } as const;
const font = '"Inter Variable", "Noto Sans SC", system-ui, sans-serif';
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
): Promise<Blob> {
  const [width, height] = shareImageSizes[orientation];
  const dark = theme === 'dark';
  const portrait = orientation === 'portrait';
  const destination = reportShareCampaign.url || 'https://example.com/vibe-intro';
  const placeholder = !reportShareCampaign.url;
  const background = reportShareCampaign.backgrounds[orientation][theme];
  const [logo, qr, artwork] = await Promise.all([
    loadImage('/logo-horizontal.png'),
    qrPngDataUrl(destination).then(loadImage),
    background ? loadImage(background) : null,
  ]);
  if (document.fonts) {
    await document.fonts.load(`600 42px ${font}`, content.title + content.highlights.join(''));
    await document.fonts.ready;
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
    ctx!.roundRect(x, y, w, h, radius);
    ctx!.fill();
  }
  function text(value: string, x: number, y: number, size: number, color = ink, weight = 400) {
    ctx!.font = `${weight} ${size}px ${font}`;
    ctx!.fillStyle = color;
    ctx!.fillText(value, x, y);
  }
  // Wrap CJK, long tokens and emoji without depending on browser viewport size.
  function paragraph(
    value: string,
    x: number,
    y: number,
    w: number,
    size: number,
    maxLines: number,
    color = ink,
    weight = 400,
  ) {
    ctx!.font = `${weight} ${size}px ${font}`;
    const lines: string[] = [];
    let line = '';
    for (const char of Array.from(value.replace(/\s+/g, ' '))) {
      if (line && ctx!.measureText(line + char).width > w) {
        lines.push(line);
        line = char;
      } else line += char;
    }
    if (line) lines.push(line);
    const visible = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      const last = Array.from(visible[maxLines - 1] ?? '');
      while (last.length && ctx!.measureText(last.join('') + '…').width > w) last.pop();
      visible[maxLines - 1] = last.join('') + '…';
    }
    visible.forEach((s, i) => text(s, x, y + i * size * 1.45, size, color, weight));
  }
  box(64, 56, 294, 78, '#ffffff', 16);
  ctx.drawImage(logo, 82, 66, 258, 58);
  text(t('pblV3.share.eyebrow'), 64, 184, 22, accent, 600);
  text(
    t(content.completed ? 'pblV3.reportCopy.completedTitle' : 'pblV3.share.achievement'),
    64,
    250,
    48,
    ink,
    700,
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
  box(inviteX, inviteY, inviteWidth, portrait ? 140 : 196, dark ? '#62409c' : '#dfc9ff');
  const qrSize = portrait ? 120 : 140;
  if (qr) ctx.drawImage(qr, inviteX + inviteWidth - qrSize - 20, inviteY + 16, qrSize, qrSize);
  const copyWidth = inviteWidth - qrSize - 64;
  paragraph(
    t('pblV3.share.invite'),
    inviteX + 24,
    inviteY + 40,
    copyWidth,
    26,
    portrait ? 1 : 2,
    ink,
    700,
  );
  paragraph(
    t('pblV3.share.tagline'),
    inviteX + 24,
    inviteY + (portrait ? 72 : 113),
    copyWidth,
    20,
    1,
    muted,
    500,
  );
  paragraph(
    destination,
    inviteX + 24,
    inviteY + (portrait ? 104 : 146),
    copyWidth,
    20,
    1,
    accent,
    600,
  );
  if (placeholder)
    paragraph(
      t('pblV3.share.linkPlaceholder'),
      inviteX + 24,
      inviteY + (portrait ? 126 : 176),
      copyWidth,
      14,
      1,
      muted,
    );

  const metricsY = portrait ? 540 : 406;
  const cardWidth = (width - 152) / (portrait ? 2 : 4);
  content.metrics.forEach(([key, value], i) => {
    const x = 64 + (i % (portrait ? 2 : 4)) * (cardWidth + 8);
    const y = metricsY + (portrait ? Math.floor(i / 2) * 136 : 0);
    box(x, y, cardWidth, portrait ? 120 : 144, dark ? '#ffffff12' : '#ffffffb8');
    text(value, x + 24, y + (portrait ? 55 : 65), 46, accent, 700);
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
    text(t('pblV3.reportCopy.skills'), 88, 871, 22, muted, 600);
    content.skills.forEach((id, i) => {
      const x = 88 + (i % 3) * 340;
      const y = 916 + Math.floor(i / 3) * 48;
      text('✓', x, y, 24, accent, 700);
      paragraph(t(`pblV3.reportCopy.skillLabels.${id}`), x + 32, y, 292, 23, 1, ink, 500);
    });
    box(64, 1020, width - 128, 146, panel);
    text(t('pblV3.reportCopy.concepts'), 88, 1055, 22, muted, 600);
    paragraph(content.concepts.join('  ·  '), 88, 1094, width - 176, 25, 2, ink, 500);
    text(t('pblV3.share.highlights'), 64, 1208, 22, muted, 600);
  } else {
    text(t('pblV3.reportCopy.skills'), 64, 602, 21, muted, 600);
    paragraph(
      content.skills.map((id) => t(`pblV3.reportCopy.skillLabels.${id}`)).join(' · '),
      64,
      642,
      width - 128,
      23,
      1,
      ink,
      500,
    );
  }
  const narrativeY = portrait ? 1254 : 690;
  const narrativeWidth = portrait ? width - 128 : width - 390;
  if (content.waiting) {
    paragraph(t('pblV3.share.waiting'), 64, narrativeY, narrativeWidth, 25, 2, muted);
  } else if (content.highlights.length) {
    content.highlights.forEach((value, i) =>
      paragraph(
        value,
        64,
        narrativeY + i * (portrait ? 80 : 37),
        narrativeWidth,
        portrait ? 26 : 23,
        portrait ? 2 : 1,
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
  const receipts = [
    ...(tested > 0 && passed === tested ? [t('pblV3.share.testsPassed')] : []),
    ...(quizTotal > 0 ? [`${t('pblV3.stageNames.quiz')} ${quizScore}/${quizTotal}`] : []),
    ...(decisions !== undefined ? [`${t('pblV3.reportCopy.decisions')} ${decisions}`] : []),
  ];
  paragraph(
    receipts.join('   ·   '),
    64,
    portrait ? 1420 : 770,
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
    2,
    accent,
    600,
  );
  text('OpenMAIC · Vibe Coding', 64, height - 44, 18, muted);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG unavailable'))),
      'image/png',
    ),
  );
}
