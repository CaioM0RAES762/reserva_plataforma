# Sprint S10 — Notificações In-App (SSE) + Painel TV

| Campo | Valor |
|---|---|
| Sprint | S10 |
| Status | ✅ Concluída |
| Data | 2026-07-13 |
| Depende de | S7 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Comunicação em tempo real (SSE) + exibição pública para chão de fábrica |

## 1. Objetivo

Comunicação em tempo real dentro do sistema (notificações in-app com sino no topbar) e exibição pública para chão de fábrica (Painel TV), consumindo um único canal SSE (`GET /api/v1/eventos`), conforme SDD §3.4.

## 2. O que foi implementado

### 2.1 Schema (migration `0008`)

- **`Notificacao`**: `id`, `usuario_id` (FK), `tipo` (`CHECK` com os 7 valores do SDD §4.3), `titulo`, `mensagem`, `link` (nullable), `lida` (BIT default 0), `criado_em`. Índice `IX_Notificacao_usuario_id_lida`.
- **`PainelToken`**: mecanismo de autenticação de dispositivo do Painel TV — **ADR-01**: tabela dedicada (não reaproveita `Usuario`), pois um token de dispositivo não é uma identidade de pessoa (sem perfil/senha/domínio de e-mail obrigatório). `token_hash` (CHAR(64), SHA-256) é o único valor persistido — o token em texto puro só é retornado uma vez, na criação (mesmo padrão de segredo de API key). `setor_id` nullable = mesmo padrão de `BloqueioAgenda.plataforma_id` (S9): `NULL` = todos os setores visíveis no painel.
- Aplicada via `sqlcmd -f 65001` contra o banco de desenvolvimento (mesmo padrão de S4-S9). Verificado via `INFORMATION_SCHEMA.TABLES` — ambas as tabelas confirmadas.

### 2.2 `packages/shared`

- `schemas/notificacao.ts`: `TIPOS_NOTIFICACAO` (7 valores do SDD §4.3), `notificacaoPublicaSchema`.
- `schemas/painel.ts`: `criarPainelTokenSchema`, `painelTokenPublicoSchema`, `painelTokenCriadoSchema` (estende o público com o campo `token`, só presente na resposta de criação), `painelDadosSchema` (reservas do dia, próximas 2h, status das plataformas).

### 2.3 `services/eventos.service.ts` — pub/sub SSE

Núcleo do canal em tempo real. `Map<string, ClienteSSE>` em memória, cada cliente com `usuarioId: string | null` (`null` = dispositivo Painel TV):

- `registrarClienteSSE(usuarioId, reply)` / `removerClienteSSE(id)`.
- `publicarEventoUsuario(usuarioId, tipo, dados)` — eventos pessoais (`reserva.criada` ao aprovador, `reserva.aprovada`/`rejeitada` ao solicitante, `notificacao.nova` ao destinatário).
- `publicarEventoGlobal(tipo, dados)` — eventos amplos (`reserva.status_alterado`, `plataforma.status_alterado`), entregues a **todos** os clientes conectados, incluindo dispositivos do Painel TV.

### 2.4 Rota SSE — `GET /api/v1/eventos`

- Autenticação dupla: cookie JWT (usuário logado) **ou** `?token=` de dispositivo válido (Painel TV) — sem exigir sessão de usuário para o dispositivo (SDD §12).
- `reply.hijack()` + `reply.raw.writeHead(...)` para manter a conexão aberta fora do ciclo request/response padrão do Fastify; heartbeat a cada 20s (`: heartbeat\n\n`) para manter proxies corporativos de não fecharem a conexão ociosa; cleanup no `request.raw.on("close")`.
- **Bug real encontrado e corrigido** (Seção 6): `reply.hijack()` pula o hook do `@fastify/cors`, então os headers CORS nunca eram escritos na resposta SSE — corrigido aplicando-os manualmente via `reply.raw.setHeader(...)` antes do `hijack()`, reaproveitando a mesma lógica de origem permitida do `app.ts` (extraída para `utils/cors.ts`).

### 2.5 `services/notificacao.service.ts`

`registrarNotificacao(transaction, input)` — insere a `Notificacao` na **mesma transação** da operação que a originou (mesma disciplina de `LogAuditoria`, aplicada por analogia), retorna o objeto mapeado; o evento `notificacao.nova` é publicado pelo chamador **depois** do commit (mesmo padrão já usado para e-mail).

