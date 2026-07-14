import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";
import { garantirPlataformaDisponivel, dataFutura, modalAtual, paraDataBR } from "./helpers";

// UC-02 — Aprovar Reserva com Dupla Aprovação (SDD §9, RN-RES-08/09): plataforma de
// risco alto (PLT-S8-DEMO, elevatória) força dupla aprovação independentemente da
// prioridade. Fluxo: Colaborador solicita → Gestor de Setor dá a 1ª aprovação (reserva
// permanece "pendente") → Admin dá a 2ª aprovação (reserva vira "agendada").
//
// Notas de implementação:
// - O modal de detalhe FECHA sozinho após qualquer ação (aprovar/rejeitar/etc —
//   onAtualizado recarrega a lista e limpa a seleção). Por isso cada aprovação é seguida
//   de uma reabertura do registro (via "Reservas", que não filtra por pendência de
//   decisão do aprovador) só para inspecionar o estado resultante.
// - As tabelas de "Reservas" e "Fila de Aprovações" não exibem o motivo da reserva
//   (colunas: Setor/Solicitante/Plataforma/Data/Horário/Prioridade/Status[/Aprovação]) —
//   a linha é identificada pela combinação plataforma + horário (únicos nesta spec)
//   + status, o que também distingue de eventuais linhas "Cancelada" residuais de
//   execuções anteriores desta mesma suite.
test.describe("UC-02 Aprovar Reserva com Dupla Aprovação", () => {
  const HORA = "08:00";

  test("Colaborador solicita, Gestor dá 1ª aprovação, Admin dá a 2ª (RN-RES-08)", async ({ browser }) => {
    const dia = dataFutura(2);
    const dataBR = paraDataBR(dia);
    // Desambigua por plataforma + data + horário: o horário sozinho se repete entre
    // execuções em datas diferentes desta mesma suite.
    const linhaPorStatus = (page: import("@playwright/test").Page, status: string) =>
      page
        .locator("tbody tr")
        .filter({ hasText: "Plataforma Elevatória Demo S8" })
        .filter({ hasText: dataBR })
        .filter({ hasText: HORA })
        .filter({ hasText: status });

    // --- 1. Colaborador cria a reserva em plataforma de risco alto ---
    const ctxColaborador = await browser.newContext({ storageState: authFile("colaborador") });
    const pgColaborador = await ctxColaborador.newPage();
    await garantirPlataformaDisponivel(pgColaborador, "PLT-S8-DEMO");
    await pgColaborador.goto("/reservas");
    await pgColaborador.getByRole("button", { name: "Nova Reserva" }).click();
    await pgColaborador.getByLabel("Plataforma *").selectOption({ label: "Plataforma Elevatória Demo S8" });
    await pgColaborador.getByLabel("Prioridade").selectOption("urgente");
    await pgColaborador.getByLabel("Data *").fill(dia);
    await pgColaborador.getByLabel("Horário Inicial *").fill(HORA);
    await pgColaborador.getByLabel("Horário Final *").fill("09:00");
    await pgColaborador.getByLabel("Motivo / Descrição *").fill("E2E S14 — UC-02 — inspeção estrutural");
    await pgColaborador.getByRole("button", { name: "Criar Reserva" }).click();
    await expect(pgColaborador.getByRole("heading", { name: "Nova Reserva" })).toHaveCount(0);
    await expect(linhaPorStatus(pgColaborador, "Pendente")).toBeVisible();
    await ctxColaborador.close();

    // --- 2. Gestor de Setor dá a 1ª aprovação a partir da Fila de Aprovações ---
    const ctxGestor = await browser.newContext({ storageState: authFile("gestor") });
    const pgGestor = await ctxGestor.newPage();
    await pgGestor.goto("/reservas/aprovacoes");
    await expect(pgGestor.getByRole("heading", { name: "Fila de Aprovações" })).toBeVisible();
    const filaGestor = linhaPorStatus(pgGestor, "Pendente");
    await expect(filaGestor).toBeVisible();
    await filaGestor.click();
    await modalAtual(pgGestor).getByRole("button", { name: "Aprovar" }).click();
    await expect(pgGestor.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);

    // Reabre pela tela "Reservas" (não filtra por pendência de decisão) só para inspecionar
    // o estado intermediário: continua "Pendente", aguardando a 2ª aprovação do Admin.
    await pgGestor.goto("/reservas");
    await linhaPorStatus(pgGestor, "Pendente").click();
    const modalGestor = modalAtual(pgGestor);
    await expect(modalGestor.getByText("Pendente")).toBeVisible();
    await expect(modalGestor.getByText("Aguardando a segunda aprovação do Admin")).toBeVisible();
    await expect(modalGestor.getByText("1ª aprovação (Gestor)")).toBeVisible();
    await expect(modalGestor.getByText("Gestor de Setor TI")).toBeVisible();
    await modalGestor.getByRole("button", { name: "Fechar" }).click();
    await ctxGestor.close();

    // --- 3. Admin dá a 2ª aprovação a partir da Fila de Aprovações (vê pendências que aguardam 2ª aprovação) ---
    const ctxAdmin = await browser.newContext({ storageState: authFile("admin") });
    const pgAdmin = await ctxAdmin.newPage();
    await pgAdmin.goto("/reservas/aprovacoes");
    const filaAdmin = linhaPorStatus(pgAdmin, "Pendente");
    await expect(filaAdmin).toBeVisible();
    await expect(filaAdmin.getByText("Aguarda 2ª aprovação")).toBeVisible();
    await filaAdmin.click();
    await modalAtual(pgAdmin).getByRole("button", { name: "Aprovar" }).click();
    await expect(pgAdmin.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);

    // Reabre pela tela "Reservas": agora "Agendada", com a 2ª aprovação em nome do Admin.
    await pgAdmin.goto("/reservas");
    await linhaPorStatus(pgAdmin, "Agendada").click();
    const modalAdmin = modalAtual(pgAdmin);
    await expect(modalAdmin.getByText("Agendada", { exact: true })).toBeVisible();
    await expect(modalAdmin.getByText("2ª aprovação (Admin)")).toBeVisible();
    await expect(modalAdmin.getByText("Administrador")).toBeVisible();

    // Limpeza: cancela para não deixar reserva "agendada" residual na fixture.
    pgAdmin.on("dialog", (dialog) => dialog.accept());
    await modalAdmin.getByRole("button", { name: "Cancelar Reserva" }).click();
    await ctxAdmin.close();
  });
});

test.describe("UC-02 RBAC — Colaborador não acessa a Fila de Aprovações como aprovador", () => {
  test.use({ storageState: authFile("colaborador") });

  test("tela informa que o perfil Colaborador não aprova reservas", async ({ page }) => {
    await page.goto("/reservas/aprovacoes");
    await expect(page.getByText("Seu perfil (Colaborador) não aprova reservas.")).toBeVisible();
  });
});
