import type { OrigemGestaoPlataforma, Perfil, PoliticaSubstituicaoUrgente } from "@plataformares/shared";
import { sql } from "../db/pool.js";
import { obterPoliticaSubstituicaoUrgente } from "./configuracao.service.js";

// Regra ÚNICA de "quem gerencia esta plataforma" (dados, status, automação, imagens). Toda rota
// de escrita de plataforma passa por avaliarGestaoPlataforma; a listagem usa a mesma função pura
// para devolver `podeEditar` — nenhuma tela recalcula permissão por conta própria.
//
//  - Admin: qualquer plataforma.
//  - Gestor de Setor: a que ele cadastrou; as do setor ATUAL dele; as em que foi atribuído
//    diretamente como responsável (PlataformaResponsavel, migration 0030).
//  - Colaborador: nunca.
//
// Perfil, setor e status vêm do banco a cada requisição (autenticar em rbac.ts): rebaixar,
// desativar ou trocar o setor de um gestor muda a permissão na requisição seguinte, e uma
// atribuição direta só concede acesso enquanto o usuário for Gestor ativo.

export interface UsuarioGestao {
  sub: string;
  perfil: Perfil;
  setorId: string | null;
}

export interface DadosGestaoPlataforma {
  criadoPorId: string | null;
  setorId: string | null;
  /** O usuário está em PlataformaResponsavel desta plataforma. */
  ehResponsavel: boolean;
}

const mesmoId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function origemGestaoPlataforma(
  usuario: UsuarioGestao,
  dados: DadosGestaoPlataforma
): OrigemGestaoPlataforma | null {
  if (usuario.perfil === "admin") return "admin";
  if (usuario.perfil !== "gestor_setor") return null;
  if (mesmoId(dados.criadoPorId, usuario.sub)) return "criador";
  if (mesmoId(dados.setorId, usuario.setorId)) return "setor";
  if (dados.ehResponsavel) return "responsavel";
  return null;
}

export type ExecutorSql = { request(): sql.Request };

/** `null` = plataforma não existe. */
export async function avaliarGestaoPlataforma(
  executor: ExecutorSql,
  usuario: UsuarioGestao,
  plataformaId: string
): Promise<{ origem: OrigemGestaoPlataforma | null; setorId: string | null } | null> {
  const result = await executor
    .request()
    .input("id", sql.UniqueIdentifier, plataformaId)
    .input("usuario_id", sql.UniqueIdentifier, usuario.sub)
    .query<{ criado_por_id: string | null; setor_id: string | null; eh_responsavel: number }>(
      `SELECT p.criado_por_id, p.setor_id,
              CASE WHEN EXISTS (
                SELECT 1 FROM PlataformaResponsavel pr WHERE pr.plataforma_id = p.id AND pr.gestor_id = @usuario_id
              ) THEN 1 ELSE 0 END AS eh_responsavel
       FROM Plataforma p WHERE p.id = @id`
    );
  const linha = result.recordset[0];
  if (!linha) return null;
  return {
    setorId: linha.setor_id,
    origem: origemGestaoPlataforma(usuario, {
      criadoPorId: linha.criado_por_id,
      setorId: linha.setor_id,
      ehResponsavel: linha.eh_responsavel === 1,
    }),
  };
}

/** Plataformas em que o usuário é responsável direto — uma consulta para a listagem inteira. */
export async function plataformasDoResponsavel(executor: ExecutorSql, usuarioId: string): Promise<Set<string>> {
  const result = await executor
    .request()
    .input("usuario_id", sql.UniqueIdentifier, usuarioId)
    .query<{ plataforma_id: string }>("SELECT plataforma_id FROM PlataformaResponsavel WHERE gestor_id = @usuario_id");
  return new Set(result.recordset.map((r) => r.plataforma_id.toLowerCase()));
}

export const MENSAGEM_SEM_GESTAO_PLATAFORMA =
  "Você não gerencia esta plataforma. Gestores alteram as que cadastraram, as do próprio setor ou aquelas pelas quais são responsáveis.";

// ---------------------------------------------------------------------------------------
// Substituição de reserva por uma urgente (política em Configurações, migration 0030)
// ---------------------------------------------------------------------------------------

export type RegraAutorizacaoSubstituicao = "admin" | "todos_aprovadores" | "responsavel";

export interface AutorizacaoSubstituicao {
  permitido: boolean;
  politica: PoliticaSubstituicaoUrgente;
  /** Qual regra concedeu (vai para a auditoria); null quando negado. */
  regra: RegraAutorizacaoSubstituicao | null;
  /** Explicação para quem não pode autorizar (botão desabilitado / 403). */
  motivo: string | null;
}

/**
 * Quem pode AUTORIZAR a substituição de reservas conflitantes por uma urgente. Não muda nada
 * na aprovação sem conflito. Chamado na análise (GET) e de novo DENTRO da transação da decisão
 * (POST), com a política lida no mesmo executor: uma mudança de política ou de atribuição entre
 * a análise e a confirmação vale na confirmação.
 */
export async function avaliarAutorizacaoSubstituicao(
  executor: ExecutorSql,
  usuario: UsuarioGestao,
  plataformaId: string
): Promise<AutorizacaoSubstituicao> {
  const politica = await obterPoliticaSubstituicaoUrgente(executor);
  if (usuario.perfil === "admin") return { permitido: true, politica, regra: "admin", motivo: null };
  if (usuario.perfil !== "gestor_setor") {
    return { permitido: false, politica, regra: null, motivo: "Somente Admin ou Gestor podem autorizar substituições." };
  }
  if (politica === "todos_aprovadores") return { permitido: true, politica, regra: "todos_aprovadores", motivo: null };

  // Política restrita: só o responsável DIRETO (criador, setor ou gestor do setor da reserva
  // não bastam). Responsável que deixou de ser Gestor ativo não conta.
  const result = await executor
    .request()
    .input("plataforma_id", sql.UniqueIdentifier, plataformaId)
    .input("usuario_id", sql.UniqueIdentifier, usuario.sub)
    .query<{ eu: number; ativos: number }>(
      `SELECT
         SUM(CASE WHEN pr.gestor_id = @usuario_id THEN 1 ELSE 0 END) AS eu,
         COUNT(*) AS ativos
       FROM PlataformaResponsavel pr
       JOIN Usuario u ON u.id = pr.gestor_id AND u.ativo = 1 AND u.perfil = 'gestor_setor'
       WHERE pr.plataforma_id = @plataforma_id`
    );
  const { eu, ativos } = result.recordset[0] ?? { eu: 0, ativos: 0 };
  if ((eu ?? 0) > 0) return { permitido: true, politica, regra: "responsavel", motivo: null };
  return {
    permitido: false,
    politica,
    regra: null,
    motivo:
      (ativos ?? 0) === 0
        ? "Esta plataforma não tem gestor responsável: pela política atual, somente o Admin pode autorizar a substituição."
        : "Pela política atual, somente o Admin ou um gestor responsável por esta plataforma pode autorizar a substituição.",
  };
}