### 2.6 Rotas `GET/PATCH /api/v1/notificacoes`

`GET /notificacoes` (TOP 50, mais recentes primeiro), `PATCH /notificacoes/:id/lida` (escopo por `usuario_id` — 404 se não for do usuário logado), `PATCH /notificacoes/lidas` (marca todas as pendentes do usuário logado).

### 2.7 Retroação dos fluxos de S3/S4/S7 para notificação in-app

- `POST /reservas` (criação): antes da transação, busca aprovadores elegíveis (Admins ativos + Gestor do setor, RN-RES-07); dentro da transação, grava uma `Notificacao` (`reserva_pendente`) por aprovador, por ocorrência; depois do commit, publica `reserva.criada` + `notificacao.nova` via SSE, mantendo o e-mail existente (só a admins, comportamento inalterado).
- `POST /reservas/:id/aprovar`: se `agendada`, grava `Notificacao` (`reserva_aprovada`) ao solicitante e publica `reserva.aprovada`; se aguardando segunda aprovação (RN-RES-08), grava `Notificacao` (`reserva_pendente`, "Aguarda segunda aprovação") a cada Admin e publica `reserva.criada` novamente (reaproveitado — semanticamente equivalente para o consumidor, "novo item na Fila de Aprovações").
- `POST /reservas/:id/rejeitar`: grava `Notificacao` (`reserva_rejeitada`) ao solicitante, publica `reserva.rejeitada`.
- `PATCH /reservas/:id/status`, `POST /reservas/:id/cancelar`, `POST /reservas/recorrencia/:id/cancelar`: publicam `reserva.status_alterado` (evento global, sem `Notificacao` — não é um dos 7 tipos do SDD §4.3, é só sincronização de UI).
- `PATCH /plataformas/:id/status`: publica `plataforma.status_alterado` (global).

### 2.8 Painel TV — `services/painelToken.service.ts` + `routes/painel.ts`

- `gerarTokenDispositivo()` (32 bytes aleatórios) / `hashTokenDispositivo()` (SHA-256) / `validarTokenDispositivo()` (lookup por hash, atualiza `ultimo_uso_em` best-effort).
- Admin: `POST/GET /api/v1/painel/tokens`, `DELETE /api/v1/painel/tokens/:id` (soft-revoke, `ativo = 0`).
- Público (sem sessão): `GET /api/v1/painel/dados?token=` — reservas de hoje (`agendada`/`em_uso`/`concluida`), próximas 2 horas (`agendada`, janela `GETDATE()`–`GETDATE()+2h` — horário local, mesma convenção de `hora_inicio_real` em `reservas.ts`), status de todas as plataformas (**ADR-02**, Seção 7). Filtro por setor quando `PainelToken.setor_id` não é nulo.

### 2.9 Frontend

- **`lib/useEventosSSE.ts`**: hook genérico — `EventSource` (com `withCredentials` quando não há token de dispositivo), reconexão automática com **backoff exponencial** (1s → 2s → 4s → ... até 30s, resetado a cada `onopen`), expõe `{ conectado }`.
- **`components/NotificationBell.tsx`**: sino no Topbar, contador de não lidas, dropdown com lista/link/marcar individual/marcar todas; fallback de polling a 30s enquanto `!conectado`; **RNF-10**: ao reconectar, dispara `carregar()` imediatamente (Seção 6).
- **`app/(app)/plataformas/painel-tv/page.tsx`** + **`components/PainelTokensClient.tsx`**: CRUD de tokens (Admin), token em texto puro exibido só na criação junto com a URL pronta do painel.
- **`app/painel/PainelClient.tsx`** (rota `app/painel`, **fora** do grupo `(app)` — sem sidebar/topbar, sem checagem de cookie de sessão): layout kiosk, tipografia ampliada via `@media (min-width: 1920px)`, relógio ao vivo, autorrefresh via SSE (token na querystring) com fallback de polling a 30s.

## 3. Testes obrigatórios — confirmação

### 3.1 Integração — evento SSE emitido e recebido (`tests/integration/eventos.test.ts`, novo)

Diferente dos demais testes de integração (que usam `app.inject()`, sem conexão TCP real — inadequado para verificar um stream contínuo), este arquivo sobe o servidor de verdade (`app.listen({ port: 0 })`) e consome `/api/v1/eventos` com um cliente HTTP real (`fetch` + `ReadableStream`), disparando a mutação por uma segunda conexão (`app.inject`). Output real:

