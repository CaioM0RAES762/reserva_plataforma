import ExcelJS from "exceljs";
import puppeteer from "puppeteer";
import type {
  RankingSetoresResposta,
  SegurancaResposta,
  SlaAprovacaoResposta,
  UtilizacaoResposta,
} from "@plataformares/shared";

// S13 (RF-REL-06): exportação de qualquer um dos 4 relatórios em PDF (Puppeteer,
// HTML → PDF) ou Excel (ExcelJS). Cada relatório tem forma própria (SDD §6.7), então
// cada exportador constrói suas próprias linhas/planilha — sem tentar generalizar uma
// tabela única que não caberia nos 4 formatos.

export type RelatorioExportavel = "utilizacao" | "ranking-setores" | "sla-aprovacao" | "seguranca";

export type DadosRelatorio =
  | { relatorio: "utilizacao"; dados: UtilizacaoResposta }
  | { relatorio: "ranking-setores"; dados: RankingSetoresResposta }
  | { relatorio: "sla-aprovacao"; dados: SlaAprovacaoResposta }
  | { relatorio: "seguranca"; dados: SegurancaResposta };

const TITULOS: Record<RelatorioExportavel, string> = {
  utilizacao: "Taxa de Utilização por Plataforma",
  "ranking-setores": "Ranking de Setores",
  "sla-aprovacao": "SLA de Aprovação e Distribuição de Reservas",
  seguranca: "Indicadores de Segurança",
};

