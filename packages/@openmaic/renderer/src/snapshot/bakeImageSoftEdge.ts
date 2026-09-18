/**
 * Bake the soft-edge feather (a:softEdge) into an <img>'s bitmap. html2canvas-pro
 * ignores CSS masks, so the feather BaseImageElement applies is lost in the PNG.
 * The feather radius is read from `data-soft-edge` (px in the element's displayed
 * box) and scaled to the image's natural pixels. Two `destination-in` linear
 * gradient passes multiply the alpha down to 0 within `r` of each edge (corners
 * get both axes), matching the live CSS mask. No-ops on undecoded/ CORS-tainted
 * images or zero radius.
 */
export async function bakeImageSoftEdge(img: HTMLImageElement): Promise<void> {
  const rCss = parseFloat(img.dataset.softEdge || '');
  if (!rCss || rCss <= 0) return;
  if (!img.complete || img.naturalWidth === 0) return;

  const displayedW = img.offsetWidth || img.naturalWidth;
  const displayedH = img.offsetHeight || img.naturalHeight;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const rx = Math.min((rCss * w) / displayedW, w / 2);
  const ry = Math.min((rCss * h) / displayedH, h / 2);
  if (rx <= 0 || ry <= 0) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';

    const stops = (g: CanvasGradient, extent: number, r: number) => {
      const f = r / extent;
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(f, 'rgba(0,0,0,1)');
      g.addColorStop(1 - f, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      return g;
    };
    const gh = stops(ctx.createLinearGradient(0, 0, w, 0), w, rx);
    ctx.fillStyle = gh;
    ctx.fillRect(0, 0, w, h);
    const gv = stops(ctx.createLinearGradient(0, 0, 0, h), h, ry);
    ctx.fillStyle = gv;
    ctx.fillRect(0, 0, w, h);

    const baked = canvas.toDataURL('image/png');
    img.removeAttribute('data-soft-edge');
    img.style.maskImage = '';
    (img.style as unknown as Record<string, string>).webkitMaskImage = '';
    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      img.src = baked;
    });
  } catch {
    // CORS-tainted source — keep the original <img>.
  }
}
