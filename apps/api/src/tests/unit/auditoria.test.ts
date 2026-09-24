/* Formatadores de auditoria (@plataformares/shared).
 *
 * A garantia que estes testes protegem é uma só e é a razão da camada existir: NENHUMA
 * nomenclatura interna — snake_case, camelCase, enum do banco, booleano cru — pode
 * escapar para o que o administrador lê. Por isso, além dos casos individuais, há um
 * teste que varre o catálogo inteiro procurando vazamento.
 *
 * Ficam aqui (e não em packages/shared) porque o pacote não tem runner próprio — mesmo
 * arranjo já usado por agendaLanes.test.ts, que também testa código de shared.
 */

import { describe, expect, it } from "vitest";
import {
  ACOES_POR_CATEGORIA,
  EVENTOS_AUDITORIA,
  alteracaoEmTexto,
  detalhesComplementares,
  formatarDetalhesAuditoria,
  traduzirAcao,
  traduzirCampo,
  traduzirRecurso,
  traduzirValor,
} from "@plataformares/shared";

/** Resumo em texto do que a listagem mostraria na coluna ALTERAÇÃO. */
function alteracao(acao: string, detalhes: unknown, entidade?: string): string {
  return alteracaoEmTexto(
    formatarDetalhesAuditoria(acao, detalhes as Record<string, unknown>, { entidade })
  );
}

describe("traduzirAcao", () => {
  it("traduz os códigos reais gravados pelo backend", () => {
    expect(traduzirAcao("criar_reserva").titulo).toBe("Reserva criada");
    expect(traduzirAcao("aprovar_reserva").titulo).toBe("Reserva aprovada");
    expect(traduzirAcao("finalizar_checklist").titulo).toBe("Checklist finalizado");
    expect(traduzirAcao("salvar_rascunho_checklist").titulo).toBe("Rascunho do checklist salvo");
    expect(traduzirAcao("editar_plataforma").titulo).toBe("Dados da plataforma atualizados");
    expect(traduzirAcao("alterar_status_plataforma").titulo).toBe("Status da plataforma alterado");
    expect(traduzirAcao("escalonar_sla_urgente").titulo).toBe("Reserva urgente escalonada");
    expect(traduzirAcao("alterar_status_usuario").titulo).toBe("Status do usuário alterado");
  });

  it("classifica tom e categoria", () => {
    expect(traduzirAcao("aprovar_reserva").tom).toBe("sucesso");
    expect(traduzirAcao("rejeitar_reserva").tom).toBe("critico");
    expect(traduzirAcao("alterar_status_plataforma").tom).toBe("atencao");
    expect(traduzirAcao("criar_reserva").tom).toBe("neutro");
    expect(traduzirAcao("alterar_status_plataforma").categoria).toBe("Frota");
    expect(traduzirAcao("finalizar_checklist").categoria).toBe("Segurança");
  });

  it("trata rascunho de checklist como atividade informativa", () => {
    // Alto volume, baixa consequência: não pode competir com aprovações na listagem.
    expect(traduzirAcao("salvar_rascunho_checklist").relevancia).toBe("informativa");
    expect(traduzirAcao("finalizar_checklist").relevancia).toBe("importante");
  });

  it("nunca devolve o código cru como título para evento desconhecido", () => {
    const meta = traduzirAcao("alguma_acao_futura");
    expect(meta.titulo).toBe("Alguma acao futura");
    expect(meta.titulo).not.toContain("_");
    expect(meta.categoria).toBe("Sistema");
  });
});

describe("traduzirRecurso / traduzirValor / traduzirCampo", () => {
  it("usa o vocabulário do produto, não o do banco", () => {
    expect(traduzirRecurso("Usuario")).toBe("Usuário");
    expect(traduzirRecurso("BloqueioAgenda")).toBe("Bloqueio de agenda");
    expect(traduzirRecurso("ConfiguracaoSistema")).toBe("Configurações");
    expect(traduzirRecurso(null)).toBe("Sistema");
  });

  it("traduz enums por família", () => {
    expect(traduzirValor("statusPlataforma", "manutencao")).toBe("Em manutenção");
    expect(traduzirValor("statusReserva", "em_uso")).toBe("Em uso");
    expect(traduzirValor("perfil", "gestor_setor")).toBe("Gestor de Setor");
    expect(traduzirValor("perfil", "admin")).toBe("Administrador");
  });

  it("nunca expõe camelCase como rótulo de campo", () => {
    expect(traduzirCampo("statusAnterior")).toBe("Status anterior");
    expect(traduzirCampo("totalRespostas")).toBe("Itens avaliados");
    expect(traduzirCampo("slaHoras")).toBe("Prazo de SLA");
    expect(traduzirCampo("perfilAprovador")).toBe("Perfil do aprovador");
  });
});

