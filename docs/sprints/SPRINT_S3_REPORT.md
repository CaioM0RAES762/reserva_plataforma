# Sprint S3 — Reservas: Criação, Conflito e Notificação por E-mail

| Campo | Valor |
|---|---|
| Sprint | S3 |
| Status | ✅ Concluída |
| Data | 2026-07-09 |
| Depende de | S2 (✅ Concluída, confirmado no início desta sessão) |

## 1. O que foi implementado

### Schema de `Reserva`
Já existia (schema-only) desde a migration `0001_init.sql` da S1, com exatamente os campos exigidos: `id, setor_id, solicitante_id, plataforma_id, data, hora_inicio, hora_fim, motivo, prioridade, status, criado_em, atualizado_em`, incluindo o `CHECK (hora_fim > hora_inicio)` já em nível de banco. **Nenhuma nova migration foi necessária** (ver ADR-01).

### `conflito.service.ts` (`apps/api/src/services/conflito.service.ts`)
Funções puras, sem acesso a banco, seguindo o padrão de `plataforma.service.ts` da S2:
- `horarioValido(horaInicio, horaFim)` — `hora_fim > hora_inicio`.
- `encontrarConflito(reservasExistentes, novoHorario)` — implementa exatamente `NOT (fim_nova <= inicio_existente OR inicio_nova >= fim_existente)`, com suporte a `ignorarReservaId` (para uso futuro em edição). Adjacência exata (`fim_nova == inicio_existente` ou `inicio_nova == fim_existente`) **não** é conflito.

### Schemas Zod (`packages/shared/src/schemas/reserva.ts`)
- `criarReservaSchema` — `plataformaId, data, horaInicio, horaFim, motivo, prioridade` (regex `HH:MM`, `.refine` garantindo `horaFim > horaInicio`). **Sem `setorId`/`solicitanteId`** — vêm exclusivamente da sessão.
- `conflitoQuerySchema` — mesmos campos + `ignorarReservaId` opcional, usado por `GET /reservas/conflitos`.
- `reservaPublicaSchema`, `conflitoRespostaSchema`.

### Rotas (`apps/api/src/routes/reservas.ts`)
- `POST /api/v1/reservas` — qualquer perfil autenticado; `setor_id`/`solicitante_id` extraídos de `request.usuario` (JWT), nunca do body; rejeita com `422` se a conta não tiver `setorId` (caso do Admin — ver ADR-02); valida RN-PLAT-01 (plataforma `inativa` não pode ser reservada); roda `conflito.service` antes de inserir; grava `LogAuditoria` na mesma transação; após o commit, enfileira e-mail "Nova reserva pendente" para cada Admin ativo via BullMQ (nunca síncrono).
- `GET /api/v1/reservas` — filtros `q` (setor/responsável/plataforma), `status`, `data`; Colaborador restrito ao próprio `setor_id`; Admin vê tudo.
- `GET /api/v1/reservas/conflitos` — usado pelo frontend para checagem em tempo real; mesma lógica de `conflito.service`, sem persistir nada.

### E-mail (`apps/api/src/services/email.service.ts`)
Novo template `templateNovaReservaPendente()`, seguindo o padrão de `templateCodigoVerificacao()` da S1 — assunto e corpo HTML com plataforma, setor, solicitante, data/horário, prioridade e motivo. Disparado via `enfileirarEmail()` (fila BullMQ existente, sem alterações).

### `GET /api/v1/conta` — extensão mínima
Adicionado `setorNome` (via `LEFT JOIN Setor`) à resposta, necessário para exibir o setor do solicitante no formulário de Nova Reserva sem inventar um endpoint `/setores` fora de escopo (esse chega em S12). Ver ADR-03.

