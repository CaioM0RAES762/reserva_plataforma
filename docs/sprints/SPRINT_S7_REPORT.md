# Sprint S7 — Perfil Gestor de Setor + Aprovação Delegada/Dupla

| Campo | Valor |
|---|---|
| Sprint | S7 |
| Status | ✅ Concluída |
| Data | 2026-07-10 |
| Depende de | S6 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Início da Fase 2 (Expansão) — primeira sprint com feature nova desde S6 |

## 1. Objetivo

Introduzir o terceiro perfil de acesso (Gestor de Setor) e o fluxo de aprovação hierárquico completo: aprovação simples delegada ao Gestor, dupla aprovação obrigatória (Gestor + Admin) para reservas urgentes ou em plataformas de risco alto, e escalonamento automático por SLA.

## 2. O que foi implementado

### 2.1 Schema (migrations `0004` e `0005`)

- **`0004_gestor_setor_risco.sql`**: troca o `CHECK` de `Usuario.perfil` para aceitar `admin`/`gestor_setor`/`colaborador`; adiciona `Plataforma.categoria` (`elevatoria`\|`andaime`\|`sala`\|`patio`\|`veiculo`\|`outro`, default `outro`), `Plataforma.risco` (`baixo`\|`medio`\|`alto`, default `baixo`) e `Plataforma.aprovacao_automatica` (BIT, default 0); adiciona `Reserva.segunda_aprovacao_por_id` (FK nullable → `Usuario`).
- **`0005_configuracao_sistema.sql`**: cria `ConfiguracaoSistema` (`chave` VARCHAR(60) PK, `valor`, `descricao`, `atualizado_em`, `atualizado_por_id`); seed de `sla_aprovacao_urgente_horas = 2`.
- Aplicadas diretamente via `sqlcmd` contra o banco de desenvolvimento (mesmo padrão de S4/S5 — ver ADR-01), com `GO` entre statements que referenciam colunas recém-adicionadas na mesma migration (necessário para o SQL Server resolver os nomes; sem isso, o batch falha com "Invalid column name").

### 2.2 `packages/shared` (contratos compartilhados)

- `enums.ts`: `PERFIS` agora inclui `gestor_setor`; novos enums `CATEGORIAS_PLATAFORMA`, `RISCOS_PLATAFORMA`; mapa `RISCO_PADRAO_POR_CATEGORIA` (SDD §2.4: elevatória/andaime → alto; pátio/veículo → médio; sala/outro → baixo).
- `schemas/plataforma.ts`: `criarPlataformaSchema`/`plataformaPublicaSchema` ganham `categoria`, `risco` (opcional — aplica o padrão da categoria quando omitido) e `aprovacaoAutomatica`.
- `schemas/reserva.ts`: `reservaPublicaSchema` ganha `segundaAprovacaoPorNome`.
- `schemas/usuario.ts`: novo `atualizarPerfilUsuarioSchema` (RF-USR-05), com `refine` garantindo `setorId` obrigatório para `gestor_setor`/`colaborador` (RN-USR-01).

### 2.3 `aprovacao.service.ts` — RN-RES-07/08

Núcleo da sprint. Novas funções, mantendo `transicionar`/`estadoFinal` (S4) intactas para as demais transições:

- `exigeDuplaAprovacao(prioridade, risco)`: `true` se `prioridade === "urgente"` **ou** `risco === "alto"`.
- `decidirAprovacao(perfil, ctx)`: decide o efeito de uma aprovação conforme quem aprova e o estado atual:
  - **Gestor, caso simples** (não exige dupla): `agendada`, grava `aprovado_por_id`.
  - **Gestor, caso dupla**: `pendente` (estado intermediário — RN-RES-08), grava `aprovado_por_id`. Uma segunda tentativa do Gestor lança `AprovacaoJaRealizadaError`.
  - **Admin, com aprovação prévia do Gestor num caso de dupla**: `agendada`, grava `segunda_aprovacao_por_id` (campo separado — nunca sobrescreve a primeira aprovação).
  - **Admin, aprovação direta** (sem esperar o Gestor, mesmo em caso de dupla): `agendada`, grava `aprovado_por_id`.
- Rejeição continua usando o `transicionar` simples de S4 (`pendente → rejeitada`) — funciona em qualquer etapa, inclusive após a primeira aprovação do Gestor, sem lógica adicional.

### 2.4 `rbac.ts` — helper de escopo

