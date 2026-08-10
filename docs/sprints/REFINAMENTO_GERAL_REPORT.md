# Refinamento Geral — Frontend (UX/Performance) e Backend (Correções, Lacunas, Latência)

| Campo | Valor |
|---|---|
| Escopo | Revisão transversal de todo o sistema, pós-S14 |
| Status | ✅ Concluído |
| Data | 2026-07-30 |
| Natureza | Não introduz módulo novo — corrige defeitos, fecha lacunas e reduz latência no que já existe |

## 1. Ponto de partida real (importante)

A suíte do backend **não estava verde** ao iniciar esta sessão, apesar de a S14 reportar
336/336. Execução de baseline, antes de qualquer alteração:

```
 Test Files  3 failed | 30 passed (33)
      Tests  5 failed | 338 passed (343)
```

A causa principal: `GET /api/v1/plataformas` respondia **500**. Uma plataforma
(`PLT-E2E-SALA`) tinha imagem cadastrada e a geração da URL assinada falhava com o Blob
Storage indisponível — derrubando a rota inteira (ver §2.1). O trabalho em curso de
redesenho do Dashboard/ficha técnica de plataforma introduziu essa dependência sem
proteção.

**Estado final: 356/356 testes passando, 34 arquivos** (13 testes novos de regressão).

---

## 2. Backend — defeitos corrigidos

### 2.1 Falha de armazenamento derrubava listagens inteiras (500)

`mapPlataforma` chamava `armazenamentoService.gerarUrlAcesso` direto. Blob Storage fora do
ar (ou connection string ausente) ⇒ **500 em `GET /plataformas`**, que por sua vez derruba
a tela de Frota, o Dashboard e o seletor de plataforma do formulário de reserva — tudo por
causa de uma miniatura.

- Novo `gerarUrlAcessoOuNulo()` em `storage.service.ts`: falha vira `imagemUrl: null`
  (a UI já trata como "Sem imagem") e registra uma advertência única por requisição.
- Aplicado também em `anexos.ts` e `checklist.ts` — no checklist isso é crítico: uma foto
  inacessível impedia a leitura do checklist que **decide se a reserva entra em uso**.

### 2.2 Condição de corrida na criação de reserva (RN-RES-02)

A checagem de conflito rodava **antes** de `transaction.begin()`. Duas requisições
simultâneas para a mesma plataforma/horário liam "livre" ao mesmo tempo e **ambas
inseriam** — violando a regra de não sobreposição. Janela pequena, mas real, e sem
nenhum teste cobrindo.

Correção: a validação de disponibilidade passou para **dentro da transação**, com lock de
intervalo (`WITH (UPDLOCK, HOLDLOCK)`) sobre `(plataforma_id, data)`. Teste novo prova o
comportamento:

```
✓ duas requisições simultâneas para o MESMO horário criam apenas uma reserva
  → statuses [201, 409]; COUNT no banco = 1
```

### 2.3 Recarga da reserva criada por heurística frágil

Após o commit, a reserva única era reencontrada por
`(plataforma, solicitante, data, hora_inicio) ORDER BY criado_em DESC` — podia devolver a
reserva errada com duas criações no mesmo milissegundo. Agora usa os IDs de
`OUTPUT INSERTED.id`.

### 2.4 Logout não encerrava a sessão em produção

`reply.clearCookie("token", { path: "/" })` omitia `secure`/`sameSite`/`httpOnly`. O
navegador só remove o cookie quando os atributos de escopo batem com os da criação — em
produção (`secure: true`, `sameSite: strict`) **a sessão continuava válida após "Sair"**.
Corrigido para reutilizar `COOKIE_OPTIONS`. Teste de regressão incluído.

### 2.5 Um cliente SSE morto interrompia a entrega para todos

`publicarEventoGlobal`/`publicarEventoUsuario` percorriam o `Map` de clientes escrevendo
sem tratamento de erro. Um socket já encerrado fazia `write` lançar e **abortava o laço**,
deixando todos os clientes seguintes sem o evento. Agora a falha é isolada por cliente e o
cliente morto é descartado. O heartbeat ganhou a mesma proteção, e `reply.raw` passou a
escutar `close`/`error` — antes, quedas que não disparavam `request.close` deixavam um
timer de heartbeat rodando para sempre a cada reconexão do backoff do frontend.

