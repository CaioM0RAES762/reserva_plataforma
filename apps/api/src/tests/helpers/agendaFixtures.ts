import { getPool, sql } from "../../db/pool.js";
import { assinarToken } from "../../utils/jwt.js";
import type { Perfil } from "@plataformares/shared";

// Fixtures das suítes de agenda (empresa terceirizada, regras de reserva, disponibilidade,
// concorrência). Objetivo: cada suíte provisiona TUDO o que usa via SQL e remove TUDO ao
// final, sem depender de SEED_ADMIN_* (que pode nem estar no .env do ambiente) nem de Redis.
//
// A sessão é montada assinando o JWT direto (`assinarToken`), o mesmo que a rota de login
// faria: o middleware `autenticar` só verifica o cookie. Isso dispensa POST /auth/login — e,
// com ele, o contador de rate limit no Redis e o hash bcrypt de cada usuário de teste.
// Nenhum e-mail é enviado por nada aqui (e as suítes ainda mockam a fila e o provider).

export interface UsuarioTeste {
  id: string;
  email: string;
  perfil: Perfil;
  setorId: string | null;
  /** Valor pronto para o header `cookie` de app.inject. */
  cookie: string;
}

export interface SetorTeste {
  id: string;
  nome: string;
  /** true = criado por esta suíte (e, portanto, removido por ela). */
  criado: boolean;
}

export interface PrefixosResiduos {
  /** Prefixo do `codigo` das plataformas de teste (LIKE 'PREFIXO%'). */
  plataforma: string;
  /** Prefixo do e-mail dos usuários de teste (LIKE 'PREFIXO%'). */
  email: string;
  /** Prefixo do `motivo` dos bloqueios de teste (LIKE 'PREFIXO%'). */
  bloqueio: string;
}

/** Data "YYYY-MM-DD" daqui a `dias` dias, com sorteio para não colidir com outras execuções. */
export function dataDaqui(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function dataFuturaAleatoria(): string {
  return dataDaqui(400 + Math.floor(Math.random() * 300));
}

/** Reaproveita o setor se já existe (sem alterá-lo nem removê-lo depois); senão cria. */
export async function garantirSetor(nome: string): Promise<SetorTeste> {
  const pool = await getPool();
  const existente = await pool
    .request()
    .input("nome", sql.NVarChar, nome)
    .query<{ id: string }>("SELECT id FROM Setor WHERE nome = @nome");
  if (existente.recordset[0]) return { id: existente.recordset[0].id, nome, criado: false };
  const novo = await pool
    .request()
    .input("nome", sql.NVarChar, nome)
    .query<{ id: string }>(`INSERT INTO Setor (nome, cor_hex) OUTPUT INSERTED.id VALUES (@nome, '#6B7280')`);
  return { id: novo.recordset[0].id, nome, criado: true };
}

/** Só remove o setor que a própria suíte criou; deve rodar DEPOIS de apagar usuários/reservas. */
export async function removerSetorSeCriado(setor: SetorTeste | undefined): Promise<void> {
  if (!setor?.criado) return;
  const pool = await getPool();
  await pool.request().input("id", sql.UniqueIdentifier, setor.id).query("DELETE FROM Setor WHERE id = @id");
}

export async function criarUsuarioTeste(dados: {
  email: string;
  nome: string;
  perfil: Perfil;
  setorId: string | null;
}): Promise<UsuarioTeste> {
  const pool = await getPool();
  const inserido = await pool
    .request()
    .input("nome", sql.NVarChar, dados.nome)
    .input("email", sql.NVarChar, dados.email)
    // Ninguém faz login com esta conta (a sessão é o JWT assinado abaixo): o valor só
    // precisa satisfazer o NOT NULL — e não é um hash válido, de propósito.
    .input("senha_hash", sql.VarChar, "!conta-de-teste-sem-login")
    .input("perfil", sql.VarChar, dados.perfil)
    .input("setor_id", sql.UniqueIdentifier, dados.setorId)
    .query<{ id: string }>(
      `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
       OUTPUT INSERTED.id
       VALUES (@nome, @email, @senha_hash, @perfil, @setor_id, 1, 1)`
    );
  const id = inserido.recordset[0].id;
  const token = assinarToken({ sub: id, email: dados.email, perfil: dados.perfil, setorId: dados.setorId });
  return { id, email: dados.email, perfil: dados.perfil, setorId: dados.setorId, cookie: `token=${token}` };
}

export async function criarPlataformaTeste(dados: {
  codigo: string;
  nome: string;
  /** 'disponivel' (padrão) | 'manutencao' | 'inativa'. */
  status?: string;
  capacidadeOperadores?: number | null;
}): Promise<string> {
  const pool = await getPool();
  const inserida = await pool
    .request()
    .input("codigo", sql.VarChar, dados.codigo)
    .input("nome", sql.NVarChar, dados.nome)
    .input("status", sql.VarChar, dados.status ?? "disponivel")
    .input("capacidade_operadores", sql.Int, dados.capacidadeOperadores ?? null)
    .query<{ id: string }>(
      `INSERT INTO Plataforma (codigo, nome, status, capacidade_operadores)
       OUTPUT INSERTED.id VALUES (@codigo, @nome, @status, @capacidade_operadores)`
    );
  return inserida.recordset[0].id;
}

/** Reserva inserida direto no banco (fixture) — não passa pela rota, então aceita qualquer status. */
export async function inserirReservaTeste(dados: {
  setorId: string;
  solicitanteId: string;
  plataformaId: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  status: string;
  motivo?: string;
}): Promise<string> {
  const pool = await getPool();
  const inserida = await pool
    .request()
    .input("setor_id", sql.UniqueIdentifier, dados.setorId)
    .input("solicitante_id", sql.UniqueIdentifier, dados.solicitanteId)
    .input("plataforma_id", sql.UniqueIdentifier, dados.plataformaId)
    .input("data", sql.Date, dados.data)
    .input("hora_inicio", sql.VarChar, dados.horaInicio)
    .input("hora_fim", sql.VarChar, dados.horaFim)
    .input("motivo", sql.NVarChar, dados.motivo ?? "Reserva de fixture (teste)")
    .input("status", sql.VarChar, dados.status)
    .query<{ id: string }>(
      `INSERT INTO Reserva (setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim, motivo, status)
       OUTPUT INSERTED.id
       VALUES (@setor_id, @solicitante_id, @plataforma_id, @data, @hora_inicio, @hora_fim, @motivo, @status)`
    );
  return inserida.recordset[0].id;
}

/** Bloqueio inserido direto no banco; `inicio`/`fim` são instantes UTC reais. */
export async function inserirBloqueioTeste(dados: {
  plataformaId: string | null;
  inicio: Date;
  fim: Date;
  motivo: string;
  criadoPorId: string;
}): Promise<string> {
  const pool = await getPool();
  const inserido = await pool
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, dados.plataformaId)
    .input("data_inicio", sql.DateTime2, dados.inicio)
    .input("data_fim", sql.DateTime2, dados.fim)
    .input("motivo", sql.NVarChar, dados.motivo)
    .input("criado_por_id", sql.UniqueIdentifier, dados.criadoPorId)
    .query<{ id: string }>(
      `INSERT INTO BloqueioAgenda (plataforma_id, data_inicio, data_fim, motivo, criado_por_id)
       OUTPUT INSERTED.id VALUES (@plataforma_id, @data_inicio, @data_fim, @motivo, @criado_por_id)`
    );
  return inserido.recordset[0].id;
}

