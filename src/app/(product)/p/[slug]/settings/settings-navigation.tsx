"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "./settings.module.css";

export function SettingsNavigation({ sections, scrollRoot }: {
  sections: { id: string; label: string }[];
  scrollRoot: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState<string | undefined>(sections[0]?.id);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const boundary = root.getBoundingClientRect().top + 112;
      let current: string | undefined = sections[0]?.id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= boundary) current = section.id;
      }
      // The last section can be shorter than the viewport.
      if (root.scrollHeight - root.scrollTop - root.clientHeight < 2) current = sections.at(-1)?.id;
      setActive(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [scrollRoot, sections]);

  useEffect(() => {
    const root = nav.current;
    const link = root?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!root || !link || root.scrollWidth <= root.clientWidth) return;
    if (link.offsetLeft < root.scrollLeft) root.scrollLeft = link.offsetLeft;
    else if (link.offsetLeft + link.offsetWidth > root.scrollLeft + root.clientWidth) {
      root.scrollLeft = link.offsetLeft + link.offsetWidth - root.clientWidth;
    }
  }, [active]);

  return (
    <nav ref={nav} className={styles.navigation} aria-label="Settings sections">
      {sections.map((section) => (
        <a key={section.id} href={`#${section.id}`} aria-current={active === section.id ? "location" : undefined}
          onClick={() => setActive(section.id)}>
          {section.label}
        </a>
      ))}
    </nav>
  );
}
