'use client';

import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

const AVAILABLE_VARIABLES = [
  {
    name: 'context',
    description: 'Classroom/lesson context',
    example: 'Unit 3: Ancient Civilizations',
  },
  {
    name: 'language',
    description: 'Target language (en/zh)',
    example: 'en',
  },
  {
    name: 'user.name',
    description: 'Current user name',
    example: 'John Smith',
  },
  {
    name: 'user.role',
    description: 'Current user role',
    example: 'INSTRUCTOR',
  },
  {
    name: 'user.id',
    description: 'Current user ID',
    example: 'user_123abc',
  },
  {
    name: 'topic',
    description: 'Lesson/content topic',
    example: 'Climate Change',
  },
  {
    name: 'grade_level',
    description: 'Student grade level',
    example: '10',
  },
  {
    name: 'media_type',
    description: 'Target media (text, image, video, audio)',
    example: 'video',
  },
];

interface VariableReferenceProps {
  onVariableClick?: (varName: string) => void;
}

export function VariableReference({ onVariableClick }: VariableReferenceProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full text-sm font-medium text-white hover:text-slate-100"
      >
        <span>Available Variables</span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="mt-3 space-y-2">
          {AVAILABLE_VARIABLES.map((variable) => (
            <div
              key={variable.name}
              className="p-3 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <code className="text-xs font-mono text-purple-400">
                    {`{{${variable.name}}}`}
                  </code>
                  <p className="text-xs text-slate-400 mt-1">{variable.description}</p>
                  <p className="text-xs text-slate-500 mt-1">Example: {variable.example}</p>
                </div>
                {onVariableClick && (
                  <button
                    type="button"
                    onClick={() => onVariableClick(variable.name)}
                    className="px-2 py-1 rounded text-xs bg-purple-600/20 text-purple-300 hover:bg-purple-600/30 whitespace-nowrap"
                  >
                    Insert
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