/**
 * Remove tudo o que uma suíte cria, identificado pelos PREFIXOS dela — serve tanto para o
 * afterAll quanto para varrer resíduos de uma execução anterior que morreu no meio. A ordem
 * respeita as FKs: auditoria e reservas antes das plataformas/usuários a que apontam.
 */
export async function limparResiduos(prefixos: PrefixosResiduos): Promise<void> {
  const pool = await getPool();
  const executar = (consulta: string) =>
    pool
      .request()
      .input("plataforma", sql.VarChar, `${prefixos.plataforma}%`)
      .input("email", sql.NVarChar, `${prefixos.email}%`)
      .input("bloqueio", sql.NVarChar, `${prefixos.bloqueio}%`)
      .query(consulta);

  const reservasDeTeste = `SELECT id FROM Reserva
    WHERE plataforma_id IN (SELECT id FROM Plataforma WHERE codigo LIKE @plataforma)
       OR solicitante_id IN (SELECT id FROM Usuario WHERE email LIKE @email)`;
  await executar(`DELETE FROM LogAuditoria WHERE entidade_id IN (${reservasDeTeste})`);
  await executar(`DELETE FROM Reserva WHERE id IN (${reservasDeTeste})`);
  // Séries semanais criadas pelos usuários de teste: sem isto a FK para Usuario impedia o
  // DELETE de usuários abaixo e a suíte seguinte falhava já no beforeAll.
  await executar(
    `DELETE FROM ReservaRecorrencia WHERE criado_por_id IN (SELECT id FROM Usuario WHERE email LIKE @email)
       AND NOT EXISTS (SELECT 1 FROM Reserva r WHERE r.recorrencia_id = ReservaRecorrencia.id)`
  );

  const bloqueiosDeTeste = `SELECT id FROM BloqueioAgenda
    WHERE motivo LIKE @bloqueio OR criado_por_id IN (SELECT id FROM Usuario WHERE email LIKE @email)`;
  await executar(`DELETE FROM LogAuditoria WHERE entidade_id IN (${bloqueiosDeTeste})`);
  await executar(`DELETE FROM BloqueioAgenda WHERE id IN (${bloqueiosDeTeste})`);

  await executar(
    `DELETE FROM LogAuditoria WHERE entidade_id IN (SELECT id FROM Plataforma WHERE codigo LIKE @plataforma)`
  );
  await executar(`DELETE FROM Plataforma WHERE codigo LIKE @plataforma`);

  const usuariosDeTeste = `SELECT id FROM Usuario WHERE email LIKE @email`;
  // Solicitação pendente de um usuário de teste notifica os aprovadores REAIS do banco
  // (Admins ativos/Gestores do setor). A mensagem começa com o nome do solicitante: remove
  // essas notificações antes de o usuário de teste (e, com ele, o nome) sumir.
  await executar(
    `DELETE FROM Notificacao
     WHERE tipo = 'reserva_pendente'
       AND EXISTS (SELECT 1 FROM Usuario u WHERE u.email LIKE @email AND Notificacao.mensagem LIKE u.nome + ' (%')`
  );
  // Um PUT /configuracoes feito por um usuário de teste deixa o id dele em
  // ConfiguracaoSistema.atualizado_por_id (FK): solta a referência antes de apagá-lo.
  await executar(
    `UPDATE ConfiguracaoSistema SET atualizado_por_id = NULL WHERE atualizado_por_id IN (${usuariosDeTeste})`
  );
  await executar(`DELETE FROM LogAuditoria WHERE usuario_id IN (${usuariosDeTeste})`);
  await executar(`DELETE FROM Notificacao WHERE usuario_id IN (${usuariosDeTeste})`);
  await executar(`DELETE FROM CodigoVerificacao WHERE usuario_id IN (${usuariosDeTeste})`);
  await executar(`DELETE FROM Usuario WHERE email LIKE @email`);
}

