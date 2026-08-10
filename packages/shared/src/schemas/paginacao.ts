import { z } from "zod";

// Paginação das rotas de listagem (pendência registrada desde S3: "GET /reservas não
// pagina resultados"). Sem limite, uma tabela com milhares de reservas era serializada
// inteira a cada troca de filtro — custo de banco, de rede e de renderização.
//
// Contrato deliberadamente aditivo: o corpo da resposta continua sendo o array de itens
// (nenhum cliente existente quebra) e os metadados vão em headers:
//   X-Total-Count  — total de registros que satisfazem o filtro, ignorando a paginação
//   X-Limit / X-Offset — janela efetivamente aplicada
// O teto de LIMITE_MAXIMO existe para que nenhuma requisição consiga pedir a tabela toda.
export const LIMITE_PADRAO = 500;
export const LIMITE_MAXIMO = 500;

export const paginacaoQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(LIMITE_MAXIMO).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type PaginacaoQuery = z.infer<typeof paginacaoQuerySchema>;

export interface JanelaPaginacao {
  limit: number;
  offset: number;
}

export function resolverPaginacao(query: PaginacaoQuery): JanelaPaginacao {
  return {
    limit: Math.min(query.limit ?? LIMITE_PADRAO, LIMITE_MAXIMO),
    offset: query.offset ?? 0,
  };
}
