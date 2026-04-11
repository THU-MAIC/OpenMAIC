'use client';

import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { PPTCodeElement, CodeLine } from '@/lib/types/slides';

// ==================== Shiki Singleton ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let highlighterPromise: Promise<any> | null = null;

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({
        themes: ['github-light'],
        langs: [
          'python',
          'javascript',
          'typescript',
          'json',
          'go',
          'rust',
          'java',
          'c',
          'cpp',
          'html',
          'css',
          'bash',
          'sql',
          'yaml',
          'markdown',
          'jsx',
          'tsx',
        ],
      }),
    );
  }
  return highlighterPromise;
}

// ==================== Helpers ====================

/**
 * Parse Shiki HTML output into per-line HTML fragments.
 * Shiki outputs: <pre ...><code><span class="line">...</span>\n...</code></pre>
 * We split by `<span class="line">` boundaries and strip the trailing `</span>`.
 */
function parseShikiLines(html: string): string[] {
  const codeMatch = html.match(/<code>([\s\S]*?)<\/code>/);
  if (!codeMatch) return [];

  const parts = codeMatch[1].split('<span class="line">');
  const lines: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const endIdx = part.lastIndexOf('</span>');
    if (endIdx !== -1) {
      lines.push(part.substring(0, endIdx));
    }
  }
  return lines;
}

// ==================== Types ====================

export interface BaseCodeElementProps {
  elementInfo: PPTCodeElement;
  animate?: boolean;
}

interface LineAnimationState {
  type: 'typing' | 'inserted' | 'replaced';
  timestamp: number;
}

// ==================== Typing Easing ====================

const STUTTER_COUNT = 5;
const STUTTER_AMOUNT = 0.04;
const LINE_GAP_MS = 120;
const TAB_SIZE = 4;

function visualLength(s: string): number {
  let len = 0;
  for (const ch of s) {
    len += ch === '\t' ? TAB_SIZE : 1;
  }
  return len;
}

function getTypingCharCount(content: string): number {
  const trimmed = content.replace(/^[\t ]+/, '');
  return trimmed.length;
}

function computeRevealSteps(content: string): number[] {
  const total = visualLength(content);
  if (total === 0) return [1];

  const trimmed = content.replace(/^[\t ]+/, '');
  const indentPart = content.slice(0, content.length - trimmed.length);

  let cumVisual = 0;
  for (const ch of indentPart) {
    cumVisual += ch === '\t' ? TAB_SIZE : 1;
  }

  const steps: number[] = [cumVisual / total];

  for (const ch of trimmed) {
    cumVisual += ch === '\t' ? TAB_SIZE : 1;
    steps.push(cumVisual / total);
  }

  return steps;
}

function humanTypingEase(t: number): number {
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
  const stutter = Math.sin(t * Math.PI * STUTTER_COUNT) * STUTTER_AMOUNT * 4 * t * (1 - t);
  return Math.min(Math.max(eased + stutter, 0), 1);
}

// ==================== TypingReveal ====================

