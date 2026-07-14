import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";

// UC-07 — Acompanhar Painel TV (SDD §9, RF-TV-01/02/03). Rota isolada `/painel`, sem
// sidebar/topbar, autenticada por token de dispositivo (não por usuário) — Admin gera o
// token pela tela de administração, depois o "dispositivo" (aba sem sessão) o consome.
test.describe("UC-07 Acompanhar Painel TV", () => {
  test("Admin gera token de dispositivo e o Painel TV exibe dados em tela kiosk", async ({ browser }) => {
    const nomeDispositivo = `E2E S14 — TV Teste (${Date.now()})`;

    // --- Admin gera o token ---
    const ctxAdmin = await browser.newContext({ storageState: authFile("admin") });
    const pgAdmin = await ctxAdmin.newPage();
    await pgAdmin.goto("/plataformas/painel-tv");
    await expect(pgAdmin.getByRole("heading", { name: "Painel TV" })).toBeVisible();
    await pgAdmin.getByRole("button", { name: "Novo Token" }).click();
    await pgAdmin.getByLabel("Nome do dispositivo *").fill(nomeDispositivo);
    await pgAdmin.getByRole("button", { name: "Gerar Token" }).click();
    await expect(pgAdmin.getByText("Copie o token agora")).toBeVisible();
    const token = await pgAdmin.getByLabel("Token").inputValue();
    expect(token.length).toBeGreaterThan(20);
    await pgAdmin.getByRole("button", { name: "✕" }).click();

    const linha = pgAdmin.locator("tbody tr").filter({ hasText: nomeDispositivo });
    await expect(linha.getByText("Ativo")).toBeVisible();

    // --- "Dispositivo" acessa /painel sem sessão de usuário, só com o token na URL ---
    const ctxDispositivo = await browser.newContext();
    const pgPainel = await ctxDispositivo.newPage();
    await pgPainel.goto(`/painel?token=${token}`);

    // getByText simples ambiguaria com "Nenhuma reserva nas próximas 2 horas." (mensagem de
    // lista vazia) — os títulos de seção são <h2>, então escopamos por role.
    await expect(pgPainel.getByRole("heading", { name: "Próximas 2 horas" })).toBeVisible({ timeout: 10_000 });
    await expect(pgPainel.getByRole("heading", { name: "Reservas de hoje" })).toBeVisible();
    await expect(pgPainel.getByRole("heading", { name: "Status das Plataformas" })).toBeVisible();
    // Rota kiosk: sem sidebar (nenhum item de navegação "Dashboard"/"Reservas" visível).
    await expect(pgPainel.getByRole("link", { name: "Dashboard" })).toHaveCount(0);
    await ctxDispositivo.close();

    // Limpeza: revoga o token gerado para o teste.
    pgAdmin.on("dialog", (dialog) => dialog.accept());
    await linha.getByRole("button", { name: "Revogar" }).click();
    // "Revogado" aparece 2x na linha (coluna Status e coluna Ações, no lugar do botão).
    await expect(linha.getByText("Revogado").first()).toBeVisible();
    await ctxAdmin.close();
  });

  test("acesso sem token exibe mensagem de token ausente", async ({ page }) => {
    await page.goto("/painel");
    await expect(page.getByText("Token de dispositivo ausente na URL")).toBeVisible();
  });
});
