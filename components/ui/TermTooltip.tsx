'use client';

import { useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface Props {
  term: string;
  explain: string;
}

/** 轻量术语解释：? 图标 hover 显示释义，不引外部库 */
export function TermTooltip({ term, explain }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-center gap-0.5 relative">
      {term}
      <HelpCircle
        className="w-3 h-3 text-gray-400 cursor-help"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
      />
      {open && (
        <span className="absolute z-20 left-0 top-5 w-44 p-2 rounded-lg bg-gray-900 dark:bg-gray-700 text-white text-xs leading-relaxed shadow-lg pointer-events-none">
          {explain}
        </span>
      )}
    </span>
  );
}
