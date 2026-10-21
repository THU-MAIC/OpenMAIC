## Math typesetting

The platform loads KaTeX into every interactive page and typesets math wherever it appears, including text your scripts add or change after the page loads. Write math as LaTeX between `\(` and `\)` for inline math or `\[` and `\]` for display math, and leave typesetting to the platform. Do not load KaTeX, MathJax or any other math library yourself, and do not call their functions: the page can run where such a copy never loads, and a call into a missing library stops the page's script.
