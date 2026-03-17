'use client';

import { useState } from 'react';
import type { QuizContent } from '@/lib/types/stage';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QuizRendererProps {
  readonly content: QuizContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

export function QuizRenderer({ content, mode, sceneId: _sceneId }: QuizRendererProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleAnswerChange = (questionId: string, answer: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
  };

  return (
    <div className="w-full h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Quiz</h1>
        {content.questions.map((question) => (
          <Card key={question.id}>
            <CardHeader>
              <CardTitle>{question.question}</CardTitle>
            </CardHeader>
            <CardContent>
              {question.type === 'single' && question.options && (
                <div className="space-y-2">
                  {question.options.map((option, optIndex) => {
                    // Normalize: options may be QuizOption objects or plain strings from AI
                    const optionValue = typeof option === 'string' ? option : option.value;
                    const optionLabel = typeof option === 'string' ? option : option.label;
                    const letterPrefix = String.fromCharCode(65 + optIndex); // A, B, C, D...

                    return (
                      <label
                        key={`${question.id}-opt-${optIndex}`}
                        className={cn(
                          'flex items-center space-x-2 p-2 rounded cursor-pointer hover:bg-muted',
                          answers[question.id] === (optionValue || letterPrefix) && 'bg-muted',
                        )}
                      >
                        <input
                          type="radio"
                          name={question.id}
                          value={optionValue || letterPrefix}
                          checked={answers[question.id] === (optionValue || letterPrefix)}
                          onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                          className="size-4"
                        />
                        <span>
                          {letterPrefix}. {optionLabel}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {question.type === 'short_answer' && (
                <textarea
                  className="w-full min-h-24 p-2 border rounded"
                  placeholder="Enter your answer..."
                  value={answers[question.id] || ''}
                  onChange={(e) => handleAnswerChange(question.id, e.target.value)}
                />
              )}
            </CardContent>
          </Card>
        ))}
        {mode === 'autonomous' && (
          <div className="flex justify-end">
            <Button>Submit Answers</Button>
          </div>
        )}
      </div>
    </div>
  );
}
