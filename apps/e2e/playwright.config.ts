import { defineConfig, devices } from "@playwright/test";

// Sprint S14 (SDD §9, §13, §14) — suite E2E dos 3 perfis. Assume que `apps/web`
// (localhost:3000) e `apps/api` (localhost:3335) já estão rodando (mesmo padrão de
// dev usado nas sprints anteriores) — ver global-setup.ts para a checagem de preflight.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  globalSetup: "./tests/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
