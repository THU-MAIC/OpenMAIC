/**
 * Workbench chat class table — the OpenPBL kimi-chat visual language
 * (`openpbl/.../chat/chat-styles.ts`), re-expressed against the scoped
 * `.wbchat` tokens (see `workbench-chat.css`) for a single-agent surface:
 * the `data-agent` speaker variants and the assistant bubble frame are gone,
 * everything else keeps the source's geometry.
 */
export const wbStyles = {
  statusDot:
    'inline-block size-[7px] shrink-0 rounded-full bg-[var(--wb-text-faint)] data-[kind=ok]:bg-[var(--wb-success)] data-[kind=error]:bg-[var(--wb-danger)] data-[kind=suspended]:bg-[var(--wb-warning)] data-[kind=running]:bg-[var(--wb-accent)] data-[kind=running]:animate-[wb-dot-pulse_1.6s_ease-out_infinite] motion-reduce:data-[kind=running]:animate-none',
  timeline: {
    // Tighter than the OpenPBL source on purpose: the workbench rail is
    // narrower, and the 18px rhythm left tool cards floating in open water
    // next to the prose. 10px reads as one conversation, still with seams.
    root: 'flex flex-col gap-2.5',
  },
  // The idle placeholder (no messages, not running). Whisper register: one
  // step below the composer placeholder (`--wb-text-sm` faint), no card, no
  // chip — it must read quieter than the affordance under it.
  emptyState: {
    root: 'flex flex-col items-center gap-1.5',
    text: 'text-[length:var(--wb-text-xs)] leading-relaxed text-[var(--wb-text-faint)]',
  },
  userBubble: {
    row: 'flex justify-end',
    bubble:
      'flex max-w-[85%] flex-col gap-1.5 whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-primary px-3 py-2 text-[length:var(--wb-text-base)] leading-relaxed text-primary-foreground [overflow-wrap:anywhere]',
    materials: 'flex flex-wrap gap-1',
    // One chip skin for both kinds of attachment inside the bubble (a file, an
    // element reference): 7px radius to match the composer's pill geometry, but
    // drawn in on-primary tints instead of the composer's tones.
    materialChip:
      'inline-flex max-w-[220px] items-center gap-1 rounded-[7px] border border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0.5 text-[11px] leading-4 text-primary-foreground',
    chipOrdinal:
      'grid size-[14px] shrink-0 place-items-center rounded-full bg-primary-foreground/20 font-mono text-[9px] font-semibold tabular-nums',
  },
  /**
   * System notice — everything the run says about itself (a recovery, a queued
   * message, a failed round). Two registers from one class table, switched by
   * `data-tone` on the row:
   *
   *  - `info` / `success`: no frame at all. A 13px icon and one line of muted
   *    12px text, quieter than the agent's prose by a whole step.
   *  - `error`: the tool card's failure skin (hairline `--wb-danger-line`,
   *    `--wb-danger-soft` wash) at notice density. The colour lives in the
   *    icon, the border and the wash — the SENTENCE stays foreground text, so
   *    it reads as a product notice instead of a `console.error` line.
   *
   * Both themes come for free: every colour is a `.wbchat` token mapped onto
   * the app's shadcn variables (`--destructive` flips with `.dark`).
   */
  systemNotice: {
    row: 'flex items-start gap-2 py-0.5 data-[tone=error]:rounded-[var(--wb-radius-md)] data-[tone=error]:border data-[tone=error]:border-[var(--wb-danger-line)] data-[tone=error]:bg-[var(--wb-danger-soft)] data-[tone=error]:px-2.5 data-[tone=error]:py-2',
    // Optically centered on the first line (13px glyph in a 17px line box)
    // rather than hung from its top edge.
    icon: 'mt-[2px] inline-flex shrink-0 items-center text-[var(--wb-text-faint)] data-[tone=error]:text-[var(--wb-danger)] data-[tone=success]:text-[var(--wb-success)]',
    body: 'flex min-w-0 flex-1 flex-col gap-1',
    head: 'flex min-w-0 items-center gap-1.5',
    text: 'min-w-0 text-[length:var(--wb-text-xs)] leading-[17px] text-[var(--wb-text-faint)] [overflow-wrap:anywhere] data-[tone=error]:font-medium data-[tone=error]:text-[var(--wb-text)] data-[tone=success]:text-[var(--wb-success)]',
    count:
      'shrink-0 rounded-[5px] border border-[var(--wb-line)] bg-[var(--wb-surface-sunken)] px-1 py-px text-[11px] leading-4 tabular-nums text-[var(--wb-text-muted)] data-[tone=error]:border-[var(--wb-danger-line)] data-[tone=error]:bg-transparent data-[tone=error]:text-[var(--wb-danger)]',
    hint: 'text-[11px] leading-[17px] text-[var(--wb-text-muted)]',
    // The technical cause, one click away. A text button in the metadata
    // register — no border, no chip: it must not look like the primary action
    // of a failed run (that is the composer).
    disclosure:
      'inline-flex w-fit cursor-pointer items-center gap-0.5 rounded-[var(--wb-radius-sm)] border-0 bg-transparent p-0 font-inherit text-[11px] leading-[17px] text-[var(--wb-text-muted)] transition-colors duration-[var(--wb-duration-base)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] motion-reduce:transition-none',
    detail:
      'm-0 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[var(--wb-radius-sm)] border border-[var(--wb-line)] bg-[var(--wb-surface-raised)] p-2 font-[family-name:var(--wb-font-mono)] text-[11px] leading-[16.5px] text-[var(--wb-text-muted)]',
  },
  // Cancel notice only. Success has no mark; this is a WeChat-style caption
  // (icon + one faint line, centered), not a full-width rule with a label.
  boundary: {
    row: 'flex justify-center py-3',
    inner: 'inline-flex items-center gap-1.5 text-[11px] leading-none text-[var(--wb-text-faint)]',
    icon: 'inline-flex shrink-0 items-center',
    count: 'tabular-nums',
  },
  /**
   * The in-chat course link, both forms — THE one place its look is decided.
   * Degrading the block form to a plain underlined link is an edit to `base` +
   * `block` here and to nothing else.
   *
   * Three states, three weights of one colour, driven by `data-state`:
   * `closed` is neutral ("this exists"), `background` is accent text ("it is
   * open over there"), `active` is an accent wash ("this is what you see") —
   * the same sentence the right pane's active tab and the rail's active row
   * already speak.
   */
  courseLink: {
    /**
     * One resting look and one hover look, for every card. There is no
     * `data-[state=…]` ramp any more: the accent border / wash / text that a
     * background or active tab used to take was a second thing to read on a row
     * whose subject is a course name, and it described the right pane rather
     * than the card.
     */
    base: 'group/clink inline-flex max-w-full items-center gap-1.5 rounded-[var(--wb-radius-sm)] border border-[var(--wb-line)] bg-[var(--wb-surface)] px-2 py-[2px] align-[-4px] text-[length:var(--wb-text-sm)] font-medium text-[var(--wb-text)] transition-colors duration-[var(--wb-duration-base)] hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent-soft)] hover:text-[var(--wb-accent)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] motion-reduce:transition-none',
    block:
      'mt-2 flex w-full max-w-[440px] gap-2 rounded-[var(--wb-radius-md)] px-2.5 py-2 text-left',
    glyph: 'size-[13px] shrink-0 text-[var(--wb-accent)]',
    /**
     * One exchange's cards, stacked. No `gap`: `block` already carries its own
     * top margin, so one spacing rule owns the distance between a card and
     * whatever is above it — the prose, or the card before it.
     */
    set: 'flex flex-col',
    /**
     * The `+N` disclosure. The SAME card box, deliberately quieter: it is not a
     * classroom, it is the rest of the list, so nothing about it is accent until
     * hover (which `base` already provides).
     */
    more: 'text-[var(--wb-text-muted)] [&>svg]:text-[var(--wb-text-faint)]',
    name: 'min-w-0 truncate',
    /**
     * The page count, at the far edge — `ml-auto` because it is now the only
     * thing after the name, and the row still has to put it against the right
     * rule rather than beside the title. The quietest type on the card.
     */
    pages:
      'ml-auto shrink-0 text-[length:var(--wb-text-xs)] font-normal text-[var(--wb-text-muted)] group-hover/clink:text-[var(--wb-accent)]',
  },
  thinking: {
    box: 'group/thinking m-0 overflow-hidden rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface)] transition-colors duration-[var(--wb-duration-base)] data-[stack=first]:rounded-none data-[stack=first]:border-0 data-[stack=middle]:rounded-none data-[stack=middle]:border-0 data-[stack=middle]:border-t data-[stack=middle]:border-[var(--wb-line)] data-[stack=last]:rounded-none data-[stack=last]:border-0 data-[stack=last]:border-t data-[stack=last]:border-[var(--wb-line)]',
    head: 'flex min-h-[var(--wb-bar-min-h)] w-full cursor-pointer items-center gap-[var(--wb-bar-gap)] rounded-none border-0 bg-transparent px-[var(--wb-bar-pad-x)] text-left font-inherit text-[length:var(--wb-text-sm)] text-[var(--wb-text)] hover:bg-[var(--wb-surface-sunken)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] group-data-[open=true]/thinking:bg-[var(--wb-surface-sunken)]',
    icon: 'inline-flex shrink-0 items-center text-[var(--wb-text-faint)]',
    text: 'flex min-w-0 flex-1 items-baseline gap-[var(--wb-bar-gap)]',
    name: 'shrink-0 font-medium text-[var(--wb-text-muted)] group-data-[streaming]/thinking:animate-[wb-think-pulse_1.6s_ease-in-out_infinite] motion-reduce:group-data-[streaming]/thinking:animate-none',
    arg: 'min-w-0 flex-1 truncate text-[length:var(--wb-text-xs)] text-[var(--wb-text-faint)]',
    car: 'inline-flex shrink-0 items-center text-[var(--wb-text-faint)]',
    body: 'flex flex-col gap-2 px-[var(--wb-bar-pad-x)] pb-[var(--wb-bar-pad-x)] pt-2',
    detail:
      'm-0 max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-inherit text-[length:var(--wb-text-sm)] leading-relaxed text-[var(--wb-text-muted)]',
  },
  toolCard: {
    box: 'group/tool m-0 overflow-hidden rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface)] transition-colors duration-[var(--wb-duration-base)] data-[kind=skill]:border-[color-mix(in_srgb,var(--wb-accent)_40%,var(--wb-line))] data-[kind=skill]:bg-[var(--wb-accent-soft)] data-[status=failed]:border-[var(--wb-danger-line)] data-[stack=first]:rounded-none data-[stack=first]:border-0 data-[stack=middle]:rounded-none data-[stack=middle]:border-0 data-[stack=middle]:border-t data-[stack=middle]:border-[var(--wb-line)] data-[stack=last]:rounded-none data-[stack=last]:border-0 data-[stack=last]:border-t data-[stack=last]:border-[var(--wb-line)]',
    head: 'flex min-h-[var(--wb-bar-min-h)] w-full cursor-pointer items-center gap-[var(--wb-bar-gap)] border-0 bg-transparent px-[var(--wb-bar-pad-x)] text-left text-[length:var(--wb-text-sm)] text-[var(--wb-text)] hover:not-disabled:bg-[var(--wb-surface-sunken)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] disabled:cursor-default group-data-[open=true]/tool:bg-[var(--wb-surface-sunken)] group-data-[status=failed]/tool:bg-[var(--wb-danger-soft)]',
    status:
      'inline-flex shrink-0 items-center data-[status=ok]:text-[var(--wb-success)] data-[status=error]:text-[var(--wb-danger)]',
    icon: 'inline-flex shrink-0 items-center text-[var(--wb-text-faint)] group-data-[kind=skill]/tool:text-[var(--wb-accent)]',
    text: 'flex min-w-0 flex-1 items-baseline gap-2',
    name: 'shrink-0 font-medium text-[var(--wb-text)] group-data-[kind=skill]/tool:text-[var(--wb-accent)]',
    arg: 'min-w-0 flex-1 truncate text-[length:var(--wb-text-xs)] text-[var(--wb-text-muted)]',
    progressTick:
      'min-w-0 flex-1 truncate text-[length:var(--wb-text-xs)] text-[var(--wb-text-muted)] motion-safe:animate-[wb-progress-tick_220ms_var(--wb-ease-out)]',
    time: 'shrink-0 text-[length:var(--wb-text-xs)] text-[var(--wb-text-faint)]',
    car: 'inline-flex shrink-0 items-center text-[var(--wb-text-faint)]',
    body: 'flex flex-col gap-2.5 px-[var(--wb-bar-pad-x)] pb-[var(--wb-bar-pad-x)] pt-2',
    section: 'flex flex-col gap-1',
    sectionLabel: 'text-[length:var(--wb-text-xs)] text-[var(--wb-text-muted)]',
    chip: 'inline-flex shrink-0 items-center rounded-[5px] border border-[var(--wb-line)] bg-[var(--wb-surface-sunken)] px-1.5 py-px text-[length:var(--wb-text-xs)] text-[var(--wb-text-muted)] data-[tone=accent]:border-[var(--wb-accent)] data-[tone=accent]:text-[var(--wb-accent)] data-[tone=warn]:border-[var(--wb-warning)] data-[tone=warn]:text-[var(--wb-warning)]',
    payload:
      'm-0 overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface-raised)] p-2.5 font-[family-name:var(--wb-font-mono)] text-[length:var(--wb-text-xs)] text-[var(--wb-text)]',
    output:
      'max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface-raised)] p-2.5 font-[family-name:var(--wb-font-mono)] text-[length:var(--wb-text-xs)] text-[var(--wb-text)] data-[error=true]:text-[var(--wb-danger)]',
  },
  /**
   * The question card (`ask_user`) — the one row on the timeline that is
   * WAITING FOR THE USER, so it sits one notch above a system line and one
   * notch below the agent's prose: a bordered card like a tool card, but with
   * the accent hairline and the faint accent wash that the rest of the rail
   * reserves for "this is yours to act on".
   *
   * `data-answered=true` retires it in place, to the neutral card skin every
   * other settled row wears — the transcript must not keep shouting a decision
   * the user already made. That flag drives EVERY difference between the two
   * states, so the card cannot look live and behave dead.
   */
  questionCard: {
    box: 'group/question flex flex-col gap-2 rounded-[var(--wb-radius-md)] border border-[var(--wb-accent-line)] bg-[var(--wb-accent-soft)] px-3 py-2.5 transition-colors duration-[var(--wb-duration-base)] motion-reduce:transition-none data-[answered=true]:border-[var(--wb-line)] data-[answered=true]:bg-[var(--wb-surface)]',
    head: 'flex items-center gap-1.5 text-[length:var(--wb-text-xs)] font-medium text-[var(--wb-accent)] group-data-[answered=true]/question:font-normal group-data-[answered=true]/question:text-[var(--wb-text-faint)]',
    glyph: 'size-[13px] shrink-0',
    question:
      'whitespace-pre-wrap break-words text-[length:var(--wb-text-base)] leading-relaxed text-[var(--wb-text)] [overflow-wrap:anywhere] group-data-[answered=true]/question:text-[var(--wb-text-muted)]',
    options: 'flex flex-wrap gap-1.5',
    // One button skin for both pick modes: `data-picked` is the multi-select
    // checked state, and a disabled button keeps the shape but drops every
    // hover affordance — a dead button that still lights up is a lie.
    option:
      'inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-[var(--wb-radius-sm)] border border-[var(--wb-line)] bg-[var(--wb-surface)] px-2.5 py-1 text-left text-[length:var(--wb-text-sm)] text-[var(--wb-text)] transition-colors duration-[var(--wb-duration-base)] hover:not-disabled:border-[var(--wb-accent)] hover:not-disabled:bg-[var(--wb-accent-soft)] hover:not-disabled:text-[var(--wb-accent)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] disabled:cursor-default disabled:text-[var(--wb-text-muted)] disabled:opacity-70 motion-reduce:transition-none data-[picked=true]:border-[var(--wb-accent)] data-[picked=true]:bg-[var(--wb-accent-soft)] data-[picked=true]:font-medium data-[picked=true]:text-[var(--wb-accent)]',
    optionLabel: 'min-w-0 truncate',
    optionCheck: 'size-[13px] shrink-0',
    footer: 'flex items-center gap-2',
    // The multi-select commit. The composer's send button in text form, so
    // "confirm" reads as the same act as pressing send.
    confirm:
      'inline-flex cursor-pointer items-center rounded-[var(--wb-radius-full)] border-0 bg-primary px-3 py-1 text-[length:var(--wb-text-sm)] font-medium text-primary-foreground transition-colors duration-[var(--wb-duration-base)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none',
    hint: 'text-[length:var(--wb-text-xs)] leading-[17px] text-[var(--wb-text-muted)] group-data-[answered=true]/question:text-[var(--wb-text-faint)]',
    // Only on the one card whose composer form the user waved off: the way back
    // to it. A text button, because the options right above it are the primary
    // way to answer and this is a second route to the same place.
    revive:
      'inline-flex cursor-pointer items-center rounded-[var(--wb-radius-sm)] border-0 bg-transparent px-1 py-0.5 text-[length:var(--wb-text-xs)] font-medium text-[var(--wb-accent)] transition-colors duration-[var(--wb-duration-base)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] motion-reduce:transition-none',
    /**
     * The row while the form below owns the question: one line, no frame, no
     * wash. It is a bookmark in the transcript ("the hand-over happened here"),
     * and the form two centimetres below it is the thing to read — so this must
     * not read as a second place to answer.
     */
    summaryBox: 'group/question flex flex-col px-3 py-1',
    summaryPointer: 'font-normal text-[var(--wb-text-faint)]',
  },
  /**
   * The question form — `ask_user` WEARING THE COMPOSER. It swaps in where the
   * input box was, so it borrows that box's frame exactly (same 2xl radius, same
   * surface, same shadow) and changes one thing: the hairline goes accent, which
   * is the rail's whole vocabulary for "this one is yours to act on".
   *
   * No elevation of its own, no colour of its own, no second type scale. A
   * takeover that also shouted would read as a modal, and this blocks nothing —
   * the dismiss control hands the box straight back.
   *
   * Both scroll caps exist for one reason: the composer's footer is
   * bottom-anchored, so a form that grew without bound would grow off the top of
   * the viewport. A long question scrolls (~22vh) and a long option list scrolls
   * (~34vh); the footer with the submit control is never among what scrolls away.
   */
  questionForm: {
    box: 'flex flex-col gap-2.5 rounded-2xl border border-[var(--wb-accent-line)] bg-[var(--wb-surface)] px-3 py-3 shadow-[0_10px_32px_-14px_rgba(15,23,42,0.22)] motion-safe:animate-[wb-form-fade_var(--wb-duration-base)_var(--wb-ease-out)] motion-reduce:animate-none dark:shadow-[0_12px_36px_-12px_rgba(0,0,0,0.55)]',
    // The question is the form's title, so it carries the weight a title does —
    // the one place in the rail where prose is bold.
    question:
      'max-h-[22vh] overflow-y-auto whitespace-pre-wrap break-words text-[length:var(--wb-text-base)] font-semibold leading-relaxed text-[var(--wb-text)] [overflow-wrap:anywhere]',
    rows: 'flex max-h-[34vh] flex-col gap-1 overflow-y-auto',
    /**
     * One row = one decision. The frame lives on the wrapper (not the button)
     * because the "other" row grows a text box inside the same frame, and its
     * highlight/picked states have to cover both.
     *
     * `data-highlight` is the keyboard's position and `data-picked` is the
     * answer: a wash for the pick, a hairline for where the keys are. They are
     * separate because ↑↓ moves through rows without choosing any of them.
     */
    row: 'group/qrow flex flex-col rounded-[var(--wb-radius-md)] border border-transparent transition-colors duration-[var(--wb-duration-base)] hover:bg-[var(--wb-surface-sunken)] data-[highlight=true]:border-[var(--wb-line)] data-[highlight=true]:bg-[var(--wb-surface-sunken)] data-[picked=true]:border-[var(--wb-accent-line)] data-[picked=true]:bg-[var(--wb-accent-soft)] motion-reduce:transition-none',
    rowButton:
      'flex w-full cursor-pointer items-start gap-2 rounded-[var(--wb-radius-md)] border-0 bg-transparent px-2 py-[7px] text-left text-[length:var(--wb-text-sm)] leading-relaxed text-[var(--wb-text)] focus-visible:outline-none disabled:cursor-default disabled:opacity-60',
    // The digit shortcut, as a number and nothing more: a filled badge here would
    // compete with the pick mark two millimetres to its right.
    badge:
      'mt-[2px] inline-flex size-[15px] shrink-0 items-center justify-center rounded-[4px] bg-[var(--wb-surface-sunken)] font-[family-name:var(--wb-font-mono)] text-[10px] leading-none text-[var(--wb-text-faint)] group-data-[picked=true]/qrow:text-[var(--wb-accent)]',
    // Radio in single-choice mode, checkbox in multi — the shape IS the "how many
    // may I pick" answer, before any hint sentence. The inset ring is the radio's
    // filled centre; the checkbox gets a glyph instead.
    mark: 'mt-[2px] inline-flex size-[15px] shrink-0 items-center justify-center rounded-full border border-[var(--wb-line)] text-primary-foreground transition-colors duration-[var(--wb-duration-base)] data-[multi=true]:rounded-[4px] data-[picked=true]:border-[var(--wb-accent)] data-[picked=true]:bg-[var(--wb-accent)] data-[multi=false]:data-[picked=true]:shadow-[inset_0_0_0_3px_var(--wb-surface)] motion-reduce:transition-none',
    label: 'min-w-0 flex-1 [overflow-wrap:anywhere]',
    // The free-text box on the "other" row: underline only, so it reads as part
    // of the row it belongs to instead of a second boxed control inside a box.
    otherInput:
      'mx-2 mb-1.5 ml-[54px] block w-auto border-0 border-b border-[var(--wb-accent-line)] bg-transparent px-0 py-1 text-[length:var(--wb-text-sm)] leading-relaxed text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-faint)] focus:border-[var(--wb-accent)] disabled:opacity-60',
    // An open question's whole answer surface: the composer's own textarea skin,
    // because that is literally what it replaces.
    openInput:
      'box-border block min-h-[76px] w-full resize-none rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-transparent px-2.5 py-2 font-inherit text-[length:var(--wb-text-sm)] leading-relaxed text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-faint)] focus:border-[var(--wb-accent)] disabled:opacity-60',
    footer: 'flex flex-wrap items-center gap-2',
    // `data-highlight` paints the keyboard's position here too: a programmatic
    // .focus() does not always count as focus-visible, so the ring cannot be the
    // only thing that says "Enter would press this".
    submit:
      'inline-flex cursor-pointer items-center rounded-[var(--wb-radius-full)] border-0 bg-primary px-3.5 py-1 text-[length:var(--wb-text-sm)] font-medium text-primary-foreground transition-colors duration-[var(--wb-duration-base)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none data-[highlight=true]:shadow-[var(--wb-focus-ring)]',
    // A way out, not a competing action: text weight, no frame.
    dismiss:
      'inline-flex cursor-pointer items-center rounded-[var(--wb-radius-sm)] border-0 bg-transparent px-1.5 py-1 text-[length:var(--wb-text-sm)] text-[var(--wb-text-muted)] transition-colors duration-[var(--wb-duration-base)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)] motion-reduce:transition-none',
    keys: 'ml-auto text-[length:var(--wb-text-xs)] leading-[17px] text-[var(--wb-text-faint)]',
  },
  actionCluster: {
    root: 'flex flex-col overflow-hidden rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface)]',
    withWait: 'flex flex-col gap-1',
  },
  toolGroup: {
    group:
      'group/tool-group flex flex-col overflow-hidden rounded-[var(--wb-radius-md)] border border-[var(--wb-line)] bg-[var(--wb-surface)] data-[kind=skill]:border-[color-mix(in_srgb,var(--wb-accent)_40%,var(--wb-line))] data-[kind=skill]:bg-[var(--wb-accent-soft)]',
    head: 'flex h-8 w-full cursor-pointer select-none items-center gap-[var(--wb-bar-gap)] border-0 bg-transparent px-[var(--wb-bar-pad-x)] text-left text-[length:var(--wb-text-sm)] text-[var(--wb-text-muted)] hover:bg-[var(--wb-surface-sunken)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus-ring)]',
    icon: 'inline-flex shrink-0 items-center text-[var(--wb-text-faint)] group-data-[kind=skill]/tool-group:text-[var(--wb-accent)]',
    title:
      'font-medium text-[var(--wb-text)] group-data-[kind=skill]/tool-group:text-[var(--wb-accent)]',
    meta: 'text-[var(--wb-text-faint)]',
    car: 'ml-auto inline-flex shrink-0 items-center text-[var(--wb-text-faint)] transition-transform duration-[var(--wb-duration-base)] group-data-[open=true]/tool-group:rotate-90',
    // The fold: one clipped grid row going 0fr → 1fr. `1fr` in an auto-height
    // grid resolves to the content's own height, so the transition needs no
    // measured pixel value and no max-height guess.
    bodyRow:
      'grid grid-rows-[0fr] transition-[grid-template-rows] duration-[var(--wb-duration-fold)] ease-[var(--wb-ease-out)] group-data-[open=true]/tool-group:grid-rows-[1fr] motion-reduce:transition-none',
    // The clipped child (`min-h-0` so the 0fr row can actually reach zero).
    // The cards also fade, one step quicker than the height, so the list does
    // not appear to slide out from under the head's edge.
    body: 'flex min-h-0 flex-col overflow-hidden opacity-0 transition-opacity duration-[var(--wb-duration-base)] ease-[var(--wb-ease-out)] group-data-[open=true]/tool-group:opacity-100 motion-reduce:transition-none',
  },
  waiting: {
    root: 'inline-flex items-center py-1',
    dots: 'inline-flex gap-1',
    dot: 'size-[5px] rounded-full bg-[var(--wb-text-faint)] animate-[wb-wait-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:opacity-60',
    dotDelayOne:
      'size-[5px] rounded-full bg-[var(--wb-text-faint)] animate-[wb-wait-pulse_1.2s_ease-in-out_0.15s_infinite] motion-reduce:animate-none motion-reduce:opacity-60',
    dotDelayTwo:
      'size-[5px] rounded-full bg-[var(--wb-text-faint)] animate-[wb-wait-pulse_1.2s_ease-in-out_0.3s_infinite] motion-reduce:animate-none motion-reduce:opacity-60',
  },
  composer: {
    inputBox:
      'relative rounded-2xl border border-[var(--wb-line)] bg-[var(--wb-surface)] shadow-[0_10px_32px_-14px_rgba(15,23,42,0.22)] transition duration-150 focus-within:border-[var(--wb-accent)] focus-within:shadow-[var(--wb-focus-ring),0_10px_32px_-14px_rgba(15,23,42,0.22)] dark:shadow-[0_12px_36px_-12px_rgba(0,0,0,0.55)]',
    /**
     * Everything attached to the next message, INSIDE the box it is attached to.
     *
     * It used to be a stack of rows above the box, inside a composer that floated
     * over the transcript against a fixed `pb-36` reserve — so the moment a pill
     * row appeared the composer grew past the reserve and the pills sat on top of
     * unread messages. Now the composer is in flow (see `composerLayout`) and the
     * rows are part of the box: the context cannot overlap the conversation
     * because it is not over it, and it is visibly attached to the sentence it
     * qualifies rather than hovering near it.
     *
     * Many pills wrap; past four rows' worth the block scrolls instead of pushing
     * the textarea off the surface. It IS the row (`ComposerPillRow`) rather than
     * a stack of one row per kind — this only tunes its padding and its ceiling.
     */
    context: 'max-h-[92px] overflow-y-auto px-2 pb-1 pt-2',
    input:
      'box-border block min-h-[62px] w-full resize-none rounded-lg border-0 bg-transparent px-3 pb-10 pt-2.5 font-inherit text-[length:var(--wb-text-sm)] leading-relaxed text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-text-faint)] disabled:opacity-60',
    actionsLeft: 'absolute bottom-2 left-2 z-10 flex items-center',
    actionsRow: 'absolute bottom-2 right-2 z-10 flex items-center',
    sendAction:
      'inline-flex size-[30px] cursor-pointer items-center justify-center rounded-full border-0 bg-primary p-0 text-primary-foreground transition-colors duration-150 disabled:cursor-default disabled:opacity-40',
    stopAction:
      'inline-flex size-[30px] cursor-pointer items-center justify-center rounded-full border-0 bg-[var(--wb-danger-soft)] p-0 text-[var(--wb-danger)] transition-colors duration-150 hover:not-disabled:bg-[var(--wb-danger)] hover:not-disabled:text-primary-foreground disabled:cursor-default disabled:opacity-50',
    /**
     * The seam between transcript and composer. The composer is opaque and in
     * flow, so this is a 12px fade over the scroll viewport's own bottom padding
     * — enough that text scrolling past does not end on a hard edge, never enough
     * to veil a line (`scrollPadding` keeps the last line clear of it).
     */
    seamFade:
      'pointer-events-none absolute inset-x-0 -top-3 h-3 bg-gradient-to-t from-background to-transparent',
  },
  // The vertical offset is the caller's, so one style serves both composer modes.
  scrollToBottom:
    'absolute left-1/2 z-30 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border border-[var(--wb-line)] bg-[var(--wb-surface-raised)] px-2.5 py-1 text-[length:var(--wb-text-xs)] text-[var(--wb-text-muted)] shadow-sm transition-colors hover:text-[var(--wb-text)]',
} as const;

/**
 * Where the composer sits — the one rule that decides whether the transcript can
 * be hidden behind it.
 *
 * It JOINS THE LAYOUT, in both modes: opaque, in flow, `shrink-0`, and the scroll
 * viewport ends exactly where the composer begins, so every message can be
 * scrolled into the clear.
 *
 * The ordinary composer used to float over the transcript instead, against a
 * fixed `pb-36` reserve in the scroll viewport. That reserve was a bet on the
 * composer's height — and the composer is not a fixed height: attach a material,
 * reference three slide elements, load a skill, and it grows straight over unread
 * messages. A question's answer form (`form`) had already been moved into the flow
 * for exactly this reason; the same argument was always true of the input, so the
 * two modes now share one geometry and only their padding differs.
 */
export function composerLayout(formOpen: boolean): {
  mode: 'form' | 'input';
  /** The scroll viewport's own bottom reserve. */
  scrollPadding: string;
  footer: string;
  jumpButtonOffset: string;
} {
  return {
    mode: formOpen ? 'form' : 'input',
    scrollPadding: 'pb-4',
    footer: 'relative shrink-0 bg-background pb-3 pt-2',
    jumpButtonOffset: 'bottom-3',
  };
}
