import type { FastifyReply, FastifyRequest } from "fastify";
import { verificarToken, type JwtPayload } from "../utils/jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    usuario?: JwtPayload;
  }
}

export async function autenticar(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies?.token;
  if (!token) {
    return reply.status(401).send({ erro: "Não autenticado." });
  }
  try {
    request.usuario = verificarToken(token);
  } catch {
    return reply.status(401).send({ erro: "Sessão inválida ou expirada." });
  }
}

export function requireRole(perfis: JwtPayload["perfil"][]) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.usuario) {
      return reply.status(401).send({ erro: "Não autenticado." });
    }
    if (!perfis.includes(request.usuario.perfil)) {
      return reply.status(403).send({ erro: "Perfil sem permissão para este recurso." });
    }
  };
}

export interface UsuarioSessao {
  perfil: JwtPayload["perfil"];
  setorId: string | null;
}

// RN-RES-07 (S7): Admin aprova/rejeita/altera status de reserva de qualquer setor;
// Gestor de Setor só atua em reservas do próprio setor; Colaborador nunca chega aqui
// (bloqueado por requireRole nas rotas de aprovação antes desta checagem).
export function usuarioNoEscopoDaReserva(usuario: UsuarioSessao, setorReservaId: string): boolean {
  return usuario.perfil === "admin" || usuario.setorId === setorReservaId;
}

// Aprovação de reservas (aprovar/rejeitar/decidir substituição por urgência): Admin e Gestor
// são aprovadores GLOBAIS — o setor do Gestor não limita esta capacidade. É deliberadamente
// uma regra à parte de usuarioNoEscopoDaReserva, que continua valendo para as demais ações
// do Gestor (alterar status, cancelar etc.); só o escopo de APROVAÇÃO deixou de ser por setor.
export const PERFIS_APROVADORES: JwtPayload["perfil"][] = ["admin", "gestor_setor"];

export function podeDecidirAprovacao(usuario: Pick<UsuarioSessao, "perfil">): boolean {
  return PERFIS_APROVADORES.includes(usuario.perfil);
}

// Autor-ou-admin: regra de edição/exclusão de recursos "pessoais" (hoje só Comentário).
// Diferente de usuarioNoEscopoDaReserva (escopo por SETOR, usado para leitura/criação), aqui a
// comparação é por AUTORIA individual — qualquer colega do setor pode comentar e ler, mas só
// quem escreveu (ou um admin) pode editar/excluir.
export function usuarioEhAutorOuAdmin(usuario: Pick<JwtPayload, "perfil" | "sub">, autorId: string): boolean {
  return usuario.perfil === "admin" || usuario.sub === autorId;
}
