import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";

// UC-06 — Consultar Relatórios (SDD §9, RF-REL-01..06). Admin vê escopo global; Gestor
// de Setor vê só o próprio setor; Colaborador não tem acesso (RBAC — fora do escopo de
// perfis do SDD §6.7).
test.describe("UC-06 Consultar Relatórios", () => {
  test.describe("Admin — visão global", () => {
    test.use({ storageState: authFile("admin") });

    test("exibe KPIs globais e exporta um relatório em Excel", async ({ page }) => {
      await page.goto("/relatorios");
      await expect(page.getByRole("heading", { name: "Relatórios & Indicadores" })).toBeVisible();
      await expect(page.getByText("Visão global — todos os setores")).toBeVisible();
      await expect(page.getByText("Utilização Média das Plataformas")).toBeVisible();
      await expect(page.getByText("Ranking de Setores")).toBeVisible();
      await expect(page.getByText("Indicadores de Segurança")).toBeVisible();

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Excel" }).first().click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^relatorio_.*\.xlsx$/);
    });
  });

  test.describe("Gestor de Setor — visão do próprio setor", () => {
    test.use({ storageState: authFile("gestor") });

    test("exibe KPIs escopados ao setor, sem o card exclusivo de Admin", async ({ page }) => {
      await page.goto("/relatorios");
      await expect(page.getByRole("heading", { name: "Relatórios & Indicadores" })).toBeVisible();
      await expect(page.getByText("Visão do seu setor")).toBeVisible();
      // "Ranking de Setores" é Admin only (RF-REL-02) — não deve aparecer para o Gestor.
      await expect(page.getByText("Ranking de Setores")).toHaveCount(0);
    });
  });

  test.describe("Colaborador — sem acesso (RBAC)", () => {
    test.use({ storageState: authFile("colaborador") });

    test("é redirecionado para /dashboard ao tentar acessar /relatorios", async ({ page }) => {
      await page.goto("/relatorios");
      await page.waitForURL("**/dashboard");
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  });
});
