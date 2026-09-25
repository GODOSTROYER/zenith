import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Statement } from "@/app/_landing/statement";
import { useStatementReveal } from "@/app/_landing/landing-motion";
import styles from "@/app/_landing/statement.module.css";

// Server markup must already contain the complete story; motion only enhances it.
vi.mock("@/app/_landing/landing-motion", () => ({ useStatementReveal: vi.fn() }));

const story = "Behind every app is a system. Zenith brings yours into focus — so you can see what changes, understand the cost, and decide what runs.";

function renderStatement() {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<Statement />);
  return host;
}

beforeEach(() => vi.clearAllMocks());

describe("landing narrative statement", () => {
  it("renders the whole story in reading order before JavaScript or scrolling", () => {
    const host = renderStatement();
    expect(host.querySelector("p")?.textContent?.trim()).toBe(story);
    expect(host.querySelectorAll("#statement")).toHaveLength(1);
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("What Zenith does");
    expect(host.querySelector("[hidden], [aria-hidden='true'], [style], button, h1")).toBeNull();
  });

  it("retains one animation target per word and natural spaces between them", () => {
    const words = [...renderStatement().querySelectorAll("[data-word]")];
    expect(words.map((word) => word.textContent)).toEqual(story.split(" ").map((word) => `${word} `));
    expect(words.every((word) => word.tagName === "SPAN")).toBe(true);
  });

  it("accents exactly the final thought about control", () => {
    const words = [...renderStatement().querySelectorAll("[data-word]")];
    const accented = words.filter((word) => word.classList.contains(styles.accent));
    expect(accented.map((word) => word.textContent).join("").trim()).toBe("and decide what runs.");
    expect(accented).toEqual(words.slice(-4));
  });

  it("keeps the original sticky layout and scroll-reveal hook", () => {
    const host = renderStatement();
    expect(host.querySelector("section")?.className).toBe(styles.statement);
    expect(host.querySelector("section > div")?.className).toBe(styles.sticky);
    expect(host.querySelector("p")?.className).toBe(styles.words);
    expect(useStatementReveal).toHaveBeenCalledTimes(1);
    expect(useStatementReveal).toHaveBeenCalledWith({ current: null });
  });
});
