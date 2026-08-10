import { randomUUID } from "node:crypto";
import { getPool, sql } from "../db/pool.js";
import { getRedis } from "../db/redis.js";
import { calcularExpiracaoCodigo, gerarCodigoVerificacao } from "../utils/password.js";
import {
  enviarEmail,
  templateCodigoVerificacao,
  type EmailSendResult,
  type TipoEmailObservabilidade,
} from "./email.service.js";

export type CodigoTipo = "ativacao_conta" | "reset_senha";

const redis = getRedis();

// Trava de concorrência por (usuário, tipo): serve dois propósitos ao mesmo tempo —
// (1) idempotência contra duplo-clique/requests quase simultâneos no "Reenviar código"
//     (sem isto: OTP A salvo + e-mail A enviado, OTP B salvo + e-mail B enviado, só o B
//     continua válido — o usuário que abriu o e-mail A primeiro digita um código já
//     invalidado); e
// (2) um cooldown mínimo entre emissões, complementar à janela de rate limit em
//     rateLimit.ts (aquela é o teto de abuso; esta é o espaçamento mínimo entre disparos
//     legítimos, alinhado ao cooldown de 45s já mostrado na UI).
const LOCK_TTL_MS = 30_000;

export interface EmitirCodigoParams {
  usuarioId: string;
  email: string;
  tipo: CodigoTipo;
  tipoObservabilidade: TipoEmailObservabilidade;
}

export type EmitirCodigoResultado =
  | { status: "enviado"; emailResultado: EmailSendResult; correlationId: string }
  | { status: "em_andamento"; correlationId: string };

// Único ponto de emissão de código em todo o app: invalida o código anterior do mesmo tipo,
// insere o novo e envia o e-mail — tudo dentro da mesma trava de concorrência, com a
// invalidação+inserção numa transação de banco (nunca existe um instante em que dois
// códigos do mesmo tipo estejam simultaneamente válidos por causa de uma falha no meio do
// caminho). Usado tanto pelos fluxos que o próprio usuário aciona (auth.ts) quanto pelos
// que o Admin aciona (usuarios.ts) — antes desta unificação, o caminho do Admin usava a
// fila fire-and-forget (`enfileirarEmail`) e podia responder "sucesso" sem nunca ter
// tentado enviar nada.
export async function emitirEEnviarCodigo(params: EmitirCodigoParams): Promise<EmitirCodigoResultado> {
  const correlationId = randomUUID().slice(0, 8);
  const chaveLock = `lock:emitir-codigo:${params.tipo}:${params.usuarioId}`;

  const adquirido = await redis.set(chaveLock, correlationId, "PX", LOCK_TTL_MS, "NX");
  if (!adquirido) {
    console.info(
      `[OTP][${correlationId}] emissão ignorada — já existe uma em andamento (lock ativo) tipo=${params.tipo} usuarioId=${params.usuarioId}`
    );
    return { status: "em_andamento", correlationId };
  }

  try {
    const codigo = gerarCodigoVerificacao();
    const expiraEm = calcularExpiracaoCodigo();
    console.info(
      `[OTP][${correlationId}] OTP criado tipo=${params.tipo} usuarioId=${params.usuarioId} expiraEm=${expiraEm.toISOString()}`
    );

    const pool = await getPool();
    const transaction = pool.transaction();
    await transaction.begin();
    try {
      // Invalida qualquer código do mesmo tipo ainda não utilizado antes de inserir o novo:
      // um código antigo vazado não continua válido depois que um novo foi emitido, e nunca
      // há dois códigos ativos do mesmo tipo ao mesmo tempo para o mesmo usuário.
      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, params.usuarioId)
        .input("tipo", sql.VarChar, params.tipo)
        .query(
          `UPDATE CodigoVerificacao SET utilizado = 1 WHERE usuario_id = @usuario_id AND tipo = @tipo AND utilizado = 0`
        );

      await transaction
        .request()
        .input("usuario_id", sql.UniqueIdentifier, params.usuarioId)
        .input("codigo", sql.Char(6), codigo)
        .input("tipo", sql.VarChar, params.tipo)
        .input("expira_em", sql.DateTime2, expiraEm)
        .query(
          `INSERT INTO CodigoVerificacao (usuario_id, codigo, tipo, expira_em, utilizado)
           VALUES (@usuario_id, @codigo, @tipo, @expira_em, 0)`
        );

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    const { assunto, corpoHtml, corpoTexto } = templateCodigoVerificacao(codigo, params.tipo);
    const emailResultado = await enviarEmail(
      { destinatario: params.email, assunto, corpoHtml, corpoTexto },
      { tipo: params.tipoObservabilidade, correlationId }
    );

    return { status: "enviado", emailResultado, correlationId };
  } catch (err) {
    // Falha real (não duplo-clique): libera a trava imediatamente. Manter o lock pelos 30s
    // completos aqui puniria o usuário com uma segunda tentativa bloqueada logo depois de
    // um erro que não foi causado por ele (rede, credencial, banco).
    await redis.del(chaveLock);
    throw err;
  }
  // Caminho de sucesso: a trava NÃO é liberada aqui de propósito — ela expira sozinha em
  // 30s, funcionando como o cooldown mínimo do item (2) acima.
}

// Escapatória só para testes: sem isto, qualquer teste que crie um usuário (o que já
// emite e envia o primeiro código) e em seguida queira testar um reenvio *independente*
// para o mesmo usuário precisaria esperar os 30s inteiros do cooldown real. Nunca chamada
// por código de produção.
export async function limparLockEmissaoParaTeste(usuarioId: string, tipo: CodigoTipo): Promise<void> {
  await redis.del(`lock:emitir-codigo:${tipo}:${usuarioId}`);
}