`usuarioNoEscopoDaReserva(usuario, setorReservaId)`: `true` para Admin (sem restrição) ou quando `usuario.setorId === setorReservaId` (Gestor/Colaborador). Usado nas rotas de aprovar/rejeitar/status para aplicar RN-RES-07 (Gestor só atua no próprio setor).

### 2.5 Rotas (`reservas.ts`)

- `POST /reservas/:id/aprovar` e `POST /reservas/:id/rejeitar`: `requireRole` relaxado de `["admin"]` (ADR-S4) para `["admin", "gestor_setor"]`, com checagem de escopo via `usuarioNoEscopoDaReserva`. A rota de aprovar usa `decidirAprovacao` em vez do `transicionar` genérico, gravando dinamicamente em `aprovado_por_id` ou `segunda_aprovacao_por_id` conforme o resultado.
- `PATCH /reservas/:id/status` (iniciar uso/concluir): mesmo relaxamento + checagem de escopo.
- `POST /reservas/:id/cancelar`: já usava a checagem genérica `perfil !== "admin"` desde S4 — Gestor de Setor já cai automaticamente na mesma regra de escopo do Colaborador, sem alteração necessária.
- `buscarContextoReserva` estendida com `prioridade`, `plataforma_risco` e `aprovado_por_id`, necessários para `decidirAprovacao`.
- `SELECT_RESERVA`/`mapReserva` ganham `segundaAprovacaoPorNome` (join adicional em `Usuario`), para a evidência do estado intermediário ficar visível na API.
- **Nova rota `GET /reservas/fila-aprovacoes`** (Admin/Gestor): pendentes elegíveis ao aprovador logado — Gestor vê só o próprio setor e exclui reservas onde `aprovado_por_id IS NOT NULL` (já agiu, aguardando o Admin); Admin vê todas as pendentes, com um campo `aguardaSegundaAprovacao` calculado. Inclui `slaEstourado`/`slaHoras` calculados via `ConfiguracaoSistema`.

### 2.6 Escalonamento de SLA (RN-RES-09)

- `services/escalonamento.service.ts` — `verificarEscalonamentoSla()`: busca reservas `urgente` + `pendente` cuja `criado_em` já ultrapassou `sla_aprovacao_urgente_horas` (lido de `ConfiguracaoSistema`) **e que ainda não foram escaladas** (checagem via `NOT EXISTS` em `LogAuditoria` com `acao = 'escalonar_sla_urgente'` — usado como marcador de idempotência, sem precisar de coluna nova). Para cada uma: grava `LogAuditoria` (`usuario_id = NULL`, ação disparada pelo sistema — mesmo padrão já registrado desde a migration `0001`) e envia e-mail a todos os Admins ativos via `enfileirarEmail`. Retorna os IDs escalados na execução, para facilitar asserção em testes.
- `queue.ts`: novo `escalonamentoQueue` (BullMQ) + `iniciarEscalonamentoWorker()` + `agendarEscalonamentoRepetitivo()` (repeatable job a cada 15 min, `jobId` fixo para não duplicar o agendamento entre reinícios do processo). O worker importa `verificarEscalonamentoSla` via `import()` dinâmico para evitar um ciclo de import estático entre `queue.ts` e `escalonamento.service.ts` (este último depende de `enfileirarEmail`, exportado por `queue.ts`).
- `server.ts`: chama `iniciarEscalonamentoWorker()` e `agendarEscalonamentoRepetitivo()` na inicialização, ao lado do worker de e-mail já existente.
- `email.service.ts`: novos templates `templateSegundaAprovacaoNecessaria` (UC-02 — notifica o Admin quando o Gestor dá a primeira aprovação de um caso de dupla) e `templateEscalonamentoSla`.

### 2.7 Promoção/rebaixamento de perfil (RF-USR-05)

`routes/usuarios.ts` (novo arquivo): `PATCH /api/v1/usuarios/:id/perfil`, restrito a Admin. Valida `atualizarPerfilUsuarioSchema`, aplica RN-USR-01 (`setorId` obrigatório fora de `admin`), grava `LogAuditoria` (`alterar_perfil_usuario`) na mesma transação. Mecanismo provisório — UI completa (listagem, filtros, criação) é escopo de S12.

### 2.8 Frontend

