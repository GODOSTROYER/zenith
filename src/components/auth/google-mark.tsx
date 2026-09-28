import Image from "next/image";

/** Google's current, unmodified brand asset. Never animate the mark itself. */
export function GoogleMark() {
  return (
    <Image
      src="/brands/google-g.png"
      alt=""
      aria-hidden="true"
      width={200}
      height={204}
      unoptimized
      className="block h-5 w-auto shrink-0"
    />
  );
}
