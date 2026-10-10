/**
 * Realistic formulas used to check that the KaTeX/Temml hardening options do
 * not change how legitimate math renders. Drawn from the editor presets, the
 * whiteboard prompt examples, quiz and importer tests, and common textbook
 * LaTeX (algebra, calculus, linear algebra, probability, physics, chemistry
 * written with plain KaTeX commands).
 */
export const LEGITIMATE_MATH_CORPUS: readonly string[] = [
  // Editor presets and whiteboard prompt examples
  'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  'e^{i\\pi} + 1 = 0',
  '\\int_a^b f(x)\\,dx',
  '\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}',
  '\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
  '\\text{合规} \\Rightarrow \\theta \\times \\tau \\circ \\varphi',
  '\\forall \\beta \\rightarrow \\sqrt{x}',
  // Quiz / importer style
  '\\frac{1}{2}',
  '\\sqrt{2}',
  'i^{(4)}=8\\%',
  '\\frac{a}{b} + \\sqrt{x^2 + y^2} + \\color{red}{z}',
  '\\partial f / \\partial x = \\nabla \\cdot \\vec{F}',
  // Algebra
  'a^2 + b^2 = c^2',
  '(a+b)^n = \\sum_{k=0}^{n} \\binom{n}{k} a^{n-k} b^k',
  'x \\neq y \\iff \\lnot (x = y)',
  '1, 2, \\dots, n \\quad a_1 + a_2 + \\cdots + a_n',
  '\\left( \\frac{x}{y} \\right)^{2} \\leq \\left| x \\right| \\cdot \\left\\| y \\right\\|',
  'f(x) = \\begin{cases} x^2 & \\text{if } x \\geq 0 \\\\ -x & \\text{otherwise} \\end{cases}',
  '\\begin{aligned} 2x + 3y &= 7 \\\\ x - y &= 1 \\end{aligned}',
  '\\begin{align*} a &= b + c \\\\ &= d \\end{align*}',
  // Equation numbering: tags, starred tags, and suppressed numbers
  'E = mc^2 \\tag{1}',
  'E = mc^2 \\tag*{a}',
  'x = y \\tag{\\text{Euler}, $\\alpha$}',
  '\\begin{align} a &= b \\tag{3} \\\\ c &= d \\nonumber \\\\ e &= f \\notag \\\\ g &= h \\end{align}',
  '\\begin{equation} x = y \\tag*{(*)} \\end{equation}',
  '\\begin{gather} a = b \\\\ c = d \\notag \\\\ e = f \\tag{ii} \\end{gather}',
  '\\begin{align*} a &= b \\tag{4} \\\\ c &= d \\end{align*}',
  '\\log_2 8 = 3, \\quad \\ln e = 1, \\quad \\lg 100 = 2',
  '\\lfloor x \\rfloor + \\lceil y \\rceil \\equiv 0 \\pmod{3}',
  'a \\bmod b, \\; \\gcd(a, b) = 1',
  // Calculus
  '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
  "\\frac{d}{dx} e^{x} = e^{x}, \\quad f'(x) = \\frac{dy}{dx}",
  '\\int_{0}^{\\infty} e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}',
  '\\iint_D f(x,y)\\,dA = \\oint_C \\mathbf{F} \\cdot d\\mathbf{r}',
  '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
  '\\prod_{i=1}^{n} x_i \\leq \\left( \\frac{1}{n} \\sum_{i=1}^{n} x_i \\right)^n',
  'f(x) = \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x-a)^n',
  '\\frac{\\partial^2 u}{\\partial t^2} = c^2 \\nabla^2 u',
  // Linear algebra
  '\\det\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc',
  'A = \\begin{bmatrix} 1 & 0 & \\cdots & 0 \\\\ 0 & 1 & \\cdots & 0 \\\\ \\vdots & \\vdots & \\ddots & \\vdots \\\\ 0 & 0 & \\cdots & 1 \\end{bmatrix}',
  '\\begin{vmatrix} 1 & 2 \\\\ 3 & 4 \\end{vmatrix} = -2',
  'A\\mathbf{x} = \\lambda \\mathbf{x}, \\quad A^{\\top} A = I, \\quad A^{-1}',
  '\\langle u, v \\rangle = \\|u\\| \\|v\\| \\cos\\theta',
  '\\operatorname{rank}(A) + \\operatorname{null}(A) = n',
  '\\left[\\begin{array}{cc|c} 1 & 2 & 3 \\\\ 4 & 5 & 6 \\end{array}\\right]',
  // Sets, logic, number systems
  '\\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q} \\subset \\mathbb{R} \\subset \\mathbb{C}',
  'A \\cup B = \\{ x \\mid x \\in A \\lor x \\in B \\}, \\quad A \\cap \\varnothing = \\emptyset',
  '\\forall \\varepsilon > 0, \\exists \\delta > 0 : |x - a| < \\delta \\implies |f(x) - L| < \\varepsilon',
  '\\mathcal{L}, \\mathfrak{g}, \\mathscr{F}, \\mathsf{T}, \\mathrm{d}x, \\boldsymbol{\\mu}',
  // Probability and statistics
  'P(A \\mid B) = \\frac{P(B \\mid A) P(A)}{P(B)}',
  '\\mathbb{E}[X] = \\sum_i x_i p_i, \\quad \\operatorname{Var}(X) = \\mathbb{E}[X^2] - (\\mathbb{E}[X])^2',
  'X \\sim \\mathcal{N}(\\mu, \\sigma^2), \\quad f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{(x-\\mu)^2}{2\\sigma^2}}',
  '\\hat{\\beta} = (X^{\\top}X)^{-1}X^{\\top}y, \\quad \\bar{x} = \\frac{1}{n}\\sum x_i',
  '\\overbrace{1 + 2 + \\cdots + n}^{n \\text{ terms}} = \\underbrace{\\frac{n(n+1)}{2}}_{\\text{Gauss}}',
  // Physics
  'F = ma, \\quad E = mc^2, \\quad \\vec{F} = q(\\vec{E} + \\vec{v} \\times \\vec{B})',
  '\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}',
  'i\\hbar \\frac{\\partial}{\\partial t} \\Psi = \\hat{H} \\Psi',
  'v = v_0 + at, \\quad s = v_0 t + \\tfrac{1}{2} a t^2',
  '\\Delta S \\geq 0, \\quad pV = nRT, \\quad 1\\,\\mathrm{atm} = 101.3\\,\\mathrm{kPa}',
  // Chemistry with plain commands (mhchem is not built in)
  '\\mathrm{2H_2 + O_2 \\longrightarrow 2H_2O}',
  '\\mathrm{CaCO_3 \\xrightarrow{\\Delta} CaO + CO_2 \\uparrow}',
  '\\mathrm{N_2 + 3H_2 \\rightleftharpoons 2NH_3}',
  '\\mathrm{Fe^{3+} + 3OH^- \\rightarrow Fe(OH)_3 \\downarrow}',
  // Geometry and trigonometry
  '\\angle ABC = 90^\\circ, \\quad \\triangle ABC \\cong \\triangle DEF, \\quad AB \\parallel CD \\perp EF',
  '\\sin^2\\theta + \\cos^2\\theta = 1, \\quad \\tan\\theta = \\frac{\\sin\\theta}{\\cos\\theta}',
  '\\overrightarrow{AB} \\cdot \\overrightarrow{AC} = |AB||AC|\\cos A',
  '\\widehat{xyz} \\quad \\overline{AB} \\quad \\underline{x} \\quad \\tilde{a} \\quad \\dot{x} \\quad \\ddot{x}',
  // Spacing, text, display helpers, colors, boxes
  'a\\,b\\:c\\;d\\!e\\quad f\\qquad g \\enspace h \\thinspace i',
  '\\text{area} = \\pi r^2 \\quad \\textbf{bold} \\quad \\textit{italic} \\quad \\text{中文 \\(x\\)}',
  '\\displaystyle \\sum_{i=1}^{n} i \\quad \\textstyle \\sum_{i=1}^{n} i',
  '\\boxed{x = 1} \\quad \\cancel{y} \\quad \\colorbox{yellow}{z} \\quad \\textcolor{blue}{w}',
  '\\stackrel{?}{=} \\quad \\overset{\\text{def}}{=} \\quad \\underset{x}{\\arg\\max}',
  'x \\coloneqq 1, \\quad a \\approx b \\sim c \\simeq d \\propto e',
  '\\xleftarrow{\\text{reverse}} \\quad \\xRightarrow[\\text{below}]{\\text{above}}',
  '\\sqrt[3]{27} = 3, \\quad \\sqrt[n]{a^m} = a^{m/n}',
  '\\begin{matrix} a & b \\\\ c & d \\end{matrix} \\quad \\begin{Bmatrix} 1 \\\\ 2 \\end{Bmatrix}',
  '\\begin{gathered} x = 1 \\\\ y = 2 \\end{gathered} \\quad \\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}',
  '\\left\\{ \\begin{array}{l} x + y = 2 \\\\ x - y = 0 \\end{array} \\right.',
  '\\ce{H2O}',
  // A long, spacing-heavy line with many built-in macros
  'x_1 \\neq x_2 \\neq x_3 \\neq x_4 \\neq x_5 \\neq x_6 \\neq x_7 \\neq x_8 \\neq x_9 \\neq x_{10} \\iff a \\iff b \\iff c \\iff d \\, \\, \\, \\, \\, \\, \\, \\, \\dots \\dots \\dots \\dots \\cdots \\ldots',
];