function TypingReveal({
  html,
  durationMs,
  revealSteps,
  onComplete,
}: {
  html: string;
  durationMs: number;
  revealSteps: number[];
  onComplete: () => void;
}) {
  const typingUnitCount = revealSteps.length - 1;

  const [revealPct, setRevealPct] = useState(revealSteps[0]);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (typingUnitCount <= 0) {
      const t = setTimeout(() => {
        setRevealPct(1);
        onComplete();
      }, 0);
      return () => clearTimeout(t);
    }

    startRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - startRef.current;
      const linearT = Math.min(elapsed / durationMs, 1);
      const easedProgress = humanTypingEase(linearT);

      const stepIdx = Math.min(Math.floor(easedProgress * (typingUnitCount + 1)), typingUnitCount);

      setRevealPct(revealSteps[stepIdx]);

      if (linearT < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setRevealPct(1);
        onComplete();
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [durationMs, typingUnitCount, revealSteps, onComplete]);

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        style={{
          clipPath: `inset(0 ${(1 - revealPct) * 100}% 0 0)`,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {revealPct < 1 && (
        <span
          className="absolute top-0 w-[2px] bg-gray-800"
          style={{
            left: `${revealPct * 100}%`,
            height: '1.1em',
            animation: 'code-cursor-blink 0.6s step-end infinite',
          }}
        />
      )}
    </span>
  );
}

// ==================== CodeLineRow ====================

function getTypingDuration(content: string): number {
  return Math.max(getTypingCharCount(content) * 40, 250);
}

const REPLACE_SELECT_MS = 350;

function CodeLineRow({
  line,
  lineNumber,
  highlightedHtml,
  showLineNumbers,
  animState,
  animate,
  typingDelay,
}: {
  line: CodeLine;
  lineNumber: number;
  highlightedHtml: string;
  showLineNumbers: boolean;
  animState?: LineAnimationState;
  animate: boolean;
  typingDelay: number;
}) {
  const isNewLine = animate && !!animState && animState.type !== 'replaced';
  const isReplace = animate && animState?.type === 'replaced';

  const [mounted, setMounted] = useState(!isNewLine || typingDelay === 0);

  useEffect(() => {
    if (isNewLine && typingDelay > 0) {
      const timer = setTimeout(() => setMounted(true), typingDelay);
      return () => clearTimeout(timer);
    }
  }, [isNewLine, typingDelay]);

  const [typing, setTyping] = useState(isNewLine && typingDelay === 0);

  useEffect(() => {
    if (mounted && isNewLine) {
      const t = setTimeout(() => setTyping(true), 0);
      return () => clearTimeout(t);
    }
  }, [mounted, isNewLine]);

  const handleTypingComplete = useCallback(() => {
    setTyping(false);
  }, []);

  const prevHtmlRef = useRef(highlightedHtml);
  const [replacePhase, setReplacePhase] = useState<'idle' | 'select' | 'type'>('idle');
  const [oldHtml, setOldHtml] = useState<string | null>(null);

  useEffect(() => {
    if (isReplace && prevHtmlRef.current !== highlightedHtml) {
      setOldHtml(prevHtmlRef.current);
      setReplacePhase('select');
      const timer = setTimeout(() => {
        setReplacePhase('type');
        setTyping(true);
        setOldHtml(null);
        prevHtmlRef.current = highlightedHtml;
      }, REPLACE_SELECT_MS);
      return () => clearTimeout(timer);
    }
    prevHtmlRef.current = highlightedHtml;
  }, [isReplace, highlightedHtml]);

  const [highlight, setHighlight] = useState<string | null>(() => {
    if (!animState) return null;
    if (animState.type === 'inserted') return 'rgba(34, 197, 94, 0.12)';
    return null;
  });

  useEffect(() => {
    if (animState?.type === 'inserted') {
      const t = setTimeout(() => setHighlight('rgba(34, 197, 94, 0.12)'), 0);
      return () => clearTimeout(t);
    }
  }, [animState]);

  const [highlightFading, setHighlightFading] = useState(false);
  useEffect(() => {
    if (!highlight || highlightFading || typing) return;
    const fadeTimer = setTimeout(() => setHighlightFading(true), 0);
    const clearTimer = setTimeout(() => {
      setHighlight(null);
      setHighlightFading(false);
    }, 2000);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(clearTimer);
    };
  }, [highlight, typing, highlightFading]);

  const typingDuration = getTypingDuration(line.content);
  const revealSteps = useMemo(() => computeRevealSteps(line.content), [line.content]);

  if (!mounted) return null;

  let bgColor = highlight || 'transparent';
  if (replacePhase === 'select') bgColor = 'rgba(59, 130, 246, 0.18)';

  let contentNode: React.ReactNode;
  if (replacePhase === 'select' && oldHtml) {
    contentNode = <span dangerouslySetInnerHTML={{ __html: oldHtml }} />;
  } else if (typing) {
    contentNode = (
      <TypingReveal
        html={highlightedHtml}
        durationMs={typingDuration}
        revealSteps={revealSteps}
        onComplete={handleTypingComplete}
      />
    );
  } else {
    contentNode = <span dangerouslySetInnerHTML={{ __html: highlightedHtml }} />;
  }

  return (
    <motion.div
      layout="position"
      initial={isNewLine ? { opacity: 0, height: 0 } : false}
      animate={{
        opacity: 1,
        height: 'auto',
        backgroundColor: bgColor,
        transition: {
          duration: 0.3,
          ease: [0.16, 1, 0.3, 1],
          backgroundColor: { duration: 0.4 },
        },
      }}
      exit={{
        backgroundColor: 'rgba(59, 130, 246, 0.18)',
        height: 0,
        opacity: 0,
        transition: {
          backgroundColor: { duration: 0 },
          height: { duration: 0, delay: 0.3 },
          opacity: { duration: 0, delay: 0.3 },
        },
      }}
      className="flex leading-[1.6]"
      style={{
        fontSize: 'inherit',
        overflow: 'hidden',
      }}
    >
      {showLineNumbers && (
        <span
          className="select-none text-right shrink-0 pr-4 pl-2"
          style={{
            width: '3.5em',
            color: '#9ca3af',
            userSelect: 'none',
          }}
        >
          {lineNumber}
        </span>
      )}
      <span className="flex-1 pr-4" style={{ whiteSpace: 'pre', tabSize: 4 }}>
        {contentNode}
      </span>
    </motion.div>
  );
}