- **Nova tela `/reservas/aprovacoes`** (`FilaAprovacoesClient.tsx`): tabela com Setor/Solicitante/Plataforma/Data/Horário/Prioridade/Status + coluna "Aprovação" com badges "SLA estourado" (vermelho) e "Aguarda 2ª aprovação" (âmbar). Reaproveita `ReservaDetalheModal` para as ações de aprovar/rejeitar/iniciar uso/concluir a partir da própria fila. Colaborador (ou qualquer 403 do backend) recebe uma mensagem de acesso — a rota nunca quebra, apenas explica que o perfil não aprova reservas.
- **`Sidebar.tsx`**: item "Fila de Aprovações" visível apenas para `admin`/`gestor_setor` (novo campo `perfis` em `NavItem`, filtrado antes de renderizar); rótulo do perfil no card do usuário agora cobre os 3 valores.
- **`ReservaDetalheModal.tsx`**: `perfil` agora aceita `gestor_setor`; `podeAprovarRejeitar`/`podeIniciarUso`/`podeConcluir` passam a considerar `usuarioNoEscopoDaReserva`-equivalente no cliente (`perfil === "admin" || reserva.setorId === setorId`) e, para aprovar, escondem o botão do Gestor quando a reserva já tem `aprovadoPorNome` preenchido (aguardando a segunda aprovação do Admin). Exibe `segundaAprovacaoPorNome` e uma nota explicando o estado de dupla aprovação em andamento.
- **Dashboard**: `GET /dashboard/kpis` ganha `pendenciasAprovacao` (contagem por escopo: Admin = todas as pendentes; Gestor = pendentes do próprio setor com `aprovado_por_id IS NULL`; Colaborador = 0, card oculto). Novo card clicável, linkando para a Fila de Aprovações.

## 3. Testes obrigatórios — confirmação

### 3.1 Unitário — `aprovacao.service.ts` (`tests/unit/aprovacao.test.ts`, 20 novos testes)

Cobre exatamente os três cenários exigidos pelo PASSO A PASSO: aprovação simples pelo Gestor (risco baixo/médio, prioridade normal/alta), dupla aprovação obrigatória (urgente OU risco alto) com estado intermediário correto, e rejeição em qualquer etapa. Output real:

```
✓ src/tests/unit/aprovacao.test.ts (35 tests) 8ms
```

(15 testes herdados de S4 — `transicionar`/`estadoFinal` — + 20 novos de S7.)

### 3.2 Integração — dupla aprovação (`tests/integration/aprovacao_dupla.test.ts`, novo arquivo)

Output real, via API real (`app.inject`, sem mocks):

```
✓ src/tests/integration/aprovacao_dupla.test.ts > Aprovação simples pelo Gestor de Setor (RN-RES-07) — risco baixo/médio, prioridade normal/alta > Gestor de Setor aprova sozinho reserva normal em plataforma de risco baixo -> agendada direto 48ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Aprovação simples pelo Gestor de Setor (RN-RES-07) — risco baixo/médio, prioridade normal/alta > Gestor de outro setor não pode aprovar reserva alheia (403 — fora de escopo) 23ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Dupla aprovação obrigatória (RN-RES-08) — prioridade urgente, estado intermediário > fluxo completo: Gestor aprova (permanece pendente) -> Admin dá a segunda aprovação (agendada) 77ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Dupla aprovação obrigatória (RN-RES-08) — prioridade urgente, estado intermediário > Admin aprova diretamente uma reserva de risco alto, sem esperar o Gestor -> agendada de uma vez 37ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Dupla aprovação obrigatória (RN-RES-08) — prioridade urgente, estado intermediário > Gestor de Setor aprova reserva em plataforma de risco alto: permanece pendente (dupla por risco, não por prioridade) 42ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Dupla aprovação obrigatória (RN-RES-08) — prioridade urgente, estado intermediário > rejeição em qualquer etapa finaliza como rejeitada, mesmo após a primeira aprovação do Gestor 69ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Fila de Aprovações (S7) — escopo por perfil > Gestor de Setor só vê pendentes do próprio setor, sem exigir segunda aprovação restante 98ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Fila de Aprovações (S7) — escopo por perfil > Admin vê todas as pendentes, incluindo as que aguardam segunda aprovação 66ms
✓ src/tests/integration/aprovacao_dupla.test.ts > Fila de Aprovações (S7) — escopo por perfil > Colaborador não acessa a Fila de Aprovações (403) 1ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

O teste `fluxo completo: Gestor aprova (permanece pendente) -> Admin dá a segunda aprovação (agendada)` asserta explicitamente os dois estados exigidos pelo Gate:
- Após o Gestor aprovar: `corpoGestor.status === "pendente"`, `corpoGestor.aprovadoPorNome` contém "Gestor de Setor TI", `corpoGestor.segundaAprovacaoPorNome === null`.
- Após o Admin dar a segunda aprovação: `corpoAdmin.status === "agendada"`, `corpoAdmin.segundaAprovacaoPorNome === "Administrador"`.

### 3.3 Integração — escalonamento de SLA (`tests/integration/escalonamento.test.ts`, novo arquivo)

"Controle de tempo" feito retroagindo `Reserva.criado_em` diretamente no banco (`UPDATE ... SET criado_em = DATEADD(HOUR, -N, SYSUTCDATETIME())`), já que o job real roda a cada 15 min via BullMQ — inviável esperar em teste automatizado. Output real:

```
✓ src/tests/integration/escalonamento.test.ts > Escalonamento de SLA (RN-RES-09) — job de verificação > sla_aprovacao_urgente_horas está configurado em ConfiguracaoSistema (seed S7) 2ms
✓ src/tests/integration/escalonamento.test.ts > Escalonamento de SLA (RN-RES-09) — job de verificação > reserva urgente recém-criada (dentro do SLA) NÃO é escalada 56ms
✓ src/tests/integration/escalonamento.test.ts > Escalonamento de SLA (RN-RES-09) — job de verificação > reserva urgente pendente além do SLA é escalada: dispara notificação e grava LogAuditoria 79ms
✓ src/tests/integration/escalonamento.test.ts > Escalonamento de SLA (RN-RES-09) — job de verificação > a mesma reserva não é escalada de novo numa segunda execução do job (idempotência) 57ms
✓ src/tests/integration/escalonamento.test.ts > Escalonamento de SLA (RN-RES-09) — job de verificação > reserva urgente já aprovada (fora de pendente) não é escalada mesmo além do SLA 53ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 3.4 Suíte completa do backend