```
✓ src/tests/integration/eventos.test.ts > SSE — GET /api/v1/eventos (S10, SDD §3.4) > evento reserva.criada, publicado na criação de uma reserva, é recebido em tempo real por um cliente SSE assinado como Admin 99ms
✓ src/tests/integration/eventos.test.ts > SSE — GET /api/v1/eventos (S10, SDD §3.4) > GET /api/v1/eventos sem cookie e sem token de dispositivo retorna 401 13ms
```

O teste assina o canal como Admin, cria uma reserva como Colaborador em outra conexão, e **aguarda e valida em tempo real** dois eventos no mesmo stream: `reserva.criada` (com `id`/`status` corretos) e `notificacao.nova` (com `tipo: "reserva_pendente"`, `lida: false`) — sem qualquer polling.

### 3.2 Integração — notificações in-app (`tests/integration/notificacoes.test.ts`, novo)

```
✓ criar uma reserva persiste Notificacao (reserva_pendente) para o Admin, além do e-mail 55ms
✓ Colaborador não vê a notificação do Admin em sua própria lista (escopo por usuario_id) 5ms
✓ Colaborador não pode marcar como lida uma notificação de outro usuário (404 — não é dele) 4ms
✓ Admin marca a própria notificação como lida (204) e ela aparece lida na listagem seguinte 17ms
✓ PATCH /notificacoes/lidas marca todas as pendentes do usuário logado de uma vez 70ms

Test Files  1 passed (1)
     Tests  5 passed (5)
```

### 3.3 Unitário — `eventos.service.ts` e `notificacao.service.ts`

```
✓ src/tests/unit/eventos.test.ts (4 tests) 5ms
✓ src/tests/unit/notificacao.test.ts (2 tests) 3ms
```

### 3.4 Manual documentado — reconexão do canal SSE após queda de rede (RNF-10)

Executado **duas vezes** durante esta sessão, derrubando de fato o processo da API (`Stop-Process -Force` no PID escutando a porta 3334) enquanto o Painel TV e o sino de notificações estavam abertos no navegador real (Browser pane), e subindo o servidor novamente (`pnpm dev`) — não uma simulação sintética, uma queda real de processo/TCP:

```
=== Ciclo 1 — 17:32:23 API derrubada ===
GET /api/v1/eventos?token=... → 200 OK [FAILED: net::ERR_CONNECTION_RESET]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... → 200 OK   <- API de volta, reconectado automaticamente

=== Ciclo 2 — 17:35:58 API derrubada de novo (segundo ciclo, intencional) ===
GET /api/v1/eventos?token=... → 200 OK [FAILED: net::ERR_CONNECTION_RESET]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... [FAILED: net::ERR_CONNECTION_REFUSED]
GET /api/v1/eventos?token=... → 200 OK   <- API de volta às 17:36:27, reconectado automaticamente
```

Durante a queda, o rodapé do Painel TV mudou automaticamente de **"Ao vivo (SSE)"** para **"Modo polling (30s)"** (fallback do RNF-10 disparando corretamente); após a reconexão, voltou a **"Ao vivo (SSE)"** com o timestamp de `atualizadoEm` renovado — **sem qualquer F5** — confirmando tanto o backoff exponencial do `useEventosSSE` quanto o fallback de polling. Um bug real de "estado preso em erro após reconectar" foi encontrado e corrigido nesse mesmo processo (Seção 6).

### 3.5 Suíte completa do backend

`pnpm --filter api test` — 22 arquivos, **257/257**, 0 falhas:

```
 Test Files  22 passed (22)
      Tests  257 passed (257)
```

Composição do delta em relação a S9 (244 testes): +4 em `unit/eventos.test.ts`, +2 em `unit/notificacao.test.ts`, +2 em `integration/eventos.test.ts`, +5 em `integration/notificacoes.test.ts` → 244 + 4 + 2 + 2 + 5 = 257.

## 4. Gate de Aceite

