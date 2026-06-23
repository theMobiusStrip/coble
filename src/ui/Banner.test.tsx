import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Banner } from "./Banner.js";

describe("Banner", () => {
  it("renders a rounded header card with model + cwd", () => {
    const frame = render(<Banner cwd="/w/coble" model="anthropic:claude-opus-4-8" />).lastFrame() ?? "";
    expect(frame).toContain("coble");
    expect(frame).toContain("anthropic:claude-opus-4-8");
    expect(frame).toContain("/w/coble");
    expect(frame).toMatch(/[╭╮╰╯]/); // rounded border box
    expect(frame).toContain("type / for commands"); // tip advertises the slash menu
  });

  it("shows 'no model' when none is resolved and renders extra notes", () => {
    const frame = render(<Banner cwd="/w" notes={["branch: main"]} />).lastFrame() ?? "";
    expect(frame).toContain("no model");
    expect(frame).toContain("branch: main");
  });

  it("uses the hint line in setup contexts (replaces the default tips)", () => {
    const frame = render(<Banner cwd="/w" hint="first-run setup" />).lastFrame() ?? "";
    expect(frame).toContain("first-run setup");
    expect(frame).not.toContain("shell & git actions"); // default tips suppressed
  });
});