`pnpm --filter api test` — 14 arquivos, **183/183**, 0 falhas:

```
 Test Files  14 passed (14)
      Tests  183 passed (183)
```

Composição do delta em relação a S6 (147 testes): +20 em `unit/aprovacao.test.ts` (decidirAprovacao/exigeDuplaAprovacao), +9 em `integration/aprovacao_dupla.test.ts` (novo arquivo), +5 em `integration/escalonamento.test.ts` (novo arquivo), +2 em `unit/plataforma.test.ts` (`resolverRiscoPlataforma`) → 147 + 20 + 9 + 5 + 2 = 183.

## 4. Gate de Aceite

- [x] **Output real dos testes de dupla aprovação, mostrando explicitamente o estado intermediário** (`pendente` após aprovação do Gestor, `agendada` só após o Admin) — Seção 3.2, teste `fluxo completo: Gestor aprova (permanece pendente) -> Admin dá a segunda aprovação (agendada)`, com asserções sobre `status`, `aprovadoPorNome` e `segundaAprovacaoPorNome` em cada etapa.
- [x] **Evidência (log/teste) do job de escalonamento disparando após o SLA configurado** — Seção 3.3 (suite automatizada) + query real abaixo (script ad hoc contra o banco de desenvolvimento, dados de teste limpos ao final):

```
=== EVIDÊNCIA S7 — reserva urgente criada há 3h (SLA configurado = 2h), ainda pendente ===
┌─────────┬────────────────────────────────────────┬────────────┬────────────┬──────────────────────────┐
│ (index) │ id                                     │ status     │ prioridade │ criado_em                │
├─────────┼────────────────────────────────────────┼────────────┼────────────┼──────────────────────────┤
│ 0       │ 'BE28765A-8247-4A36-AF48-94D69F3E463A' │ 'pendente' │ 'urgente'  │ 2026-07-10T16:28:55.176Z │
└─────────┴────────────────────────────────────────┴────────────┴────────────┴──────────────────────────┘
=== EVIDÊNCIA S7 — retorno de verificarEscalonamentoSla() (IDs escalados nesta execução) ===
[ 'BE28765A-8247-4A36-AF48-94D69F3E463A' ]
=== EVIDÊNCIA S7 — LogAuditoria real gravado pelo job (usuario_id NULL = ação disparada pelo sistema) ===
┌─────────┬────────────────────────────────────────┬────────────┬─────────────────────────┬───────────┬────────────────────────────────────────┬──────────────────┬──────────────────────────┐
│ (index) │ id                                     │ usuario_id │ acao                    │ entidade  │ entidade_id                            │ detalhes         │ criado_em                │
├─────────┼────────────────────────────────────────┼────────────┼─────────────────────────┼───────────┼────────────────────────────────────────┼──────────────────┼──────────────────────────┤
│ 0       │ '52B46B80-9977-4974-811B-88E44581606F' │ null       │ 'escalonar_sla_urgente' │ 'Reserva' │ 'BE28765A-8247-4A36-AF48-94D69F3E463A' │ '{"slaHoras":2}' │ 2026-07-10T19:28:55.193Z │
└─────────┴────────────────────────────────────────┴────────────┴─────────────────────────┴───────────┴────────────────────────────────────────┴──────────────────┴──────────────────────────┘
```