// ==================== BaseCodeElement ====================

export function BaseCodeElement({ elementInfo, animate }: BaseCodeElementProps) {
  const { language, lines, fileName, showLineNumbers = true, fontSize = 14 } = elementInfo;
  const codeBodyRef = useRef<HTMLDivElement>(null);

  // Prevent wheel events from bubbling to the whiteboard zoom handler
  // when the code body has scrollable content in the wheel direction.
  useEffect(() => {
    const el = codeBodyRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const canScroll = scrollHeight > clientHeight;
      if (!canScroll) return; // nothing to scroll — let whiteboard zoom

      const atTop = scrollTop <= 0;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
      const scrollingUp = e.deltaY < 0;
      const scrollingDown = e.deltaY > 0;

      // At scroll limits, let the event propagate for whiteboard zoom
      if ((atTop && scrollingUp) || (atBottom && scrollingDown)) return;

      e.stopPropagation();
    };

    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [highlighter, setHighlighter] = useState<any>(null);
  const prevLinesRef = useRef<CodeLine[]>([]);
  const isFirstRenderRef = useRef(true);

  const [animStates, setAnimStates] = useState<Map<string, LineAnimationState>>(
    () => new Map<string, LineAnimationState>(),
  );

  useEffect(() => {
    const states = new Map<string, LineAnimationState>();

    if (animate) {
      if (isFirstRenderRef.current) {
        isFirstRenderRef.current = false;
        lines.forEach((line, i) => {
          states.set(line.id, { type: 'typing', timestamp: i * 80 });
        });
      } else {
        const prevIds = new Set(prevLinesRef.current.map((l) => l.id));

        for (const line of lines) {
          if (!prevIds.has(line.id)) {
            states.set(line.id, { type: 'inserted', timestamp: 0 });
          }
        }

        for (const line of lines) {
          const prev = prevLinesRef.current.find((p) => p.id === line.id);
          if (prev && prev.content !== line.content) {
            states.set(line.id, { type: 'replaced', timestamp: 0 });
          }
        }
      }

      prevLinesRef.current = lines;
    }

    const t = setTimeout(() => setAnimStates(states), 0);
    return () => clearTimeout(t);
  }, [lines, animate]);

  useEffect(() => {
    getHighlighter().then(setHighlighter);
  }, []);

  const highlightedLines = useMemo(() => {
    if (!highlighter) return null;

    const code = lines.map((l) => l.content).join('\n');

    let lang = language;
    try {
      highlighter.getLoadedLanguages();
    } catch {
      lang = 'text';
    }

    try {
      const html = highlighter.codeToHtml(code, { lang, theme: 'github-light' });
      const parsed = parseShikiLines(html);

      return lines.map((line, i) => ({
        id: line.id,
        html: parsed[i] || escapeHtml(line.content),
      }));
    } catch {
      return lines.map((line) => ({
        id: line.id,
        html: escapeHtml(line.content),
      }));
    }
  }, [highlighter, lines, language]);

  const fallbackLines = useMemo(() => {
    return lines.map((line) => ({
      id: line.id,
      html: escapeHtml(line.content),
    }));
  }, [lines]);

  const lineHtmlMap = highlightedLines || fallbackLines;

  const typingDelays = useMemo(() => {
    const delays = new Map<string, number>();
    let cumulative = 0;
    for (const line of lines) {
      if (animStates.has(line.id)) {
        delays.set(line.id, cumulative);
        cumulative += getTypingDuration(line.content) + LINE_GAP_MS;
      }
    }
    return delays;
  }, [lines, animStates]);

  const langDisplay = LANG_DISPLAY_NAMES[language] || language;

  return (
    <div
      className="base-element-code absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <style>{`
          @keyframes code-cursor-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>

        <div
          className="element-content w-full h-full flex flex-col overflow-hidden"
          style={{
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            background: '#fafbfc',
            boxShadow: '0 2px 6px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.05)',
            fontFamily:
              '"JetBrains Mono", "Fira Code", "SF Mono", "Cascadia Code", ui-monospace, SFMono-Regular, "Liberation Mono", Menlo, Monaco, Consolas, monospace',
            fontSize: `${fontSize}px`,
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between shrink-0 px-3"
            style={{
              height: '32px',
              background: '#f8f9fa',
              borderBottom: '1px solid #e5e7eb',
            }}
          >
            <div className="flex items-center gap-2">
              <div className="flex gap-[6px]">
                <div className="w-[10px] h-[10px] rounded-full" style={{ background: '#ff5f57' }} />
                <div className="w-[10px] h-[10px] rounded-full" style={{ background: '#febc2e' }} />
                <div className="w-[10px] h-[10px] rounded-full" style={{ background: '#28c840' }} />
              </div>
              {fileName && (
                <span
                  className="ml-2 truncate"
                  style={{
                    color: '#6b7280',
                    fontSize: '11px',
                    letterSpacing: '0.01em',
                  }}
                >
                  {fileName}
                </span>
              )}
            </div>
            <span
              style={{
                color: '#9ca3af',
                fontSize: '10px',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 500,
              }}
            >
              {langDisplay}
            </span>
          </div>

          {/* Code body */}
          <div
            ref={codeBodyRef}
            className="flex-1 overflow-auto py-2"
            style={{
              background: '#fafbfc',
              color: '#24292e',
            }}
          >
            <AnimatePresence initial={false} mode="popLayout">
              {lineHtmlMap.map((lineData, index) => {
                const line = lines[index];
                if (!line) return null;
                return (
                  <CodeLineRow
                    key={line.id}
                    line={line}
                    lineNumber={index + 1}
                    highlightedHtml={lineData.html}
                    showLineNumbers={showLineNumbers}
                    animState={animStates.get(line.id)}
                    animate={!!animate}
                    typingDelay={typingDelays.get(line.id) ?? 0}
                  />
                );
              })}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== Utilities ====================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LANG_DISPLAY_NAMES: Record<string, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  html: 'HTML',
  css: 'CSS',
  bash: 'Bash',
  sql: 'SQL',
  yaml: 'YAML',
  markdown: 'Markdown',
  jsx: 'JSX',
  tsx: 'TSX',
};