### Frontend
- **Tela "Reservas"** (`apps/web/app/(app)/reservas/`): listagem com busca (`q`), filtro de status e filtro de data, batendo em `GET /reservas` com debounce de 250ms — mesmo padrão de `PlataformasClient.tsx`. Colunas: Setor, Responsável, Plataforma, Data, Horário, Prioridade, Status.
- **Modal "Nova Reserva"** (`ReservaModal.tsx`): Setor Solicitante e Responsável **somente leitura**, preenchidos a partir da sessão (`GET /conta`) — desvio deliberado do protótipo, que tratava esses campos como `<select>`/`<input>` livres (ver ADR-04). Plataforma (exclui `inativa`), Prioridade, Data (mínimo hoje), Horário Inicial/Final, Motivo. Checagem de conflito em tempo real: debounce de 250ms a cada mudança de plataforma/data/horário, chamando `GET /reservas/conflitos`; alerta vermelho exibido e botão "Criar Reserva" desabilitado enquanto há conflito ou horário inválido — fiel a `checkConflicts()` do protótipo, agora contra a API real em vez de `state.reservations`.
- **`ReservaStatusBadge`** e **`PriorityBadge`**: componentes novos (o protótipo não tinha rótulos/cores para `pendente`/`rejeitada`, pois nasciam sempre `agendada` — ver ADR-05).
- **Sidebar**: item "Reservas" habilitado (`disponivel: true`); versão atualizada para "S3".

## 2. Evidência do Gate de Aceite

### 2.1 Output real dos testes unitários de `conflito.service.ts`, incluindo o caso limítrofe de adjacência

```
✓ src/tests/unit/conflito.test.ts > horarioValido > aceita horário final após o inicial
✓ src/tests/unit/conflito.test.ts > horarioValido > rejeita horário final igual ao inicial
✓ src/tests/unit/conflito.test.ts > horarioValido > rejeita horário final antes do inicial
✓ src/tests/unit/conflito.test.ts > encontrarConflito > detecta sobreposição total (novo horário engloba o existente)
✓ src/tests/unit/conflito.test.ts > encontrarConflito > detecta sobreposição parcial no início
✓ src/tests/unit/conflito.test.ts > encontrarConflito > detecta sobreposição parcial no final
✓ src/tests/unit/conflito.test.ts > encontrarConflito > detecta novo horário totalmente contido no existente
✓ src/tests/unit/conflito.test.ts > encontrarConflito > CASO LIMÍTROFE — adjacência exata (fim_nova == inicio_existente) NÃO é conflito
✓ src/tests/unit/conflito.test.ts > encontrarConflito > CASO LIMÍTROFE — adjacência exata (inicio_nova == fim_existente) NÃO é conflito
✓ src/tests/unit/conflito.test.ts > encontrarConflito > não detecta conflito quando não há sobreposição alguma
✓ src/tests/unit/conflito.test.ts > encontrarConflito > ignora a própria reserva quando editando (ignorarReservaId)
✓ src/tests/unit/conflito.test.ts > encontrarConflito > ainda detecta conflito com OUTRA reserva mesmo ignorando a própria
✓ src/tests/unit/conflito.test.ts > encontrarConflito > retorna null para lista vazia

 Test Files  1 passed (1)
      Tests  13 passed (13)
   Duration  771ms
```

Testes de integração (`criar reserva A → tentar criar reserva B conflitante → erro`), executados contra o SQL Server real:

```
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > Colaborador cria reserva A com sucesso (201, status pendente)
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > GET /reservas reflete a reserva A criada
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > Admin sem setor não pode criar reserva (422)
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > GET /reservas/conflitos detecta conflito com a reserva A para um horário sobreposto
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > POST /reservas rejeita reserva B conflitante na mesma plataforma/data (409)
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > POST /reservas aceita reserva adjacente exata (início == fim da reserva A) — SEM conflito
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > Colaborador de outro setor (Manutenção) não vê a reserva A na listagem (escopo por setor)
✓ src/tests/integration/reservas.test.ts > Reservas (S3) — criação, conflito e escopo por setor > Admin vê a reserva A mesmo sem pertencer ao setor TI

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Duration  3.43s
```

Suíte completa do backend (`pnpm --filter api test`), 0 falhas:

```
 ✓ src/tests/unit/plataforma.test.ts (7 tests) 5ms
 ✓ src/tests/unit/conflito.test.ts (13 tests) 6ms
 ✓ src/tests/unit/password.test.ts (10 tests) 1267ms
 ✓ src/tests/integration/auth.test.ts (4 tests) 827ms
 ✓ src/tests/integration/plataformas.test.ts (6 tests) 831ms
 ✓ src/tests/integration/reservas.test.ts (8 tests) 1130ms

 Test Files  6 passed (6)
      Tests  48 passed (48)
   Duration  3.37s
```

### 2.2 Curl mostrando erro 409 ao criar reserva conflitante

Reserva A criada previamente via UI (Colaborador do setor Produção, Plataforma Elevatória A, 15/08/2026, 08:00–10:00). Tentativa de criar reserva conflitante via curl, autenticado como o mesmo Colaborador:

