import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  alterarStatusReservaSchema,
  aprovarReservaSchema,
  CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO,
  CODIGO_CONFLITO_APROVACAO,
  CODIGO_CONFLITO_SUBSTITUIVEL,
  CODIGO_ERRO_HORARIO_INDISPONIVEL,
  conflitoQuerySchema,
  criarReservaSchema,
  listarReservasQuerySchema,
  prioridadeEhUrgente,
  rejeitarReservaSchema,
  resolverPaginacao,
  setorExigeEmpresaTerceirizada,
  validarEmpresaTerceirizada,
  type CategoriaPlataforma,
  type PrioridadeReserva,
  type RiscoPlataforma,
  type StatusReserva,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import {
  autenticar,
  PERFIS_APROVADORES,
  podeDecidirAprovacao,
  requireRole,
  usuarioNoEscopoDaReserva,
} from "../middlewares/rbac.js";
import { validarJanelaReserva } from "../services/conflito.service.js";
import {
  analisarAprovacao,
  executarComRepeticaoEmDeadlock,
  verificarBloqueio,
  verificarDisponibilidade,
} from "../services/disponibilidade.service.js";
import { obterModoAprovacaoReservas, obterRegrasReservaConfiguraveis } from "../services/configuracao.service.js";
import { diaSemanaDe, gerarDatasRecorrencia } from "../services/recorrencia.service.js";
import {
  concluirReserva,
  contabilizarUsoReserva,
  horaAtualBrasilia,
  iniciarUsoReserva,
} from "../services/reservaTransicao.service.js";
import { janelaTotalmenteVencida, transicionar, TransicaoInvalidaError } from "../services/reservaEstado.service.js";
import { agoraEmBrasilia } from "../services/automacaoReserva.service.js";
import { publicarEventoGlobal, publicarEventoUsuario } from "../services/eventos.service.js";
import {
  despacharEmailsDeNotificacoes,
  registrarNotificacao,
  type NotificacaoRegistrada,
} from "../services/notificacao.service.js";

// E-mail é canal ADICIONAL da notificação interna: disparado depois do commit e SEM await —
// Redis/SMTP indisponível nunca segura nem reverte a operação (o despachante loga as falhas).
function enviarEmailsEmSegundoPlano(notificacoes: NotificacaoRegistrada[]): void {
  void despacharEmailsDeNotificacoes(notificacoes).catch((err: Error) =>
    console.error(`[EMAIL][notificacao] falha-enfileirar motivo="${err.message}"`)
  );
}

export interface ReservaRow {
  id: string;
  setor_id: string;
  setor_nome: string;
  // NULL em setores internos e em reservas anteriores à migration 0020.
  empresa_terceirizada: string | null;
  solicitante_id: string;
  solicitante_nome: string;
  plataforma_id: string;
  plataforma_nome: string;
  plataforma_categoria: string;
  plataforma_localizacao: string | null;
  data: string;
  hora_inicio: string;
  hora_fim: string;
  quantidade_pessoas: number;
  motivo: string;
  prioridade: string;
  status: string;
  aprovado_por_nome: string | null;
  segunda_aprovacao_por_nome: string | null;
  motivo_rejeicao: string | null;
  telefone_contato: string | null;
  plataforma_telefone_emergencia: string | null;
  hora_inicio_real: string | null;
  hora_fim_real: string | null;
  recorrencia_id: string | null;
  inicio_automatico: boolean;
  fim_automatico: boolean;
  substituida_por_id: string | null;
  motivo_cancelamento: string | null;
  uso_contabilizado_minutos: number | null;
  criado_em: Date;
  atualizado_em: Date;
}

export const SELECT_RESERVA = `
  r.id, r.setor_id, s.nome AS setor_nome,
  r.empresa_terceirizada,
  r.solicitante_id, u.nome AS solicitante_nome,
  r.plataforma_id, p.nome AS plataforma_nome, p.categoria AS plataforma_categoria,
  p.localizacao AS plataforma_localizacao,
  CONVERT(varchar(10), r.data, 23) AS data,
  CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
  CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim,
  r.quantidade_pessoas,
  r.motivo, r.prioridade, r.status,
  aprovador.nome AS aprovado_por_nome,
  segundo_aprovador.nome AS segunda_aprovacao_por_nome,
  r.motivo_rejeicao,
  r.telefone_contato,
  p.telefone_emergencia AS plataforma_telefone_emergencia,
  CONVERT(varchar(5), r.hora_inicio_real, 108) AS hora_inicio_real,
  CONVERT(varchar(5), r.hora_fim_real, 108) AS hora_fim_real,
  r.recorrencia_id,
  r.inicio_automatico, r.fim_automatico,
  r.substituida_por_id, r.motivo_cancelamento, r.uso_contabilizado_minutos,
  r.criado_em, r.atualizado_em`;

export const FROM_RESERVA = `
  FROM Reserva r
  JOIN Setor s ON s.id = r.setor_id
  JOIN Usuario u ON u.id = r.solicitante_id
  JOIN Plataforma p ON p.id = r.plataforma_id
  -- aprovado_por_id é preenchido pela aprovação (migration 0022); segunda_aprovacao_por_id
  -- só existe em reservas históricas da antiga dupla aprovação.
  LEFT JOIN Usuario aprovador ON aprovador.id = r.aprovado_por_id
  LEFT JOIN Usuario segundo_aprovador ON segundo_aprovador.id = r.segunda_aprovacao_por_id`;