### 2.6 `GET /reservas` sem validação de entrada

Único ponto do sistema fora do padrão Zod da Seção 2 do MASTER.md. `?status=xpto`
devolvia lista vazia sem explicação; `?data=abc` chegava ao driver como `sql.Date`
inválido e virava **500**. Agora usa `listarReservasQuerySchema` (422 com detalhes).

### 2.7 `Plataforma.status = 'reservada'` com fim de intervalo inclusivo

`CONVERT(time, GETDATE()) BETWEEN r.hora_inicio AND r.hora_fim` marcava a plataforma como
"Reservada" no minuto exato do término — incoerente com a regra de adjacência de
RN-RES-02, que permite outra reserva começar nesse instante. Trocado por
`>= hora_inicio AND < hora_fim`.

### 2.8 Utilização 30d podia ficar negativa

`DATEDIFF(MINUTE, COALESCE(hora_inicio_real, hora_inicio), COALESCE(hora_fim_real, hora_fim))`
mistura início real com fim planejado numa reserva `em_uso`; se o uso começou depois do fim
previsto, a duração era negativa e **subtraía** do total. Guardado com `CASE`.

### 2.9 Auditoria — leitura defensiva

`JSON.parse(row.detalhes)` sem proteção. Hoje a constraint `CK_LogAuditoria_detalhes_json`
(migration 0001) garante JSON válido, então **não era uma falha explorável** — mas a
garantia vive só no banco. Adicionada tolerância (defesa em profundidade) e teste que
documenta honestamente o papel da constraint.

### 2.10 Pool de banco sem tuning e sem recuperação

- Padrão do driver: **10 conexões**. Uma única tela (Dashboard) dispara 8 requisições em
  paralelo e várias rotas fazem 3–5 consultas concorrentes cada — sob RNF-03 (50 usuários)
  as requisições enfileiravam esperando o pool, inflando o p95 sem o banco estar ocupado.
  Agora: `max 25`, `min 2`, timeouts explícitos de conexão/consulta.
- **Falha na conexão inicial ficava em cache como promise rejeitada**: a API só voltava a
  funcionar após restart, mesmo com o banco já saudável. Agora o cache é limpo no erro.

---

## 3. Backend — segurança

