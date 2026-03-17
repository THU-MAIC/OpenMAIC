/**
 * Agent Avatar Component
 * Displays agent avatar and name in chat messages
 */

import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface AgentAvatarProps {
  avatar: string; // Image URL or emoji
  color: string; // Theme color (hex)
  name: string; // Agent display name
  size?: 'sm' | 'md' | 'lg';
}

// Check if string is a URL
function isUrl(str: string): boolean {
  return str.startsWith('http') || str.startsWith('/') || str.startsWith('data:');
}

export default function AgentAvatar({ avatar, color, name, size = 'md' }: AgentAvatarProps) {
  const sizeClasses = {
    sm: 'size-6',
    md: 'size-8',
    lg: 'size-10',
  };

  return (
    <div className="flex items-center gap-2 mb-2">
      <Avatar className={sizeClasses[size]} style={{ borderColor: color, borderWidth: 2 }}>
        {isUrl(avatar) ? (
          <>
            <AvatarImage src={avatar} alt={name} />
            <AvatarFallback style={{ backgroundColor: `${color}20`, color }}>
              {name.charAt(0)}
            </AvatarFallback>
          </>
        ) : (
          <AvatarFallback style={{ backgroundColor: `${color}20`, color }}>
            {avatar || name.charAt(0)}
          </AvatarFallback>
        )}
      </Avatar>
      <span className="text-sm font-semibold" style={{ color }}>
        {name}
      </span>
    </div>
  );
}
