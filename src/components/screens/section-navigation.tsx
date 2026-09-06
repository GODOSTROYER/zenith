"use client";
import { useEffect, useRef, useState } from "react";

/** Anchor navigation stays usable on phones and tracks the section being read. */
export function SectionNavigation({ sections, label }: {
  sections: { id: string; label: string }[];
  label: string;
}) {
  const [active, setActive] = useState(sections[0]?.id);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const container = nav.current;
    const selected = container?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!container || !selected) return;
    const left = selected.offsetLeft;
    const right = left + selected.offsetWidth;
    if (left < container.scrollLeft) container.scrollLeft = left;
    else if (right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = right - container.clientWidth;
    }
  }, [active]);
  useEffect(() => {
    const root = nav.current?.parentElement;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const entering = entries.filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (entering) setActive(entering.target.id);
    }, { root, rootMargin: "-10% 0px -65% 0px", threshold: 0 });
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sections]);
  return (
    <nav ref={nav} aria-label={label} className="settings-navigation sticky top-0 z-10 mb-8 flex gap-1 overflow-x-auto border-b border-line bg-bg0 py-2">
      {sections.map((section) => (
        <a key={section.id} href={`#${section.id}`} onClick={() => setActive(section.id)}
          aria-current={active === section.id ? "location" : undefined}
          className="shrink-0 rounded-ctl px-3 text-[13px] text-ink-mute transition-colors hover:bg-bg2 hover:text-ink">
          {section.label}
        </a>
      ))}
    </nav>
  );
}
