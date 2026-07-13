import { describe, expect, it, vi } from "vitest";
import type { FastifyReply } from "fastify";
import {
  contarClientesConectados,
  publicarEventoGlobal,
  publicarEventoUsuario,
  registrarClienteSSE,
  removerClienteSSE,
} from "../../services/eventos.service.js";

function criarReplyFake(): FastifyReply {
  return { raw: { write: vi.fn() } } as unknown as FastifyReply;
}

describe("eventos.service — pub/sub SSE (S10, SDD §3.4)", () => {
  it("publicarEventoUsuario escreve apenas nos clientes do usuário-alvo", () => {
    const replyA = criarReplyFake();
    const replyB = criarReplyFake();
    const idA = registrarClienteSSE("USR-A", replyA);
    const idB = registrarClienteSSE("USR-B", replyB);

    publicarEventoUsuario("USR-A", "notificacao.nova", { foo: "bar" });

    expect(replyA.raw.write).toHaveBeenCalledTimes(1);
    expect(replyA.raw.write).toHaveBeenCalledWith(expect.stringContaining("event: notificacao.nova"));
    expect(replyA.raw.write).toHaveBeenCalledWith(expect.stringContaining(`data: {"foo":"bar"}`));
    expect(replyB.raw.write).not.toHaveBeenCalled();

    removerClienteSSE(idA);
    removerClienteSSE(idB);
  });

  it("publicarEventoGlobal escreve em todos os clientes conectados, inclusive dispositivos (usuarioId null — Painel TV)", () => {
    const replyUsuario = criarReplyFake();
    const replyDispositivo = criarReplyFake();
    const id1 = registrarClienteSSE("USR-X", replyUsuario);
    const id2 = registrarClienteSSE(null, replyDispositivo);

    publicarEventoGlobal("plataforma.status_alterado", { id: "PLAT-1", status: "manutencao" });

    expect(replyUsuario.raw.write).toHaveBeenCalledTimes(1);
    expect(replyDispositivo.raw.write).toHaveBeenCalledTimes(1);

    removerClienteSSE(id1);
    removerClienteSSE(id2);
  });

  it("removerClienteSSE interrompe o recebimento de eventos após a remoção", () => {
    const reply = criarReplyFake();
    const id = registrarClienteSSE("USR-Y", reply);
    removerClienteSSE(id);

    publicarEventoUsuario("USR-Y", "reserva.aprovada", {});

    expect(reply.raw.write).not.toHaveBeenCalled();
  });

  it("contarClientesConectados reflete os registros e remoções", () => {
    const antes = contarClientesConectados();
    const reply = criarReplyFake();
    const id = registrarClienteSSE("USR-Z", reply);

    expect(contarClientesConectados()).toBe(antes + 1);

    removerClienteSSE(id);
    expect(contarClientesConectados()).toBe(antes);
  });
});
