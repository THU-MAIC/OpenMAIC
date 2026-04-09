'use client';

import { useState } from 'react';
import type { CourseCollaborator } from '@/lib/types/course';
import { Bot, User, Plus, Trash2 } from 'lucide-react';

interface CollaboratorPanelProps {
  collaborators: CourseCollaborator[];
  onAdd: (collaborator: CourseCollaborator) => void;
  onRemove: (id: string) => void;
}

export function CollaboratorPanel({ collaborators, onAdd, onRemove }: CollaboratorPanelProps) {
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<'virtual' | 'real'>('real');
  const [identifier, setIdentifier] = useState('');
  const [nickname, setNickname] = useState('');

  const handleAdd = () => {
    if (!identifier) return;
    onAdd({
      id: `collab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type,
      agentId: type === 'virtual' ? identifier : undefined,
      userId: type === 'real' ? identifier : undefined,
      nickname,
      role: 'student',
      joinedAt: Date.now(),
    });
    setIdentifier('');
    setNickname('');
    setShowForm(false);
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {collaborators.length === 0 && (
          <li className="text-sm text-gray-500 italic">Sin colaboradores todavía.</li>
        )}
        {collaborators.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-50 dark:bg-gray-800/50"
          >
            {c.type === 'virtual' ? (
              <Bot className="w-4 h-4 text-violet-500" />
            ) : (
              <User className="w-4 h-4 text-blue-500" />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {c.nickname || c.userId || c.agentId}
              </div>
              <div className="text-[11px] text-gray-500 capitalize">
                {c.type === 'virtual' ? 'Agente AI' : 'Usuario real'} · {c.role}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemove(c.id)}
              className="p-1 text-gray-400 hover:text-red-500"
              aria-label="Quitar colaborador"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>

      {showForm ? (
        <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 space-y-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setType('real')}
              className={`flex-1 py-1.5 text-xs rounded-md ${type === 'real' ? 'bg-blue-500 text-white' : 'bg-gray-100 dark:bg-gray-700'}`}
            >
              Usuario real
            </button>
            <button
              type="button"
              onClick={() => setType('virtual')}
              className={`flex-1 py-1.5 text-xs rounded-md ${type === 'virtual' ? 'bg-violet-500 text-white' : 'bg-gray-100 dark:bg-gray-700'}`}
            >
              Agente AI
            </button>
          </div>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={type === 'real' ? 'User ID o email' : 'Agent ID'}
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
          />
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Apodo (opcional)"
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              className="flex-1 py-1.5 text-xs bg-violet-600 text-white rounded-md hover:bg-violet-700"
            >
              Agregar
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex-1 py-1.5 text-xs bg-gray-200 dark:bg-gray-700 rounded-md"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-violet-600 border border-dashed border-violet-300 dark:border-violet-700 rounded-lg hover:bg-violet-50 dark:hover:bg-violet-900/20"
        >
          <Plus className="w-3.5 h-3.5" /> Agregar colaborador
        </button>
      )}
    </div>
  );
}
