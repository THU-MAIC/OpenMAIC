import { Fragment, memo, useMemo } from 'react';
import { renderCaptionMathText } from '@/lib/quiz/math-text';

/**
 * Renders speech caption text with inline KaTeX math (`$...$`, `$$...$$`, `\(...\)`).
 * Plain text with no math renders as a bare text child with zero extra DOM nodes.
 */
export const CaptionMathText = memo(function CaptionMathText({ text }: { text: string }) {
  const segments = useMemo(() => renderCaptionMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <>{segments[0].value}</>;
  }
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <Fragment key={index}>{segment.value}</Fragment>
        ) : (
          <span
            key={index}
            className="inline-block max-w-full overflow-x-auto align-baseline mx-0.5 [&_.katex-display]:!my-0"
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ),
      )}
    </>
  );
});
