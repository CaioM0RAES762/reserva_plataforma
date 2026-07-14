import { request as playwrightRequest, type Locator, type Page } from "@playwright/test";
import { authFile } from "./global-setup";

// Os modais (Nova Reserva, Detalhe da Reserva, Bloqueio) usam CSS Modules — o nome da
// classe é "mangled" (`page_modalOverlay__xyz`) então um seletor exato (`.modalOverlay`)
// nunca bate; usamos [class*=] para casar por substring, imune ao hash. Necessário porque
// vários textos do modal (status, nomes) também aparecem em elementos de fundo (linha da
// tabela, sidebar), e precisamos escopar as asserções ao modal para evitar strict-mode
// violations do Playwright (locator resolvendo mais de um elemento).
export function modalAtual(page: Page): Locator {
  return page.locator('[class*="modalOverlay"]').last();
}

export interface PlataformaApi {
  id: string;
  codigo: string;
  nome: string;
  status: string;
}

const API_URL = "http://localhost:3335";

// Busca uma plataforma pelo código via a própria API (usa os cookies já autenticados da
// `page`) — descobre o id real (UUID) sem depender de valores fixos entre execuções.
export async function buscarPlataformaViaApi(page: Page, codigo: string): Promise<PlataformaApi> {
  const resposta = await page.request.get(`${API_URL}/api/v1/plataformas`);
  const lista = (await resposta.json()) as PlataformaApi[];
  const encontrada = lista.find((p) => p.codigo === codigo);
  if (!encontrada) throw new Error(`Plataforma ${codigo} não encontrada via API.`);
  return encontrada;
}

// PATCH /plataformas/:id/status exige perfil admin (RBAC) — usa sempre uma sessão de
// Admin para o reset de fixture, independente de qual perfil está rodando o teste que
// chamou esta função (um `page` de Colaborador/Gestor receberia 403 aqui, silenciosamente
// sem efeito, deixando a plataforma "presa" no status de uma execução anterior).
export async function garantirPlataformaDisponivel(page: Page, codigo: string): Promise<PlataformaApi> {
  const plataforma = await buscarPlataformaViaApi(page, codigo);
  if (plataforma.status !== "disponivel") {
    const adminCtx = await playwrightRequest.newContext({
      baseURL: API_URL,
      storageState: authFile("admin"),
    });
    const resposta = await adminCtx.patch(`/api/v1/plataformas/${plataforma.id}/status`, {
      data: { status: "disponivel" },
    });
    if (!resposta.ok()) {
      throw new Error(
        `Falha ao normalizar status da plataforma ${codigo} para "disponivel": ${resposta.status()} ${await resposta.text()}`
      );
    }
    await adminCtx.dispose();
  }
  return plataforma;
}

// Data futura (YYYY-MM-DD), respeitando antecedência mínima (2h, ConfiguracaoSistema).
// Inclui um jitter aleatório (0-500 dias) além da base pedida: reexecuções da suite (ex.:
// depois de uma falha que não chegou a limpar a reserva criada) não devem colidir com uma
// reserva "pendente"/"agendada" órfã de uma execução anterior na mesma combinação
// plataforma+data+horário — ver RN-RES-02 (conflito de horário).
export function dataFutura(diasAFrente: number): string {
  const d = new Date();
  d.setDate(d.getDate() + diasAFrente + Math.floor(Math.random() * 500));
  return d.toISOString().slice(0, 10);
}

// Converte "YYYY-MM-DD" para "DD/MM/YYYY" — formato exibido nas colunas "Data" das
// tabelas de Reservas/Fila de Aprovações (ver `formatarData` nos componentes do
// frontend). Usado para desambiguar linhas por data além de plataforma/horário, já que
// o horário sozinho (ex.: "08:00") se repete entre execuções em datas diferentes.
export function paraDataBR(isoDate: string): string {
  const [ano, mes, dia] = isoDate.split("-");
  return `${dia}/${mes}/${ano}`;
}
