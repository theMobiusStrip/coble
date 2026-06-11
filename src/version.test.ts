import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("version", () => {
  it("exposes a semver string from package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
