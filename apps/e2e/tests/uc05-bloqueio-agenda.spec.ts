import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";
import { dataFutura } from "./helpers";

// UC-05 — Criar Bloqueio de Agenda (SDD §9, RF-BLK-01/02, RN-BLK-01). Admin only —
// também cobre o RBAC dos outros 2 perfis (redirecionamento ao tentar acessar a rota).
test.describe("UC-05 Criar Bloqueio de Agenda", () => {
  test.use({ storageState: authFile("admin") });

  test("Admin cria bloqueio de agenda numa plataforma específica", async ({ page }) => {
    const motivo = `E2E S14 — UC-05 — parada programada (${Date.now()})`;
    // Janela distante no tempo (30 dias à frente) para não colidir com reservas criadas
    // pelas demais specs desta suite.
    const dia = dataFutura(30);

    await page.goto("/plataformas/bloqueios");
    await expect(page.getByRole("heading", { name: "Bloqueios de Agenda" })).toBeVisible();

    await page.getByRole("button", { name: "Novo Bloqueio" }).click();
    await page.getByLabel("Plataforma").selectOption({ label: "Sala de Reuniões E2E (S14)" });
    await page.getByLabel("Início *").fill(`${dia}T08:00`);
    await page.getByLabel("Fim *").fill(`${dia}T18:00`);
    await page.getByLabel("Motivo *").fill(motivo);
    await page.getByRole("button", { name: "Criar Bloqueio" }).click();

    await expect(page.getByRole("heading", { name: "Novo Bloqueio de Agenda" })).toHaveCount(0);
    const linha = page.locator("tbody tr").filter({ hasText: motivo });
    await expect(linha).toBeVisible();
    await expect(linha.getByText("Sala de Reuniões E2E (S14)")).toBeVisible();

    // Limpeza: remove o bloqueio para manter a fixture idempotente entre execuções.
    page.on("dialog", (dialog) => dialog.accept());
    await linha.getByRole("button", { name: "Remover" }).click();
    await expect(page.locator("tbody tr").filter({ hasText: motivo })).toHaveCount(0);
  });
});

for (const perfil of ["gestor", "colaborador"] as const) {
  test.describe(`UC-05 RBAC — ${perfil} não acessa Bloqueios de Agenda`, () => {
    test.use({ storageState: authFile(perfil) });

    test(`${perfil} é redirecionado para /plataformas ao tentar acessar a rota`, async ({ page }) => {
      await page.goto("/plataformas/bloqueios");
      await page.waitForURL("**/plataformas");
      await expect(page).toHaveURL(/\/plataformas$/);
    });
  });
}
