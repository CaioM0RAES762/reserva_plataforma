import { test, expect } from "@playwright/test";
import { authFile } from "./global-setup";
import { garantirPlataformaDisponivel, dataFutura, modalAtual, paraDataBR } from "./helpers";

// UC-03 — Preencher Checklist e Iniciar Uso + UC-04 — Reportar Ocorrência ao Concluir
// (SDD §9, RN-RES-12, RN-CHK-01/02, RN-PLAT-04). Encadeados numa única reserva porque
// representam o mesmo ciclo de vida contínuo (agendada → checklist → em_uso → concluída
// com ocorrência) numa plataforma que exige checklist (elevatória, risco alto).
//
// Cada ação de mudança de status fecha o modal (onAtualizado recarrega a lista na tela
// "Reservas") — por isso a linha é reaberta a cada etapa. O preenchimento do checklist é
// a exceção: usa um callback local (não fecha o modal), permitindo checklist → Iniciar Uso
// na mesma sessão do modal.
test.describe("UC-03/UC-04 Checklist de Segurança, Iniciar Uso e Ocorrência ao Concluir", () => {
  test.use({ storageState: authFile("admin") });

  test("preenche checklist, inicia uso, conclui reportando ocorrência com manutenção automática", async ({ page }) => {
    const dia = dataFutura(3);
    const HORA = "07:00";

    await garantirPlataformaDisponivel(page, "PLT-S8-DEMO");

    // --- Criação + auto-aprovação (Admin aprova diretamente, sem esperar o Gestor) ---
    await page.goto("/reservas");
    await page.getByRole("button", { name: "Nova Reserva" }).click();
    // Admin não tem setor de sessão (RN-USR-01) — escolhe o setor de destino (S14, RF-RES-01).
    await page.getByLabel("Setor Solicitante *").selectOption({ label: "TI" });
    await page.getByLabel("Plataforma *").selectOption({ label: "Plataforma Elevatória Demo S8" });
    await page.getByLabel("Data *").fill(dia);
    await page.getByLabel("Horário Inicial *").fill(HORA);
    await page.getByLabel("Horário Final *").fill("08:00");
    await page
      .getByLabel("Motivo / Descrição *")
      .fill("E2E S14 — UC-03/04 — manutenção preventiva");
    await page.getByRole("button", { name: "Criar Reserva" }).click();
    await expect(page.getByRole("heading", { name: "Nova Reserva" })).toHaveCount(0);

    // A tabela de "Reservas" não exibe o motivo — identifica a linha pela combinação
    // plataforma + data + horário, estável ao longo de toda a transição de status
    // (pendente → agendada → em_uso → concluída) já que o locator é reavaliado a cada
    // uso. A data entra no filtro porque o horário sozinho se repete entre execuções
    // desta mesma suite em datas diferentes.
    const linha = page
      .locator("tbody tr")
      .filter({ hasText: "Plataforma Elevatória Demo S8" })
      .filter({ hasText: paraDataBR(dia) })
      .filter({ hasText: HORA });
    await linha.click();
    await modalAtual(page).getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);
    await expect(linha.getByText("Agendada", { exact: true })).toBeVisible();

    // --- UC-03: checklist de segurança (categoria elevatória — RN-RES-12) ---
    await linha.click();
    const modalChecklist = modalAtual(page);
    await expect(modalChecklist.getByText("Checklist de Segurança (NR-18/NR-35)")).toBeVisible();
    await expect(modalChecklist.getByText("Pendente de preenchimento")).toBeVisible();

    const botoesConforme = modalChecklist.getByRole("button", { name: "Conforme", exact: true });
    const totalItens = await botoesConforme.count();
    expect(totalItens).toBeGreaterThan(0);
    for (let i = 0; i < totalItens; i++) {
      await botoesConforme.nth(i).click();
    }
    await modalChecklist.getByRole("button", { name: "Salvar Checklist" }).click();
    await expect(modalChecklist.getByText("Aprovado — libera Iniciar Uso")).toBeVisible();

    // --- UC-03: Iniciar Uso (só libera com checklist 100% conforme) ---
    const botaoIniciarUso = modalChecklist.getByRole("button", { name: "Iniciar Uso" });
    await expect(botaoIniciarUso).toBeEnabled();
    await botaoIniciarUso.click();
    await expect(page.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);
    await expect(linha.getByText("Em Uso")).toBeVisible();

    // --- UC-04: concluir reportando ocorrência com abertura automática de manutenção ---
    await linha.click();
    const modalConcluir = modalAtual(page);
    await modalConcluir.getByRole("button", { name: "Concluir" }).click();
    await expect(modalConcluir.getByText("Houve alguma ocorrência ou avaria durante o uso?")).toBeVisible();
    await modalConcluir.getByRole("button", { name: "Sim, reportar ocorrência" }).click();

    await modalConcluir
      .getByLabel("Descrição da ocorrência *")
      .fill("E2E S14 — vazamento hidráulico identificado ao final do uso.");
    await modalConcluir.getByLabel("Gravidade").selectOption("alta");
    await modalConcluir
      .getByLabel("Abrir manutenção automática (RN-PLAT-04 — bloqueia novas reservas na plataforma)")
      .check();
    await modalConcluir.getByRole("button", { name: "Registrar Ocorrência e Concluir" }).click();
    await expect(page.getByRole("heading", { name: "Detalhe da Reserva" })).toHaveCount(0);
    await expect(linha.getByText("Concluída")).toBeVisible();

    // --- RN-PLAT-04: ocorrência grave com geraManutencao=true muda a plataforma para "Manutenção" ---
    await page.goto("/plataformas");
    const linhaPlataforma = page.locator("tbody tr").filter({ hasText: "PLT-S8-DEMO" });
    await expect(linhaPlataforma.getByText("Manutenção")).toBeVisible();
  });
});
