import { useState } from 'react';
import type { CSBotConfig } from './types';
import ChatWindow from './ChatWindow';

interface Props {
  cfg: CSBotConfig;
}

export default function Widget({ cfg }: Props) {
  const [open, setOpen] = useState(false);
  const color = cfg.primaryColor ?? '#00CE80';

  return (
    <div className="csbot-widget fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-4">
      {open && <ChatWindow cfg={cfg} onClose={() => setOpen(false)} />}

      <div className="relative">
        {/* Pulse ring */}
        {!open && (
          <span
            className="absolute inset-0 rounded-full animate-ping opacity-25 pointer-events-none"
            style={{ backgroundColor: color }}
          />
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="csbot-fab relative w-14 h-14 rounded-full flex items-center justify-center"
          style={{
            background: open ? '#079755' : '#00CE80',
            color: '#1B1A18',
          }}
          aria-label="Open support chat"
        >
          <span className="csbot-fab-icon">
            {open ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            )}
          </span>
        </button>
      </div>
    </div>
  );
}
