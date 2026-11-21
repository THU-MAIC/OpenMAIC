### Speech Must Be TTS-Readable (Must Follow Strictly)

Every `type:"text"` object drives both the visual script/caption (rendered with inline KaTeX in the classroom, timeline script, and HTML player) and the text-to-speech engine. Write speech in the teaching language.

1. Write **EVERY** mathematical formula, equation, series expansion, function expression (`$e^x$`, `$\sin x$`, `$\cos x$`, `$\ln(x+1)$`, `$f(x)$`, `$f'(x)$`, `$f^{(n)}(a)$`), power/subscript/factorial (`$x^2$`, `$x_n$`, `$n!$`), algebraic fraction (`$\frac{a}{b}$`, `$\frac{x^3}{3!}$`), root, limit, integral, sum, vector, matrix, inequality, or substituted calculation (`$x = 0$`, `$1 + 1 + \frac{1}{2} = 2.5$`) as an **inline pair** `[[$<LaTeX>$ | <spoken reading>]]`:
   - Left of `|`: inline `$...$` LaTeX for the visual script and caption. Inside JSON strings, **always double-escape backslashes** (`\\frac`, `\\sqrt`, `\\sin`, `\\cos`, `\\ln`, `\\lim`, `\\sum`, `\\Delta`, `\\to`, `\\cdots`).
   - Right of `|`: natural spoken words in the teaching language for TTS — no LaTeX, no code-style math. Resolve context-dependent readings here (e.g. `[[$A^T$ | 矩阵 A 的转置]]`, `[[$f^{-1}(x)$ | f 的反函数 x]]`, `[[$C_n^k$ | C n k]]`).
   - **NEVER flatten a mathematical expression into prose-only words** — keep real math notation on the left of `|` so learners can read the formula visually:
     - WRONG: `"e 的 x 次方展开是一加 x 加 x 平方除以二阶乘，正弦 x 的展开是 x 减 x 的三次方除以三阶乘"`
     - RIGHT: `"[[$e^x = 1 + x + \\frac{x^2}{2!} + \\cdots$ | e 的 x 次方等于 1 加 x 加二阶乘分之 x 的平方，一直加下去]]，[[$\\sin x = x - \\frac{x^3}{3!} + \\cdots$ | sin x 等于 x 减三阶乘分之 x 的三次方，一直加下去]]"`
     - More examples: `"[[$E = mc^2$ | E equals m c squared]]"`, `"[[$\\frac{a}{b}$ | b 分之 a]]"`, `"在 [[$x = 0$ | x 等于 0]] 处"`, `"导数的定义是 [[$f'(x) = \\lim_{\\Delta x \\to 0} \\frac{\\Delta y}{\\Delta x}$ | f 撇 x 等于，当德尔塔 x 趋近于零时，德尔塔 y 比德尔塔 x 的极限]]。"`.
   - NEVER put unpaired formula notation, bare `\frac{a}{b}`, `a^2 x / y`, `x_1`, or code-style math outside `[[$...$ | ...]]`.
2. When slide elements include `Formula: …` or `Table: …` entries with mathematical expressions and your narration states, quotes, or walks through any expression from them, **always write each expression as `[[$<LaTeX>$ | <spoken reading>]]`** (never copy bare unpaired LaTeX into prose, and never flatten those formulas into plain words).
3. Outside `$...$` (and on the spoken side right of `|`), write standalone prose operators, arrows, and units the way a teacher says them: `→` "leads to", `≥` "greater than or equal to", `%` "percent", `m/s²` "meters per second squared".
4. Plain numbers, dates, and simple decimals in non-formula prose may stay as digits (e.g. "3", "2026", "9.8").
5. In prose and on the spoken side right of `|`, write Greek letters and named constants as the standard symbol, never as a phonetic homophone or transliteration. A homophone is the wrong word on screen. In Chinese write "从负π到正π" and "一除以π", never "负派到正派" or "一除以派". In English write "from negative π to positive π" and "one divided by π". The same applies to `θ`, `α`, `β`, `λ`, `ω`, `Σ`, and the constant `e` (write `e`, not a spelled-out syllable). For example, on the spoken side write `"π r 的平方"` or `"π r squared"`.
6. Apart from `$...$` inside `[[$...$ | ...]]` (rule 1), digits (rule 4), and the symbols in rule 5, speech must be pronounceable words.

### Speaking in the teaching language

Use the course's teaching language for every spoken reading, including the opening sentence. Bilingual courses may switch languages as requested. Name the base of a binary or hexadecimal number wherever the reading would be ambiguous. Separate adjacent variables and explain code operators in ordinary speech. Use short clauses and natural pauses for the language and the learner. Start with a brief orientation when it fits the lesson.

{{#if mandarinNarration}}
For Mandarin narration only, use natural measure words and classroom readings, for example “两倍”, “百分之八十五”, “四分之三” and “x 的平方”. When the lesson actually teaches Mandarin pronunciation, distinguish initials, finals and syllables in the teaching language. Show tone marks in pinyin, explain neutral tone when relevant, and introduce a character’s uncommon reading in context. In an English-language pinyin lesson, for example, say “The initial is b.” Other subjects and languages follow their own spelling and pronunciation conventions.
{{/if}}
