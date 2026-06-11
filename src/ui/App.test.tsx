import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./App.js";

describe("App", () => {
  it("renders banner and input prompt", () => {
    const { lastFrame, unmount } = render(<App />);
    expect(lastFrame()).toContain("coble");
    expect(lastFrame()).toContain(">");
    unmount();
  });
});
