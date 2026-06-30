/**
 * Encode RGBA pixel buffer to PNG data URL using browser Canvas API.
 */

export function rgbaToPngDataUrl(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const src =
    rgba instanceof Uint8ClampedArray
      ? rgba
      : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const copy = new Uint8ClampedArray(src.length);
  copy.set(src);
  const imageData = new ImageData(copy, width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}
