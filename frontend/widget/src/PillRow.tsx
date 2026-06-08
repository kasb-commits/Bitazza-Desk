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
      className="flex flex-col items-end gap-2 mt-2"
      style={{ opacity: visible ? 1 : 0, transition: 'opacity 150ms ease' }}
    >
      {pills.map((pill) => (
        <button
          key={pill}
          onClick={() => onTap(pill)}
          className="rounded-full border-2 text-xs px-4 py-2.5 cursor-pointer font-semibold transition-colors w-full text-center"
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
