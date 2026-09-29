import type { FastifyInstance } from "fastify";
import {
  ArquivoNaoEncontradoError,
  armazenamentoService,
  chaveValida,
  validarUrlDeLeitura,
} from "../services/storage.service.js";

/* Única forma de o navegador ler um arquivo enviado (imagens de plataforma, anexos, imagens de
 * comentário/não conformidade, fotos de checklist). A URL vem pronta das listagens da API
 * (urlDeLeitura): assinada e com validade de até 1 hora — quem a recebeu já passou pela
 * autorização da rota que listou o recurso. O cliente nunca informa caminho físico: a chave é
 * validada contra ../, caminho absoluto e caracteres fora do padrão antes de qualquer I/O. */
export async function arquivosRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/arquivos/*", async (request, reply) => {
    const chave = (request.params as { "*": string })["*"];
    const { exp, sig } = request.query as { exp?: string; sig?: string };

    if (!chaveValida(chave)) {
      return reply.status(400).send({ erro: "Identificador de arquivo inválido." });
    }
    const validadeRestante = validarUrlDeLeitura(chave, exp, sig);
    if (validadeRestante === null) {
      return reply.status(403).send({ erro: "Link do arquivo inválido ou expirado. Recarregue a página." });
    }

    try {
      const arquivo = await armazenamentoService.lerArquivo(chave);
      return reply
        .header("Content-Type", arquivo.tipoMime)
        .header("Content-Length", arquivo.tamanhoBytes)
        // Exibe no navegador (imagem/PDF); o nome original fica com a tela que listou o arquivo.
        .header("Content-Disposition", "inline")
        .header("Cache-Control", `private, max-age=${validadeRestante}`)
        .header("X-Content-Type-Options", "nosniff")
        // O web encaminha /api/v1/arquivos/* para cá: a imagem é sempre "da mesma origem" para a
        // página, mas quem acessar a API direto também precisa conseguir exibir.
        .header("Cross-Origin-Resource-Policy", "same-site")
        .send(arquivo.conteudo);
    } catch (erro) {
      if (erro instanceof ArquivoNaoEncontradoError) {
        return reply.status(404).send({ erro: "Arquivo não encontrado." });
      }
      throw erro;
    }
  });
}