function formatarPercentual(valor: number): string {
  return `${valor.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Excel (ExcelJS)
// ---------------------------------------------------------------------------

function estilarCabecalho(linha: ExcelJS.Row): void {
  linha.font = { bold: true, color: { argb: "FFFFFFFF" } };
  linha.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
}

export async function gerarExcelRelatorio(entrada: DadosRelatorio): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PlataformaRes";
  workbook.created = new Date();

  const planilha = workbook.addWorksheet(TITULOS[entrada.relatorio].slice(0, 31));

  switch (entrada.relatorio) {
    case "utilizacao": {
      planilha.columns = [
        { header: "Código", key: "codigo", width: 14 },
        { header: "Plataforma", key: "nome", width: 28 },
        { header: "Categoria", key: "categoria", width: 14 },
        { header: "Horas Disponíveis", key: "horasDisponiveis", width: 18 },
        { header: "Horas Reservadas", key: "horasReservadas", width: 18 },
        { header: "Taxa de Utilização (%)", key: "taxaUtilizacao", width: 20 },
      ];
      estilarCabecalho(planilha.getRow(1));
      for (const p of entrada.dados.plataformas) {
        planilha.addRow({
          codigo: p.codigo,
          nome: p.nome,
          categoria: p.categoria,
          horasDisponiveis: p.horasDisponiveis,
          horasReservadas: p.horasReservadas,
          taxaUtilizacao: p.taxaUtilizacao,
        });
      }
      break;
    }
    case "ranking-setores": {
      planilha.columns = [
        { header: "Setor", key: "setorNome", width: 24 },
        { header: "Total de Reservas", key: "totalReservas", width: 18 },
        { header: "Total Rejeitadas", key: "totalRejeitadas", width: 18 },
        { header: "Taxa de Rejeição (%)", key: "taxaRejeicao", width: 20 },
      ];
      estilarCabecalho(planilha.getRow(1));
      for (const s of entrada.dados.setores) {
        planilha.addRow({
          setorNome: s.setorNome,
          totalReservas: s.totalReservas,
          totalRejeitadas: s.totalRejeitadas,
          taxaRejeicao: s.taxaRejeicao,
        });
      }
      break;
    }
    case "sla-aprovacao": {
      planilha.columns = [
        { header: "Métrica", key: "metrica", width: 30 },
        { header: "Valor", key: "valor", width: 20 },
      ];
      estilarCabecalho(planilha.getRow(1));
      planilha.addRow({
        metrica: "Tempo médio de aprovação (h)",
        valor: entrada.dados.tempoMedioAprovacaoHoras ?? "—",
      });
      planilha.addRow({ metrica: "Total de decisões no período", valor: entrada.dados.totalDecisoes });
      planilha.addRow({});
      planilha.addRow({ metrica: "Distribuição por status" });
      for (const item of entrada.dados.porStatus) {
        planilha.addRow({ metrica: item.chave, valor: item.quantidade });
      }
      planilha.addRow({});
      planilha.addRow({ metrica: "Distribuição por prioridade" });
      for (const item of entrada.dados.porPrioridade) {
        planilha.addRow({ metrica: item.chave, valor: item.quantidade });
      }
      planilha.addRow({});
      planilha.addRow({ metrica: "Distribuição por categoria de plataforma" });
      for (const item of entrada.dados.porCategoria) {
        planilha.addRow({ metrica: item.chave, valor: item.quantidade });
      }
      planilha.addRow({});
      planilha.addRow({ metrica: "Tendência mensal" });
      for (const item of entrada.dados.tendenciaMensal) {
        planilha.addRow({ metrica: item.mes, valor: item.quantidade });
      }
      break;
    }
    case "seguranca": {
      planilha.addRow(["Total de checklists no período", entrada.dados.totalChecklists]);
      planilha.addRow(["Checklists com não conformidade", entrada.dados.totalChecklistsNaoConformes]);
      planilha.addRow(["% de não conformidade", formatarPercentual(entrada.dados.percentualChecklistNaoConforme)]);
      planilha.addRow([]);
      const cabecalho = planilha.addRow(["Plataforma", "Baixa", "Média", "Alta", "Total"]);
      estilarCabecalho(cabecalho);
      for (const o of entrada.dados.ocorrenciasPorPlataforma) {
        planilha.addRow([o.plataformaNome, o.baixa, o.media, o.alta, o.total]);
      }
      break;
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// PDF (Puppeteer — HTML → PDF)
// ---------------------------------------------------------------------------

function montarTabelaHtml(cabecalho: string[], linhas: Array<Array<string | number>>): string {
  const th = cabecalho.map((c) => `<th>${c}</th>`).join("");
  const tr = linhas
    .map((linha) => `<tr>${linha.map((celula) => `<td>${celula}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function montarCorpoHtml(entrada: DadosRelatorio): string {
  switch (entrada.relatorio) {
    case "utilizacao":
      return montarTabelaHtml(
        ["Código", "Plataforma", "Categoria", "Horas Disponíveis", "Horas Reservadas", "Utilização"],
        entrada.dados.plataformas.map((p) => [
          p.codigo,
          p.nome,
          p.categoria,
          p.horasDisponiveis,
          p.horasReservadas,
          formatarPercentual(p.taxaUtilizacao),
        ])
      );
    case "ranking-setores":
      return montarTabelaHtml(
        ["Setor", "Total de Reservas", "Rejeitadas", "Taxa de Rejeição"],
        entrada.dados.setores.map((s) => [
          s.setorNome,
          s.totalReservas,
          s.totalRejeitadas,
          formatarPercentual(s.taxaRejeicao),
        ])
      );
    case "sla-aprovacao":
      return `
        <p><strong>Tempo médio de aprovação:</strong> ${
          entrada.dados.tempoMedioAprovacaoHoras !== null ? `${entrada.dados.tempoMedioAprovacaoHoras}h` : "—"
        } (${entrada.dados.totalDecisoes} decisões)</p>
        <h3>Distribuição por status</h3>
        ${montarTabelaHtml(["Status", "Quantidade"], entrada.dados.porStatus.map((i) => [i.chave, i.quantidade]))}
        <h3>Distribuição por prioridade</h3>
        ${montarTabelaHtml(["Prioridade", "Quantidade"], entrada.dados.porPrioridade.map((i) => [i.chave, i.quantidade]))}
        <h3>Distribuição por categoria de plataforma</h3>
        ${montarTabelaHtml(["Categoria", "Quantidade"], entrada.dados.porCategoria.map((i) => [i.chave, i.quantidade]))}
        <h3>Tendência mensal</h3>
        ${montarTabelaHtml(["Mês", "Quantidade"], entrada.dados.tendenciaMensal.map((i) => [i.mes, i.quantidade]))}
      `;
    case "seguranca":
      return `
        <p><strong>Checklists no período:</strong> ${entrada.dados.totalChecklists}
           — <strong>não conformes:</strong> ${entrada.dados.totalChecklistsNaoConformes}
           (${formatarPercentual(entrada.dados.percentualChecklistNaoConforme)})</p>
        <h3>Ocorrências por plataforma</h3>
        ${montarTabelaHtml(
          ["Plataforma", "Baixa", "Média", "Alta", "Total"],
          entrada.dados.ocorrenciasPorPlataforma.map((o) => [o.plataformaNome, o.baixa, o.media, o.alta, o.total])
        )}
      `;
  }
}

function montarHtmlRelatorio(entrada: DadosRelatorio, periodo: { inicio: string; fim: string }): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1f2e; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h3 { font-size: 14px; margin-top: 24px; margin-bottom: 8px; }
  .periodo { color: #6b7280; font-size: 12px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 12px; }
  th { background: #2563eb; color: #fff; text-align: left; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
</style>
</head>
<body>
  <h1>PlataformaRes — ${TITULOS[entrada.relatorio]}</h1>
  <div class="periodo">Período: ${periodo.inicio} a ${periodo.fim}</div>
  ${montarCorpoHtml(entrada)}
</body>
</html>`;
}

export async function gerarPdfRelatorio(
  entrada: DadosRelatorio,
  periodo: { inicio: string; fim: string }
): Promise<Buffer> {
  const html = montarHtmlRelatorio(entrada, periodo);
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" } });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