/**
 * Expediente de dia inteiro (00:00–23:59) durante a suíte, para cenários de conflito que usam
 * prioridade NORMAL não dependerem do expediente configurado no banco de dev. Devolve a
 * função que restaura exatamente os valores anteriores (chamar no afterAll).
 */
export async function definirExpedienteDiaInteiro(): Promise<() => Promise<void>> {
  const { invalidarCacheConfiguracao } = await import("../../services/configuracao.service.js");
  const pool = await getPool();
  const chaves = ["horario_expediente_inicio", "horario_expediente_fim"];
  const originais = await pool
    .request()
    .query<{ chave: string; valor: string }>(
      `SELECT chave, valor FROM ConfiguracaoSistema WHERE chave IN ('${chaves.join("','")}')`
    );
  const gravar = async (chave: string, valor: string) => {
    await pool
      .request()
      .input("chave", sql.VarChar, chave)
      .input("valor", sql.NVarChar, valor)
      .query("UPDATE ConfiguracaoSistema SET valor = @valor WHERE chave = @chave");
  };
  await gravar("horario_expediente_inicio", "00:00");
  await gravar("horario_expediente_fim", "23:59");
  invalidarCacheConfiguracao();
  return async () => {
    for (const { chave, valor } of originais.recordset) await gravar(chave, valor);
    invalidarCacheConfiguracao();
  };
}

/** Define o modo de aprovação (migration 0023) durante a suíte; devolve a função que restaura o valor anterior. */
export async function definirModoAprovacao(modo: "manual" | "automatica"): Promise<() => Promise<void>> {
  const { invalidarCacheConfiguracao } = await import("../../services/configuracao.service.js");
  const pool = await getPool();
  // Guarda também os METADADOS (quem/quando alterou): um teste que passa pela rota real de
  // PUT /configuracoes os sobrescreve, e a tela de Configurações mostra "Última alteração".
  const atual = await pool
    .request()
    .query<{ valor: string; atualizado_em: Date; atualizado_por_id: string | null }>(
      "SELECT valor, atualizado_em, atualizado_por_id FROM ConfiguracaoSistema WHERE chave = 'modo_aprovacao_reservas'"
    );
  const anterior = atual.recordset[0];
  await pool
    .request()
    .input("valor", sql.NVarChar, modo)
    .query("UPDATE ConfiguracaoSistema SET valor = @valor WHERE chave = 'modo_aprovacao_reservas'");
  invalidarCacheConfiguracao();
  return async () => {
    if (!anterior) return;
    await pool
      .request()
      .input("valor", sql.NVarChar, anterior.valor)
      .input("atualizado_em", sql.DateTime2, anterior.atualizado_em)
      .input("atualizado_por_id", sql.UniqueIdentifier, anterior.atualizado_por_id)
      .query(
        `UPDATE ConfiguracaoSistema SET valor = @valor, atualizado_em = @atualizado_em, atualizado_por_id = @atualizado_por_id
         WHERE chave = 'modo_aprovacao_reservas'`
      );
    invalidarCacheConfiguracao();
  };
}
