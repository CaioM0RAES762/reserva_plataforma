# Sprint S13 — Relatórios & Indicadores (BI)

| Campo | Valor |
|---|---|
| Sprint | S13 |
| Status | ✅ Concluída |
| Data | 2026-07-14 |
| Depende de | S9 (✅ Concluída, confirmado no início desta sessão), S11 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Feature nova da Fase 2 (Expansão) — módulo gerencial de indicadores com exportação |

## 1. Objetivo

Oferecer visibilidade gerencial sobre uso, aprovação e segurança das plataformas, com exportação em PDF/Excel — RF-REL-01 a RF-REL-06 (SDD §6.7).

## 2. O que foi implementado

### 2.1 Schema (migration `0011`)

- **`0011_indices_relatorios.sql`**: `IX_Reserva_status`, `IX_Reserva_criado_em` e `IX_Reserva_setor_data` (composto `setor_id, data`) em `Reserva` — `Reserva.data` já era indexada desde 0003/S5. Aplicada via `sqlcmd -C -f 65001` (o runner `migrate:up` não tem tabela de controle — pendência reafirmada desde S4/S9 — e tentaria recriar `0001_init.sql` do zero; aplicação direta é a prática já estabelecida nas sprints anteriores). `up`/`down`/`up` testados e confirmados via `sys.indexes` (Seção 4).

### 2.2 `packages/shared`

- `schemas/relatorio.ts` (novo): `relatorioQuerySchema` (`dateFrom`/`dateTo` obrigatórios, `setor` opcional), schemas de resposta dos 4 relatórios (`utilizacaoRespostaSchema`, `rankingSetoresRespostaSchema`, `slaAprovacaoRespostaSchema`, `segurancaRespostaSchema`) e `exportarRelatorioQuerySchema` (RF-REL-06).

### 2.3 `relatorio.service.ts` (novo) — agregações puras

Cada função de agregação é pura (sem I/O), recebendo linhas já buscadas do banco:

- `calcularUtilizacaoPlataformas` (RF-REL-01): horas disponíveis (tempo total do período **menos** união de bloqueios de agenda de S9, sem dupla contagem de bloqueios sobrepostos) menos horas em reservas `agendada`/`em_uso`/`concluida`, clipadas ao período.
- `calcularRankingSetores` (RF-REL-02): volume e taxa de rejeição por setor, ordenado por volume desc.
- `calcularTempoMedioAprovacaoHoras` (RF-REL-03): média de `criado_em → decisão final` em horas.
- `contarPorChave` (RF-REL-03/04): distribuição por status/prioridade/categoria, sempre na ordem fixa do enum (inclui chaves com quantidade 0).
- `calcularTendenciaMensal` (RF-REL-04): contagem por mês (`YYYY-MM`) em ordem cronológica.
- `calcularIndicadoresSeguranca` (RF-REL-05): % de checklists não conformes e ocorrências por plataforma/gravidade.

### 2.4 Cache Redis (`relatorioCache.service.ts`, novo)

`obterOuCalcularRelatorio` — chave `relatorio:{tipo}:{dateFrom}:{dateTo}:{setor|"global"}`, TTL 900s (15 min) via `ioredis` (mesmo padrão de conexão de `rateLimit.ts`, S1). TTL puro, sem invalidação ativa em escrita (conforme especificado no prompt da sprint). Cada rota expõe o resultado via header `X-Cache: HIT|MISS`, usado tanto pela evidência automatizada quanto pela evidência manual (Seção 4).

### 2.5 Exportação (`relatorioExport.service.ts`, novo)

- **Excel** via ExcelJS: uma planilha por relatório, cabeçalho estilizado, dados reais.
- **PDF** via Puppeteer (`headless: true`, HTML → PDF, A4): navegador é lançado e fechado por chamada de exportação — aceitável para uma rota de exportação pontual (não está sob o SLA de leitura de RNF-01), registrado como possível otimização futura (pool de browser) na Seção 6.

### 2.6 Rotas `relatorios.ts` (novo)