export function mapReserva(row: ReservaRow) {
  return {
    id: row.id,
    setorId: row.setor_id,
    setorNome: row.setor_nome,
    // Só preenchido em reservas do setor "Terceirizados" (ver POST /reservas); null nas demais.
    empresaTerceirizada: row.empresa_terceirizada,
    solicitanteId: row.solicitante_id,
    solicitanteNome: row.solicitante_nome,
    plataformaId: row.plataforma_id,
    plataformaNome: row.plataforma_nome,
    plataformaCategoria: row.plataforma_categoria,
    // Exibido na coluna "Recurso" da listagem de Reservas ("Fachada Leste · motivo") —
    // sem isto, a linha não dizia ONDE a plataforma fica.
    plataformaLocalizacao: row.plataforma_localizacao,
    data: row.data,
    horaInicio: row.hora_inicio,
    horaFim: row.hora_fim,
    quantidadePessoas: row.quantidade_pessoas,
    motivo: row.motivo,
    prioridade: row.prioridade,
    status: row.status,
    // Snapshot do contato informado na criação — nunca o telefone atual do cadastro do
    // usuário, para que a reserva antiga continue mostrando quem contatar naquela data.
    telefoneContato: row.telefone_contato,
    // Contato de emergência do EQUIPAMENTO, projetado aqui para que quem está em campo
    // não precise abrir a Frota para achá-lo.
    plataformaTelefoneEmergencia: row.plataforma_telefone_emergencia,
    aprovadoPorNome: row.aprovado_por_nome,
    segundaAprovacaoPorNome: row.segunda_aprovacao_por_nome,
    motivoRejeicao: row.motivo_rejeicao,
    substituidaPorId: row.substituida_por_id,
    motivoCancelamento: row.motivo_cancelamento,
    usoContabilizadoMinutos: row.uso_contabilizado_minutos,
    horaInicioReal: row.hora_inicio_real,
    horaFimReal: row.hora_fim_real,
    recorrenciaId: row.recorrencia_id,
    inicioAutomatico: row.inicio_automatico,
    fimAutomatico: row.fim_automatico,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

async function registrarAuditoriaReserva(
  transaction: sql.Transaction,
  usuarioId: string,
  acao: string,
  reservaId: string,
  detalhes: Record<string, unknown>
): Promise<void> {
  await transaction
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .input("acao", sql.VarChar, acao)
    .input("entidade_id", sql.UniqueIdentifier, reservaId)
    .input("detalhes", sql.NVarChar, JSON.stringify(detalhes))
    .query(
      `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       VALUES (@usuario_id, @acao, 'Reserva', @entidade_id, @detalhes)`
    );
}

interface ReservaContexto {
  id: string;
  status: StatusReserva;
  setor_id: string;
  solicitante_id: string;
  solicitante_email: string;
  plataforma_id: string;
  plataforma_nome: string;
  plataforma_risco: RiscoPlataforma;
  plataforma_categoria: CategoriaPlataforma;
  // RN-PLAT-01/04: uma plataforma que foi para manutenção/inativa depois de a reserva ser
  // agendada não pode entrar em uso — checado na transição.
  plataforma_status: string;
  prioridade: PrioridadeReserva;
  aprovado_por_id: string | null;
  data: string;
  hora_inicio: string;
  hora_fim: string;
}

async function buscarContextoReserva(id: string): Promise<ReservaContexto | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("id", sql.UniqueIdentifier, id)
    .query<ReservaContexto>(
      `SELECT r.id, r.status, r.setor_id, r.solicitante_id, u.email AS solicitante_email,
              r.plataforma_id, p.nome AS plataforma_nome, p.risco AS plataforma_risco, p.categoria AS plataforma_categoria,
              p.status AS plataforma_status,
              r.prioridade, r.aprovado_por_id,
              CONVERT(varchar(10), r.data, 23) AS data,
              CONVERT(varchar(5), r.hora_inicio, 108) AS hora_inicio,
              CONVERT(varchar(5), r.hora_fim, 108) AS hora_fim
       FROM Reserva r
       JOIN Usuario u ON u.id = r.solicitante_id
       JOIN Plataforma p ON p.id = r.plataforma_id
       WHERE r.id = @id`
    );
  return result.recordset[0] ?? null;
}

// Disponibilidade (RN-RES-02 conflito de reserva + RN-RES-11/RN-BLK-01 bloqueio de
// agenda) foi centralizada em services/disponibilidade.service.ts — fonte única de
// verdade reaproveitada pela criação de reserva (abaixo) e por GET /reservas/conflitos.

export async function reservasRoutes(app: FastifyInstance): Promise<void> {
  const criarReserva = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = criarReservaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }

    // RF-RES-01: setor/solicitante vêm da sessão para Gestor/Colaborador (nunca do body,
    // por segurança). Admin é a exceção estrutural: RN-USR-01 diz que Admin não possui
    // setor_id próprio, mas RF-RES-01 o lista entre quem pode solicitar reserva — por
    // isso, exclusivamente para o perfil admin, o setor de destino vem do body.
    const solicitanteId = request.usuario!.sub;
    let setorId = request.usuario!.setorId;
    if (request.usuario!.perfil === "admin") {
      if (!parsed.data.setorId) {
        return reply
          .status(422)
          .send({ erro: "Selecione o setor para o qual a reserva está sendo solicitada." });
      }
      setorId = parsed.data.setorId;
    }
    if (!setorId) {
      return reply
        .status(422)
        .send({ erro: "Sua conta não está vinculada a um setor. Não é possível solicitar reservas." });
    }

    const {
      plataformaId,
      data,
      horaInicio,
      horaFim,
      quantidadePessoas,
      motivo,
      prioridade,
      recorrencia,
      telefoneContato,
      empresaTerceirizada,
    } = parsed.data;
    const pool = await getPool();
    // Resolvido logo abaixo, depois de ler os padrões da plataforma: o corpo da requisição
    // só sobrescreve quando o campo veio explicitamente.

    const contexto = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
      .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
      .query(
        `SELECT
           (SELECT nome FROM Setor WHERE id = @setor_id) AS setor_nome,
           (SELECT nome FROM Usuario WHERE id = @solicitante_id) AS solicitante_nome,
           (SELECT nome FROM Plataforma WHERE id = @plataforma_id) AS plataforma_nome,
           (SELECT status FROM Plataforma WHERE id = @plataforma_id) AS plataforma_status,
           (SELECT capacidade_operadores FROM Plataforma WHERE id = @plataforma_id) AS plataforma_capacidade_operadores,
           (SELECT inicio_automatico_padrao FROM Plataforma WHERE id = @plataforma_id) AS inicio_automatico_padrao,
           (SELECT fim_automatico_padrao FROM Plataforma WHERE id = @plataforma_id) AS fim_automatico_padrao`
      );
    const {
      setor_nome,
      solicitante_nome,
      plataforma_nome,
      plataforma_status,
      plataforma_capacidade_operadores,
      inicio_automatico_padrao,
      fim_automatico_padrao,
    } = contexto.recordset[0];
    if (!plataforma_nome) {
      return reply.status(404).send({ erro: "Plataforma não encontrada." });
    }

    // Empresa terceirizada: a obrigatoriedade depende do NOME do setor (não há flag no
    // cadastro), e o setor só é conhecido aqui — o schema zod não o enxerga porque, para o
    // Admin, ele vem do body e, para os demais, da sessão. A regra e a mensagem vêm do
    // shared para que o formulário e esta rota nunca divirjam. Fica antes das checagens 409
    // de negócio: dado de formulário inválido é 422, não conflito de agenda.
    const setorExigeEmpresa = setorExigeEmpresaTerceirizada(setor_nome);
    const erroEmpresa = validarEmpresaTerceirizada(empresaTerceirizada, setorExigeEmpresa);
    if (erroEmpresa) {
      // Mesmo formato do `parsed.error.flatten()` usado nos demais 422 deste arquivo.
      return reply.status(422).send({
        erro: "Dados inválidos.",
        detalhes: { formErrors: [], fieldErrors: { empresaTerceirizada: [erroEmpresa] } },
      });
    }
    // Setor interno ignora o valor enviado: persistir um nome de empresa numa reserva que não
    // é de terceiro seria lixo que apareceria depois na listagem/exportação como se fosse real.
    const empresaParaGravar = setorExigeEmpresa ? empresaTerceirizada : null;

    // Padrão da plataforma com override opcional da reserva (§ "Configuração da automação").
    // Gravado na reserva agora: alterar o padrão do equipamento amanhã não pode reescrever o
    // comportamento de reservas já criadas.
    const inicioAutomatico = parsed.data.inicioAutomatico ?? Boolean(inicio_automatico_padrao);
    const fimAutomatico = parsed.data.fimAutomatico ?? Boolean(fim_automatico_padrao);
    // RN-PLAT-01: plataforma só pode ser reservada se status diferente de "inativa".
    // RN-PLAT-04 (S11): ocorrência com gera_manutencao=1 move a plataforma para
    // "manutencao" e bloqueia novas reservas até reversão manual pelo Admin — mesmo
    // tratamento de "inativa" aqui.
    if (plataforma_status === "inativa" || plataforma_status === "manutencao") {
      return reply.status(409).send({
        erro:
          plataforma_status === "inativa"
            ? "Esta plataforma está inativa e não pode ser reservada."
            : "Esta plataforma está em manutenção e não pode ser reservada (RN-PLAT-04).",
      });
    }

    // Correção da área de Reservas: capacidade oficial vem sempre do banco, nunca de um
    // valor enviado pelo cliente — um `capacidadeMaxima` no corpo da requisição não seria
    // fonte confiável (o cliente poderia mandar qualquer número). QUANTIDADE DE PESSOAS só
    // pode ser validada contra Plataforma.capacidade_operadores (pessoas/operadores) —
    // NUNCA contra Plataforma.capacidade, que é a capacidade de carga em kg (bug corrigido:
    // as duas colunas eram confundidas aqui). Quando a plataforma ainda não tem capacidade
    // de pessoas cadastrada (`plataforma_capacidade_operadores` null), não há limite
    // conhecido para validar — a reserva segue sem essa checagem, em vez de inventar um
    // teto arbitrário.
    if (plataforma_capacidade_operadores !== null && quantidadePessoas > plataforma_capacidade_operadores) {
      return reply.status(409).send({
        erro: `Esta plataforma possui capacidade máxima para ${plataforma_capacidade_operadores} pessoa(s).`,
      });
    }

    // S12 (RF-CFG-01/02): antecedência mínima, duração máxima e horário de expediente —
    // lidos de ConfiguracaoSistema (com cache leve), nunca hardcoded. A recorrência usa a
    // mesma janela (horaInicio/horaFim) em toda ocorrência, então validar uma vez com a
    // data-base já cobre a antecedência mínima de toda a série (ocorrências seguintes são
    // sempre mais distantes no tempo).
    const regrasReserva = await obterRegrasReservaConfiguraveis();
    const janela = validarJanelaReserva({ data, horaInicio, horaFim, prioridade }, regrasReserva);
    if (!janela.ok) {
      return reply.status(409).send({ erro: janela.erro });
    }

    // Aprovação (migrations 0022/0023): no modo MANUAL (padrão) o Colaborador SOLICITA — a
    // reserva nasce pendente e só ocupa a plataforma depois de aprovada por Admin/Gestor. No
    // modo AUTOMÁTICO, reserva válida de Colaborador já nasce agendada. Admin e Gestor criando
    // uma reserva operacional decidem ao criar: nasce agendada, sem autoaprovação de fachada.
    const perfilSolicitante = request.usuario!.perfil;
    const modoAprovacao = await obterModoAprovacaoReservas();
    let statusInicial: "pendente" | "agendada" =
      perfilSolicitante === "colaborador" && modoAprovacao === "manual" ? "pendente" : "agendada";
    const urgente = prioridadeEhUrgente(prioridade);
    // Urgente que colide com reserva existente vira solicitação pendente mesmo quando quem
    // cria é Admin/Gestor: a substituição só acontece na APROVAÇÃO, com os conflitos na tela e
    // confirmação explícita — nunca de forma implícita na criação.
    let conflitoUrgenteAguardandoDecisao = false;

    // S9 (RF-RES-03): sem recorrência, a "série" é só a própria data solicitada.
    const datasOcorrencias = recorrencia
      ? gerarDatasRecorrencia(data, diaSemanaDe(data), recorrencia.quantidadeOcorrencias)
      : [data];

    // Aprovadores elegíveis (Admins ativos + Gestores do setor) — lidos antes da transação,
    // usados só se a reserva nascer pendente.
    const aprovadores =
      statusInicial === "pendente" || urgente
        ? (
            await pool
              .request()
              .input("setor_id", sql.UniqueIdentifier, setorId)
              .query<{ id: string }>(
                `SELECT id FROM Usuario
                 WHERE ativo = 1 AND (perfil = 'admin' OR (perfil = 'gestor_setor' AND setor_id = @setor_id))`
              )
          ).recordset
        : [];
    const notificacoesAprovadores: NotificacaoRegistrada[] = [];

    const transaction = pool.transaction();
    await transaction.begin();
    const idsCriados: string[] = [];
    try {
      // RN-RES-02/RN-RES-11: a disponibilidade de TODAS as ocorrências é checada dentro
      // da mesma transação do INSERT, com lock de intervalo (ver buscarReservasConflitantes).
      // Antes a checagem rodava antes de `begin()`: duas requisições concorrentes para a
      // mesma plataforma/horário liam "livre" ao mesmo tempo e ambas inseriam, violando
      // RN-RES-02 — a janela era pequena, mas real, e nenhum teste a cobria.
      for (const dataOcorrencia of datasOcorrencias) {
        const disponibilidade = await verificarDisponibilidade(
          { plataformaId, data: dataOcorrencia, horaInicio, horaFim },
          transaction,
          true
        );
        // Só conflito com OUTRA RESERVA é tolerável para urgência (vira pedido pendente de
        // decisão). Bloqueio de agenda é indisponibilidade técnica: urgência não passa por ele.
        // EXCEÇÃO ABSOLUTA: vale em qualquer modo de aprovação, inclusive o automático — urgente
        // em conflito nunca é confirmada nem substitui nada sem decisão manual de Gestor/Admin.
        if (!disponibilidade.ok && urgente && disponibilidade.tipo === "conflito_reserva") {
          // O conflito com reserva é tolerado, mas o bloqueio de agenda ainda precisa ser
          // conferido: verificarDisponibilidade para no primeiro problema que encontra.
          const bloqueio = await verificarBloqueio(
            { plataformaId, data: dataOcorrencia, horaInicio, horaFim },
            transaction
          );
          if (!bloqueio.ok) {
            await transaction.rollback();
            return reply.status(409).send({
              erro: bloqueio.erro,
              codigo: CODIGO_ERRO_HORARIO_INDISPONIVEL,
              tipo: bloqueio.tipo,
              bloqueio: bloqueio.bloqueio,
            });
          }
          conflitoUrgenteAguardandoDecisao = true;
          statusInicial = "pendente";
          continue;
        }
        if (!disponibilidade.ok) {
          await transaction.rollback();
          return reply.status(409).send({
            erro: recorrencia
              ? `Não foi possível criar a série semanal: ${disponibilidade.erro} (ocorrência de ${dataOcorrencia}).`
              : disponibilidade.erro,
            // `codigo` é estável e legível por máquina: o front troca a mensagem técnica por
            // "esse horário acabou de ficar indisponível" e recarrega a disponibilidade.
            codigo: CODIGO_ERRO_HORARIO_INDISPONIVEL,
            tipo: disponibilidade.tipo,
            bloqueio: disponibilidade.bloqueio,
          });
        }
      }

      let recorrenciaId: string | null = null;
      if (recorrencia) {
        const insercaoRecorrencia = await transaction
          .request()
          .input("criado_por_id", sql.UniqueIdentifier, solicitanteId)
          .input("dia_semana", sql.TinyInt, diaSemanaDe(data))
          .input("quantidade_ocorrencias", sql.TinyInt, recorrencia.quantidadeOcorrencias)
          .query<{ id: string }>(
            `INSERT INTO ReservaRecorrencia (criado_por_id, dia_semana, quantidade_ocorrencias)
             OUTPUT INSERTED.id
             VALUES (@criado_por_id, @dia_semana, @quantidade_ocorrencias)`
          );
        recorrenciaId = insercaoRecorrencia.recordset[0].id;
      }

      for (const dataOcorrencia of datasOcorrencias) {
        const insercao = await transaction
          .request()
          .input("setor_id", sql.UniqueIdentifier, setorId)
          .input("solicitante_id", sql.UniqueIdentifier, solicitanteId)
          .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
          .input("data", sql.Date, dataOcorrencia)
          .input("hora_inicio", sql.VarChar, horaInicio)
          .input("hora_fim", sql.VarChar, horaFim)
          .input("quantidade_pessoas", sql.Int, quantidadePessoas)
          .input("motivo", sql.NVarChar, motivo)
          .input("prioridade", sql.VarChar, prioridade)
          .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
          .input("inicio_automatico", sql.Bit, inicioAutomatico)
          .input("fim_automatico", sql.Bit, fimAutomatico)
          .input("telefone_contato", sql.NVarChar, telefoneContato)
          .input("empresa_terceirizada", sql.NVarChar, empresaParaGravar)
          .input("status", sql.VarChar, statusInicial)
          .query<{ id: string }>(
            // `status` é sempre informado explicitamente (pendente para solicitação de
            // Colaborador ou urgência em conflito; agendada para Admin/Gestor) — nunca o
            // DEFAULT da coluna. A validação inteira (conflito, bloqueio, capacidade, janela)
            // já rodou acima, dentro desta mesma transação e com lock de intervalo.
            `INSERT INTO Reserva (setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim, quantidade_pessoas, motivo, prioridade, status, recorrencia_id, inicio_automatico, fim_automatico, telefone_contato, empresa_terceirizada)
             OUTPUT INSERTED.id
             VALUES (@setor_id, @solicitante_id, @plataforma_id, @data, @hora_inicio, @hora_fim, @quantidade_pessoas, @motivo, @prioridade, @status, @recorrencia_id, @inicio_automatico, @fim_automatico, @telefone_contato, @empresa_terceirizada)`
          );
        const novaId = insercao.recordset[0].id;
        idsCriados.push(novaId);

        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, solicitanteId)
          .input("acao", sql.VarChar, "criar_reserva")
          .input("entidade", sql.VarChar, "Reserva")
          .input("entidade_id", sql.UniqueIdentifier, novaId)
          .input(
            "detalhes",
            sql.NVarChar,
            JSON.stringify({
              plataformaId,
              data: dataOcorrencia,
              horaInicio,
              horaFim,
              prioridade,
              recorrenciaId,
              statusNovo: statusInicial,
              perfilSolicitante,
              ...(conflitoUrgenteAguardandoDecisao ? { conflitoUrgenteAguardandoDecisao: true } : {}),
              // Só quando houver: a auditoria de uma reserva interna não ganha uma chave nula.
              ...(empresaParaGravar ? { empresaTerceirizada: empresaParaGravar } : {}),
            })
          )
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, @acao, @entidade, @entidade_id, @detalhes)`
          );
      }

      // Solicitação pendente avisa os aprovadores pelo sino (in-app) — uma notificação por
      // solicitação, não por ocorrência da série. Sem e-mail: a fila de e-mail do ambiente é
      // real e não é necessária para o aprovador enxergar a pendência.
      if (statusInicial === "pendente") {
        const quando = `${data} (${horaInicio}–${horaFim})${recorrencia ? `, ${datasOcorrencias.length} ocorrências` : ""}`;
        for (const aprovador of aprovadores) {
          if (aprovador.id === solicitanteId) continue;
          notificacoesAprovadores.push(
            await registrarNotificacao(transaction, {
              usuarioId: aprovador.id,
              tipo: "reserva_pendente",
              titulo: conflitoUrgenteAguardandoDecisao
                ? "Urgente em conflito: decisão de substituição"
                : urgente
                  ? "Reserva urgente aguardando aprovação"
                  : "Reserva aguardando aprovação",
              mensagem: conflitoUrgenteAguardandoDecisao
                ? `${solicitante_nome} (${setor_nome}) solicitou ${plataforma_nome} em ${quando} com prioridade urgente, sobre uma reserva já confirmada.`
                : `${solicitante_nome} (${setor_nome}) solicitou ${plataforma_nome} em ${quando}.`,
              link: "/reservas?status=pendente",
            })
          );
        }
      }

      await transaction.commit();

      // Recarrega exatamente as linhas inseridas pelos IDs devolvidos por OUTPUT.INSERTED.
      // A versão anterior reencontrava a reserva única por (plataforma, solicitante, data,
      // hora_inicio) + `ORDER BY criado_em DESC`, uma heurística que podia devolver a
      // reserva errada quando duas eram criadas no mesmo milissegundo.
      const listaIds = await pool.request();
      idsCriados.forEach((valor, indice) => listaIds.input(`id${indice}`, sql.UniqueIdentifier, valor));
      const completas = await listaIds.query<ReservaRow>(
        `SELECT ${SELECT_RESERVA} ${FROM_RESERVA}
         WHERE r.id IN (${idsCriados.map((_, indice) => `@id${indice}`).join(", ")})
         ORDER BY r.data ASC`
      );
      const novas = completas.recordset.map(mapReserva);

      // Evento global (não mais dirigido a aprovadores): Calendário, Reservas, Frota e
      // Central de Operações revalidam sozinhos quando uma reserva entra na agenda.
      // Fora da transação, best-effort — uma conexão SSE ausente nunca deve reverter a
      // criação da reserva.
      for (const nova of novas) {
        publicarEventoGlobal("reserva.criada", nova);
      }
      for (const notificacao of notificacoesAprovadores) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
      }
      enviarEmailsEmSegundoPlano(notificacoesAprovadores);

      // `aviso` só quando a reserva ficou aguardando decisão por causa de conflito: o
      // formulário explica por que uma urgência criada por Admin/Gestor não nasceu agendada.
      const aviso = conflitoUrgenteAguardandoDecisao
        ? "O horário conflita com uma reserva existente. A solicitação urgente ficou pendente: ao aprová-la, Admin ou Gestor decide se substitui a reserva atual."
        : undefined;
      return reply
        .status(201)
        .send(recorrenciaId ? { recorrenciaId, reservas: novas, aviso } : { ...novas[0], aviso });
    } catch (err) {
      // A transação pode já ter sido revertida no caminho de conflito acima; `rollback()`
      // numa transação encerrada lança um erro que mascararia a causa original.
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
  };

  // A criação inteira (leituras + transação com lock de intervalo) é reexecutada se o SQL
  // Server a escolher como vítima de deadlock — ver executarComRepeticaoEmDeadlock. Nada
  // externo acontece antes do commit (eventos SSE só saem depois dele), então repetir é seguro.
  app.post("/api/v1/reservas", { preHandler: autenticar }, (request, reply) =>
    executarComRepeticaoEmDeadlock(() => criarReserva(request, reply))
  );

  // S9 (RF-RES-03): cancela todas as ocorrências futuras (pendente/agendada) de uma
  // série semanal de uma vez. Escopo verificado pela primeira reserva da série — todas
  // pertencem ao mesmo setor/solicitante, pois a série nasce de uma única submissão.
  app.post(
    "/api/v1/reservas/recorrencia/:recorrenciaId/cancelar",
    { preHandler: autenticar },
    async (request, reply) => {
      const { recorrenciaId } = request.params as { recorrenciaId: string };
      const pool = await getPool();

      const ocorrencias = await pool
        .request()
        .input("recorrencia_id", sql.UniqueIdentifier, recorrenciaId)
        .query<{ id: string; status: StatusReserva; setor_id: string }>(
          `SELECT id, status, setor_id FROM Reserva
           WHERE recorrencia_id = @recorrencia_id AND status IN ('pendente','agendada')`
        );
      if (ocorrencias.recordset.length === 0) {
        return reply
          .status(404)
          .send({ erro: "Nenhuma ocorrência futura cancelável encontrada para esta série." });
      }

      const perfil = request.usuario!.perfil;
      const setorSerie = ocorrencias.recordset[0].setor_id;
      if (perfil !== "admin" && setorSerie !== request.usuario!.setorId) {
        return reply.status(403).send({ erro: "Você só pode cancelar séries de reservas do seu próprio setor." });
      }

      const transaction = pool.transaction();
      await transaction.begin();
      const statusPorOcorrencia = new Map<string, StatusReserva>();
      try {
        for (const ocorrencia of ocorrencias.recordset) {
          const novoStatus = transicionar(ocorrencia.status, "cancelar");
          statusPorOcorrencia.set(ocorrencia.id, novoStatus);
          await transaction
            .request()
            .input("id", sql.UniqueIdentifier, ocorrencia.id)
            .input("status", sql.VarChar, novoStatus)
            .query(`UPDATE Reserva SET status = @status, atualizado_em = SYSUTCDATETIME() WHERE id = @id`);
          await registrarAuditoriaReserva(transaction, request.usuario!.sub, "cancelar_serie_reserva", ocorrencia.id, {
            statusAnterior: ocorrencia.status,
            statusNovo: novoStatus,
            recorrenciaId,
          });
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        throw err;
      }
      for (const [ocorrenciaId, status] of statusPorOcorrencia) {
        publicarEventoGlobal("reserva.status_alterado", { id: ocorrenciaId, status });
      }

      return reply.status(200).send({ ocorrenciasCanceladas: ocorrencias.recordset.length });
    }
  );

  app.get("/api/v1/reservas", { preHandler: autenticar }, async (request, reply) => {
    const parsed = listarReservasQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    const { q, status, data, dateFrom, dateTo } = parsed.data;
    const { limit, offset } = resolverPaginacao(parsed.data);
    const pool = await getPool();
    const dbRequest = pool.request();

    // A ocupação das plataformas é global: qualquer usuário autenticado precisa enxergar
    // reservas de outros setores para saber quando um equipamento está livre (senão a tela
    // de Reservas e o Calendário mostram menos ocupação do que a real e o usuário tenta
    // reservar em cima de um horário que já é de outro setor). Filtrar por setor aqui era
    // controle de ACESSO indevido numa tela de LEITURA — a proteção de conteúdo interno
    // (motivo/telefone/empresa) de reserva alheia continua existindo, só que agora é
    // aplicada campo a campo em mapReservaParaListagem, não a linha inteira.
    let where = "WHERE 1=1";
    if (q) {
      dbRequest.input("q", sql.NVarChar, `%${q}%`);
      // `motivo` incluído na busca livre para igualar o comportamento de /historico —
      // digitar um trecho do motivo na tela de Reservas não encontrava nada.
      where += " AND (s.nome LIKE @q OR u.nome LIKE @q OR p.nome LIKE @q OR r.motivo LIKE @q OR r.empresa_terceirizada LIKE @q)";
    }
    if (status) {
      dbRequest.input("status", sql.VarChar, status);
      where += " AND r.status = @status";
    }
    if (data) {
      dbRequest.input("data", sql.Date, data);
      where += " AND r.data = @data";
    }
    // Usado pelo Calendário: intervalo de datas da semana exibida (S5).
    if (dateFrom) {
      dbRequest.input("date_from", sql.Date, dateFrom);
      where += " AND r.data >= @date_from";
    }
    if (dateTo) {
      dbRequest.input("date_to", sql.Date, dateTo);
      where += " AND r.data <= @date_to";
    }

    dbRequest.input("limit", sql.Int, limit).input("offset", sql.Int, offset);
    // Corrigir/melhorar Reservas: ordem cronológica (ASC), não "mais recente criada
    // primeiro" — a tela agora sempre opera sobre um período (padrão: esta semana), e o
    // caso de uso passou a ser "o que vem primeiro nesse intervalo", não um feed de
    // atividade. Combinado com o filtro de dateFrom/dateTo do período selecionado.
    const result = await dbRequest.query<ReservaRow & { total_geral: number }>(
      `SELECT ${SELECT_RESERVA}, COUNT(*) OVER() AS total_geral ${FROM_RESERVA} ${where}
       ORDER BY r.data ASC, r.hora_inicio ASC, r.id
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
    );
    // COUNT(*) OVER() devolve o total do filtro na mesma varredura — evita a segunda
    // query de contagem que uma paginação ingênua faria.
    const total = result.recordset[0]?.total_geral ?? 0;
    return reply
      .header("X-Total-Count", String(total))
      .header("X-Limit", String(limit))
      .header("X-Offset", String(offset))
      .status(200)
      .send(result.recordset.map(mapReserva));
  });

  // Deep link "Ver reserva" (usado por Não Conformidades e, no futuro, qualquer tela que
  // precise abrir uma reserva específica) — mesma projeção/escopo da listagem (leitura
  // global: a reserva é informação operacional compartilhada, ver GET /reservas acima), só
  // para um único id. Fastify resolve rotas estáticas (ex.: /reservas/conflitos, abaixo) antes
  // de rotas com parâmetro, então não há ambiguidade de roteamento entre elas.
  app.get("/api/v1/reservas/:id", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
    const row = result.recordset[0];
    if (!row) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    return reply.status(200).send(mapReserva(row));
  });

  app.get("/api/v1/reservas/conflitos", { preHandler: autenticar }, async (request, reply) => {
    const parsed = conflitoQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    const { plataformaId, data, horaInicio, horaFim, ignorarReservaId } = parsed.data;

    // S9: mesma checagem usada na criação (reserva-reserva + bloqueio de agenda), para
    // o formulário de Nova Reserva bloquear o envio com a mesma regra do backend. Aqui é
    // só leitura para feedback em tempo real — sem lock de intervalo, que serializaria
    // requisições a cada tecla digitada no formulário.
    const pool = await getPool();
    const disponibilidade = await verificarDisponibilidade(
      { plataformaId, data, horaInicio, horaFim, ignorarReservaId },
      pool
    );
    if (disponibilidade.ok) {
      return reply.status(200).send({ conflito: false, motivo: null, reserva: null, tipo: null, bloqueio: null });
    }
    return reply.status(200).send({
      conflito: true,
      motivo: disponibilidade.erro ?? null,
      reserva: disponibilidade.reservaConflitante ?? null,
      tipo: disponibilidade.tipo ?? null,
      bloqueio: disponibilidade.bloqueio ?? null,
    });
  });

  /* ---------------------------------------------------------------------------------
   * Aprovação (migration 0022) — Admin e Gestor aprovam, rejeitam e decidem substituição
   * de reservas de QUALQUER setor (podeDecidirAprovacao). Colaborador recebe 403 no
   * requireRole: não é um botão escondido, é a rota que recusa.
   *
   * A aprovação REVALIDA a disponibilidade dentro da transação, com o mesmo lock de
   * intervalo da criação: duas solicitações pendentes sobrepostas nunca terminam as duas
   * agendadas — a segunda aprovação enxerga a primeira e recebe 409.
   *
   * Urgente em conflito com reserva existente: o backend devolve os conflitos (409
   * CONFLITO_SUBSTITUIVEL) e só substitui quando o aprovador reenviar com
   * `substituirConflitantes: true` — e, se alguma conflitante estiver EM USO, com
   * `confirmarInterrupcaoEmUso: true` também. Substituir + aprovar é uma transação só.
   * --------------------------------------------------------------------------------- */
  class ConflitoDeEstadoError extends Error {}

  const aprovarReserva = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const parsed = aprovarReservaSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { substituirConflitantes, confirmarInterrupcaoEmUso } = parsed.data;
    const usuario = request.usuario!;

    const contexto = await buscarContextoReserva(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }
    if (!podeDecidirAprovacao(usuario)) {
      return reply.status(403).send({ erro: "Somente Admin ou Gestor podem aprovar reservas." });
    }
    try {
      transicionar(contexto.status, "aprovar");
    } catch (err) {
      if (err instanceof TransicaoInvalidaError) {
        return reply.status(409).send({ erro: "Esta solicitação já foi decidida ou não está mais pendente." });
      }
      throw err;
    }
    // Indisponibilidade técnica não é "outra reserva": nem urgência nem substituição passam.
    if (contexto.plataforma_status === "inativa" || contexto.plataforma_status === "manutencao") {
      return reply.status(409).send({
        erro: `A plataforma está ${contexto.plataforma_status === "inativa" ? "inativa" : "em manutenção"} e não pode receber reservas.`,
      });
    }
    if (janelaTotalmenteVencida({ data: contexto.data, horaFim: contexto.hora_fim }, agoraEmBrasilia())) {
      return reply.status(409).send({
        erro: "O horário desta solicitação já passou. Rejeite-a ou peça uma nova solicitação.",
      });
    }

    const urgente = prioridadeEhUrgente(contexto.prioridade);
    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    const substituidas: Array<{ id: string; solicitanteId: string; estavaEmUso: boolean }> = [];
    const notificacoes: NotificacaoRegistrada[] = [];
    try {
      // Trava a própria solicitação: dois aprovadores clicando juntos serializam aqui, e o
      // segundo encontra a reserva já decidida.
      const atual = await transaction
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<{ status: string }>("SELECT status FROM Reserva WITH (UPDLOCK, ROWLOCK) WHERE id = @id");
      if (atual.recordset[0]?.status !== "pendente") {
        await transaction.rollback();
        return reply.status(409).send({ erro: "Esta solicitação já foi decidida por outro aprovador." });
      }

      const analise = await analisarAprovacao(transaction, {
        reservaId: id,
        plataformaId: contexto.plataforma_id,
        data: contexto.data,
        horaInicio: contexto.hora_inicio,
        horaFim: contexto.hora_fim,
      });

      if (analise.bloqueio) {
        await transaction.rollback();
        return reply.status(409).send({
          erro: `O horário está bloqueado na agenda (${analise.bloqueio.motivo}). Bloqueio não pode ser substituído.`,
          codigo: CODIGO_CONFLITO_APROVACAO,
          tipo: analise.bloqueio.global ? "bloqueio_global" : "bloqueio_plataforma",
          bloqueio: analise.bloqueio,
          conflitos: [],
        });
      }

      if (analise.conflitos.length > 0) {
        const conflitos = analise.conflitos.map(({ solicitanteId: _solicitante, ...publico }) => publico);
        const emUso = analise.conflitos.some((c) => c.status === "em_uso");

        if (!urgente) {
          await transaction.rollback();
          return reply.status(409).send({
            codigo: CODIGO_CONFLITO_APROVACAO,
            erro: "O horário já foi confirmado para outra reserva. Esta solicitação não pode ser aprovada.",
            conflitos,
          });
        }
        // Urgente só substitui reserva de prioridade menor. O setor da reserva conflitante
        // não importa: Admin e Gestor decidem substituição de qualquer setor.
        const conflitoUrgente = analise.conflitos.find((c) => prioridadeEhUrgente(c.prioridade));
        if (conflitoUrgente) {
          await transaction.rollback();
          return reply.status(409).send({
            codigo: CODIGO_CONFLITO_APROVACAO,
            erro: "O horário já está ocupado por outra reserva urgente — urgência não substitui urgência.",
            conflitos,
          });
        }
        if (!substituirConflitantes) {
          await transaction.rollback();
          return reply.status(409).send({
            codigo: CODIGO_CONFLITO_SUBSTITUIVEL,
            erro: "Esta reserva conflita com uma reserva existente. Por ser uma solicitação urgente, você pode substituir a reserva atual.",
            conflitos,
            emUso,
          });
        }
        if (emUso && !confirmarInterrupcaoEmUso) {
          await transaction.rollback();
          return reply.status(409).send({
            codigo: CODIGO_CONFIRMAR_INTERRUPCAO_EM_USO,
            erro: "Esta plataforma está atualmente em uso. Confirmar a substituição encerrará a reserva atual.",
            conflitos,
            emUso,
          });
        }

        const motivo = `Substituída por reserva urgente #${id.slice(0, 8).toUpperCase()}`;
        for (const conflito of analise.conflitos) {
          const estavaEmUso = conflito.status === "em_uso";
          // UPDATE condicional ao status lido: se algo mudou a conflitante desde a análise, a
          // transação inteira volta — a urgente não é aprovada pela metade.
          const substituicao = await transaction
            .request()
            .input("id", sql.UniqueIdentifier, conflito.id)
            .input("status_esperado", sql.VarChar, conflito.status)
            .input("substituida_por_id", sql.UniqueIdentifier, id)
            .input("motivo", sql.NVarChar, motivo)
            .input("hora_real", sql.VarChar, horaAtualBrasilia())
            .query(
              `UPDATE Reserva
               SET status = 'cancelada',
                   substituida_por_id = @substituida_por_id,
                   motivo_cancelamento = @motivo,
                   hora_fim_real = CASE WHEN status = 'em_uso' THEN CAST(@hora_real AS TIME) ELSE hora_fim_real END,
                   atualizado_em = SYSUTCDATETIME()
               WHERE id = @id AND status = @status_esperado`
            );
          if (substituicao.rowsAffected[0] !== 1) {
            throw new ConflitoDeEstadoError();
          }
          // Reserva interrompida em uso: horímetro recebe só o tempo realmente usado.
          const usoMinutos = estavaEmUso ? await contabilizarUsoReserva(transaction, conflito.id) : null;

          await registrarAuditoriaReserva(transaction, usuario.sub, "substituir_reserva", conflito.id, {
            statusAnterior: conflito.status,
            statusNovo: "cancelada",
            substituidaPorId: id,
            motivo,
            prioridadeSubstituida: conflito.prioridade,
            prioridadeNova: contexto.prioridade,
            estavaEmUso,
            ...(usoMinutos !== null ? { usoContabilizadoMinutos: usoMinutos } : {}),
          });
          notificacoes.push(
            await registrarNotificacao(transaction, {
              usuarioId: conflito.solicitanteId,
              tipo: "reserva_substituida",
              titulo: "Reserva substituída por urgência",
              mensagem: `Sua reserva de ${conflito.plataformaNome} em ${conflito.data} (${conflito.horaInicio}–${conflito.horaFim}) foi cancelada para atender uma reserva urgente.`,
              link: "/reservas",
            })
          );
          substituidas.push({ id: conflito.id, solicitanteId: conflito.solicitanteId, estavaEmUso });
        }
      }

      const aprovacao = await transaction
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("aprovador_id", sql.UniqueIdentifier, usuario.sub)
        .query(
          `UPDATE Reserva SET status = 'agendada', aprovado_por_id = @aprovador_id, atualizado_em = SYSUTCDATETIME()
           WHERE id = @id AND status = 'pendente'`
        );
      if (aprovacao.rowsAffected[0] !== 1) {
        throw new ConflitoDeEstadoError();
      }
      await registrarAuditoriaReserva(transaction, usuario.sub, "aprovar_reserva", id, {
        perfilAprovador: usuario.perfil,
        statusAnterior: "pendente",
        statusNovo: "agendada",
        prioridade: contexto.prioridade,
        ...(substituidas.length > 0 ? { substituiuReservas: substituidas.map((s) => s.id) } : {}),
      });
      if (contexto.solicitante_id !== usuario.sub) {
        notificacoes.push(
          await registrarNotificacao(transaction, {
            usuarioId: contexto.solicitante_id,
            tipo: "reserva_aprovada",
            titulo: "Reserva aprovada",
            mensagem: `Sua reserva de ${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) foi aprovada.`,
            link: "/reservas",
          })
        );
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      if (err instanceof ConflitoDeEstadoError) {
        return reply.status(409).send({
          erro: "A agenda mudou durante a aprovação. Nada foi alterado — revise e tente novamente.",
        });
      }
      throw err;
    }

    publicarEventoGlobal("reserva.status_alterado", { id, status: "agendada" });
    for (const substituida of substituidas) {
      publicarEventoGlobal("reserva.status_alterado", { id: substituida.id, status: "cancelada" });
    }
    for (const notificacao of notificacoes) {
      publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
    }
    enviarEmailsEmSegundoPlano(notificacoes);

    const completa = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
    return reply.status(200).send({
      ...mapReserva(completa.recordset[0]),
      reservasSubstituidas: substituidas.map((s) => s.id),
    });
  };

  // Pré-análise da decisão (somente leitura, sem lock): o modal de detalhe mostra o conflito
  // ANTES de o aprovador clicar — "Esta solicitação urgente conflita com...". A decisão em si
  // (POST /aprovar) revalida tudo de novo, sob lock; esta leitura nunca é a autoridade.
  app.get(
    "/api/v1/reservas/:id/analise-aprovacao",
    { preHandler: [autenticar, requireRole(PERFIS_APROVADORES)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }
      if (contexto.status !== "pendente") {
        return reply.status(200).send({ pendente: false, conflitos: [], bloqueio: null, emUso: false, podeSubstituir: false });
      }
      const pool = await getPool();
      const analise = await analisarAprovacao(
        pool,
        {
          reservaId: id,
          plataformaId: contexto.plataforma_id,
          data: contexto.data,
          horaInicio: contexto.hora_inicio,
          horaFim: contexto.hora_fim,
        },
        false
      );
      return reply.status(200).send({
        pendente: true,
        conflitos: analise.conflitos.map(({ solicitanteId: _solicitante, ...publico }) => publico),
        bloqueio: analise.bloqueio,
        emUso: analise.conflitos.some((c) => c.status === "em_uso"),
        // Mesma regra do POST: só urgente, sem bloqueio, e nunca sobre outra urgente.
        podeSubstituir:
          prioridadeEhUrgente(contexto.prioridade) &&
          !analise.bloqueio &&
          analise.conflitos.length > 0 &&
          !analise.conflitos.some((c) => prioridadeEhUrgente(c.prioridade)),
      });
    }
  );

  // Deadlock entre aprovações concorrentes (locks de linha + intervalo em ordens distintas)
  // é resolvido reexecutando: nada externo acontece antes do commit.
  app.post(
    "/api/v1/reservas/:id/aprovar",
    { preHandler: [autenticar, requireRole(PERFIS_APROVADORES)] },
    (request, reply) => executarComRepeticaoEmDeadlock(() => aprovarReserva(request, reply))
  );

  app.post(
    "/api/v1/reservas/:id/rejeitar",
    { preHandler: [autenticar, requireRole(PERFIS_APROVADORES)] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = rejeitarReservaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const usuario = request.usuario!;
      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }
      if (!podeDecidirAprovacao(usuario)) {
        return reply.status(403).send({ erro: "Somente Admin ou Gestor podem rejeitar reservas." });
      }
      try {
        transicionar(contexto.status, "rejeitar");
      } catch (err) {
        if (err instanceof TransicaoInvalidaError) {
          return reply.status(409).send({ erro: "Esta solicitação já foi decidida ou não está mais pendente." });
        }
        throw err;
      }

      const pool = await getPool();
      const transaction = pool.transaction();
      await transaction.begin();
      let notificacao: NotificacaoRegistrada | null = null;
      try {
        const rejeicao = await transaction
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .input("motivo", sql.NVarChar, parsed.data.motivo)
          .query(
            `UPDATE Reserva SET status = 'rejeitada', motivo_rejeicao = @motivo, atualizado_em = SYSUTCDATETIME()
             WHERE id = @id AND status = 'pendente'`
          );
        if (rejeicao.rowsAffected[0] !== 1) {
          await transaction.rollback();
          return reply.status(409).send({ erro: "Esta solicitação já foi decidida por outro aprovador." });
        }
        await registrarAuditoriaReserva(transaction, usuario.sub, "rejeitar_reserva", id, {
          perfilAprovador: usuario.perfil,
          statusAnterior: "pendente",
          statusNovo: "rejeitada",
          prioridade: contexto.prioridade,
          motivo: parsed.data.motivo,
        });
        if (contexto.solicitante_id !== usuario.sub) {
          notificacao = await registrarNotificacao(transaction, {
            usuarioId: contexto.solicitante_id,
            tipo: "reserva_rejeitada",
            titulo: "Reserva rejeitada",
            mensagem: `Sua solicitação de ${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) foi rejeitada: ${parsed.data.motivo}`,
            link: "/reservas",
          });
        }
        await transaction.commit();
      } catch (err) {
        await transaction.rollback().catch(() => undefined);
        throw err;
      }

      publicarEventoGlobal("reserva.status_alterado", { id, status: "rejeitada" });
      if (notificacao) {
        publicarEventoUsuario(notificacao.usuarioId, "notificacao.nova", notificacao);
        enviarEmailsEmSegundoPlano([notificacao]);
      }

      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      return reply.status(200).send(mapReserva(completa.recordset[0]));
    }
  );

  app.patch(
    "/api/v1/reservas/:id/status",
    { preHandler: [autenticar, requireRole(["admin", "gestor_setor"])] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = alterarStatusReservaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
      }
      const acao = parsed.data.acao;

      const contexto = await buscarContextoReserva(id);
      if (!contexto) {
        return reply.status(404).send({ erro: "Reserva não encontrada." });
      }

      if (!usuarioNoEscopoDaReserva(request.usuario!, contexto.setor_id)) {
        return reply.status(403).send({ erro: "Você só pode alterar reservas do seu próprio setor." });
      }

      // Fallback administrativo. No fluxo normal ninguém precisa desta rota: o
      // sincronizador move a reserva por horário (services/automacaoReserva.service.ts).
      // Ela existe para exceções operacionais — encerrar um uso adiantado, iniciar antes
      // do horário com o equipamento já liberado.
      //
      // A transição em si (validação de estado, UPDATE condicional, auditoria e evento
      // SSE) vive em reservaTransicao.service.ts — exatamente a mesma função que o worker
      // de automação chama, então manual e automático nunca divergem de regra.
      try {
        transicionar(contexto.status, acao);
      } catch (err) {
        if (err instanceof TransicaoInvalidaError) {
          return reply.status(409).send({ erro: err.message });
        }
        throw err;
      }

      const resultado =
        acao === "iniciar_uso"
          ? await iniciarUsoReserva({
              reservaId: id,
              origem: "manual",
              usuarioId: request.usuario!.sub,
              contexto: {
                plataformaId: contexto.plataforma_id,
                plataformaStatus: contexto.plataforma_status,
              },
            })
          : await concluirReserva({ reservaId: id, origem: "manual", usuarioId: request.usuario!.sub });

      if (!resultado.aplicada) {
        return reply.status(409).send({ erro: resultado.motivo });
      }

      const pool = await getPool();
      const completa = await pool
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
      return reply.status(200).send(mapReserva(completa.recordset[0]));
    }
  );

  // RF-RES-11: Admin cancela qualquer reserva; Colaborador só as do próprio setor.
  app.post("/api/v1/reservas/:id/cancelar", { preHandler: autenticar }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const contexto = await buscarContextoReserva(id);
    if (!contexto) {
      return reply.status(404).send({ erro: "Reserva não encontrada." });
    }

    const perfil = request.usuario!.perfil;
    if (perfil !== "admin" && contexto.setor_id !== request.usuario!.setorId) {
      return reply.status(403).send({ erro: "Você só pode cancelar reservas do seu próprio setor." });
    }

    let novoStatus: StatusReserva;
    try {
      novoStatus = transicionar(contexto.status, "cancelar");
    } catch (err) {
      if (err instanceof TransicaoInvalidaError) {
        return reply.status(409).send({ erro: err.message });
      }
      throw err;
    }

    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    let notificacaoCancelamento: NotificacaoRegistrada | null = null;
    try {
      // Condicional ao status lido: se a automação (ou outro usuário) mudou a reserva no meio
      // do caminho, nada é sobrescrito. Cancelar EM USO encerra o uso agora (hora de Brasília).
      const cancelamento = await transaction
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .input("status", sql.VarChar, novoStatus)
        .input("status_anterior", sql.VarChar, contexto.status)
        .input("hora_real", sql.VarChar, horaAtualBrasilia())
        .query(
          `UPDATE Reserva
           SET status = @status,
               hora_fim_real = CASE WHEN status = 'em_uso' THEN CAST(@hora_real AS TIME) ELSE hora_fim_real END,
               atualizado_em = SYSUTCDATETIME()
           WHERE id = @id AND status = @status_anterior`
        );
      if (cancelamento.rowsAffected[0] !== 1) {
        await transaction.rollback();
        return reply.status(409).send({ erro: "A reserva mudou de status enquanto era cancelada. Atualize e tente novamente." });
      }
      // Cancelada antes de começar não soma nada; cancelada durante o uso soma o que foi usado.
      const usoMinutos = contexto.status === "em_uso" ? await contabilizarUsoReserva(transaction, id) : null;
      await registrarAuditoriaReserva(transaction, request.usuario!.sub, "cancelar_reserva", id, {
        statusAnterior: contexto.status,
        statusNovo: novoStatus,
        ...(usoMinutos !== null ? { usoContabilizadoMinutos: usoMinutos } : {}),
      });
      // Quem cancelou a PRÓPRIA reserva não precisa ser avisado; cancelamento feito por outra
      // pessoa (Admin, colega do setor) avisa o responsável.
      if (contexto.solicitante_id !== request.usuario!.sub) {
        notificacaoCancelamento = await registrarNotificacao(transaction, {
          usuarioId: contexto.solicitante_id,
          tipo: "reserva_cancelada",
          titulo: "Reserva cancelada",
          mensagem: `Sua reserva de ${contexto.plataforma_nome} em ${contexto.data} (${contexto.hora_inicio}–${contexto.hora_fim}) foi cancelada.`,
          link: "/reservas",
        });
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback().catch(() => undefined);
      throw err;
    }
    publicarEventoGlobal("reserva.status_alterado", { id, status: novoStatus });
    if (notificacaoCancelamento) {
      publicarEventoUsuario(notificacaoCancelamento.usuarioId, "notificacao.nova", notificacaoCancelamento);
      enviarEmailsEmSegundoPlano([notificacaoCancelamento]);
    }

    const completa = await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query<ReservaRow>(`SELECT ${SELECT_RESERVA} ${FROM_RESERVA} WHERE r.id = @id`);
    return reply.status(200).send(mapReserva(completa.recordset[0]));
  });
}