```
$ curl -s -i -X POST http://localhost:3333/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"colaborador.gate.s3@metalsider.com.br","senha":"SenhaForte123"}'

HTTP/1.1 200 OK
set-cookie: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; HttpOnly; SameSite=Strict

$ curl -s -i -X POST http://localhost:3333/api/v1/reservas \
  -H "Content-Type: application/json" \
  -H "Cookie: token=<token-do-colaborador>" \
  --data-raw '{"plataformaId":"8FEC71A0-5F76-4FEB-927E-80C1294CFDB3","data":"2026-08-15","horaInicio":"09:00","horaFim":"11:00","motivo":"Reserva conflitante via curl para evidencia do Gate de Aceite","prioridade":"normal"}'

HTTP/1.1 409 Conflict
content-type: application/json; charset=utf-8

{"erro":"Conflito de horário com reserva do setor Produção (08:00–10:00)."}
```

### 2.3 Evidência de e-mail enfileirado (BullMQ / Redis)

Ao criar a reserva A via UI, o handler `POST /reservas` enfileirou automaticamente um job na fila `email` (Redis) para o Admin seedado. Inspeção real da fila via `redis-cli` (`bull:email:7`, o job da criação da reserva A):

```
data
{"destinatario":"admin@metalsider.com.br",
 "assunto":"PlataformaRes — Nova reserva pendente (Plataforma Elevatória A)",
 "corpoHtml":"...<strong>Colaborador Gate S3</strong> (Produção) solicitou o uso de <strong>Plataforma Elevatória A</strong>...
              Data: 2026-08-15 | Horário: 08:00 – 10:00 | Prioridade: normal |
              Motivo: Manutenção preventiva do painel eletrico da linha 2 ..."}
opts
{"backoff":{"delay":5000,"type":"exponential"},"attempts":3}
failedReason
GRAPH_SENDER_EMAIL não configurado.
```

O job foi corretamente **enfileirado** com destinatário, assunto e corpo HTML consistentes com a reserva criada — confirmando que `POST /reservas` disparou a notificação de forma assíncrona (a resposta HTTP 201 retornou em ~68ms, sem aguardar o envio). O `failedReason` mostra que o *worker* tentou processar o job e falhou apenas por falta de credenciais reais do Microsoft Graph (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`GRAPH_SENDER_EMAIL` em branco no `.env` — condição herdada desde a S1, fora do escopo desta sprint). O mecanismo de fila/retry (3 tentativas, backoff exponencial) funcionou exatamente como projetado em `queue.ts`.

### 2.4 Captura de tela do formulário de Nova Reserva com o alerta de conflito bloqueando o envio

Fluxo real executado no navegador (Preview), como Colaborador do setor Produção: criada a reserva A (Plataforma Elevatória A, 15/08/2026, 08:00–10:00) → reaberto o modal "Nova Reserva" → preenchida uma segunda reserva para a mesma plataforma/data com horário sobreposto (09:00–11:00) → após o debounce de 250ms, `GET /reservas/conflitos` retornou `conflito: true` e a UI exibiu:

> "Conflito com reserva do setor Produção (08:00–10:00)."

com o botão **"Criar Reserva" desabilitado** (confirmado via inspeção do DOM: `btnDisabled: true`) enquanto o conflito persistir. Screenshot capturada mostra o alerta vermelho no rodapé do formulário e o botão azul-claro (estado `disabled`) ao lado de "Cancelar".

## 3. Decisões técnicas (ADRs curtos)