- `GET /api/v1/relatorios/utilizacao` — Admin (global) | Gestor de Setor (escopo do próprio setor).
- `GET /api/v1/relatorios/ranking-setores` — **Admin only** (SDD §6.7, RF-REL-02).
- `GET /api/v1/relatorios/sla-aprovacao` — Admin (global) | Gestor de Setor (escopo).
- `GET /api/v1/relatorios/seguranca` — **Admin only** (SDD §6.7, RF-REL-05 — ver ADR-01).
- `GET /api/v1/relatorios/export` — mesmo RBAC por `relatorio`, reaproveita o MESMO cache das rotas de leitura.

Escopo por setor: `resolverEscopoSetor` força o Gestor de Setor ao próprio `setor_id`, mesmo que a query envie `?setor=<outro>` (mesmo padrão de `montarWhereHistorico`, S5). Colaborador não acessa nenhuma rota de relatório (RBAC 403 — fora do escopo de perfis do SDD §6.7).

## 3. Testes obrigatórios — confirmação

### 3.1 Unitário — agregações contra fixture exato (`tests/unit/relatorio.test.ts`, novo, 11 testes)

Cada teste valida o **valor numérico exato**, não apenas "retorna algo" — inclui casos de bloqueio sobreposto (união sem dupla contagem), bloqueio clipado nas bordas do período, ordenação por volume, virada de ano na tendência mensal, e divisão por zero (0 reservas / 0 checklists). Output real:

```
✓ src/tests/unit/relatorio.test.ts (11 tests) 6ms

  ✓ calcularUtilizacaoPlataformas (RF-REL-01) > desconta bloqueio de agenda do tempo
    disponível e soma só reservas ocupando a plataforma (agendada/em_uso/concluida)
  ✓ calcularUtilizacaoPlataformas (RF-REL-01) > bloqueio global (plataformaId=null)
    desconta de TODAS as plataformas, sem contar duas vezes horas sobrepostas
  ✓ calcularUtilizacaoPlataformas (RF-REL-01) > bloqueio que ultrapassa os limites
    do período é clipado (não gera horasDisponiveis negativas)
  ✓ calcularRankingSetores (RF-REL-02) > calcula volume e taxa de rejeição exatos,
    ordenado por volume desc
  ✓ calcularTempoMedioAprovacaoHoras (RF-REL-03) > calcula a média exata em horas
  ✓ calcularTempoMedioAprovacaoHoras (RF-REL-03) > retorna null quando não há decisão
  ✓ contarPorChave — distribuição > conta cada status na ordem fixa do enum,
    incluindo chaves com quantidade 0
  ✓ calcularTendenciaMensal (RF-REL-04) > agrupa por mês em ordem cronológica ascendente
  ✓ calcularTendenciaMensal (RF-REL-04) > atravessa a virada de ano corretamente
  ✓ calcularIndicadoresSeguranca (RF-REL-05) > calcula o percentual exato e agrupa
    ocorrências por plataforma/gravidade
  ✓ calcularIndicadoresSeguranca (RF-REL-05) > retorna 0% quando não há checklist

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Exemplo do fixture do primeiro teste (asserção `toEqual` sobre o objeto completo): período de 48h (2 dias), bloqueio de 4h só na plataforma P1, reservas de 3h (`agendada`) + 1,5h (`concluida`) contando, 1h (`pendente`) e 1h (`rejeitada`) **não** contando → `horasDisponiveis: 44`, `horasReservadas: 4.5`, `taxaUtilizacao: 10.23` (4.5/44×100, arredondado).

### 3.2 Integração — RBAC, escopo e cache real (`tests/integration/relatorios.test.ts`, novo, 12 testes)

```
✓ Relatórios (S13) — RF-REL-01: GET /relatorios/utilizacao (3 testes)
✓ Relatórios (S13) — RF-REL-02: GET /relatorios/ranking-setores (Admin only) (2 testes)
✓ Relatórios (S13) — RF-REL-03/04: GET /relatorios/sla-aprovacao (1 teste)
✓ Relatórios (S13) — RF-REL-05: GET /relatorios/seguranca (Admin only) (1 teste)
✓ Relatórios (S13) — cache Redis (TTL 15 min) (2 testes)
✓ Relatórios (S13) — RF-REL-06: GET /relatorios/export (3 testes)

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Destaques:
- Prova real de que o Gestor de Setor só soma horas de reservas do **próprio** setor numa plataforma compartilhada, enquanto o Admin soma de todos.
- Prova real de cache: primeira chamada `X-Cache: MISS`, segunda chamada idêntica `X-Cache: HIT` **com o corpo idêntico** (sem recalcular); e prova de que escopos diferentes (Admin global vs. Gestor de setor) usam chaves de cache **diferentes** (não vazam dado entre escopos).
- Excel exportado real (assinatura de arquivo ZIP `PK`, >1KB) e PDF exportado real (assinatura `%PDF`, >500B) via rota HTTP real, não mock.