describe("formatarDetalhesAuditoria — casos reais da tela", () => {
  it("alteração de status de plataforma vira transição legível", () => {
    expect(
      alteracao("alterar_status_plataforma", { statusAnterior: "manutencao", statusNovo: "disponivel" }, "Plataforma")
    ).toBe("Em manutenção → Disponível");
  });

  it("usa o domínio de status certo conforme o recurso", () => {
    // As mesmas chaves, dois vocabulários diferentes: "em_uso" não existe em plataforma.
    expect(alteracao("cancelar_reserva", { statusAnterior: "agendada", statusNovo: "cancelada" }, "Reserva")).toBe(
      "Agendada → Cancelada"
    );
  });

  it("booleano de ativação vira o efeito, não true/false", () => {
    expect(alteracao("alterar_status_usuario", { ativoAnterior: true, ativoNovo: false }, "Usuario")).toBe(
      "Usuário desativado"
    );
    expect(alteracao("alterar_status_usuario", { ativoAnterior: false, ativoNovo: true }, "Usuario")).toBe(
      "Usuário ativado"
    );
    expect(alteracao("alterar_status_setor", { ativoAnterior: true, ativoNovo: false }, "Setor")).toBe(
      "Setor desativado"
    );
  });

  it("checklist conforme e com pendências geram frases distintas", () => {
    expect(alteracao("finalizar_checklist", { finalizar: true, todosConformes: true, totalRespostas: 6 })).toBe(
      "Checklist finalizado · 6 itens conformes"
    );
    expect(alteracao("finalizar_checklist", { finalizar: true, todosConformes: false, totalRespostas: 6 })).toBe(
      "Checklist finalizado com pendências · 6 itens avaliados"
    );
  });

  it("rascunho de checklist não se confunde com finalização", () => {
    expect(
      alteracao("salvar_rascunho_checklist", { finalizar: false, todosConformes: false, totalRespostas: 3 })
    ).toBe("Preenchimento parcial · 3 itens respondidos");
  });

  it("concorda em número — a frase é lida, não montada por template solto", () => {
    expect(alteracao("finalizar_checklist", { finalizar: true, todosConformes: true, totalRespostas: 1 })).toBe(
      "Checklist finalizado · 1 item conforme"
    );
    expect(alteracao("salvar_rascunho_checklist", { finalizar: false, totalRespostas: 1 })).toBe(
      "Preenchimento parcial · 1 item respondido"
    );
    expect(alteracao("escalonar_sla_urgente", { slaHoras: 1 })).toBe("SLA de 1 hora excedido");
  });

  it("SLA excedido explica o número em vez de mostrá-lo cru", () => {
    expect(alteracao("escalonar_sla_urgente", { slaHoras: 2 })).toBe("SLA de 2 horas excedido");
  });

  it("aprovação mostra a transição e, sem ela, quem aprovou", () => {
    expect(
      alteracao("aprovar_reserva", { perfilAprovador: "admin", statusAnterior: "pendente", statusNovo: "agendada" }, "Reserva")
    ).toBe("Pendente → Agendada");
    expect(alteracao("aprovar_reserva", { perfilAprovador: "admin" }, "Reserva")).toBe(
      "Aprovado por Administrador"
    );
  });

  it("mudança de perfil de acesso vira transição de perfis", () => {
    expect(
      alteracao("alterar_perfil_usuario", { perfilAnterior: "colaborador", perfilNovo: "gestor_setor" }, "Usuario")
    ).toBe("Colaborador → Gestor de Setor");
  });

  it("criação de reserva resume a janela reservada", () => {
    expect(
      alteracao("criar_reserva", { plataformaId: "abc", data: "2026-08-14", horaInicio: "18:00", horaFim: "22:00", prioridade: "normal" }, "Reserva")
    ).toBe("14 ago · 18:00–22:00");
  });

  it("prioridade só entra no resumo quando é exceção", () => {
    const urgente = alteracao(
      "criar_reserva",
      { data: "2026-08-14", horaInicio: "08:00", horaFim: "10:00", prioridade: "urgente" },
      "Reserva"
    );
    expect(urgente).toContain("prioridade urgente");
  });

  it("payload não-JSON não some nem quebra", () => {
    expect(alteracao("acao_qualquer", "texto solto do log")).toBe("texto solto do log");
    expect(alteracao("acao_qualquer", null)).toBe("");
  });
});

describe("detalhesComplementares", () => {
  it("não repete o que a frase de alteração já disse", () => {
    const campos = detalhesComplementares({
      statusAnterior: "manutencao",
      statusNovo: "disponivel",
      ocorrenciaId: "uuid",
      motivo: "Vazamento hidráulico",
    });
    const rotulos = campos.map((c) => c.rotulo);
    expect(rotulos).not.toContain("Status anterior");
    expect(rotulos).not.toContain("Novo status");
    expect(rotulos).toContain("Motivo");
  });

  it("traduz booleanos e enums remanescentes", () => {
    const campos = detalhesComplementares({ exigeChecklist: true, gravidade: "alta", origem: "AUTOMATICA" });
    const porRotulo = Object.fromEntries(campos.map((c) => [c.rotulo, c.valor]));
    expect(porRotulo["Exige checklist"]).toBe("Sim");
    expect(porRotulo["Gravidade"]).toBe("Alta");
    expect(porRotulo["Origem"]).toBe("Automática");
  });

  it("formata tamanho de arquivo em unidade legível", () => {
    const campos = detalhesComplementares({ tamanhoBytes: 2_097_152 });
    expect(campos[0].valor).toBe("2.0 MB");
  });
});

describe("integridade do catálogo", () => {
  it("nenhum título exposto ao usuário carrega nomenclatura interna", () => {
    for (const [acao, meta] of Object.entries(EVENTOS_AUDITORIA)) {
      expect(meta.titulo, `título de ${acao}`).not.toMatch(/_/);
      // camelCase remanescente (duas palavras coladas com maiúscula no meio)
      expect(meta.titulo, `título de ${acao}`).not.toMatch(/[a-z][A-Z]/);
      expect(meta.titulo.trim().length, `título de ${acao}`).toBeGreaterThan(0);
    }
  });

  it("todo evento pertence a uma categoria indexada", () => {
    for (const [acao, meta] of Object.entries(EVENTOS_AUDITORIA)) {
      expect(ACOES_POR_CATEGORIA[meta.categoria], `categoria de ${acao}`).toContain(acao);
    }
  });
});