| Lacuna | Correção |
|---|---|
| Código de 6 dígitos (ativação/reset) com tentativas ilimitadas por 15 min | `checarRateLimitCodigo` — 8 tentativas / 15 min por e-mail+tipo |
| `POST /recuperar-senha` sem limite — um e-mail enfileirado por chamada | `checarRateLimitSolicitacaoCodigo` — 3 / 10 min, resposta genérica mantida |
| Usuário travado no rate limit de login mesmo após redefinir a senha | Redefinição bem-sucedida limpa o contador de login |
| Erros não tratados vazavam no formato padrão do Fastify | `setErrorHandler` — envelope `{ erro }` único; mensagem interna nunca vaza em produção |
| Rota inexistente devolvia formato diferente do resto da API | `setNotFoundHandler` com `{ erro }` |
| Frontend Next servido sem nenhum header de segurança | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` + `poweredByHeader: false` |

---

## 4. Backend — latência e eficiência

### 4.1 Paginação nas listagens (pendência aberta desde a S3)

`GET /reservas`, `GET /historico` e `GET /auditoria` devolviam a tabela inteira
(`/auditoria` com um `TOP 500` fixo que **truncava silenciosamente**, sem o Admin saber que
havia mais). Agora aceitam `limit`/`offset` com teto, e o total real vai em headers:

```
X-Total-Count: 43   X-Limit: 50   X-Offset: 0
```

Contrato **aditivo**: o corpo continua sendo o array de itens — nenhum cliente existente
quebra. O total sai da mesma varredura via `COUNT(*) OVER()`, sem segunda query.

> **Detalhe que quase passou:** headers customizados não são legíveis pelo JavaScript em
> respostas cross-origin sem `exposedHeaders`. Como o front roda em `:3000` e a API em
> `:3335`, isso vale inclusive em desenvolvimento — `Access-Control-Expose-Headers`
> configurado e verificado no navegador (`X-Total-Count: "43"` legível).

### 4.2 Migration `0014_indices_performance.sql`

Cinco índices, cada um a partir de uma consulta concreta:

| Índice | Consulta que ele resolve |
|---|---|
| `IX_Reserva_plataforma_data_status` | Checagem de conflito de RN-RES-02 — roda em toda criação, em cada uma das até 12 ocorrências de uma série, e a cada digitação no formulário. É também o índice sobre o qual o novo lock de intervalo é tomado |
| `IX_Notificacao_usuario_naolida` (filtrado) | Contador do sino — o dado mais consultado do sistema |
| `IX_LogAuditoria_criado_em` | Tela de Auditoria, sobre a tabela que mais cresce |
| `IX_BloqueioAgenda_periodo` | RN-RES-11, checada junto com o conflito |
| `IX_Ocorrencia_plataforma_criado` | `OUTER APPLY` do card da frota, uma vez por linha da listagem |

### 4.3 SAS do Blob Storage sem ida à rede

`gerarUrlAcesso` chamava `getContainerClient()`, que executa `createIfNotExists()` — **uma
chamada de rede ao Blob Storage por arquivo**, ou seja, uma por linha em toda listagem de
plataformas/anexos. Assinar um SAS é HMAC local. Removida a ida à rede.

### 4.4 Puppeteer com navegador reaproveitado (pendência do ADR-03 da S13)

Cada exportação em PDF subia e derrubava um Chromium inteiro. O custo dominante é o
start-up, não a renderização — a ponto de **o teste de exportação estourar o timeout de
20s** com o processo frio (uma das 5 falhas da baseline). Agora há uma instância única
reaproveitada, com reconstrução automática se o processo morrer, e encerramento explícito.

### 4.5 Desligamento gracioso

Não existia. Ao reiniciar a API, requisições em andamento eram cortadas, conexões do pool
ficavam penduradas até o timeout do servidor e **o Chromium sobrevivia como processo órfão
a cada ciclo**. Agora `SIGTERM`/`SIGINT` fecham servidor → pool → navegador, nessa ordem.

### 4.6 Consultas redundantes

`POST /reservas` fazia uma segunda consulta só para listar os e-mails dos Admins — os
mesmos registros já vinham da consulta de aprovadores elegíveis. Removida.

---

## 5. Runner de migrations — pendência aberta desde a S4, fechada

Reafirmada em S5, S6, S7, S9 e S13. O runner antigo tinha três problemas graves:

1. **Sem tabela de controle** — reexecutava todos os arquivos a cada chamada e falhava no
   primeiro `CREATE TABLE` de algo existente. Consequência prática: **todas as migrations
   de S4 em diante foram aplicadas à mão via `sqlcmd`**, sem registro do que já rodou em
   cada ambiente. Inviável para o deploy da S15.
2. **Não entendia `GO`** — separava só por `;`, então as linhas `GO` iam ao servidor como
   SQL. Justamente as migrations que precisam de `GO` (0004, 0005, 0007) eram as
   impossíveis de aplicar pelo runner.
3. **`migrate:down` revertia TUDO** de uma vez — bom para o teste up/down de uma sprint,
   catastrófico se rodado por engano num ambiente com dados.

Agora: tabela `SchemaMigracao` (nome + checksum + data), aplicação apenas do pendente,
**cada migration numa transação**, `GO` tratado como separador de lote, aviso quando um
arquivo já aplicado é editado, e quatro comandos:

```bash
pnpm migrate:status              # o que já foi aplicado
pnpm migrate:up                  # aplica só o pendente
pnpm migrate:down [--tudo]       # reverte a última (ou todas, explicitamente)
pnpm migrate:baseline [arquivo]  # adota banco já provisionado à mão, sem reexecutar
```

Validado no banco de desenvolvimento: `baseline 0013` → `up` → `down` → `status` → `up`.

---

## 6. Frontend — o que estava quebrado

### 6.1 Não havia como sair do sistema

O bloco de conta do Topbar tinha sido esvaziado e depois removido. Resultado: **nenhum
caminho em todo o app para encerrar a sessão nem para abrir "Minha Conta"** — a rota
`/conta` existia, mas nada apontava para ela (a Sidebar também não tem o item). O CSS das
classes `.accountLink`/`.logoutBtn`/`.userBlock` continuava no arquivo, órfão.

Restaurado como menu acessível (`aria-haspopup`/`aria-expanded`, fecha por ESC e clique
fora). Validado no navegador: clique em "Sair" → redirecionado para `/login` e
`document.cookie` sem `token`.

### 6.2 Dois itens do menu acendiam ao mesmo tempo

O item ativo era decidido por `pathname === href.split("?")[0]`, então "Reservas"
(`/reservas`) e "Checklists NR-18/35" (`/reservas?status=agendada`) ficavam **ambos**
destacados. Agora a querystring também é comparada. Verificado: em
`/reservas?status=agendada` só "Checklists NR-18/35" fica ativo; em `/reservas`, só
"Reservas".

### 6.3 Breadcrumb dizia "PlataformaRes" em 9 telas

O mapa de títulos cobria três rotas. Calendário, Histórico, Relatórios, Fila de
Aprovações, Bloqueios, Painel TV e as quatro telas de Administração exibiam o nome do
sistema no lugar do próprio nome. Mapa completo, resolvido por prefixo.

### 6.4 Responsividade: a correção da S14 nunca surtiu efeito

Medido **159px de transbordo horizontal a 360px** no Dashboard. Duas causas:

- **Ordem de cascata no `Topbar.module.css`**: as media queries da S14 estavam declaradas
  **no topo** do arquivo, antes das regras base de `.clock`/`.userInfo`. Mesma
  especificidade ⇒ a regra declarada depois vence. Os `display: none` da correção **nunca
  foram aplicados**, embora estivessem no arquivo desde a S14. Movidas para o fim.
- **Dashboard redesenhado depois da matriz da S14**: botões do hero lado a lado, régua de
  11 horários e tabela de ranking de 4 colunas. Corrigidos com empilhamento, rótulos
  alternados e rolagem interna da tabela.

Resultado medido após a correção: **overflow 0** a 360px em `/dashboard`, `/reservas` e
`/administracao/auditoria`.

### 6.5 Uma conexão SSE por componente

Ao ligar mais telas ao canal de eventos, cada `useEventosSSE` abria seu **próprio**
`EventSource`. Com o sino sempre montado no Topbar mais a tela atual, seriam 2–3 conexões
permanentes por aba. Navegadores limitam ~6 conexões por origem em HTTP/1.1 e conexões SSE
nunca terminam — algumas abas esgotariam o orçamento e travariam as requisições comuns.

Reescrito como **canal compartilhado por token**: os componentes assinam e desassinam de
uma única conexão, encerrada só quando o último consumidor sai. Verificado no navegador:
navegar de `/reservas` para `/calendario` abre **0** novas conexões.

### 6.6 `apiFetch` enviava `Content-Type` sem corpo

Raiz de um bug que apareceu na S4, voltou na S10 e obrigava todo chamador a passar
`body: JSON.stringify({})` defensivamente. O header agora só é enviado quando há corpo.
Junto: `ApiRequestError` com status HTTP e `detalhes`, mensagem específica para falha de
rede, e `apiDownload` centralizando os downloads.

> A detecção de "sem permissão" na Fila de Aprovações era feita procurando a substring
> `"permiss"` na mensagem de erro — qualquer ajuste de texto no backend quebraria a tela
> em silêncio. Agora usa o status HTTP.

`apiDownload` também corrige um defeito real nos downloads: o `<a>` nunca era inserido no
DOM e o object URL era revogado no mesmo tick do `click()` — Firefox e Safari cancelam o
download nessa condição.

---

## 7. Frontend — UX, acessibilidade e eficiência

**Acessibilidade**
- Linhas de tabela clicáveis eram acionáveis **só com mouse** (`onClick` num `<tr>`): quem
  navega por teclado não conseguia abrir nenhuma reserva. Agora são focáveis, respondem a
  Enter/Espaço e têm rótulo descritivo ("Detalhe da reserva de X em DD/MM, HH:MM às HH:MM").
- `useModalAcessivel` aplicado aos 5 modais: `role="dialog"`, `aria-modal`,
  `aria-labelledby`, foco inicial no primeiro campo, **armadilha de foco** (antes era
  possível tabular para os campos do fundo), trava de rolagem e **devolução do foco a quem
  abriu**. Verificado no navegador, incluindo o retorno do foco ao botão "Nova Reserva".
- `role="alert"` nos erros (14 componentes) e `aria-live` no alerta de conflito, que
  aparece sozinho após o debounce.
- Link "Pular para o conteúdo", `aria-current="page"` na navegação, `scope="col"` nos
  cabeçalhos, rótulos em todos os filtros.
- Foco visível global (`:focus-visible`) — vários componentes faziam `outline: none` sem
  nada no lugar. Campos desabilitados agora parecem desabilitados.
- `prefers-reduced-motion` respeitado; alvos de toque ≥36px no celular.

**Percepção de velocidade**
- O debounce de 250ms cobria a busca inteira: escolher um status, uma data ou até o
  **primeiro carregamento** esperavam sem motivo. Isolado no campo de texto (`useDebounce`).
- Esqueleto de carregamento na tabela de Reservas — antes ela colapsava para uma linha de
  texto e voltava, deslocando o layout a cada busca.
- Requisições em voo são canceladas ao trocar de filtro (`AbortController`) — respostas
  fora de ordem podiam sobrescrever a lista com o resultado de um filtro já abandonado.
- Layout autenticado: `/conta` e `/dashboard/kpis` eram buscados **em série** em toda
  navegação. Agora em paralelo — um round-trip a menos por página.

**Menos trabalho inútil**
- Dashboard recarregava **8 rotas a cada 60s incondicionalmente**, inclusive com a aba em
  segundo plano. Agora é dirigido por eventos SSE (com agrupamento de rajadas — criar uma
  série publica até 12 eventos), o intervalo virou rede de segurança de 180s, pausa quando
  a aba está oculta e sincroniza ao voltar.
- Reservas, Frota e Fila de Aprovações passaram a atualizar em tempo real. Na Fila isso
  evita um erro concreto: uma reserva já decidida por outro aprovador continuava listada e
  retornava 409 ao tentar decidir de novo.
- Imagens da frota com `loading="lazy"`/`decoding="async"` e fallback quando o SAS expira.

**Correções de conteúdo**
- O seletor de plataforma do formulário de reserva excluía apenas as `inativa`. As em
  **manutenção** apareciam e o usuário só descobria a recusa (RN-PLAT-04) depois de
  preencher tudo. Verificado: as 2 plataformas em manutenção sumiram da lista.
- Busca de reservas agora cobre o **motivo** (o Histórico já cobria) — digitar um trecho
  do motivo não encontrava nada.
- Auditoria exibe a coluna **Detalhes**, que a API já devolvia desde a S12 e nenhuma
  coluna mostrava: era justamente o campo que diz *o que* mudou.
- Período com data final anterior à inicial: agora é bloqueado no próprio seletor
  (`min`/`max`) e avisado, em vez de devolver lista vazia sem explicação.
- Login: `autoComplete` (o gerenciador de senhas não oferecia preenchimento nem salvava a
  credencial), mostrar/ocultar senha, `router.replace` (voltar no navegador reexibia o
  formulário já autenticado) e `Link` no lugar de `<a>`.
- `HistoricoClient` tipava o perfil como `"admin" | "colaborador"` — um Gestor chegava
  tipado como Colaborador e era repassado assim ao modal que decide as ações por perfil.

---

## 8. Validação

```
 Test Files  34 passed (34)
      Tests  356 passed (356)
```

- Baseline antes das mudanças: **5 falhas / 343**.
- 13 testes novos em `integration/refinamento.test.ts` cobrindo: concorrência na criação,
  recarga por id, paginação nas três rotas, validação de query, envelope de erro, atributos
  do cookie no logout e leitura de auditoria.
- `tsc --noEmit` limpo nos três pacotes.
- `next build` de produção: 21 rotas geradas, sem erro.
- Verificação no navegador real (login, dashboard, reservas, auditoria, modais, logout,
  360px e desktop) — **0 erros de console** em aba limpa.

## 9. Pendências que permanecem (fora do escopo desta revisão)

- Credenciais reais do Microsoft Graph (desde S1) e conta Azure real (desde S11) — o
  código está pronto; falta configuração de infraestrutura.
- Migração para Fastify 5.x (ADR-04 da S6) — 3 advisories remanescentes, com mitigação
  documentada.
- `configuracao.service.ts` com cache em memória de processo único: se a API rodar em
  múltiplas réplicas, migrar para Redis (ADR-04 da S12).
- Tensão entre RF-RES-03 (12 ocorrências) e RN-RES-05 (`max_pendentes_por_setor`, padrão 5)
  — decisão de produto, registrada na S12.