- [x] **Captura de tela da "Fila de Aprovações" para os 3 perfis, comprovando o escopo correto de cada um** — coletadas via browser real (login efetivo com cada usuário, navegação real para `/reservas/aprovacoes`), com 2 reservas de demonstração pré-cadastradas (uma `normal` em plataforma de risco baixo, outra `urgente` em plataforma de risco alto retroagida no tempo para exibir o badge de SLA estourado):
  - **Gestor de Setor TI** (`gestor.ti@metalsider.com.br`): título "Reservas pendentes do seu setor que ainda aguardam sua decisão"; tabela mostra as 2 reservas do setor TI; badge "SLA estourado" visível na reserva urgente; item "Fila de Aprovações" destacado no menu.
  - **Admin** (`admin@metalsider.com.br`): título "Todas as reservas pendentes, incluindo as que aguardam segunda aprovação"; mesma tabela (escopo global — só havia reservas do setor TI no ambiente de teste).
  - **Colaborador** (`colaborador.ti@metalsider.com.br`): item "Fila de Aprovações" **não aparece no menu lateral** (filtrado por perfil); acesso direto à URL mostra a mensagem "Seu perfil (Colaborador) não aprova reservas. Fale com o Gestor do seu setor ou com o Admin." — sem erro, sem quebra de layout.
  - Dashboard do Admin confirmado mostrando o novo card "Pendências de Aprovação: 2", clicável para a Fila.

## 5. Correção incidental — flakiness pré-existente no rate limit de login em testes

Durante a coleta de evidências, a suíte apresentou falhas intermitentes (`429` em vez do status esperado) em arquivos que fazem login como o Admin seedado em `beforeAll`. Investigação: `checarRateLimitLogin` (S1) usa uma janela de 10 min por e-mail no Redis; como o Vitest roda arquivos de teste em paralelo por padrão, múltiplos arquivos de integração (8 dos 14 arquivos atuais fazem login como o mesmo Admin) corridavam contra o mesmo contador antes que qualquer um deles chamasse `limparRateLimitLogin` — pré-existente desde que o número de arquivos de integração cresceu, apenas mais visível agora que S7 adicionou mais 2 arquivos que também fazem login como Admin.

**Correção**: `fileParallelism: false` em `apps/api/vitest.config.ts`, serializando a execução dos arquivos de teste. Trade-off consciente: a suíte fica um pouco mais lenta (~32s vs. ~7s em paralelo) em troca de determinismo — dado o padrão evidence-first do projeto, uma suíte que passa "na maioria das vezes" não é aceitável como evidência de Gate. Não há mock do rate limiter nos testes de integração (mantém a cobertura realista de RF-AUTH-05).

## 6. Invariantes da Seção 2 do MASTER.md — uma exceção registrada (não é quebra silenciosa)

Todas as invariantes seguidas, com uma exceção documentada:

- **`ConfiguracaoSistema.chave` é `VARCHAR(60)` como chave primária, não `UNIQUEIDENTIFIER DEFAULT NEWID()`.** A invariante da Seção 2 do MASTER.md diz "IDs sempre `UNIQUEIDENTIFIER DEFAULT NEWID()` em toda entidade — nunca `INT IDENTITY`". `ConfiguracaoSistema` é uma tabela de configuração chave-valor, não uma entidade de domínio com necessidade de identidade substituta — o próprio SDD (§4.3 e §17.10) especifica `chave` como chave primária natural (ex.: `sla_aprovacao_urgente_horas`), o que é necessário para leituras diretas (`WHERE chave = 'x'`) sem uma junção adicional. Interpretação: a invariante visa evitar `INT IDENTITY` (chaves sequenciais previsíveis/frágeis para entidades de negócio), não proibir chaves naturais semânticas em tabelas de configuração — mas por precaução, registro aqui como exceção explícita, já prevista no design original do SDD, não uma decisão nova desta sprint.