- [x] **Evidência real (teste ou log) do evento SSE emitido e recebido** — Seção 3.1, teste automatizado real (servidor TCP real + `fetch` streaming, sem mocks), mais o log de rede do navegador real na Seção 3.4 mostrando dezenas de conexões `GET /api/v1/eventos` reais, incluindo falhas e reconexões genuínas.
- [x] **Captura de tela do sino de notificações com itens não lidos e do dropdown funcionando** — tool de screenshot voltou a travar (mesmo problema documentado em S8/S9); substituído por evidência DOM real via `javascript_tool`: `badgeText: "6"`, dropdown com `headerText: "NotificaçõesMarcar todas como lidas"`, 6 itens com classe `unread` e link para `/reservas/aprovacoes`; fluxo completo testado ponta-a-ponta no navegador real — abrir dropdown, clicar "Marcar todas como lidas" (badge zera, confirmado via query direta ao banco: `lida=1` nas 6 notificações), nova notificação chegando **ao vivo via SSE** sem reload (badge `0→1` instantâneo), clicar num item individual (marca como lida + navega para `/reservas/aprovacoes`, onde a reserva aparece na Fila de Aprovações).
- [x] **Captura de tela do Painel TV em resolução ≥ 1920 px, com autorrefresh comprovado** — viewport redimensionado para 1920×1080 (`resize_window`); tipografia ampliada confirmada via `getComputedStyle` (`h1: 42px`, `h2: 28.5px`, batendo exatamente com a media query `@media (min-width: 1920px)`); autorrefresh comprovado criando/aprovando uma reserva **e** mudando o status de uma plataforma via `curl` (simulando "outra aba"), sem qualquer chamada de reload da minha parte — o DOM do painel mudou sozinho: nova reserva apareceu em "Próximas 2 horas" e "Reservas de hoje", status da plataforma mudou de "Disponível" para "Manutenção", rodapé atualizou o timestamp e manteve "Ao vivo (SSE)".

## 5. Limitação de evidência visual — tool de screenshot

Mesma limitação documentada em S8 e S9: `computer{action:"screenshot"}` e `computer{action:"zoom"}` travam após 30s neste ambiente ("Browser pane may be stuck"). Substituído consistentemente por `get_page_text` (texto renderizado real da página) e `javascript_tool` (inspeção de DOM/CSS computado real, não suposto) em todas as evidências desta seção — nunca omitido silenciosamente.

## 6. Bugs reais encontrados e corrigidos durante o desenvolvimento (disciplina evidence-first)

Quatro bugs genuínos, todos descobertos testando os fluxos de verdade no navegador/API real (nenhum é hipotético):

