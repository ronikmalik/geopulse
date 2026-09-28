"use client";

import { CORE_CATEGORIES, CATEGORY_LABELS, type Category } from "@/lib/categories";

interface CategoryFilterProps {
  active: Set<Category>;
  onToggle: (category: Category) => void;
}

export default function CategoryFilter({
  active,
  onToggle,
}: CategoryFilterProps) {
  return (
    <div className="flex flex-nowrap gap-1.5 sm:flex-wrap">
      {CORE_CATEGORIES.map((cat) => {
        const isActive = active.has(cat);
        return (
          <button
            key={cat}
            onClick={() => onToggle(cat)}
            className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
              isActive
                ? "border-red-500 bg-red-950/60 text-red-300 shadow-[0_0_8px_rgba(255,0,0,0.3)]"
                : "border-neutral-800 text-neutral-500 hover:border-red-900 hover:text-red-400"
            }`}
          >
            {CATEGORY_LABELS[cat]}
          </button>
        );
      })}
    </div>
  );
}