Demais invariantes confirmadas: `/api/v1` como prefixo único (rotas novas: `PATCH /usuarios/:id/perfil`, `GET /reservas/fila-aprovacoes`); toda rota de escrita valida via Zod (`atualizarPerfilUsuarioSchema`); `rbac.ts` continua a única fonte de verdade de autorização (nenhuma regra de escopo resolvida só no frontend — a UI apenas espelha a mesma regra para not mostrar botões inúteis, mas o backend sempre revalida); `LogAuditoria` gravado na mesma transação da operação em toda rota de escrita nova (`aprovar_reserva` com `campo`/`perfilAprovador` no detalhe, `alterar_perfil_usuario`); e-mail sempre via fila BullMQ (`enfileirarEmail`, nunca síncrono), inclusive no job de escalonamento.

## 7. ADRs (Architecture Decision Records)

- **ADR-01 — Migrations `0004`/`0005` aplicadas diretamente via `sqlcmd`, mesmo padrão de S4/S5/S6.** O runner (`src/db/migrate.ts`) continua sem tabela de controle de migrations aplicadas (pendência registrada desde S4, ainda não tratada — ver Seção 8).
- **ADR-02 — Dentro da migration `0004`, cada `ALTER TABLE` foi separado por `GO`.** Sem separação de batch, o SQL Server falha com `Invalid column name` ao tentar resolver nomes de colunas (`categoria`, `risco`) referenciadas por um `ALTER TABLE ADD CONSTRAINT ... CHECK` na mesma execução em que a coluna foi criada — comportamento de resolução de nomes por batch do T-SQL, não um bug da migration em si. Migrations anteriores (`0001`-`0003`) não precisaram disso porque cada uma adicionava colunas e depois só as usava em consultas de outras rotinas, nunca na mesma migration.
- **ADR-03 — `verificarEscalonamentoSla` usa `LogAuditoria` como marcador de idempotência em vez de uma coluna `escalonado_em` em `Reserva`.** Evita alterar o schema de `Reserva` só para um flag de controle interno do job; `LogAuditoria` já é a fonte de verdade para "o que já aconteceu com esta reserva", e a query `NOT EXISTS (... acao = 'escalonar_sla_urgente')` é barata (índice `IX_LogAuditoria_entidade` já cobre `entidade_id`).
- **ADR-04 — Rejeição de reserva não usa `decidirAprovacao`, continua no `transicionar` simples de S4.** RN-RES-08 (dupla aprovação) é uma regra específica de *aprovação*; a rejeição sempre finaliza o fluxo (`pendente → rejeitada`) independentemente de quantas aprovações parciais já ocorreram — não há "dupla rejeição". Manter os dois caminhos separados evita uma função `decidirAprovacao` genérica demais tentando cobrir semânticas diferentes.
- **ADR-05 — `fileParallelism: false` no `vitest.config.ts`** — ver Seção 5.
- **ADR-06 — Fila de Aprovações reaproveita `ReservaDetalheModal` em vez de um modal dedicado de aprovação rápida.** O modal já resolve toda a lógica de escopo/estado/botões contextuais; duplicar essa lógica num componente "aprovar rápido" só para a fila introduziria uma segunda fonte de verdade para as mesmas regras de negócio no frontend. Ações rápidas em linha (sem abrir modal) ficam como possível melhoria de UX para uma sprint futura de polimento (S14).

## 8. Pendências para sprints futuras

- Runner de migrations sem tabela de controle (ADR-01 de S4/S5/S6, reafirmado aqui) — ainda recomendado tratar antes de S15.
- Migração para Fastify 5.x (ADR-04 de S6) — segue pendente, sem impacto nesta sprint (nenhuma dependência nova adicionada em S7).
- Credenciais reais do Microsoft Graph — pendente desde S1.
- Checklist de segurança (S8) vai depender de `Plataforma.categoria`/`requer_checklist` — os campos de categoria já existem desde esta sprint (S7), prontos para uso em S8.
- `ChecklistItemTemplate`/preenchimento (S8), Bloqueios de Agenda/recorrência (S9) e o restante do roadmap seguem conforme MASTER.md Seção 5.
- UI completa de administração de usuários (listagem, criação, edição de perfil via formulário) — mecanismo provisório de S7 (`PATCH /usuarios/:id/perfil`) é suficiente para uso interno até S12.
- Ações rápidas em linha na Fila de Aprovações (ADR-06) — possível melhoria de UX futura, não bloqueante.

---

Não iniciei a Sprint S8 nesta sessão, conforme instruído.