**Bug real encontrado e corrigido durante a escrita destes testes**: a query de `/sla-aprovacao` originalmente filtrava o conjunto de reservas por `Reserva.criado_em` (timestamp de criação, sempre "agora"), enquanto as demais 3 rotas filtram por `Reserva.data` (data de uso, controlada pelo usuário no formulário). Isso fazia o relatório nunca encontrar reservas dentro de um período de teste controlado (`data` no período, mas `criado_em` = momento real do teste) — sintoma real: `totalDecisoes` retornando `0` em vez de `3`. **Corrigido**: `buscarSlaAprovacao` agora filtra por `r.data`, igual às demais rotas — o tempo médio de aprovação e a tendência mensal continuam medidos/agrupados por `criado_em`/`decidido_em`, só a **seleção** do conjunto de reservas usa `data`, unificando a semântica de período entre os 4 relatórios (ADR-02, Seção 5).

### 3.3 Suíte completa do backend

`pnpm --filter api test` (via `npx vitest run`) — 32 arquivos, **333/333**, 0 falhas:

```
 Test Files  32 passed (32)
      Tests  333 passed (333)
```

Composição do delta desta sprint: a primeira execução da suíte completa (já com `relatorio.service.ts`/`relatorio.test.ts` prontos, antes de `relatorios.test.ts` existir) retornou **321/321**; depois de adicionar `integration/relatorios.test.ts` (12 testes), a suíte passou a **333/333** — delta de exatamente +12, confirmando que nenhum teste pré-existente foi afetado pelas mudanças desta sprint.

`tsc --noEmit` limpo nos três pacotes (`apps/api`, `apps/web`, `packages/shared`).

## 4. Gate de Aceite

- [x] **Output real dos testes de agregação batendo com o valor exato esperado do fixture** — Seção 3.1 (11/11), incluindo o cálculo passo a passo do fixture de utilização.

- [x] **Evidência real de cache hit na segunda chamada** — dupla evidência:
  1. Teste de integração automatizado (Seção 3.2): `X-Cache: MISS` → `X-Cache: HIT`, corpo idêntico.
  2. Evidência manual via `curl` contra o servidor de desenvolvimento real (`localhost:3334`), sessão de Admin real, período inédito (nunca consultado antes, para eliminar qualquer cache residual de execuções anteriores):

```
=== Cache MISS (periodo inedito: 2025-01-01 a 2025-01-02) ===
HTTP/1.1 200 OK
x-cache: MISS
=== Cache HIT (mesma chamada, dentro do TTL) ===
HTTP/1.1 200 OK
x-cache: HIT
```

- [x] **PDF e Excel reais gerados nesta sprint** — gerados via `curl` autenticado contra o servidor de desenvolvimento real:

```
=== Excel real (utilizacao) ===
HTTP/1.1 200 OK
content-type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
content-disposition: attachment; filename="relatorio_utilizacao_2026-07-01_a_2026-07-14.xlsx"
(6893 bytes)

=== PDF real (sla-aprovacao) ===
HTTP/1.1 200 OK
content-type: application/pdf
content-disposition: attachment; filename="relatorio_sla-aprovacao_2026-07-01_a_2026-07-14.pdf"
(58857 bytes)
```

Assinatura de arquivo real do Excel (primeiros bytes — `PK` confirma pacote ZIP/OOXML válido):

