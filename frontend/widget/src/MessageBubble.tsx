import { useState } from 'react';
import type { Message } from './types';

const AGENT_AVATARS: Record<string, string> = {
  Ploy:  'https://i.pravatar.cc/150?img=47',
  James: 'https://i.pravatar.cc/150?img=11',
  Mint:  'https://i.pravatar.cc/150?img=49',
  Arm:   'https://i.pravatar.cc/150?img=15',
  Nook:  'https://i.pravatar.cc/150?img=45',
};

function resolveAvatarUrl(name: string, url?: string | null): string | null {
  if (url && !url.includes('dicebear') && !url.includes('avataaars')) return url;
  return AGENT_AVATARS[name] ?? null;
}

interface Props {
  message: Message;
  primaryColor?: string;
  botName?: string | null;
  botAvatarUrl?: string | null;
  escalatedAgent?: { name: string; avatar: string; avatarUrl: string | null } | null;
}

export default function MessageBubble({ message, primaryColor = '#00CE80', botName, botAvatarUrl, escalatedAgent }: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  if (message.role === 'system') {
    return (
      <div className="flex items-center gap-2 my-2 px-2">
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
        <span className="text-[10px] font-medium shrink-0" style={{ color: 'rgba(27,26,24,0.4)' }}>{message.content}</span>
        <div className="flex-1 h-px" style={{ background: '#EDEDF8' }} />
      </div>
    );
  }

  const isUser = message.role === 'user';
  const isAgent = message.role === 'agent';
  const isAssistant = message.role === 'assistant';
  const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Use message metadata first; fall back to escalatedAgent identity for old messages without metadata
  const agentName = message.agentName ?? escalatedAgent?.name ?? 'Support Agent';
  const agentAvatar = message.agentAvatar ?? escalatedAgent?.avatar ?? agentName[0];
  const agentAvatarUrl = message.agentAvatarUrl ?? escalatedAgent?.avatarUrl;

  // Static messages pin their name via senderName; AI messages use botName after category is selected
  const assistantDisplayName = message.senderName ?? botName ?? 'Bitazza Support';
  const displayName = isAgent ? agentName : assistantDisplayName;
  // Prefer avatar pinned onto the message; fall back to live botAvatarUrl only for unpinned bubbles
  const assistantAvatarUrl = message.agentAvatarUrl ?? (message.senderName ? null : botAvatarUrl);
  const displayAvatarUrl = resolveAvatarUrl(displayName, isAgent ? agentAvatarUrl : assistantAvatarUrl);
  const displayAvatar = isAgent ? agentAvatar : displayName[0].toUpperCase();

  return (
    <div className={`csbot-msg flex flex-col mb-3 ${isUser ? 'items-end' : 'items-start'}`}>
      {(isAgent || isAssistant) && (
        <div className="flex items-center gap-1.5 mb-1 ml-1">
          {displayAvatarUrl ? (
            <img
              src={displayAvatarUrl}
              alt={displayName}
              className="w-6 h-6 rounded-full object-cover"
              style={{ boxShadow: '0 0 0 1px #00CE80' }}
            />
          ) : (
            <span
              className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{ background: '#00CE80', color: '#1B1A18' }}
            >
              {displayAvatar}
            </span>
          )}
          <span className="text-[11px] font-semibold" style={{ color: 'rgba(27,26,24,0.5)' }}>{displayName}</span>
          {isAgent && <span className="text-[9px] font-medium" style={{ color: '#079755' }}>● live</span>}
        </div>
      )}

      <div
        className={`csbot-bubble max-w-[80%] px-4 py-2.5 break-words ${
          isUser ? 'csbot-bubble-user' : isAgent ? 'csbot-bubble-agent' : 'csbot-bubble-bot'
        }`}
      >
        {message.id === 'greeting' ? (
          (() => {
            const [enPart, thPart] = message.content.split('\n---\n');
            return (
              <>
                <span className="whitespace-pre-wrap">{enPart}</span>
                <div className="my-2" style={{ borderTop: '1px solid #EDEDF8' }} />
                <span className="whitespace-pre-wrap">{thPart}</span>
              </>
            );
          })()
        ) : (
          <span className="whitespace-pre-wrap">{message.content}</span>
        )}

        {/* Attachment thumbnails */}
        {message.attachments && message.attachments.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${message.content ? 'mt-2' : ''}`}>
            {message.attachments.map((a) => (
              a.mimeType.startsWith('image/') ? (
                <img
                  key={a.id}
                  src={a.url}
                  alt={a.name}
                  onClick={() => setLightbox(a.url)}
                  className="w-20 h-20 object-cover rounded-lg hover:opacity-90 transition-opacity cursor-zoom-in"
                  style={{ border: '1px solid rgba(255,255,255,0.2)' }}
                />
              ) : (
                <a
                  key={a.id}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs transition-colors"
                  style={{ background: 'rgba(255,255,255,0.15)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.25)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span className="max-w-[100px] truncate">{a.name}</span>
                </a>
              )
            ))}
          </div>
        )}
      </div>

      <span className="text-[10px] mt-1 mx-1" style={{ color: 'rgba(27,26,24,0.4)' }}>{time}</span>

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="full size"
            className="max-w-[90vw] max-h-[90vh] rounded-xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center transition-colors"
            style={{ background: 'rgba(255,255,255,0.2)', color: '#fff' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.4)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.2)')}
            onClick={() => setLightbox(null)}
          >✕</button>
        </div>
      )}
    </div>
  );
}
