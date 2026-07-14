import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";
import { garantirPlataformaDisponivel, dataFutura } from "./helpers";

// UC-01 — Solicitar Reserva (SDD §9), nos 3 perfis (Colaborador/Gestor/Admin). Usa a
// plataforma de baixo risco (sala, sem checklist, sem aprovação automática) para isolar
// exclusivamente o fluxo de criação — os fluxos de dupla aprovação/checklist ficam nas
// specs de UC-02/03/04.
const PERFIS = [
  { chave: "colaborador" as const, horaInicio: "09:00", horaFim: "10:00" },
  { chave: "gestor" as const, horaInicio: "10:30", horaFim: "11:30" },
  { chave: "admin" as const, horaInicio: "12:00", horaFim: "13:00" },
];

for (const { chave, horaInicio, horaFim } of PERFIS) {
  test.describe(`UC-01 Solicitar Reserva — perfil ${chave}`, () => {
    test.use({ storageState: authFile(chave) });

    test(`${chave} cria reserva e ela nasce pendente (RN-RES-01)`, async ({ page }) => {
      page.on("dialog", (dialog) => dialog.accept());
      await garantirPlataformaDisponivel(page, "PLT-E2E-SALA");

      await page.goto("/reservas");
      await expect(page.getByRole("heading", { name: "Reservas" })).toBeVisible();

      await page.getByRole("button", { name: "Nova Reserva" }).click();
      // Admin não tem setor de sessão (RN-USR-01) — escolhe o setor de destino (S14, RF-RES-01).
      if (chave === "admin") {
        await page.getByLabel("Setor Solicitante *").selectOption({ label: "TI" });
      }
      await page.getByLabel("Plataforma *").selectOption({ label: "Sala de Reuniões E2E (S14)" });
      await page.getByLabel("Data *").fill(dataFutura(1));
      await page.getByLabel("Horário Inicial *").fill(horaInicio);
      await page.getByLabel("Horário Final *").fill(horaFim);
      await page
        .getByLabel("Motivo / Descrição *")
        .fill(`E2E S14 — UC-01 (${chave}) — reunião de alinhamento de equipe`);
      await page.getByRole("button", { name: "Criar Reserva" }).click();

      // Modal fecha e a lista recarrega com a nova reserva pendente no topo. A tabela de
      // "Reservas" não exibe o motivo (colunas: Setor/Responsável/Plataforma/Data/
      // Horário/Prioridade/Status) — identifica a linha pela combinação plataforma +
      // horário (único por perfil nesta spec) + status "Pendente", que distingue a
      // reserva recém-criada de eventuais linhas "Cancelada" de execuções anteriores.
      await expect(page.getByRole("heading", { name: "Nova Reserva" })).toHaveCount(0);
      const linha = page
        .locator("tbody tr")
        .filter({ hasText: "Sala de Reuniões E2E (S14)" })
        .filter({ hasText: horaInicio })
        .filter({ hasText: "Pendente" });
      await expect(linha).toBeVisible();

      // Limpeza: cancela a reserva recém-criada para manter a fixture idempotente entre execuções.
      await linha.click();
      await page.getByRole("button", { name: "Cancelar Reserva" }).click();
      await expect(page.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);
    });
  });
}