```
00000000: 504b 0304 0a00 0000 0800 f169 ee5c 91db  PK.........i.\..
00000010: c009 5901 0000 f004 0000 1300 0000 5b43  ..Y...........[C
00000020: 6f6e 7465 6e74 5f54 7970 6573 5d2e 786d  ontent_Types].xm
```

Conteúdo real (strings compartilhadas do xlsx, `unzip -p ... xl/sharedStrings.xml`), com acentuação correta e dados reais das plataformas seedadas/demo:

```xml
<sst ...><si><t>Código</t></si><si><t>Plataforma</t></si><si><t>Categoria</t></si>
<si><t>Horas Disponíveis</t></si><si><t>Horas Reservadas</t></si>
<si><t>Taxa de Utilização (%)</t></si><si><t>PLT-S11-DEMO</t></si>
<si><t>Plataforma Demo S11 (Anexos/Comentários/Ocorrência)</t></si>...
```

Assinatura de arquivo real do PDF (primeiros bytes — gerado pelo Chromium headless via Puppeteer):

```
%PDF-1.4
%����
1 0 obj
<</Title (about:blank)
/Creator (Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... HeadlessChrome/150.0.0.0 ...)
/Producer (Skia/PDF...
```

## 5. Evidência de UI — sessão real no navegador

`computer{action:"screenshot"}` voltou a apresentar timeout de 30s (mesmo problema recorrente documentado em S8/S9/S10/S11 — ambiente/infraestrutura da sessão, não do código desta sprint). Evidência substituta: texto real da página (`get_page_text`) após navegação real, login real (Admin) e clique real no botão "Excel", contra o servidor de desenvolvimento (`apps/web` em `localhost:3000` + `apps/api` em `localhost:3334`, já rodando antes desta sessão via `tsx watch`/`next dev` com hot-reload — as rotas/páginas novas desta sprint foram detectadas automaticamente).

Tela `/relatorios` renderizada com dados reais (período padrão = mês corrente, 2026-07-01 a 2026-07-14):

```
Relatórios & Indicadores
Visão global — todos os setores
0.2% Utilização Média das Plataformas
0h Tempo Médio de Aprovação
2 Decisões no Período
100% Checklists Não Conformes
Taxa de Utilização por Plataforma
  PLATAFORMA                              DISPONÍVEL(H)  RESERVADA(H)  UTILIZAÇÃO
  Plataforma Demo S11 (...)               336            0             0%
  Plataforma Elevatória A                 336            1             0.3%
  Plataforma Elevatória Demo S8           336            1             0.3%
Tendência Mensal de Reservas — 2026-07: 4
Distribuição por Status — Pendente/Agendada/Em Uso/Concluída/Cancelada/Rejeitada
Distribuição por Prioridade e Categoria
Ranking de Setores
  SETOR          RESERVAS  REJEITADAS  TAXA DE REJEIÇÃO
  TI             2         0           0%
  (demais 7 setores: 0/0/0%)
Indicadores de Segurança
  Plataforma Demo S11 (...) — Baixa/Média/Alta
```

Requisições de rede reais confirmadas (`read_network_requests`), incluindo o clique real no botão "Excel" disparando a exportação:

```
GET .../api/v1/relatorios/utilizacao?dateFrom=2026-07-01&dateTo=2026-07-14 → 200 OK
GET .../api/v1/relatorios/sla-aprovacao?dateFrom=2026-07-01&dateTo=2026-07-14 → 200 OK
GET .../api/v1/relatorios/ranking-setores?dateFrom=2026-07-01&dateTo=2026-07-14 → 200 OK
GET .../api/v1/relatorios/seguranca?dateFrom=2026-07-01&dateTo=2026-07-14 → 200 OK
GET .../api/v1/relatorios/export?relatorio=utilizacao&formato=excel&... → 200 OK
```

Console do navegador sem erros (`read_console_messages`, `onlyErrors: true` → nenhum log).

## 6. Invariantes da Seção 2 do MASTER.md — nenhuma quebra, duas decisões registradas

