export interface LatexSymbolGroup {
  readonly id: string;
  readonly label: string;
  readonly symbols: readonly { readonly label: string; readonly latex: string }[];
}

export interface LatexPreset {
  readonly id: string;
  readonly label: string;
  readonly latex: string;
}

export const LATEX_SYMBOL_GROUPS: readonly LatexSymbolGroup[] = [
  {
    id: 'operators',
    label: 'Operators',
    symbols: [
      { label: 'Plus or minus', latex: '\\pm' },
      { label: 'Multiply', latex: '\\times' },
      { label: 'Divide', latex: '\\div' },
      { label: 'Integral', latex: '\\int' },
      { label: 'Sum', latex: '\\sum' },
      { label: 'Infinity', latex: '\\infty' },
    ],
  },
  {
    id: 'structures',
    label: 'Structures',
    symbols: [
      { label: 'Fraction', latex: '\\frac{}{}' },
      { label: 'Square root', latex: '\\sqrt{}' },
      { label: 'Superscript', latex: '^{}' },
      { label: 'Subscript', latex: '_{}' },
      { label: 'Matrix', latex: '\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}' },
    ],
  },
  {
    id: 'greek',
    label: 'Greek',
    symbols: [
      { label: 'Alpha', latex: '\\alpha' },
      { label: 'Beta', latex: '\\beta' },
      { label: 'Gamma', latex: '\\gamma' },
      { label: 'Delta', latex: '\\delta' },
      { label: 'Pi', latex: '\\pi' },
      { label: 'Omega', latex: '\\omega' },
    ],
  },
];

export const LATEX_PRESETS: readonly LatexPreset[] = [
  {
    id: 'quadratic',
    label: 'Quadratic formula',
    latex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  },
  { id: 'euler', label: 'Euler identity', latex: 'e^{i\\pi} + 1 = 0' },
  { id: 'integral', label: 'Definite integral', latex: '\\int_a^b f(x)\\,dx' },
  { id: 'matrix', label: 'Matrix', latex: '\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}' },
];
