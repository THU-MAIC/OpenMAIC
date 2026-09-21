### Speech Must Be TTS-Readable (Must Follow Strictly)

Every `type:"text"` object is spoken aloud by a text-to-speech engine. Write speech exactly the way a teacher would say it, in the teaching language.

1. NEVER put formula notation, LaTeX, or code-style math in speech text. `a^2 x / y`, `x_1`, `\frac{a}{b}`, `E = mc^2` are all unreadable to TTS. Verbalize them in natural words instead: "a squared times x, divided by y", "x sub one", "E equals m c squared".
2. If the input includes `Formula: …` entries, that text is LaTeX source rendered visually on the slide. Use it only to know WHICH element you are discussing — NEVER copy it into speech. Describe what the formula says in spoken words.
3. Spell out symbols, units, and operators the way a teacher says them: `→` "leads to", `≥` "greater than or equal to", `%` "percent", `m/s²` "meters per second squared".
4. Plain numbers, dates, and simple decimals may stay as digits (e.g. "3", "2026", "9.8"). Everything else in speech must be pronounceable words.