- IDs: nenhuma entidade nova nesta sprint (só índices) — não se aplica.
- `/api/v1` como prefixo único: `GET/GET/GET/GET/GET /relatorios/*`.
- Toda rota de escrita valida via Zod: não há rota de escrita nesta sprint (todas leitura/exportação); os schemas de query (`relatorioQuerySchema`, `exportarRelatorioQuerySchema`) são validados via `safeParse` em toda rota.
- `rbac.ts`/`requireRole` continuam a única fonte de verdade de autorização.
- `LogAuditoria`: não se aplica — relatórios são operações de leitura, sem escrita sensível a auditar (consistente com o restante do sistema, que só audita mutações).
- E-mail: não se aplica a esta sprint.
- Cache Redis com TTL de 15 min: implementado exatamente como especificado no prompt (TTL puro, sem invalidação ativa em escrita).

Decisões registradas como ADR:

- **ADR-01 — `GET /relatorios/seguranca` é Admin only, não Gestor(setor)/Admin(global) como os demais 3 relatórios.** O prompt de execução desta sprint (MASTER.md) lista as 5 rotas sem marcar `/seguranca` como Admin-only (só marcou `/ranking-setores` explicitamente), mas o SDD §6.7 (RF-REL-05, fonte de verdade que prevalece em caso de ambiguidade) lista **apenas Admin** no requisito de indicadores de segurança — diferente de RF-REL-01/03/04/06, que listam "Gestor (setor) | Admin (global)". Segui o SDD.
- **ADR-02 — período do relatório sempre filtra pela `Reserva.data` (data de uso), nunca por `criado_em` (data de criação), uniformemente nas 4 rotas.** Corrigido durante a escrita dos testes de integração (Seção 3.2) — ver o bug real documentado ali. Além de corrigir o bug, torna a semântica de "período selecionado" consistente e previsível entre `/utilizacao`, `/ranking-setores`, `/sla-aprovacao` e `/seguranca` (esta última via `preenchido_em`/`criado_em` de `ChecklistPreenchido`/`Ocorrencia`, que não têm campo `data` próprio — mantido como o timestamp natural dessas entidades).
- **ADR-03 — Puppeteer lança e fecha um navegador Chromium por chamada de `/relatorios/export?formato=pdf`**, sem pool/reuso de instância. Aceitável para uma rota de exportação pontual (uso esporádico, não está sob o SLA de leitura de RNF-01 — "relatórios agregados ≤ 1,5s **com cache**" refere-se às rotas de leitura, não à exportação em PDF). Custo observado: ~1,6s por exportação PDF (Seção 3, teste de integração). Registrado como oportunidade de otimização futura (Seção 7) caso o volume de exportações cresça.
- **ADR-04 — Recharts fixado em `^2.15.4` (não a versão `^3.9.2` que o `pnpm add` instalaria por padrão)**, para respeitar a decisão de stack congelada do MASTER.md/SDD §3.1 ("Recharts | 2.x"). Migrar para Recharts 3.x é uma decisão de arquitetura que exigiria um ADR formal em sprint dedicada, não uma sprint de feature.

## 7. Pendências para sprints futuras

- **Puppeteer sem pool de browser** (ADR-03) — se o volume de exportação de PDF crescer, considerar manter uma instância de browser viva entre requisições (trade-off: memória residente vs. latência por chamada).
- **Ferramenta de screenshot do Browser pane segue instável nesta sessão** — mesma observação recorrente desde S8; evidência funcional (texto real da página + chamadas de rede reais) documentada em detalhe na Seção 5.
- **Runner de migrations sem tabela de controle** (pendência reafirmada desde S4/S9) — a migration 0011 foi aplicada via `sqlcmd` direto, mesma prática já estabelecida; ainda recomendado tratar antes de S15.
- **`.claude/launch.json`**: corrigida a porta da config `api` de `3333` para `3334` (porta real definida por `API_PORT` em `.env` desde S1) — divergência de configuração de tooling encontrada durante esta sessão, não um bug de produto.
- Credenciais reais do Microsoft Graph / conta Azure real — pendentes desde S1/S11, sem impacto nesta sprint.
- Migração para Fastify 5.x — segue pendente, sem impacto nesta sprint.

---

Não iniciei a Sprint S14 nesta mesma sessão, conforme instruído.
