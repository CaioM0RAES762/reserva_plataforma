import { afterEach, describe, expect, it, vi } from "vitest";
import { enfileirarEmail } from "../../services/queue.js";
import {
  despacharEmailsDeNotificacoes,
  type EnfileirarEmail,
  type NotificacaoRegistrada,
} from "../../services/notificacao.service.js";
import { templateNotificacaoReserva } from "../../services/email.service.js";

/* Canal e-mail das notificações de reserva. A entrega real (SMTP/Graph) não é exercitada
 * aqui — depende de credenciais e envia para caixas reais; o que se garante é: quem recebe,
 * com qual endereço, qual conteúdo, e que falha de e-mail nunca propaga. */

function notificacao(tipo: NotificacaoRegistrada["tipo"], usuarioId: string, extra: Partial<NotificacaoRegistrada> = {}) {
  return {
    id: `n-${tipo}-${usuarioId}`,
    usuarioId,
    tipo,
    titulo: "Reserva aprovada",
    mensagem: "Sua reserva de PLT-01 em 2026-09-24 (10:00–11:00) foi aprovada.",
    link: "/reservas",
    lida: false,
    criadoEm: new Date().toISOString(),
    ...extra,
  } satisfies NotificacaoRegistrada;
}

const EMAILS = new Map([
  ["user-a", "colaborador.a@metalsider.com.br"],
  ["user-b", "gestor.b@metalsider.com.br"],
]);
const buscarEmails = async (ids: string[]) => new Map(ids.filter((id) => EMAILS.has(id)).map((id) => [id, EMAILS.get(id)!]));

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WEB_APP_URL;
});

describe("setup global de testes", () => {
  it("a fila BullMQ de e-mail nunca é usada de verdade nos testes", () => {
    expect(vi.isMockFunction(enfileirarEmail)).toBe(true);
  });
});

describe("despacharEmailsDeNotificacoes", () => {
  it("enfileira para o e-mail CADASTRADO do usuário, com o conteúdo da notificação", async () => {
    const enfileirar = vi.fn<EnfileirarEmail>(async () => {});
    await despacharEmailsDeNotificacoes([notificacao("reserva_aprovada", "user-a")], { enfileirar, buscarEmails });
    expect(enfileirar).toHaveBeenCalledTimes(1);
    const [dados] = enfileirar.mock.calls[0];
    expect(dados.destinatario).toBe("colaborador.a@metalsider.com.br");
    expect(dados.assunto).toBe("PlataformaRes — Reserva aprovada");
    expect(dados.corpoHtml).toContain("foi aprovada");
    expect(dados.corpoTexto).toContain("foi aprovada");
  });

  it("todos os eventos de reserva relevantes vão por e-mail; os demais ficam só no sino", async () => {
    const enfileirar = vi.fn<EnfileirarEmail>(async () => {});
    await despacharEmailsDeNotificacoes(
      [
        notificacao("reserva_pendente", "user-b"),
        notificacao("reserva_aprovada", "user-a"),
        notificacao("reserva_rejeitada", "user-a"),
        notificacao("reserva_substituida", "user-a"),
        notificacao("reserva_cancelada", "user-a"),
        notificacao("comentario_novo", "user-a"),
      ],
      { enfileirar, buscarEmails }
    );
    expect(enfileirar).toHaveBeenCalledTimes(5);
  });

  it("usuário sem e-mail cadastrado: não envia, registra o motivo e não quebra", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const enfileirar = vi.fn<EnfileirarEmail>(async () => {});
    await despacharEmailsDeNotificacoes([notificacao("reserva_rejeitada", "sem-email")], { enfileirar, buscarEmails });
    expect(enfileirar).not.toHaveBeenCalled();
    expect(aviso.mock.calls[0][0]).toContain("sem-email notificationType=reserva_rejeitada userId=sem-email");
  });

  it("falha ao enfileirar (Redis fora) é logada e NÃO propaga — a operação de reserva segue", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const enfileirar = vi.fn<EnfileirarEmail>(async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    });
    await expect(
      despacharEmailsDeNotificacoes(
        [notificacao("reserva_aprovada", "user-a"), notificacao("reserva_substituida", "user-b")],
        { enfileirar, buscarEmails }
      )
    ).resolves.toBeUndefined();
    // Tentou os dois: a falha do primeiro não impediu o segundo.
    expect(enfileirar).toHaveBeenCalledTimes(2);
    expect(erro.mock.calls[0][0]).toContain("falha-enfileirar notificationType=reserva_aprovada");
  });

  it("log de sucesso identifica tipo, usuário e só o DOMÍNIO do destinatário", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await despacharEmailsDeNotificacoes([notificacao("reserva_aprovada", "user-a")], {
      enfileirar: async () => {},
      buscarEmails,
    });
    const linha = String(info.mock.calls[0][0]);
    expect(linha).toContain("enfileirado notificationType=reserva_aprovada userId=user-a domain=metalsider.com.br");
    expect(linha).not.toContain("colaborador.a@");
  });
});

describe("templateNotificacaoReserva", () => {
  it("escapa texto digitado por usuário (ex.: motivo de rejeição)", () => {
    const { corpoHtml } = templateNotificacaoReserva({
      titulo: "Reserva rejeitada",
      mensagem: 'Motivo: <script>alert("x")</script>',
      link: null,
    });
    expect(corpoHtml).not.toContain("<script>");
    expect(corpoHtml).toContain("&lt;script&gt;");
  });

  it("monta o link absoluto a partir de WEB_APP_URL; sem URL configurada, sai sem link", () => {
    process.env.WEB_APP_URL = "https://plataformares.metalsider.com.br/";
    expect(templateNotificacaoReserva({ titulo: "T", mensagem: "M", link: "/reservas?status=pendente" }).corpoHtml).toContain(
      'href="https://plataformares.metalsider.com.br/reservas?status=pendente"'
    );
    delete process.env.WEB_APP_URL;
    const semBase = { ...process.env };
    delete process.env.WEB_ALLOWED_ORIGINS;
    expect(templateNotificacaoReserva({ titulo: "T", mensagem: "M", link: "/reservas" }).corpoHtml).not.toContain("href=");
    Object.assign(process.env, semBase);
  });
});
