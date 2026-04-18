'use client';

import type { ExerciseCard } from '@/lib/types/stage';
import { PhraseChunkCard } from './cards/phrase-chunk';
import { DialogSnippetCard } from './cards/dialog-snippet';
import { ShadowCard } from './cards/shadow';
import { RoleplayCard } from './cards/roleplay';
import { DialogueCompletionCard } from './cards/dialogue-completion';
import { GrammarPatternCard } from './cards/grammar-pattern';
import { FillBlankCard } from './cards/fill-blank';
import { CaseTransformCard } from './cards/case-transform';
import { TenseTransformCard } from './cards/tense-transform';
import { VocabInContextCard } from './cards/vocab-in-context';
import { MatchingCard } from './cards/matching';
import { MultipleChoiceCard } from './cards/multiple-choice';
import { TranslateSentenceCard } from './cards/translate-sentence';
import { MistakeSpotlightCard } from './cards/mistake-spotlight';

export function CardDispatch({ card }: { card: ExerciseCard }) {
  switch (card.kind) {
    case 'phrase_chunk':
      return <PhraseChunkCard card={card} />;
    case 'dialog_snippet':
      return <DialogSnippetCard card={card} />;
    case 'shadow':
      return <ShadowCard card={card} />;
    case 'roleplay':
      return <RoleplayCard card={card} />;
    case 'dialogue_completion':
      return <DialogueCompletionCard card={card} />;
    case 'grammar_pattern':
      return <GrammarPatternCard card={card} />;
    case 'fill_blank':
      return <FillBlankCard card={card} />;
    case 'case_transform':
      return <CaseTransformCard card={card} />;
    case 'tense_transform':
      return <TenseTransformCard card={card} />;
    case 'vocab_in_context':
      return <VocabInContextCard card={card} />;
    case 'matching':
      return <MatchingCard card={card} />;
    case 'multiple_choice':
      return <MultipleChoiceCard card={card} />;
    case 'translate_sentence':
      return <TranslateSentenceCard card={card} />;
    case 'mistake_spotlight':
      return <MistakeSpotlightCard card={card} />;
    default:
      return <div className="text-sm text-gray-400">Unknown card type</div>;
  }
}
