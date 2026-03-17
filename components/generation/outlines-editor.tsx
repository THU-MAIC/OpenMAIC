'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { nanoid } from 'nanoid';
import type { SceneOutline } from '@/lib/types/generation';

interface OutlinesEditorProps {
  outlines: SceneOutline[];
  onChange: (outlines: SceneOutline[]) => void;
  onConfirm: () => void;
  onBack: () => void;
  isLoading?: boolean;
}

export function OutlinesEditor({
  outlines,
  onChange,
  onConfirm,
  onBack,
  isLoading = false,
}: OutlinesEditorProps) {
  const addOutline = () => {
    const newOutline: SceneOutline = {
      id: nanoid(8),
      type: 'slide',
      title: '',
      description: '',
      keyPoints: [],
      order: outlines.length + 1,
    };
    onChange([...outlines, newOutline]);
  };

  const updateOutline = (index: number, updates: Partial<SceneOutline>) => {
    const newOutlines = [...outlines];
    newOutlines[index] = { ...newOutlines[index], ...updates };
    onChange(newOutlines);
  };

  const removeOutline = (index: number) => {
    const newOutlines = outlines.filter((_, i) => i !== index);
    // Update order
    newOutlines.forEach((outline, i) => {
      outline.order = i + 1;
    });
    onChange(newOutlines);
  };

  const moveOutline = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= outlines.length) return;
    const newOutlines = [...outlines];
    [newOutlines[index], newOutlines[newIndex]] = [newOutlines[newIndex], newOutlines[index]];
    // Update order
    newOutlines.forEach((outline, i) => {
      outline.order = i + 1;
    });
    onChange(newOutlines);
  };

  const updateKeyPoints = (index: number, keyPointsText: string) => {
    const keyPoints = keyPointsText
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    updateOutline(index, { keyPoints });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">场景大纲</h2>
          <p className="text-sm text-muted-foreground">
            共 {outlines.length} 个场景，可编辑、添加、删除或重排序
          </p>
        </div>
        <Button variant="outline" onClick={addOutline} disabled={isLoading}>
          <Plus className="size-4 mr-1" />
          添加场景
        </Button>
      </div>

      <div className="space-y-4">
        {outlines.map((outline, index) => (
          <Card key={outline.id} className="relative">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => moveOutline(index, 'up')}
                    disabled={index === 0 || isLoading}
                    className="size-6"
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => moveOutline(index, 'down')}
                    disabled={index === outlines.length - 1 || isLoading}
                    className="size-6"
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </div>
                <div className="flex-1">
                  <CardTitle className="text-base flex items-center gap-2">
                    <span className="bg-primary text-primary-foreground size-6 rounded-full flex items-center justify-center text-sm">
                      {index + 1}
                    </span>
                    <Input
                      value={outline.title}
                      onChange={(e) => updateOutline(index, { title: e.target.value })}
                      placeholder="场景标题"
                      className="flex-1"
                      disabled={isLoading}
                    />
                  </CardTitle>
                </div>
                <Select
                  value={outline.type}
                  onValueChange={(value) =>
                    updateOutline(index, {
                      type: value as SceneOutline['type'],
                    })
                  }
                  disabled={isLoading}
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="slide">幻灯片</SelectItem>
                    <SelectItem value="quiz">测验</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeOutline(index)}
                  disabled={isLoading}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>场景描述</Label>
                <Textarea
                  value={outline.description}
                  onChange={(e) => updateOutline(index, { description: e.target.value })}
                  placeholder="简短描述这个场景的目的和内容"
                  rows={2}
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label>关键要点（每行一个）</Label>
                <Textarea
                  value={outline.keyPoints?.join('\n') || ''}
                  onChange={(e) => updateKeyPoints(index, e.target.value)}
                  placeholder="输入关键要点，每行一个"
                  rows={3}
                  disabled={isLoading}
                />
              </div>

              {outline.type === 'quiz' && (
                <div className="p-3 bg-muted/50 rounded-lg space-y-3">
                  <Label className="text-sm font-medium">测验配置</Label>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs">题目数量</Label>
                      <Input
                        type="number"
                        value={outline.quizConfig?.questionCount || 3}
                        onChange={(e) =>
                          updateOutline(index, {
                            quizConfig: {
                              ...outline.quizConfig,
                              questionCount: parseInt(e.target.value) || 3,
                              difficulty: outline.quizConfig?.difficulty || 'medium',
                              questionTypes: outline.quizConfig?.questionTypes || ['single'],
                            },
                          })
                        }
                        min={1}
                        max={10}
                        disabled={isLoading}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">难度</Label>
                      <Select
                        value={outline.quizConfig?.difficulty || 'medium'}
                        onValueChange={(value) =>
                          updateOutline(index, {
                            quizConfig: {
                              ...outline.quizConfig,
                              difficulty: value as 'easy' | 'medium' | 'hard',
                              questionCount: outline.quizConfig?.questionCount || 3,
                              questionTypes: outline.quizConfig?.questionTypes || ['single'],
                            },
                          })
                        }
                        disabled={isLoading}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="easy">简单</SelectItem>
                          <SelectItem value="medium">中等</SelectItem>
                          <SelectItem value="hard">困难</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">题型</Label>
                      <Select
                        value={outline.quizConfig?.questionTypes?.[0] || 'single'}
                        onValueChange={(value) =>
                          updateOutline(index, {
                            quizConfig: {
                              ...outline.quizConfig,
                              questionTypes: [value as 'single' | 'multiple' | 'text'],
                              questionCount: outline.quizConfig?.questionCount || 3,
                              difficulty: outline.quizConfig?.difficulty || 'medium',
                            },
                          })
                        }
                        disabled={isLoading}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="single">单选</SelectItem>
                          <SelectItem value="multiple">多选</SelectItem>
                          <SelectItem value="text">简答</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {outlines.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground mb-4">暂无场景大纲</p>
          <Button variant="outline" onClick={addOutline} disabled={isLoading}>
            <Plus className="size-4 mr-1" />
            添加第一个场景
          </Button>
        </Card>
      )}

      {/* Actions */}
      <div className="flex justify-between pt-4">
        <Button variant="outline" onClick={onBack} disabled={isLoading}>
          返回修改需求
        </Button>
        <Button onClick={onConfirm} disabled={isLoading || outlines.length === 0}>
          {isLoading ? '生成中...' : '确认并生成课程'}
        </Button>
      </div>
    </div>
  );
}
