/**
 * Long block formulas from the #1905 repro.
 *
 * OpenMAIC draws each on one line (`white-space: nowrap` plus shrink-to-fit).
 * PowerPoint and WPS wrapped the longest ones (course intro Fourier series,
 * error-analysis MSE) after PPTX export. Inline LaTeX text runs (#1904) are
 * not part of this fixture.
 */
export const LONG_DERIVATION_FORMULAS = {
  /** Slide 1 of the placeholder course: the longest one-line Fourier series. */
  fourierSeries: String.raw`f(x) = a_0 + \sum_{n=1}^{N} (a_n\cos nx + b_n\sin nx)`,
  /** Slide 8: the other formula that wrapped. */
  mse: String.raw`MSE = \frac{1}{N}\sum_{i=1}^{N} (f(x_i)-S_N(x_i))^2`,
  /** A longer single-line derivation that fills a typical slide formula box. */
  fourierPartialSum: String.raw`S_N(x)=\frac{a_0}{2}+\sum_{n=1}^{N}\left(a_n\cos\frac{n\pi x}{L}+b_n\sin\frac{n\pi x}{L}\right),\quad a_n=\frac{1}{L}\int_{-L}^{L}f(x)\cos\frac{n\pi x}{L}\,dx,\quad b_n=\frac{1}{L}\int_{-L}^{L}f(x)\sin\frac{n\pi x}{L}\,dx`,
} as const;
