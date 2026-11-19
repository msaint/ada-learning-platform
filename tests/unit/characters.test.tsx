// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AdaMark, AmbientGlyphRow, LinkGlyph, PrismGlyph, SparkGlyph, StaticGlyph } from "@/components/characters/glyphs";

afterEach(cleanup);

describe("Decorative geometric glyphs", () => {
  it("renders all four ambient characters purely as aria-hidden decoration with no selector or text", () => {
    const { container } = render(<AmbientGlyphRow />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs.length).toBe(4);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent?.trim()).toBe("");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders individual decorative glyphs and AdaMark safely", () => {
    const { container } = render(
      <div>
        <SparkGlyph />
        <LinkGlyph />
        <PrismGlyph />
        <StaticGlyph />
        <AdaMark />
      </div>,
    );
    expect(container.querySelectorAll("svg").length).toBe(5);
  });
});
