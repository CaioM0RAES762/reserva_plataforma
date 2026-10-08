import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/* Categorias administráveis, Marca e galeria de até 4 imagens (migrations 0025/0026).
 * Armazenamento REAL (pasta local): o setup global dos testes aponta STORAGE_ROOT para uma
 * pasta temporária, então aqui se confere o disco de verdade — arquivo criado, trocado e
 * removido junto com o banco. */

const { buildApp } = await import("../../app.js");
const { armazenamentoService, raizDoArmazenamento } = await import("../../services/storage.service.js");
const { closePool, getPool, sql } = await import("../../db/pool.js");
const { criarUsuarioTeste, limparResiduos } = await import("../helpers/agendaFixtures.js");

const PREFIXOS = { plataforma: "PLT-CMI", email: "teste.cmi.", bloqueio: "CMI" };
const SUFIXO = String(Date.now()).slice(-6);
const NOME_CATEGORIA = `Empilhadeira ${SUFIXO}`;

const PNG = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64")}`;
const JPG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]).toString("base64")}`;
const WEBP = `data:image/webp;base64,${Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]).toString("base64")}`;
const GIF = `data:image/gif;base64,${Buffer.from("GIF89a-teste").toString("base64")}`;

type Usuario = Awaited<ReturnType<typeof criarUsuarioTeste>>;
interface Imagem {
  id: string;
  url: string | null;
  ordem: number;
  principal: boolean;
}

let app: FastifyInstance;
let admin: Usuario;
let gestor: Usuario;
let colaborador: Usuario;
let categoria: { id: string; codigo: string; nome: string; ativo: boolean };
let plataformaId: string;

function req(
  usuario: Usuario,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: Record<string, unknown>
) {
  return app.inject({ method, url, headers: { cookie: usuario.cookie }, ...(payload !== undefined ? { payload } : {}) });
}

// Setor responsável (migration 0030): obrigatório quando o Admin cadastra/edita.
let setorResponsavelId: string;

function plataformaBase(codigo: string, extra: Record<string, unknown> = {}) {
  return {
    codigo,
    nome: `Plataforma ${codigo}`,
    inicioAutomaticoPadrao: true,
    fimAutomaticoPadrao: true,
    setorId: setorResponsavelId,
    ...extra,
  };
}

async function auditoria(acao: string, entidadeId: string): Promise<Array<{ detalhes: string }>> {
  const pool = await getPool();
  const r = await pool
    .request()
    .input("acao", sql.VarChar, acao)
    .input("id", sql.UniqueIdentifier, entidadeId)
    .query<{ detalhes: string }>("SELECT detalhes FROM LogAuditoria WHERE acao = @acao AND entidade_id = @id");
  return r.recordset;
}

async function limparCategoriasDeTeste() {
  const pool = await getPool();
  await pool.request().input("sufixo", sql.NVarChar, `%${SUFIXO}%`).query(
    `DELETE FROM LogAuditoria WHERE entidade = 'CategoriaEquipamento'
       AND entidade_id IN (SELECT id FROM CategoriaEquipamento WHERE nome LIKE @sufixo);
     DELETE FROM CategoriaEquipamento WHERE nome LIKE @sufixo;`
  );
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await limparResiduos(PREFIXOS);
  setorResponsavelId = (await (await getPool()).request().query<{ id: string }>("SELECT TOP 1 id FROM Setor WHERE ativo = 1"))
    .recordset[0].id;
  admin = await criarUsuarioTeste({ email: `${PREFIXOS.email}admin@metalsider.com.br`, nome: "Admin (cmi)", perfil: "admin", setorId: null });
  gestor = await criarUsuarioTeste({ email: `${PREFIXOS.email}gestor@metalsider.com.br`, nome: "Gestor (cmi)", perfil: "gestor_setor", setorId: null });
  colaborador = await criarUsuarioTeste({ email: `${PREFIXOS.email}colab@metalsider.com.br`, nome: "Colab (cmi)", perfil: "colaborador", setorId: null });
});

afterAll(async () => {
  await limparResiduos(PREFIXOS);
  await limparCategoriasDeTeste();
  await app.close();
  await closePool();
});

describe("Categorias de equipamento", () => {
  it("migration 0026: Andaime, Veículo, Sala, Pátio e Outro foram REMOVIDAS; Plataforma elevatória permanece", async () => {
    const r = await req(colaborador, "GET", "/api/v1/categorias-equipamento");
    expect(r.statusCode).toBe(200);
    const lista = r.json() as Array<{ codigo: string; nome: string }>;
    expect(lista.find((c) => c.codigo === "elevatoria")?.nome).toBe("Plataforma elevatória");
    for (const removida of ["andaime", "veiculo", "sala", "patio", "outro"]) {
      expect(lista.some((c) => c.codigo === removida)).toBe(false);
    }
    // Direto no banco: removidas de fato (não inativas), nenhuma plataforma com FK órfã e o
    // DEFAULT da coluna aponta para uma categoria que existe.
    const pool = await getPool();
    const banco = await pool.request().query<{ removidas: number; orfas: number; padrao: string }>(
      `SELECT
         (SELECT COUNT(*) FROM CategoriaEquipamento WHERE codigo IN ('andaime','veiculo','sala','patio','outro')) AS removidas,
         (SELECT COUNT(*) FROM Plataforma p WHERE NOT EXISTS (SELECT 1 FROM CategoriaEquipamento c WHERE c.codigo = p.categoria)) AS orfas,
         (SELECT dc.definition FROM sys.default_constraints dc
            JOIN sys.columns col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id
           WHERE dc.parent_object_id = OBJECT_ID('Plataforma') AND col.name = 'categoria') AS padrao`
    );
    expect(banco.recordset[0]).toEqual({ removidas: 0, orfas: 0, padrao: "('elevatoria')" });
  });

  it("categoria removida não pode mais ser usada; sem categoria no corpo vale 'elevatoria'", async () => {
    expect((await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-6", { categoria: "outro" }))).statusCode).toBe(422);
    const semCategoria = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-6"));
    expect(semCategoria.statusCode).toBe(201);
    expect(semCategoria.json().categoria).toBe("elevatoria");
  });

  it("Admin cria 'Empilhadeira' e ela fica disponível (ativa) para novos cadastros", async () => {
    const r = await req(admin, "POST", "/api/v1/categorias-equipamento", { nome: NOME_CATEGORIA });
    expect(r.statusCode).toBe(201);
    categoria = r.json();
    expect(categoria.nome).toBe(NOME_CATEGORIA);
    expect(categoria.ativo).toBe(true);
    expect(categoria.codigo).toBe(`empilhadeira_${SUFIXO}`);
    const lista = (await req(admin, "GET", "/api/v1/categorias-equipamento")).json() as Array<{ id: string; ativo: boolean }>;
    expect(lista.find((c) => c.id === categoria.id)?.ativo).toBe(true);
    expect(await auditoria("criar_categoria_equipamento", categoria.id)).toHaveLength(1);
  });

  it("nome duplicado é recusado (409)", async () => {
    const r = await req(admin, "POST", "/api/v1/categorias-equipamento", { nome: NOME_CATEGORIA.toUpperCase() });
    expect(r.statusCode).toBe(409);
  });

  it("Gestor e Colaborador não alteram categorias — 403 também na API", async () => {
    for (const usuario of [gestor, colaborador]) {
      expect((await req(usuario, "POST", "/api/v1/categorias-equipamento", { nome: `Invasora ${SUFIXO}` })).statusCode).toBe(403);
      expect((await req(usuario, "PUT", `/api/v1/categorias-equipamento/${categoria.id}`, { ativo: false })).statusCode).toBe(403);
    }
  });

  it("plataforma criada com a categoria nova e Marca 'Dingli'", async () => {
    const r = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-1", { categoria: categoria.codigo, marca: "Dingli" }));
    expect(r.statusCode).toBe(201);
    const p = r.json();
    plataformaId = p.id;
    expect(p.categoria).toBe(categoria.codigo);
    expect(p.categoriaNome).toBe(NOME_CATEGORIA);
    expect(p.marca).toBe("Dingli");
    expect(p.risco).toBe("baixo");
    expect(p.imagens).toEqual([]);
    expect(p.imagemUrl).toBeNull();
  });

  it("Admin renomeia (código não muda) e a plataforma passa a mostrar o nome novo", async () => {
    const novoNome = `Empilhadeira elétrica ${SUFIXO}`;
    const r = await req(admin, "PUT", `/api/v1/categorias-equipamento/${categoria.id}`, { nome: novoNome });
    expect(r.statusCode).toBe(200);
    expect(r.json().codigo).toBe(categoria.codigo);
    const lista = (await req(admin, "GET", "/api/v1/plataformas?q=PLT-CMI-1")).json() as Array<{ categoriaNome: string }>;
    expect(lista[0].categoriaNome).toBe(novoNome);
    expect(await auditoria("editar_categoria_equipamento", categoria.id)).toHaveLength(1);
    categoria = r.json();
  });

  it("desativada: some dos novos cadastros, mas a plataforma antiga continua com ela", async () => {
    const r = await req(admin, "PUT", `/api/v1/categorias-equipamento/${categoria.id}`, { ativo: false });
    expect(r.statusCode).toBe(200);
    expect(r.json().ativo).toBe(false);
    expect(r.json().emUso).toBe(1);
    expect(await auditoria("desativar_categoria_equipamento", categoria.id)).toHaveLength(1);

    const nova = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-2", { categoria: categoria.codigo }));
    expect(nova.statusCode).toBe(422);

    const lista = (await req(colaborador, "GET", "/api/v1/plataformas?q=PLT-CMI-1")).json() as Array<{
      categoria: string;
      categoriaNome: string;
      categoriaAtiva: boolean;
    }>;
    expect(lista[0]).toMatchObject({ categoria: categoria.codigo, categoriaNome: categoria.nome, categoriaAtiva: false });
  });

  it("editar a plataforma antiga mantendo a categoria inativa é permitido; Marca Dingli → JLG é auditada", async () => {
    const r = await req(admin, "PUT", `/api/v1/plataformas/${plataformaId}`, plataformaBase("PLT-CMI-1", { categoria: categoria.codigo, marca: "JLG" }));
    expect(r.statusCode).toBe(200);
    expect(r.json().marca).toBe("JLG");
    const registros = await auditoria("alterar_marca_plataforma", plataformaId);
    expect(registros).toHaveLength(1);
    expect(JSON.parse(registros[0].detalhes)).toMatchObject({ marcaAnterior: "Dingli", marcaNova: "JLG" });
  });

  it("categoria inexistente é recusada", async () => {
    const r = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-3", { categoria: "nao_existe" }));
    expect(r.statusCode).toBe(422);
  });
});

describe("Excluir categoria", () => {
  it("só Admin exclui (Gestor/Colaborador 403)", async () => {
    for (const usuario of [gestor, colaborador]) {
      expect((await req(usuario, "DELETE", `/api/v1/categorias-equipamento/${categoria.id}`)).statusCode).toBe(403);
    }
  });

  it("categoria em uso não é excluída (409) — continua existindo", async () => {
    const r = await req(admin, "DELETE", `/api/v1/categorias-equipamento/${categoria.id}`);
    expect(r.statusCode).toBe(409);
    const lista = (await req(admin, "GET", "/api/v1/categorias-equipamento")).json() as Array<{ id: string }>;
    expect(lista.some((c) => c.id === categoria.id)).toBe(true);
  });

  it("categoria sem plataformas é removida de fato e auditada", async () => {
    const criada = await req(admin, "POST", "/api/v1/categorias-equipamento", { nome: `Guindaste ${SUFIXO}` });
    expect(criada.statusCode).toBe(201);
    const id = criada.json().id as string;
    expect((await req(admin, "DELETE", `/api/v1/categorias-equipamento/${id}`)).statusCode).toBe(204);
    const lista = (await req(admin, "GET", "/api/v1/categorias-equipamento")).json() as Array<{ id: string }>;
    expect(lista.some((c) => c.id === id)).toBe(false);
    expect(await auditoria("excluir_categoria_equipamento", id)).toHaveLength(1);
  });
});

describe("Marca", () => {
  it("é opcional: plataforma sem marca continua válida (marca null)", async () => {
    const r = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-4", { categoria: "elevatoria" }));
    expect(r.statusCode).toBe(201);
    expect(r.json().marca).toBeNull();
  });

  it("entra na busca da Frota", async () => {
    const r = await req(colaborador, "GET", "/api/v1/plataformas?q=JLG");
    const codigos = (r.json() as Array<{ codigo: string }>).map((p) => p.codigo);
    expect(codigos).toContain("PLT-CMI-1");
    expect(codigos).not.toContain("PLT-CMI-4");
  });
});

describe("Galeria — até 4 imagens", () => {
  const base = () => `/api/v1/plataformas/${plataformaId}/imagens`;
  const ids = (imagens: Imagem[]) => imagens.map((i) => i.id);
  let enviadas: string[] = [];

  // Arquivos físicos da plataforma na pasta de armazenamento.
  async function arquivosNoDisco(): Promise<string[]> {
    try {
      return await readdir(join(raizDoArmazenamento(), "plataformas", plataformaId.toLowerCase()));
    } catch {
      return [];
    }
  }
  // Chaves gravadas no banco, na ordem da galeria.
  async function chavesNoBanco(): Promise<string[]> {
    const pool = await getPool();
    const r = await pool
      .request()
      .input("id", sql.UniqueIdentifier, plataformaId)
      .query<{ blob_path: string }>("SELECT blob_path FROM PlataformaImagem WHERE plataforma_id = @id ORDER BY ordem");
    return r.recordset.map((l) => l.blob_path);
  }

  it("formato fora de JPG/PNG/WEBP é recusado antes de gravar (422)", async () => {
    const r = await req(admin, "POST", base(), { imagemBase64: GIF });
    expect(r.statusCode).toBe(422);
    expect(r.json().erro).toContain("JPEG, PNG, WEBP");
    expect(await arquivosNoDisco()).toHaveLength(0);
  });

  it("Gestor não gerencia imagens (403)", async () => {
    expect((await req(gestor, "POST", base(), { imagemBase64: PNG })).statusCode).toBe(403);
  });

  it("1ª imagem vira principal; 4 persistem em ordem 0..3", async () => {
    let imagens: Imagem[] = [];
    for (const img of [PNG, JPG, WEBP, PNG]) {
      const r = await req(admin, "POST", base(), { imagemBase64: img });
      expect(r.statusCode).toBe(201);
      imagens = r.json().imagens;
    }
    expect(imagens.map((i) => i.ordem)).toEqual([0, 1, 2, 3]);
    expect(imagens.map((i) => i.principal)).toEqual([true, false, false, false]);
    enviadas = ids(imagens);
    const p = (await req(colaborador, "GET", "/api/v1/plataformas?q=PLT-CMI-1")).json()[0];
    expect(ids(p.imagens)).toEqual(enviadas);
    // imagemUrl (capa) é derivada da principal — não é uma segunda fonte.
    expect(p.imagemUrl).toBe(p.imagens[0].url);
    expect(await auditoria("adicionar_imagem_plataforma", plataformaId)).toHaveLength(4);
    // Banco guarda chave RELATIVA com nome gerado (uuid + extensão do tipo real), e os 4
    // arquivos existem na pasta local.
    const chaves = await chavesNoBanco();
    for (const chave of chaves) {
      expect(chave).toMatch(new RegExp(`^plataformas/${plataformaId.toLowerCase()}/[0-9a-f-]{36}\\.(png|jpg|webp)$`));
      expect(await armazenamentoService.existeArquivo(chave)).toBe(true);
    }
    expect(await arquivosNoDisco()).toHaveLength(4);
  });

  it("card/carrossel/lightbox: a URL de cada imagem é servida pela API com o tipo correto", async () => {
    const p = (await req(colaborador, "GET", "/api/v1/plataformas?q=PLT-CMI-1")).json()[0];
    const tipos: string[] = [];
    for (const img of p.imagens as Imagem[]) {
      expect(img.url).toMatch(/^\/api\/v1\/arquivos\//);
      const arquivo = await app.inject({ method: "GET", url: img.url! });
      expect(arquivo.statusCode).toBe(200);
      tipos.push(String(arquivo.headers["content-type"]));
    }
    expect(tipos).toEqual(["image/png", "image/jpeg", "image/webp", "image/png"]);
  });

  it("a 5ª é bloqueada com 'Limite de 4 imagens atingido.' e nada é gravado no storage", async () => {
    const r = await req(admin, "POST", base(), { imagemBase64: PNG });
    expect(r.statusCode).toBe(409);
    expect(r.json().erro).toBe("Limite de 4 imagens atingido.");
    expect(await arquivosNoDisco()).toHaveLength(4);
  });

  it("tornar principal leva a imagem para a capa e mantém a ordem relativa das demais", async () => {
    const [a, b, c, d] = enviadas;
    const r = await req(admin, "PATCH", `${base()}/${c}/principal`);
    expect(r.statusCode).toBe(200);
    const imagens: Imagem[] = r.json().imagens;
    expect(ids(imagens)).toEqual([c, a, b, d]);
    expect(imagens.map((i) => i.principal)).toEqual([true, false, false, false]);
    expect(await auditoria("definir_imagem_principal", plataformaId)).toHaveLength(1);
    enviadas = ids(imagens);
  });

  it("substituir mantém posição e papel, e apaga o arquivo antigo do disco", async () => {
    const alvo = enviadas[1];
    const chaveAntiga = (await chavesNoBanco())[1];
    const r = await req(admin, "PUT", `${base()}/${alvo}`, { imagemBase64: JPG });
    expect(r.statusCode).toBe(200);
    const imagens: Imagem[] = r.json().imagens;
    expect(ids(imagens)).toEqual(enviadas);
    const chaveNova = (await chavesNoBanco())[1];
    expect(chaveNova).not.toBe(chaveAntiga);
    expect(await armazenamentoService.existeArquivo(chaveNova)).toBe(true);
    expect(await armazenamentoService.existeArquivo(chaveAntiga)).toBe(false);
    expect(await arquivosNoDisco()).toHaveLength(4);
  });

  it("remover a principal: a seguinte assume a capa, ordem continua 0..n-1 e o arquivo sai do disco", async () => {
    const [principal, segunda, terceira, quarta] = enviadas;
    const chaveRemovida = (await chavesNoBanco())[0];
    const r = await req(admin, "DELETE", `${base()}/${principal}`);
    expect(r.statusCode).toBe(200);
    const imagens: Imagem[] = r.json().imagens;
    expect(ids(imagens)).toEqual([segunda, terceira, quarta]);
    expect(imagens.map((i) => i.ordem)).toEqual([0, 1, 2]);
    expect(imagens.map((i) => i.principal)).toEqual([true, false, false]);
    // Banco e disco consistentes: 3 chaves, 3 arquivos, a removida não existe mais.
    expect(await armazenamentoService.existeArquivo(chaveRemovida)).toBe(false);
    const chaves = await chavesNoBanco();
    expect(chaves).toHaveLength(3);
    expect((await arquivosNoDisco()).sort()).toEqual(chaves.map((c) => c.split("/").pop()).sort());
    const registro = await auditoria("remover_imagem_plataforma", plataformaId);
    expect(JSON.parse(registro[0].detalhes)).toMatchObject({ eraPrincipal: true });
    enviadas = ids(imagens);
  });

  it("depois de remover, cabe de novo uma 4ª (vai para o fim)", async () => {
    const r = await req(admin, "POST", base(), { imagemBase64: WEBP });
    expect(r.statusCode).toBe(201);
    const imagens: Imagem[] = r.json().imagens;
    expect(imagens).toHaveLength(4);
    expect(ids(imagens).slice(0, 3)).toEqual(enviadas);
    expect(imagens[3].ordem).toBe(3);
  });

  it("imagem de outra plataforma / inexistente: 404", async () => {
    const r = await req(admin, "DELETE", `${base()}/00000000-0000-0000-0000-000000000000`);
    expect(r.statusCode).toBe(404);
  });

  it("editar os dados da plataforma não mexe na galeria", async () => {
    const antes = (await req(admin, "GET", "/api/v1/plataformas?q=PLT-CMI-1")).json()[0].imagens as Imagem[];
    const r = await req(admin, "PUT", `/api/v1/plataformas/${plataformaId}`, plataformaBase("PLT-CMI-1", { categoria: categoria.codigo, marca: "JLG" }));
    expect(r.statusCode).toBe(200);
    expect(ids(r.json().imagens)).toEqual(ids(antes));
  });
});

describe("Compatibilidade com a imagem única antiga", () => {
  it("a imagem migrada (ordem 0, principal) aparece como imagemUrl e como 1ª da galeria", async () => {
    const pool = await getPool();
    const criada = await req(admin, "POST", "/api/v1/plataformas", plataformaBase("PLT-CMI-5", { categoria: "elevatoria" }));
    const id = criada.json().id as string;
    // Mesmo INSERT que a migration 0025 faz a partir de Plataforma.imagem_url.
    await pool
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query("INSERT INTO PlataformaImagem (plataforma_id, blob_path, ordem, principal) VALUES (@id, 'plataformas/legado/foto.jpg', 0, 1)");
    const p = (await req(colaborador, "GET", "/api/v1/plataformas?q=PLT-CMI-5")).json()[0];
    expect(p.imagens).toHaveLength(1);
    expect(p.imagens[0].principal).toBe(true);
    // URL de leitura assinada gerada da chave migrada — nenhum reenvio necessário.
    expect(p.imagemUrl).toContain("plataformas/legado/foto.jpg");
  });
});
