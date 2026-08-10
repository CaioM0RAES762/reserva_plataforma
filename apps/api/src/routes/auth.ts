import type { FastifyInstance } from "fastify";
import {
  ativarContaReenviarSchema,
  ativarContaSchema,
  cadastrarContaSchema,
  loginSchema,
  recuperarSenhaConfirmarSchema,
  recuperarSenhaSolicitarSchema,
} from "@plataformares/shared";
import { getPool, sql } from "../db/pool.js";
import {
  codigoExpirado,
  codigosConferem,
  gerarCodigoVerificacao,
  hashPassword,
  verifyPassword,
} from "../utils/password.js";
import { assinarToken } from "../utils/jwt.js";
import {
  checarRateLimitCodigo,
  checarRateLimitLogin,
  checarRateLimitSolicitacaoCodigo,
  checarRateLimitSolicitacaoPorIp,
  limparRateLimitCodigo,
  limparRateLimitLogin,
} from "../services/rateLimit.js";
import { EmailNaoEnviadoError } from "../services/email.service.js";
import { emitirEEnviarCodigo } from "../services/otp.service.js";

// Falha de envio precisa chegar ao usuário: se o e-mail não saiu, o código nunca vai
// aparecer na caixa de entrada e mandá-lo para a tela seguinte é enganoso. A mensagem é
// genérica; o motivo real (credencial, timeout, resposta do Graph) fica só no log.
const ERRO_ENVIO_EMAIL = "Não foi possível enviar o código. Tente novamente em instantes.";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/logout", async (_request, reply) => {
    // O cookie só é removido pelo navegador se os atributos de escopo (path/secure/
    // sameSite/httpOnly) baterem com os usados na criação — limpar só com `path` deixava
    // a sessão viva em produção (onde secure=true e sameSite=strict estão ativos).
    reply.clearCookie("token", COOKIE_OPTIONS);
    return reply.status(200).send({ mensagem: "Sessão encerrada." });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, senha } = parsed.data;

    const rateLimit = await checarRateLimitLogin(email);
    if (!rateLimit.permitido) {
      return reply.status(429).send({
        erro: "Muitas tentativas de login. Tente novamente em alguns minutos.",
      });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query(
        "SELECT id, nome, email, senha_hash, perfil, setor_id, ativo, email_verificado FROM Usuario WHERE email = @email"
      );

    const usuario = result.recordset[0];
    if (!usuario) {
      return reply.status(401).send({ erro: "Credenciais inválidas." });
    }
    if (!usuario.ativo) {
      return reply.status(403).send({ erro: "Conta desativada. Contate o administrador." });
    }
    if (!usuario.email_verificado) {
      return reply.status(403).send({ erro: "Conta não ativada. Verifique o código enviado por e-mail." });
    }

    const senhaValida = await verifyPassword(senha, usuario.senha_hash);
    if (!senhaValida) {
      return reply.status(401).send({ erro: "Credenciais inválidas." });
    }

    await limparRateLimitLogin(email);

    const token = assinarToken({
      sub: usuario.id,
      email: usuario.email,
      perfil: usuario.perfil,
      setorId: usuario.setor_id,
    });

    await pool
      .request()
      .input("id", sql.UniqueIdentifier, usuario.id)
      .query("UPDATE Usuario SET ultimo_login = SYSUTCDATETIME() WHERE id = @id");

    reply.setCookie("token", token, COOKIE_OPTIONS);
    return reply.status(200).send({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        setorId: usuario.setor_id,
      },
    });
  });

  // RN-USR-01 estendida: autocadastro. Antes, a única forma de uma conta nascer era o
  // Admin criá-la em /api/v1/usuarios (RF-USR-01) — o autocadastro elimina essa
  // dependência para o caso comum (colaborador). O Admin continua existindo para promover/
  // rebaixar perfil (PATCH /:id/perfil) e ativar/desativar contas (PATCH /:id/status); a
  // rota administrativa de criação (POST /api/v1/usuarios) continua disponível para casos
  // em que o Admin precisa criar diretamente uma conta gestor_setor/admin, que este fluxo
  // público nunca cria (perfil aqui é sempre 'colaborador', nunca escolhido pelo cliente).
  //
  // Resposta sempre genérica (mesmo padrão anti-enumeração de recuperar-senha e
  // ativar-conta/reenviar): não revela se o e-mail já tinha conta, já estava ativo, ou
  // acabou de ser criado agora.
  app.post("/api/v1/auth/cadastrar", async (request, reply) => {
    const parsed = cadastrarContaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { nome, email, setorId } = parsed.data;
    const RESPOSTA_GENERICA = {
      mensagem: "Se o cadastro puder ser concluído, um código de verificação foi enviado.",
    };

    const limiteIp = await checarRateLimitSolicitacaoPorIp(request.ip);
    if (!limiteIp.permitido) {
      request.log.warn({ ip: request.ip }, "autocadastro bloqueado por rate limit de IP");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    // Mesma chave/tipo de ativar-conta/reenviar: são dois jeitos de disparar o mesmo
    // envio (primeira vez vs. reenvio) e não deveriam somar cotas independentes.
    const limiteSolicitacao = await checarRateLimitSolicitacaoCodigo(email, "ativacao_conta");
    if (!limiteSolicitacao.permitido) {
      request.log.warn({ email }, "autocadastro bloqueado por rate limit — nenhum e-mail enviado");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    const pool = await getPool();

    // setorId não é confiável só porque veio validado como UUID — precisa corresponder a
    // um setor real e ativo, senão o INSERT abaixo falharia com um erro de FK cru em vez
    // de uma mensagem que a tela consegue mostrar.
    const setorResult = await pool
      .request()
      .input("setor_id", sql.UniqueIdentifier, setorId)
      .query<{ id: string }>("SELECT id FROM Setor WHERE id = @setor_id AND ativo = 1");
    if (!setorResult.recordset[0]) {
      return reply.status(422).send({ erro: "Setor inválido." });
    }

    const usuarioExistente = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query<{ id: string; email_verificado: boolean; ativo: boolean }>(
        "SELECT id, email_verificado, ativo FROM Usuario WHERE email = @email"
      );
    const existente = usuarioExistente.recordset[0];

    let usuarioId: string;
    if (existente) {
      // Já ativo ou desativado: resposta genérica, sem enviar nada — não revela ao
      // solicitante em qual desses dois estados a conta está.
      if (existente.email_verificado || !existente.ativo) {
        return reply.status(200).send(RESPOSTA_GENERICA);
      }
      // Pendente de ativação (cadastro anterior não concluído): reenvia em vez de tentar
      // inserir de novo e colidir com a UNIQUE de e-mail.
      usuarioId = existente.id;
    } else {
      const senhaPlaceholder = await hashPassword(gerarCodigoVerificacao() + gerarCodigoVerificacao());
      const transaction = pool.transaction();
      await transaction.begin();
      try {
        const insercao = await transaction
          .request()
          .input("nome", sql.NVarChar, nome)
          .input("email", sql.NVarChar, email)
          .input("senha_hash", sql.VarChar, senhaPlaceholder)
          .input("setor_id", sql.UniqueIdentifier, setorId)
          .query<{ id: string }>(
            `INSERT INTO Usuario (nome, email, senha_hash, perfil, setor_id, ativo, email_verificado)
             OUTPUT INSERTED.id
             VALUES (@nome, @email, @senha_hash, 'colaborador', @setor_id, 1, 0)`
          );
        usuarioId = insercao.recordset[0].id;

        // Sem ator autenticado (é o próprio usuário se cadastrando) — usuario_id e
        // entidade_id apontam para a conta recém-criada, registrando que ela nasceu por
        // autocadastro, não por ação do Admin.
        await transaction
          .request()
          .input("usuario_id", sql.UniqueIdentifier, usuarioId)
          .input("acao", sql.VarChar, "autocadastro")
          .input("entidade_id", sql.UniqueIdentifier, usuarioId)
          .input("detalhes", sql.NVarChar, JSON.stringify({ nome, email, setorId }))
          .query(
            `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             VALUES (@usuario_id, @acao, 'Usuario', @entidade_id, @detalhes)`
          );

        await transaction.commit();
      } catch (err) {
        await transaction.rollback();
        const sqlErr = err as { number?: number };
        if (sqlErr.number && (sqlErr.number === 2601 || sqlErr.number === 2627)) {
          // Corrida: dois cadastros simultâneos para o mesmo e-mail — trata como se a
          // conta já existisse (resposta genérica, sem vazar a colisão).
          return reply.status(200).send(RESPOSTA_GENERICA);
        }
        throw err;
      }
    }

    try {
      await emitirEEnviarCodigo({
        usuarioId,
        email,
        tipo: "ativacao_conta",
        tipoObservabilidade: "ACTIVATION",
      });
    } catch (err) {
      request.log.error({ err }, "falha ao enviar código de autocadastro");
      if (err instanceof EmailNaoEnviadoError) {
        return reply.status(502).send({ erro: ERRO_ENVIO_EMAIL });
      }
      throw err;
    }

    return reply.status(200).send(RESPOSTA_GENERICA);
  });

  app.post("/api/v1/auth/ativar-conta", async (request, reply) => {
    const parsed = ativarContaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, codigo, senha } = parsed.data;

    // Um código de 6 dígitos válido por 15 min é adivinhável se as tentativas forem
    // ilimitadas — o rate limit de RF-AUTH-05 cobria só o login até aqui.
    const limiteCodigo = await checarRateLimitCodigo(email, "ativacao_conta");
    if (!limiteCodigo.permitido) {
      return reply
        .status(429)
        .send({ erro: "Muitas tentativas com código inválido. Solicite um novo código e tente mais tarde." });
    }

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query(
        `SELECT u.id, u.nome, s.nome AS setor_nome FROM Usuario u
         LEFT JOIN Setor s ON s.id = u.setor_id
         WHERE u.email = @email`
      );

    const usuario = usuarioResult.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }

    const codigoResult = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuario.id)
      .input("tipo", sql.VarChar, "ativacao_conta")
      .query(
        `SELECT TOP 1 id, codigo, expira_em, utilizado FROM CodigoVerificacao
         WHERE usuario_id = @usuario_id AND tipo = @tipo
         ORDER BY criado_em DESC`
      );

    const codigoRegistro = codigoResult.recordset[0];
    if (!codigoRegistro || !codigosConferem(codigo, codigoRegistro.codigo)) {
      return reply.status(400).send({ erro: "Código de verificação inválido." });
    }
    if (codigoRegistro.utilizado) {
      return reply.status(400).send({ erro: "Código já utilizado." });
    }
    if (codigoExpirado(new Date(codigoRegistro.expira_em))) {
      return reply.status(400).send({ erro: "Código expirado." });
    }

    const senhaHash = await hashPassword(senha);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, usuario.id)
        .input("senha_hash", sql.VarChar, senhaHash)
        .query(
          "UPDATE Usuario SET senha_hash = @senha_hash, email_verificado = 1 WHERE id = @id"
        );

      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, codigoRegistro.id)
        .query("UPDATE CodigoVerificacao SET utilizado = 1 WHERE id = @id");

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, usuario.id)
        .input("acao", sql.VarChar, "ativar_conta")
        .input("entidade", sql.VarChar, "Usuario")
        .input("entidade_id", sql.UniqueIdentifier, usuario.id)
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, NULL)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    // Código correto: zera o contador para não punir quem errou antes de acertar.
    await limparRateLimitCodigo(email, "ativacao_conta");
    // nome/setorNome vão só para a copy da tela de sucesso ("Seu acesso ao setor X foi
    // liberado") — nunca dados sensíveis, e o usuário já provou posse do e-mail.
    return reply
      .status(200)
      .send({ mensagem: "Conta ativada com sucesso.", nome: usuario.nome, setorNome: usuario.setor_nome });
  });

  // Reenvio de código de ativação: espelha o mesmo padrão de segurança de
  // recuperar-senha (resposta genérica sempre 200, rate limit de solicitação) — evita
  // usar a rota para enumerar contas ou martelar o envio de e-mail. Só dispara um
  // código novo se a conta existir, estiver ativa E ainda não tiver sido ativada;
  // caso contrário, responde igual, sem revelar qual condição falhou.
  app.post("/api/v1/auth/ativar-conta/reenviar", async (request, reply) => {
    const parsed = ativarContaReenviarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, nome, setorId } = parsed.data;
    const RESPOSTA_GENERICA = {
      mensagem: "Se a conta existir e estiver pendente de ativação, um código foi enviado.",
    };

    const limiteIp = await checarRateLimitSolicitacaoPorIp(request.ip);
    if (!limiteIp.permitido) {
      request.log.warn({ ip: request.ip }, "solicitação de código de ativação bloqueada por rate limit de IP");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    const limiteSolicitacao = await checarRateLimitSolicitacaoCodigo(email, "ativacao_conta");
    if (!limiteSolicitacao.permitido) {
      // A resposta ao cliente é sempre a genérica (não pode revelar que a conta existe e
      // só está sob rate limit) — mas sem este log, um usuário clicando em "reenviar" mais
      // de 3x em 10 min via nada além do 200 de sucesso, sem entender por que o e-mail
      // parou de chegar. Isto fica só no log do servidor.
      request.log.warn({ email }, "solicitação de código de ativação bloqueada por rate limit — nenhum e-mail enviado");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query<{ id: string; nome: string; setor_id: string | null; email_verificado: boolean; ativo: boolean }>(
        "SELECT id, nome, setor_id, email_verificado, ativo FROM Usuario WHERE email = @email"
      );

    const usuario = usuarioResult.recordset[0];
    if (!usuario || usuario.email_verificado || !usuario.ativo) {
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    // Divergência entre o que o usuário digitou e o cadastro feito pelo Admin não impede
    // a ativação (ver comentário em ativarContaReenviarSchema), mas fica registrada:
    // é o sinal que permite ao Admin perceber alguém tentando ativar a conta de outro.
    const nomeDivergente = Boolean(nome) && nome!.toLowerCase() !== usuario.nome.toLowerCase();
    const setorDivergente = Boolean(setorId) && setorId!.toLowerCase() !== (usuario.setor_id ?? "").toLowerCase();
    if (nomeDivergente || setorDivergente) {
      request.log.warn(
        { usuarioId: usuario.id, nomeDivergente, setorDivergente },
        "solicitação de código de ativação com dados divergentes do cadastro"
      );
    }

    try {
      const resultado = await emitirEEnviarCodigo({
        usuarioId: usuario.id,
        email,
        tipo: "ativacao_conta",
        tipoObservabilidade: "ACTIVATION_RESEND",
      });
      // "em_andamento" = já existe uma emissão nos últimos 30s para este usuário (duplo
      // clique / requests quase simultâneos) — não é erro, é o mesmo e-mail que já está a
      // caminho. A resposta ao cliente continua a mesma de sucesso, sem enviar de novo.
      if (resultado.status === "em_andamento") {
        return reply.status(200).send(RESPOSTA_GENERICA);
      }
    } catch (err) {
      request.log.error({ err }, "falha ao enviar código de ativação");
      if (err instanceof EmailNaoEnviadoError) {
        return reply.status(502).send({ erro: ERRO_ENVIO_EMAIL });
      }
      throw err;
    }

    return reply.status(200).send(RESPOSTA_GENERICA);
  });

  app.post("/api/v1/auth/recuperar-senha", async (request, reply) => {
    const parsed = recuperarSenhaSolicitarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email } = parsed.data;
    const RESPOSTA_GENERICA = { mensagem: "Se o e-mail existir, um código foi enviado." };

    const limiteIp = await checarRateLimitSolicitacaoPorIp(request.ip);
    if (!limiteIp.permitido) {
      request.log.warn({ ip: request.ip }, "solicitação de código de recuperação de senha bloqueada por rate limit de IP");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    // Evita usar a rota como amplificador de e-mail (um disparo por chamada, sem limite).
    // Resposta 200 genérica também aqui, pelo mesmo motivo de não vazar cadastro.
    const limiteSolicitacao = await checarRateLimitSolicitacaoCodigo(email, "reset_senha");
    if (!limiteSolicitacao.permitido) {
      request.log.warn({ email }, "solicitação de código de recuperação de senha bloqueada por rate limit — nenhum e-mail enviado");
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query("SELECT id FROM Usuario WHERE email = @email");

    const usuario = usuarioResult.recordset[0];
    // Resposta genérica sempre 200, mesmo se o e-mail não existir, para não vazar quais
    // e-mails estão cadastrados (enumeração de contas).
    if (!usuario) {
      return reply.status(200).send(RESPOSTA_GENERICA);
    }

    try {
      await emitirEEnviarCodigo({
        usuarioId: usuario.id,
        email,
        tipo: "reset_senha",
        tipoObservabilidade: "PASSWORD_RESET",
      });
      // "em_andamento" também responde com a mensagem genérica de sucesso — ver comentário
      // equivalente em /ativar-conta/reenviar.
    } catch (err) {
      request.log.error({ err }, "falha ao enviar código de recuperação de senha");
      if (err instanceof EmailNaoEnviadoError) {
        return reply.status(502).send({ erro: ERRO_ENVIO_EMAIL });
      }
      throw err;
    }

    return reply.status(200).send(RESPOSTA_GENERICA);
  });

  app.post("/api/v1/auth/recuperar-senha/confirmar", async (request, reply) => {
    const parsed = recuperarSenhaConfirmarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Dados inválidos.", detalhes: parsed.error.flatten() });
    }
    const { email, codigo, novaSenha } = parsed.data;

    const limiteCodigo = await checarRateLimitCodigo(email, "reset_senha");
    if (!limiteCodigo.permitido) {
      return reply
        .status(429)
        .send({ erro: "Muitas tentativas com código inválido. Solicite um novo código e tente mais tarde." });
    }

    const pool = await getPool();
    const usuarioResult = await pool
      .request()
      .input("email", sql.NVarChar, email)
      .query("SELECT id FROM Usuario WHERE email = @email");

    const usuario = usuarioResult.recordset[0];
    if (!usuario) {
      return reply.status(404).send({ erro: "Usuário não encontrado." });
    }

    const codigoResult = await pool
      .request()
      .input("usuario_id", sql.UniqueIdentifier, usuario.id)
      .input("tipo", sql.VarChar, "reset_senha")
      .query(
        `SELECT TOP 1 id, codigo, expira_em, utilizado FROM CodigoVerificacao
         WHERE usuario_id = @usuario_id AND tipo = @tipo
         ORDER BY criado_em DESC`
      );

    const codigoRegistro = codigoResult.recordset[0];
    if (!codigoRegistro || !codigosConferem(codigo, codigoRegistro.codigo)) {
      return reply.status(400).send({ erro: "Código de verificação inválido." });
    }
    if (codigoRegistro.utilizado) {
      return reply.status(400).send({ erro: "Código já utilizado." });
    }
    if (codigoExpirado(new Date(codigoRegistro.expira_em))) {
      return reply.status(400).send({ erro: "Código expirado." });
    }

    const senhaHash = await hashPassword(novaSenha);
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, usuario.id)
        .input("senha_hash", sql.VarChar, senhaHash)
        .query("UPDATE Usuario SET senha_hash = @senha_hash WHERE id = @id");

      await transaction
        .request()
        .input("id", sql.UniqueIdentifier, codigoRegistro.id)
        .query("UPDATE CodigoVerificacao SET utilizado = 1 WHERE id = @id");

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, usuario.id)
        .input("acao", sql.VarChar, "redefinir_senha")
        .input("entidade", sql.VarChar, "Usuario")
        .input("entidade_id", sql.UniqueIdentifier, usuario.id)
        .query(
          `INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           VALUES (@usuario_id, @acao, @entidade, @entidade_id, NULL)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    await limparRateLimitCodigo(email, "reset_senha");
    // Senha redefinida com sucesso também libera o login: se a conta chegou aqui é porque
    // o dono provou posse do e-mail, então o bloqueio por tentativas erradas não faz mais
    // sentido (antes, quem esquecia a senha ficava travado mesmo após redefini-la).
    await limparRateLimitLogin(email);
    return reply.status(200).send({ mensagem: "Senha redefinida com sucesso." });
  });
}
