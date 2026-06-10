import { useEffect, useState } from 'react';

interface Props {
  pills: string[];
  primaryColor: string;
  onTap: (text: string) => void;
}

export default function PillRow({ pills, primaryColor, onTap }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  if (!pills.length) return null;

  return (
    <div
      className="flex flex-col items-end gap-1.5 mt-2"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 150ms ease' }}
    >
      {[...pills].sort((a, b) => a.length - b.length).map((pill) => (
        <button
          key={pill}
          onClick={() => onTap(pill)}
          className="rounded-full border text-[11px] px-3 py-1 cursor-pointer font-medium transition-colors"
          style={{ borderColor: primaryColor, color: primaryColor, background: 'transparent' }}
          onMouseEnter={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = primaryColor;
            el.style.color = '#ffffff';
          }}
          onMouseLeave={e => {
            const el = e.currentTarget as HTMLButtonElement;
            el.style.background = 'transparent';
            el.style.color = primaryColor;
          }}
        >
          {pill}
        </button>
      ))}
    </div>
  );
}
