export interface NaturalImageDimensions {
  readonly width: number;
  readonly height: number;
}

export function readImageDimensions(src: string): Promise<NaturalImageDimensions | undefined> {
  if (typeof Image === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve(
        image.naturalWidth > 0 && image.naturalHeight > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : undefined,
      );
    image.onerror = () => resolve(undefined);
    image.src = src;
  });
}
