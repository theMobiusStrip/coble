import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 20_000,
    // Run test files serially. The real-OS-sandbox integration test (Seatbelt /
    // bubblewrap) is CPU-heavy and would starve the timing-based Ink TUI tests
    // running in a parallel worker, making them flaky. The suite is small, so the
    // wall-clock cost is minimal and worth the determinism.
    fileParallelism: false,
  },
});