1. **CORS ausente na resposta SSE (`routes/eventos.ts`)** — `reply.hijack()` pula o hook `onSend` do `@fastify/cors`, então a resposta SSE nunca carregava `Access-Control-Allow-Origin`/`-Credentials`. Confirmado via `curl -H "Origin: http://localhost:3000"` (headers ausentes) antes da correção, presentes depois. Sem a correção, o `EventSource` do navegador falhava com `net::ERR_FAILED` silenciosamente, sem nunca dar match no `onerror` de forma útil. Corrigido aplicando os headers manualmente via `reply.raw.setHeader(...)` antes do `hijack()`, reaproveitando `isAllowedOrigin()` (extraída de `app.ts` para `utils/cors.ts`, sem duplicar a lista de origens permitidas).
2. **`PATCH /notificacoes/:id/lida` e `/lidas` retornavam 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`)** — `apiFetch` sempre define `Content-Type: application/json`, mesmo sem `body`; o Fastify rejeita corpo vazio com esse header. O padrão já estabelecido no restante do frontend (`ReservaDetalheModal.tsx`, `ReservasClient.tsx`) sempre passa `body: JSON.stringify({})` nesse caso — o `NotificationBell.tsx` não seguiu o padrão na primeira versão. Corrigido aplicando o mesmo padrão.
3. **Clique numa notificação não marcava como lida** — o `<a>` do item navega imediatamente (RF-NOT-02, link direto) e o navegador cancelava o `fetch` do `PATCH .../lida` em voo antes de completar. Confirmado via query direta ao banco (`lida` continuava `0` após o clique). Corrigido com `keepalive: true` na chamada — a requisição sobrevive à navegação (mesmo mecanismo usado por beacons de analytics).
4. **Estado "erro"/desatualizado preso após reconexão SSE** — nem o Painel TV nem o sino tinham um gatilho para re-buscar dados quando a conexão SSE voltava (`conectado: false → true`); a UI só se recuperava esperando o próximo evento de domínio, o que podia nunca acontecer. Achado durante o teste manual de reconexão da Seção 3.4 (rodapé preso em "Falha de conexão com o servidor." mesmo com a API já saudável). Corrigido adicionando um `useEffect` que dispara `carregar()` sempre que `conectado` passa a `true`, em `PainelClient.tsx` e `NotificationBell.tsx`.

## 7. ADRs (Architecture Decision Records)

- **ADR-01 — `PainelToken` como tabela dedicada, não reaproveitando `Usuario`.** Um token de dispositivo não tem perfil, setor obrigatório, e-mail no domínio `@metalsider.com.br` nem senha — forçar isso em `Usuario` exigiria relaxar `CHECK`s pensados para contas humanas. Token armazenado como hash SHA-256 (`token_hash`), nunca em claro; escopo por `setor_id` nullable segue o mesmo padrão de `BloqueioAgenda.plataforma_id` (S9).
- **ADR-02 — grade de status de plataformas no Painel TV é sempre global, independente do escopo por setor do token.** `Plataforma` não pertence a um `Setor` no schema atual (plataformas são recurso compartilhado entre setores) — só as **reservas** exibidas são filtradas por `PainelToken.setor_id`. Interpretação pragmática de RF-TV-03 ("quais setores/plataformas aparecem"): sem uma relação Plataforma↔Setor no modelo de dados atual, filtrar plataformas individualmente exigiria uma tabela de associação nova, fora do escopo desta sprint — registrado como pendência (Seção 9).
- **ADR-03 — evento `reserva.criada` reaproveitado para "aguarda segunda aprovação" (RN-RES-08).** O SDD §3.4 não define um evento dedicado para esse caso; semanticamente é idêntico do ponto de vista do consumidor (Admin) — "um novo item apareceu na Fila de Aprovações que precisa da minha atenção" — então reaproveitar evita inflar a lista de tipos de evento por uma distinção que não muda o comportamento da UI.
- **ADR-04 — `reserva.status_alterado`/`plataforma.status_alterado` nunca geram `Notificacao` persistida, só evento SSE.** Esses dois tipos não estão entre os 7 valores do `CHECK` de `Notificacao.tipo` no SDD §4.3 — são sincronização de UI (Dashboard/Painel/Calendário), não itens que pedem ação/leitura de um usuário específico.
- **ADR-05 — `keepalive: true` em vez de reestruturar a navegação do sino em torno do roteador do Next.js.** Preserva o link como uma âncora real de HTML (comportamento nativo de "abrir em nova aba" com Ctrl/Cmd+clique continua funcionando) em vez de interceptar o clique com `router.push()`, ao custo de uma dependência simples da API `fetch({ keepalive })`.

## 8. Invariantes da Seção 2 do MASTER.md

Todas seguidas, sem exceções novas: IDs `UNIQUEIDENTIFIER DEFAULT NEWID()` em `Notificacao`/`PainelToken`; `/api/v1` como prefixo único; toda rota de escrita valida via Zod (`criarPainelTokenSchema`); `rbac.ts` como única fonte de autorização (rotas de tokens do Painel TV exigem `requireRole(["admin"])`; `/painel/dados` e `/eventos` deliberadamente fora do RBAC de usuário, pois são as duas exceções já previstas no próprio SDD §12 — autenticação por token de dispositivo, não por perfil); `LogAuditoria` gravado na mesma transação em toda escrita nova (`criar_painel_token`, `revogar_painel_token`); e-mail sempre via fila BullMQ (comportamento existente, não tocado nesta sprint).

## 9. Pendências para sprints futuras

- RF-TV-03 (filtro de plataformas específicas por painel, não só por setor) — seria necessária uma relação Plataforma↔Setor, hoje inexistente no modelo de dados (ADR-02).
- Migration-runner sem tabela de controle (pendência reafirmada desde S4).
- Migração para Fastify 5.x (pendência desde S6).
- Credenciais reais do Microsoft Graph (pendência desde S1).
- `PainelToken.ultimo_uso_em` é best-effort (não bloqueia a leitura se o UPDATE falhar) — aceitável para uma métrica informativa, mas vale revisar se algum dia virar critério de expiração automática de tokens.
- Anexos, Comentários e Ocorrências (S11) e o restante do roadmap seguem conforme MASTER.md Seção 5.

---

Não iniciei a Sprint S11 nesta sessão, conforme instruído.
