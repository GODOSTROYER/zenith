"use client";
import { useEffect, useState } from "react";

/**
 * The time of day belongs to the reader, not to the server the page rendered
 * on. The server sends a neutral greeting; the browser refines it after mount,
 * so there is nothing to mismatch during hydration.
 */
export function Greeting() {
  const [daypart, setDaypart] = useState<string | null>(null);

  useEffect(() => {
    const h = new Date().getHours();
    setDaypart(
      h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
    );
  }, []);

  return <>{daypart ?? "Welcome back"}</>;
}
