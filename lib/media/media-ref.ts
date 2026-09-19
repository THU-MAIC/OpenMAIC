/** Whether a value has the generated image/video placeholder shape. */
export function isGeneratedMediaPlaceholder(value: string | undefined): value is string {
  return !!value && /^gen_(img|vid)_[\w-]+$/i.test(value);
}