- **ADR-01 — Nenhuma nova migration nesta sprint.** A tabela `Reserva` já fora criada por completo na migration `0001_init.sql` (S1), inclusive com o `CHECK (hora_fim > hora_inicio)` em nível de banco. Confirmado lendo a migration antes de codificar, conforme exigido pelo passo 1 do prompt.
- **ADR-02 — Admin sem `setor_id` não pode criar reserva (422 explícito).** `Reserva.setor_id` é `NOT NULL` desde a S1, e `Usuario.setor_id` é sempre `NULL` para o perfil `admin` (RN-USR-01, SDD §7). Como o PASSO A PASSO exige que "setor/solicitante vêm da sessão, nunca do body", não havia como inferir um setor para o Admin sem violar essa regra. Optou-se por retornar `422` com mensagem explícita em vez de silenciosamente aceitar `setor_id = NULL` (que quebraria a constraint) ou aceitar um `setorId` vindo do body (que violaria a regra explícita da sprint). Coberto pelo teste de integração "Admin sem setor não pode criar reserva".
- **ADR-03 — `GET /api/v1/conta` passou a retornar `setorNome`.** O formulário de Nova Reserva precisa exibir o setor do solicitante (herdado do comportamento do protótipo, que mostrava o nome do setor no campo "Setor Solicitante"). Como não existe endpoint `/setores` até S12 (SDD §11), a alternativa mais simples e no escopo desta sprint foi um `LEFT JOIN Setor` de uma linha extra na rota de conta já existente, em vez de introduzir um módulo de setores inteiro fora de escopo.
- **ADR-04 — Setor Solicitante e Responsável são somente leitura no formulário de produção**, diferente do protótipo (que os tratava como `<select>`/`<input>` livremente editáveis, já que não havia autenticação real). Essa é uma consequência direta e obrigatória da regra "setor/solicitante vêm da sessão, nunca do body" — permitir edição desses campos no formulário criaria uma falsa impressão de que eles são enviados ao servidor, quando na realidade são sempre ignorados/sobrescritos pela sessão.
- **ADR-05 — Novos componentes `ReservaStatusBadge` e `PriorityBadge`.** O protótipo nunca precisou de rótulos/cores para os status `pendente` e `rejeitada` (reservas nasciam sempre `agendada`, sem fluxo de aprovação). Cores escolhidas para consistência visual com o restante do sistema: `pendente` = laranja (aguardando ação, mesma cor de `em_uso`/`manutencao`), `rejeitada` = vermelho (mesma cor de `cancelada`/erros).
- **ADR-06 — Notificação enviada a *todos* os Admins ativos, não a um único endereço fixo.** O prompt diz "destinatário único nesta sprint — distribuição por Gestor de Setor entra em S7", que interpretamos como "o papel Admin é o único destinatário" (em oposição a distribuir por Gestor de Setor, que só existe a partir de S7), não como um limite artificial de uma única linha de e-mail. Como o seed atual só cria um Admin, o comportamento observável é idêntico a "destinatário único"; a query `SELECT email FROM Usuario WHERE perfil='admin' AND ativo=1` também continua correta se um segundo Admin for cadastrado antes de S12.

## 4. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

`UNIQUEIDENTIFIER DEFAULT NEWID()` mantido (nenhuma tabela nova criada). Validação Zod compartilhada (`packages/shared`) em `POST /reservas`. `rbac.ts` (`autenticar`) aplicado em todas as rotas novas; escopo por setor resolvido no backend (nunca só no frontend). `LogAuditoria` gravado na mesma transação da criação da reserva. E-mail passa pela fila BullMQ, nunca síncrono bloqueando a requisição HTTP (confirmado pelo tempo de resposta do `POST /reservas`, ~36–68ms). Nomenclatura de domínio em português. Testes com evidência real (13 unitários + 8 de integração, todos contra lógica pura / banco real). `/api/v1` mantido como prefixo único.

## 5. Pendências para a próxima sprint (e além)

- S4 (Aprovação simples Admin + máquina de estados) é a próxima sprint no roadmap do MASTER.md — não iniciada nesta sessão, conforme instrução explícita.
- Credenciais reais do Microsoft Graph (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`GRAPH_SENDER_EMAIL`) continuam pendentes desde a S1 — o e-mail de "Nova reserva pendente" está corretamente implementado e enfileirado, mas o envio real falha até essas variáveis serem configuradas em um ambiente com tenant do Microsoft Graph disponível.
- `GET /api/v1/reservas` não pagina resultados — aceitável no volume atual do MVP, mas deve ser revisitado quando o volume de reservas crescer (possivelmente em S5, junto do Histórico).
- A opção "Repetir semanalmente" e o campo `recorrencia_id` do protótipo/SDD só entram em S9 — o formulário desta sprint intencionalmente não inclui essa opção.
- Testes desta sprint criam e limpam usuários/reservas/jobs de fila reais no ambiente de desenvolvimento compartilhado (banco `PlataformaRes` e fila `email` no Redis) — toda a limpeza foi confirmada ao final da sessão (`SELECT COUNT(*) FROM Reserva` = 0 reservas de teste remanescentes; chaves `bull:email:*` de teste removidas do Redis).
