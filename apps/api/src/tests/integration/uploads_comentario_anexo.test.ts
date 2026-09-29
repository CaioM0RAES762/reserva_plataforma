import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/* Uploads de comentário (imagem, inclusive de não conformidade) e anexo de reserva (PDF) no
 * armazenamento LOCAL: gravação, leitura pela URL devolvida, rejeição de arquivo inválido e
 * remoção do arquivo quando o comentário é excluído. Pasta temporária do setup global. */

const { buildApp } = await import("../../app.js");
const { closePool, getPool, sql } = await import("../../db/pool.js");
const { armazenamentoService } = await import("../../services/storage.service.js");
const {
  criarPlataformaTeste,
  criarUsuarioTeste,
  dataFuturaAleatoria,
  garantirSetor,
  inserirReservaTeste,
  limparResiduos,
  removerSetorSeCriado,
} = await import("../helpers/agendaFixtures.js");

const PREFIXOS = { plataforma: "PLT-UPL", email: "teste.upl.", bloqueio: "UPL" };
const PNG = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=`;
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF").toString("base64")}`;
const FALSO_PNG = `data:image/png;base64,${Buffer.from("isto nao e uma imagem").toString("base64")}`;

type Setor = Awaited<ReturnType<typeof garantirSetor>>;
type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;

let app: FastifyInstance;
let ti: Setor;
let colaborador: Usuario;
let reservaId: string;

function req(method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { cookie: colaborador.cookie }, ...(payload ? { payload } : {}) });
}

async function chavesDoComentario(comentarioId: string): Promise<string[]> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("id", sql.UniqueIdentifier, comentarioId)
    .query<{ url_blob: string }>("SELECT url_blob FROM ComentarioImagem WHERE comentario_id = @id");
  return r.recordset.map((l) => l.url_blob);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  ti = await garantirSetor("TI");
  colaborador = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab@metalsider.com.br`, nome: "Colab (upl)", perfil: "colaborador", setorId: ti.id });
  const plataformaId = await criarPlataformaTeste({ codigo: "PLT-UPL-1", nome: "Plataforma teste uploads" });
  reservaId = await inserirReservaTeste({
    setorId: ti.id,
    solicitanteId: colaborador.id,
    plataformaId,
    data: dataFuturaAleatoria(),
    horaInicio: "08:00",
    horaFim: "09:00",
    status: "agendada",
  });
});

afterAll(async () => {
  await limparResiduos(PREFIXOS);
  await removerSetorSeCriado(ti);
  await app.close();
  await closePool();
});

describe("comentário com imagem", () => {
  let comentarioId: string;

  it("upload grava no disco e a URL devolvida carrega a imagem", async () => {
    const r = await req("POST", `/api/v1/reservas/${reservaId}/comentarios`, {
      mensagem: "Foto do local",
      imagens: [{ nomeArquivo: "../../foto maliciosa.png", arquivoBase64: PNG }],
    });
    expect(r.statusCode).toBe(201);
    comentarioId = r.json().id;
    const [imagem] = r.json().imagens as Array<{ url: string; nomeArquivo: string }>;
    // O nome enviado é só rótulo: o arquivo físico tem nome gerado, na pasta da reserva.
    const [chave] = await chavesDoComentario(comentarioId);
    expect(chave).toMatch(new RegExp(`^reservas/${reservaId}/comentarios/[0-9a-f-]{36}\\.png$`, "i"));
    expect(await armazenamentoService.existeArquivo(chave)).toBe(true);
    const arquivo = await app.inject({ method: "GET", url: imagem.url });
    expect(arquivo.statusCode).toBe(200);
    expect(arquivo.headers["content-type"]).toBe("image/png");
  });

  it("arquivo que não é imagem continua sendo rejeitado (422) e nada fica no disco", async () => {
    const r = await req("POST", `/api/v1/reservas/${reservaId}/comentarios`, {
      mensagem: "Falso",
      imagens: [{ nomeArquivo: "falso.png", arquivoBase64: FALSO_PNG }],
    });
    expect(r.statusCode).toBe(422);
  });

  it("excluir o comentário remove o arquivo do disco", async () => {
    const [chave] = await chavesDoComentario(comentarioId);
    const r = await req("DELETE", `/api/v1/reservas/${reservaId}/comentarios/${comentarioId}`);
    expect(r.statusCode).toBeLessThan(300);
    expect(await armazenamentoService.existeArquivo(chave)).toBe(false);
  });
});

describe("anexo da reserva (PDF)", () => {
  it("upload de PDF grava no disco e a URL é lida como application/pdf", async () => {
    const r = await req("POST", `/api/v1/reservas/${reservaId}/anexos`, { nomeArquivo: "laudo.pdf", arquivoBase64: PDF });
    expect(r.statusCode).toBe(201);
    const anexo = r.json() as { url: string; nomeArquivo: string };
    expect(anexo.nomeArquivo).toBe("laudo.pdf");
    const arquivo = await app.inject({ method: "GET", url: anexo.url });
    expect(arquivo.statusCode).toBe(200);
    expect(arquivo.headers["content-type"]).toBe("application/pdf");
  });

  it("listagem de anexos devolve URL de leitura da própria aplicação", async () => {
    const r = await req("GET", `/api/v1/reservas/${reservaId}/anexos`);
    expect(r.statusCode).toBe(200);
    const [anexo] = r.json() as Array<{ url: string }>;
    expect(anexo.url).toMatch(/^\/api\/v1\/arquivos\/reservas\//);
  });

  it("conteúdo que não é imagem nem PDF é rejeitado (422)", async () => {
    const r = await req("POST", `/api/v1/reservas/${reservaId}/anexos`, {
      nomeArquivo: "script.pdf",
      arquivoBase64: `data:application/pdf;base64,${Buffer.from("<script>alert(1)</script>").toString("base64")}`,
    });
    expect(r.statusCode).toBe(422);
  });
});
