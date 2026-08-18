import { expect, test } from "@playwright/test";
import { authFile } from "./global-setup";

// Cenários I, J e K da correção do fluxo de checklist. Deliberadamente SOMENTE LEITURA:
// navega e verifica, sem criar reserva nem finalizar checklist. Fluxos de escrita
// notificam os Admin ativos por e-mail, e o worker do ambiente de desenvolvimento envia
// de verdade — um teste de UI não é motivo para disparar mensagem para ninguém.

test.use({ storageState: authFile("admin") });

test("CENÁRIO I — Checklists abre no dia atual, não no meio do histórico", async ({ page }) => {
  await page.goto("/checklists");

  await expect(page.getByRole("heading", { name: "Checklists NR-18/35" })).toBeVisible();

  // O filtro temporal padrão é "Hoje" — o chip nasce pressionado, sem nenhum clique.
  const chipHoje = page.getByRole("button", { name: "Hoje", exact: true });
  await expect(chipHoje).toHaveAttribute("aria-pressed", "true");

  // E os demais atalhos existem, para navegar sem perder o histórico.
  for (const rotulo of ["Amanhã", "Esta semana", "Próximos 7 dias", "Histórico"]) {
    await expect(page.getByRole("button", { name: rotulo, exact: true })).toBeVisible();
  }

  // Os filtros de situação continuam disponíveis e combinam com o período.
  for (const rotulo of ["Todos", "Pendentes", "Em preenchimento", "Concluídos", "Com não conformidade"]) {
    await expect(page.getByRole("button", { name: rotulo, exact: true })).toBeVisible();
  }
});

test("CENÁRIO I — 'Esta semana' e 'Histórico' recarregam a lista sem sair da tela", async ({ page }) => {
  await page.goto("/checklists");

  await page.getByRole("button", { name: "Esta semana", exact: true }).click();
  await expect(page.getByRole("button", { name: "Esta semana", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("button", { name: "Hoje", exact: true })).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await expect(page.getByRole("button", { name: "Histórico", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Checklists NR-18/35" })).toBeVisible();
});

test("CENÁRIO J — checklists do próprio usuário ficam destacados como em Reservas", async ({ page }) => {
  // O destaque é o mesmo par (fundo + faixa lateral) da tela de Reservas: a classe
  // `linhaMinha` do CSS Module compartilhado. Procurar por ela em Histórico, que é onde há
  // execuções acumuladas, evita depender de existir checklist marcado para hoje.
  await page.goto("/checklists");
  await page.getByRole("button", { name: "Histórico", exact: true }).click();
  await page.waitForTimeout(600);

  const linhas = page.locator('[class*="linha"]');
  const total = await linhas.count();
  test.skip(total === 0, "Nenhum checklist no histórico deste ambiente para avaliar o destaque.");

  // Toda linha destacada precisa exibir o selo textual correspondente — o destaque nunca é
  // só cor (critério de acessibilidade já aplicado em Reservas).
  const destacadas = page.locator('[class*="linhaMinha"]');
  const totalDestacadas = await destacadas.count();
  if (totalDestacadas > 0) {
    await expect(destacadas.first().getByText("Meu checklist")).toBeVisible();
  }
});

test("CENÁRIO K — Painel TV não existe mais na aplicação", async ({ page }) => {
  await page.goto("/dashboard");

  // Sem item no menu lateral.
  await expect(page.getByRole("link", { name: "Painel TV" })).toHaveCount(0);
  // Sem atalho na Frota.
  await page.goto("/plataformas");
  await expect(page.getByRole("link", { name: "Painel TV" })).toHaveCount(0);
  await expect(page.getByText("Painel TV")).toHaveCount(0);

  // E a rota foi removida de fato, não escondida por CSS.
  const resposta = await page.request.get("/plataformas/painel-tv");
  expect(resposta.status()).toBe(404);
  const painelPublico = await page.request.get("/painel");
  expect(painelPublico.status()).toBe(404);
  // A API do painel também saiu.
  const api = await page.request.get("http://localhost:3335/api/v1/painel/tokens");
  expect(api.status()).toBe(404);
});

test("Frota — a configuração de checklist do equipamento está no cadastro", async ({ page }) => {
  await page.goto("/plataformas");
  await expect(page.getByRole("heading", { name: "Plataformas" })).toBeVisible();

  // Abre o formulário da primeira plataforma e confere a seção Segurança.
  await page.getByRole("button", { name: "Editar" }).first().click();
  const modal = page.locator('[class*="modal"]').last();
  await expect(modal.getByText("Segurança")).toBeVisible();
  await expect(modal.getByText("Exige checklist de segurança antes da aprovação")).toBeVisible();
  await expect(modal.getByText("Automação")).toBeVisible();
  await expect(modal.getByText("Iniciar automaticamente no horário agendado")).toBeVisible();
});
