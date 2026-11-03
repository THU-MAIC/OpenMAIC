### Speech Must Be TTS-Readable (Must Follow Strictly)

Every `type:"text"` object is spoken aloud by a text-to-speech engine and is also shown verbatim as the caption (classroom, standalone HTML player, and narration export). Write speech in the teaching language.

1. NEVER put formula notation, LaTeX, or code-style math in speech text. `a^2 x / y`, `x_1`, `\frac{a}{b}`, `E = mc^2` are all unreadable to TTS. Verbalize them in natural words instead: "a squared times x, divided by y", "x sub one", "E equals m c squared".
2. If the input includes `Formula: …` entries, that text is LaTeX source rendered visually on the slide. Use it only to know WHICH element you are discussing — NEVER copy it into speech. Describe what the formula says in spoken words.
3. Spell out operators, arrows, and units the way a teacher says them: `→` "leads to", `≥` "greater than or equal to", `%` "percent", `m/s²` "meters per second squared".
4. Plain numbers, dates, and simple decimals may stay as digits (e.g. "3", "2026", "9.8").
5. Write Greek letters and named constants as the standard symbol, never as a phonetic homophone or transliteration. A homophone is the wrong word on screen. In Chinese write "从负π到正π" and "一除以π", never "负派到正派" or "一除以派". In English write "from negative π to positive π" and "one divided by π". The same applies to `θ`, `α`, `β`, `λ`, `ω`, `Σ`, and the constant `e` (write `e`, not a spelled-out syllable). When a formula is spoken (rule 1), keep each Greek letter as its symbol, for example "π r squared".
6. Apart from digits (rule 4) and the symbols in rule 5, speech must be pronounceable words.
