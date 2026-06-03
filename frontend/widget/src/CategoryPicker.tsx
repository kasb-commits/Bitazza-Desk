import type { IssueCategory, IssueCategoryDef } from './types';
import { ISSUE_CATEGORIES } from './types';

// SVG line icons — stroke="currentColor", 18×18, 1.75px stroke
const CATEGORY_ICONS: Record<IssueCategory, JSX.Element> = {
  kyc_verification: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  account_restriction: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  password_2fa_reset: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M10.85 12.15L19 4M18 5l2 2M15 8l2 2" />
    </svg>
  ),
  fraud_security: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  ),
  withdrawal_issue: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
      <path d="M12 15v-3M10 13l2-2 2 2" />
    </svg>
  ),
  other: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
};

interface Props {
  lang: 'en' | 'th';
  primaryColor: string;
  onSelect: (category: IssueCategory) => void;
  disabled?: boolean;
}

export default function CategoryPicker({ lang, onSelect, disabled }: Props) {
  // Pair categories into rows of 2
  const pairs: (IssueCategoryDef | null)[][] = [];
  const cats = ISSUE_CATEGORIES;
  for (let i = 0; i < cats.length; i += 2) {
    pairs.push([cats[i], cats[i + 1] ?? null]);
  }

  return (
    <div data-testid="category-picker" className="csbot-category-mosaic">
      {pairs.map((row, ri) => (
        <div key={ri} className="csbot-mosaic-row">
          {row.map((cat, ci) =>
            cat ? (
              <MosaicCard
                key={cat.key}
                cat={cat}
                lang={lang}
                disabled={disabled}
                onSelect={onSelect}
              />
            ) : (
              <div key={`empty-${ci}`} className="csbot-mosaic-empty" />
            )
          )}
        </div>
      ))}
    </div>
  );
}

function MosaicCard({
  cat,
  lang,
  disabled,
  onSelect,
}: {
  cat: IssueCategoryDef;
  lang: 'en' | 'th';
  disabled?: boolean;
  onSelect: (key: IssueCategory) => void;
}) {
  return (
    <button
      onClick={() => !disabled && onSelect(cat.key)}
      disabled={disabled}
      className="csbot-mosaic-card"
    >
      <span className="csbot-mosaic-icon" style={{ color: 'rgba(27,26,24,0.75)' }}>
        {CATEGORY_ICONS[cat.key]}
      </span>
      <span className="csbot-mosaic-label">{cat.label[lang]}</span>
    </button>
  );
}
