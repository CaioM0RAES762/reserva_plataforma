import type { FastifyInstance } from "fastify";
import { disponibilidadeQuerySchema, proximoHorarioQuerySchema } from "@plataformares/shared";
import { autenticar } from "../middlewares/rbac.js";
import {
  buscarProximoHorario,
  consultarDisponibilidadeDia,
  dataCivilValida,
} from "../services/disponibilidadeDia.service.js";

// Leitura agregada de disponibilidade para Calendário, timeline "Disponibilidade" e Nova
// Reserva. Qualquer perfil autenticado consulta — a agenda de ocupação já é pública entre
// setores (a mensagem de conflito do POST expõe o setor da reserva concorrente); o que NÃO é
// público, o motivo de uma reserva alheia, é mascarado pelo serviço, no servidor.
//
// É informativa: quem decide se um horário pode ser reservado continua sendo POST /reservas,
// com o lock de intervalo (services/disponibilidade.service.ts). Por isso as respostas saem
// com no-store — o cliente nunca deve tratar um horário "livre" cacheado como garantia.
export async function disponibilidadeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/disponibilidade", { preHandler: autenticar }, async (request, reply) => {
    const parsed = disponibilidadeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    // O regex do schema deixa passar 2026-02-31, que estouraria como erro 500 no driver.
    if (!dataCivilValida(parsed.data.data)) {
      return reply.status(422).send({
        erro: "Parâmetros inválidos.",
        detalhes: { formErrors: [], fieldErrors: { data: ["Data inválida."] } },
      });
    }

    const resposta = await consultarDisponibilidadeDia({
      data: parsed.data.data,
      plataformaId: parsed.data.plataformaId,
      usuario: { perfil: request.usuario!.perfil, setorId: request.usuario!.setorId },
    });
    if (!resposta) {
      return reply.status(404).send({ erro: "Plataforma não encontrada." });
    }
    return reply.header("Cache-Control", "no-store").status(200).send(resposta);
  });

  // "Ver próximo horário disponível": varre até `limiteDias` dias com uma consulta de reservas
  // e uma de bloqueios para o intervalo inteiro (não uma por dia).
  app.get("/api/v1/disponibilidade/proximo", { preHandler: autenticar }, async (request, reply) => {
    const parsed = proximoHorarioQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(422).send({ erro: "Parâmetros inválidos.", detalhes: parsed.error.flatten() });
    }
    if (!dataCivilValida(parsed.data.data)) {
      return reply.status(422).send({
        erro: "Parâmetros inválidos.",
        detalhes: { formErrors: [], fieldErrors: { data: ["Data inválida."] } },
      });
    }

    const resposta = await buscarProximoHorario(parsed.data);
    if (!resposta) {
      return reply.status(404).send({ erro: "Plataforma não encontrada." });
    }
    return reply.header("Cache-Control", "no-store").status(200).send(resposta);
  });
}
