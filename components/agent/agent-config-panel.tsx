/**
 * Agent Configuration Panel
 * UI for viewing and managing AI agents in the registry
 */

'use client';

import { useState } from 'react';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { PlusIcon, Trash2Icon, EditIcon } from 'lucide-react';

export function AgentConfigPanel() {
  const { listAgents, deleteAgent } = useAgentRegistry();
  const agents = listAgents();
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const handleDelete = (agentId: string) => {
    if (confirm('确定要删除这个智能体吗？')) {
      deleteAgent(agentId);
      if (selectedAgent === agentId) {
        setSelectedAgent(null);
      }
    }
  };

  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">智能体配置</h2>
          <p className="text-sm text-muted-foreground">管理课堂讨论的AI智能体</p>
        </div>
        <Button size="sm" variant="outline">
          <PlusIcon className="w-4 h-4 mr-2" />
          新建
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-3">
          {agents.map((agent) => (
            <Card
              key={agent.id}
              className={`cursor-pointer transition-colors ${
                selectedAgent === agent.id ? 'border-primary' : ''
              }`}
              onClick={() => setSelectedAgent(agent.id)}
            >
              <CardHeader className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar
                      className="size-10"
                      style={{
                        borderColor: agent.color,
                        borderWidth: 2,
                      }}
                    >
                      <AvatarImage src={agent.avatar} alt={agent.name} />
                      <AvatarFallback
                        style={{
                          backgroundColor: `${agent.color}20`,
                          color: agent.color,
                        }}
                      >
                        {agent.name.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <CardDescription className="text-sm">{agent.role}</CardDescription>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="secondary" className="text-xs">
                      优先级 {agent.priority}
                    </Badge>
                    {agent.isDefault && (
                      <Badge variant="outline" className="text-xs">
                        默认
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4 pt-0">
                <div className="space-y-2">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">能力描述</p>
                    <p className="text-sm line-clamp-2">{agent.persona}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      可用动作 ({agent.allowedActions.length})
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {agent.allowedActions.slice(0, 3).map((tool) => (
                        <Badge key={tool} variant="secondary" className="text-xs">
                          {tool}
                        </Badge>
                      ))}
                      {agent.allowedActions.length > 3 && (
                        <Badge variant="secondary" className="text-xs">
                          +{agent.allowedActions.length - 3}
                        </Badge>
                      )}
                    </div>
                  </div>
                  {!agent.isDefault && (
                    <div className="flex gap-2 pt-2">
                      <Button size="sm" variant="outline" className="flex-1">
                        <EditIcon className="w-3 h-3 mr-1" />
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(agent.id);
                        }}
                      >
                        <Trash2Icon className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>

      {agents.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-center p-8">
          <div className="max-w-sm">
            <p className="text-muted-foreground mb-4">还没有配置智能体</p>
            <Button>
              <PlusIcon className="w-4 h-4 mr-2" />
              创建第一个智能体
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
