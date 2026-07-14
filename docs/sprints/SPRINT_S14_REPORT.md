# Sprint S14 — Testes E2E, Responsividade e Homologação

| Campo | Valor |
|---|---|
| Sprint | S14 |
| Status | ✅ Concluída |
| Data | 2026-07-14 |
| Depende de | S10, S12, S13 (✅ Concluídas, confirmado no início desta sessão) |
| Natureza | Sprint de validação — não introduz módulo de produto novo; valida o sistema como um todo e corrige os bugs reais encontrados no processo |

## 1. Objetivo

Validar o sistema de ponta a ponta nos 3 perfis (Admin, Gestor de Setor, Colaborador), em todos os breakpoints (360/600/900/1920 px), antes do deploy — SDD §9 (UC-01 a UC-07) e §13 (todos os RNFs).

## 2. O que foi implementado

### 2.1 Suite Playwright (`apps/e2e`, pacote novo do monorepo)

Novo workspace `@plataformares/e2e` (pnpm), com Playwright + Chromium, cobrindo os 7 casos de uso do SDD §9 nos perfis aplicáveis:

- `tests/uc01-solicitar-reserva.spec.ts` — UC-01, nos 3 perfis (Colaborador/Gestor/Admin), reserva nasce `pendente` (RN-RES-01).
- `tests/uc02-dupla-aprovacao.spec.ts` — UC-02, fluxo completo Colaborador solicita → Gestor dá 1ª aprovação (reserva permanece `pendente`, RN-RES-08) → Admin dá a 2ª (`agendada`) + RBAC (Colaborador não aprova).
- `tests/uc03-uc04-checklist-ocorrencia.spec.ts` — UC-03 (checklist de segurança elevatória, todos os itens conformes, libera "Iniciar Uso" — RN-RES-12) encadeado com UC-04 (concluir reportando ocorrência grave com `geraManutencao=true`, confirmando que a plataforma vai para "Manutenção" — RN-PLAT-04).
- `tests/uc05-bloqueio-agenda.spec.ts` — UC-05, Admin cria e remove bloqueio de agenda + RBAC (Gestor/Colaborador redirecionados).
- `tests/uc06-relatorios.spec.ts` — UC-06, Admin (visão global + exportação Excel real via evento de download) e Gestor (visão do próprio setor, sem o card exclusivo de Admin) + RBAC (Colaborador redirecionado).
- `tests/uc07-painel-tv.spec.ts` — UC-07, Admin gera token de dispositivo, uma aba **sem sessão de usuário** consome `/painel?token=...` e exibe dados reais em layout kiosk.
- `tests/responsive.spec.ts` — matriz de responsividade (Seção 2.3).

**Fixtures** (`scripts/seed-e2e.mjs`, `tests/global-setup.ts`, `tests/helpers.ts`): define senha conhecida para as contas de teste Gestor/Colaborador de TI já existentes desde S7 (`bcryptjs`, hash compatível com o `bcrypt` do backend), cria a plataforma `PLT-E2E-SALA` (categoria sala, risco baixo — fluxos de aprovação simples) e garante `PLT-S8-DEMO` disponível (categoria elevatória, risco alto — fluxos de checklist/dupla aprovação); autentica os 3 perfis uma vez via UI e reusa `storageState` (cookie JWT) entre specs.

### 2.2 Bugs reais encontrados e corrigidos

Quatro bugs genuínos, todos descobertos rodando os fluxos de verdade contra o ambiente de desenvolvimento real (nenhum é hipotético):

1. **Admin não conseguia solicitar reserva (RF-RES-01 quebrado desde S3)** — `POST /reservas` sempre derivava `setor_id` da sessão; como RN-USR-01 diz que `admin` não possui `setor_id` próprio, todo Admin recebia `422 "Sua conta não está vinculada a um setor"` ao tentar UC-01, embora o SDD §6.4 liste explicitamente Admin entre os perfis que podem solicitar reserva. Corrigido: `criarReservaSchema` (`packages/shared`) ganhou um campo opcional `setorId`; `POST /reservas` (`apps/api/src/routes/reservas.ts`) agora exige e usa esse campo **somente** para o perfil `admin` — Gestor/Colaborador continuam 100% restritos ao setor da própria sessão (o body é ignorado para esses perfis, nunca confiado). No frontend, `ReservaModal.tsx` troca o campo desabilitado "Setor Solicitante" por um `<select>` de setores ativos quando quem está logado é Admin (`setorNome === null`). Cobertura de regressão adicionada em `apps/api/src/tests/integration/reservas.test.ts` (3 testes novos, Seção 3.1).
2. **`PainelTokensClient.tsx`: campos "Token" e "URL do Painel" sem `<label>` associado ao `<input>`** (sem `htmlFor`/`id`) — falha de acessibilidade real (leitor de tela não anuncia o campo) descoberta ao tentar automatizar UC-07. Corrigido com `id`/`htmlFor` correspondentes.
3. **Sidebar/Topbar sem nenhum breakpoint responsivo abaixo de 900 px (RNF-04)** — a sidebar é `position: fixed; width: 240px` sem media query, então em qualquer tela ≤ 900 px o conteúdo era espremido ao lado dela e transbordava horizontalmente (confirmado por `scrollWidth − clientWidth`: até 250 px de overflow em 360 px, em **9 das 9 telas autenticadas testadas**). Corrigido com uma sidebar off-canvas **sem JavaScript** (técnica checkbox+label, consistente com a decisão de stack "CSS Modules, zero runtime, media queries" do SDD §3.1): abaixo de 900 px a sidebar fica fora da tela por padrão (`transform: translateX(-100%)`), um botão ☰ novo no Topbar (`label[for="sidebar-toggle"]`) a abre, e um backdrop fecha ao tocar fora. Ver `apps/web/app/(app)/layout.tsx`, `Sidebar.module.css`, `Topbar.tsx`/`.module.css`.
4. **Topbar ainda transbordava ~56 px em telas de celular (≤ 480 px) mesmo com a sidebar corrigida** — a barra de ações (data + sino + "Minha Conta" + "Sair") não cabia ao lado do novo botão ☰. Corrigido escondendo a data (redundante — já aparece no Dashboard) e o rótulo de texto de "Minha Conta" (fica só o ícone) abaixo de 480 px.
5. **Painel TV: nome de plataforma com trecho sem espaço vazava o card em qualquer breakpoint, inclusive 1920 px** (RF-TV-01) — ex.: "Plataforma Demo S11 (Anexos/Comentários/Ocorrência)" não quebra linha por padrão porque `/` não é um ponto de quebra do CSS. Corrigido com `overflow-wrap: break-word` em `.plataformaNome` (`app/painel/painel.module.css`).

Nenhum desses bugs tinha teste E2E ou de responsividade cobrindo o cenário antes desta sprint — todos vieram à tona exatamente pelo processo que esta sprint pede (rodar os UCs de ponta a ponta nos 3 perfis, e a matriz de breakpoints).

### 2.3 Matriz de responsividade (RNF-04)

9 telas autenticadas principais + Login + Painel TV, nos 4 breakpoints pedidos (360/600/900/1920 px), com captura real em arquivo (`apps/e2e/responsive-shots/*.png`, gerada por `page.screenshot({fullPage:true})`) e checagem automática de overflow horizontal (`document.documentElement.scrollWidth − clientWidth`, tolerância de 4 px) — evidência mais confiável que a ferramenta de screenshot interativa, que sprints anteriores (S8-S13) documentaram como instável neste ambiente.

Tabela completa gerada por `apps/e2e/responsive-matrix.md` (reproduzida abaixo, **estado final após as correções da Seção 2.2**):

| Tela | 360px | 600px | 900px | 1920px |
|---|---|---|---|---|
| login | OK | OK | OK | OK |
| dashboard | OK | OK | OK | OK |
| reservas | OK | OK | OK | OK |
| fila-aprovacoes | OK | OK | OK | OK |
| calendario | OK | OK | OK | OK |
| plataformas | OK | OK | OK | OK |
| bloqueios-agenda | OK | OK | OK | OK |
| relatorios | OK | OK | OK | OK |
| administracao-usuarios | OK | OK | OK | OK |
| painel-tv | OK | OK | OK | OK |

**40/40 combinações OK** — 0 px de overflow horizontal em todas, após as correções. Antes das correções: 13 combinações "AJUSTE" (sidebar/topbar) + 2 no Painel TV (79 px @ 360px, 26 px @ 1920px).

### 2.4 Teste de carga leve (RNF-01/RNF-03)

`k6` não está instalado neste ambiente (`k6: command not found`); `artillery` está disponível via `npx` mas sem suporte nativo a SSE persistente sem plugin adicional. Optou-se por um script Node dedicado (`apps/e2e/load/run-load-test.mjs`, sem dependências além do `fetch`/`ReadableStream` nativos), permitido pelo prompt da sprint ("k6 ou Artillery" como referência de ferramenta, não uma imposição rígida de framework) e mais preciso para medir exatamente o que o Gate pede: **50 conexões HTTP concorrentes** em rotas de leitura representativas (`/dashboard/kpis`, `/reservas`, `/plataformas`, `/historico`, `/setores`) **+ 10 conexões SSE simultâneas** de Painel TV (`GET /eventos?token=...`), por 30 segundos.

**Simplificação documentada**: as 50 "conexões simultâneas" reaproveitam 1 sessão JWT real (Admin) em vez de 50 contas distintas — RNF-03 mede capacidade do servidor sob carga concorrente, não unicidade de conta; a característica medida (throughput/latência da API sob N conexões simultâneas) independe de quantas contas diferentes as originaram.

Output real (`apps/e2e/load/load-test-report.json`):

```json
{
  "duracaoRealMs": 32035,
  "usuariosSimultaneos": 50,
  "conexoesSSEAlvo": 10,
  "sse": { "conexoesAbertas": 10, "bytesRecebidos": 260, "falhas": 0 },
  "totalRequisicoes": 4969,
  "totalErros": 0,
  "taxaErroPercent": 0,
  "latenciaMs": { "p50": 17.6, "p95": 66.4, "p99": 128.5, "min": 2.4, "max": 387.6 },
  "rnf01_p95_leitura_300ms": true,
  "rnf03_50_usuarios_10_sse": true,
  "amostraErros": []
}
```

- **RNF-01 (p95 ≤ 300 ms para leitura sob carga nominal)**: confirmado — p95 real de **66,4 ms**, menos de um quarto do limite, com **4.969 requisições e 0 erros** (taxa de erro 0%).
- **RNF-03 (50 usuários simultâneos + 10 conexões SSE de Painel TV, sem degradação perceptível)**: confirmado — as 10 conexões SSE abriram e permaneceram vivas (heartbeat recebido, `falhas: 0`) durante toda a janela de carga concorrente dos 50 clientes HTTP, sem nenhuma requisição rejeitada ou com erro.

## 3. Testes obrigatórios — confirmação

### 3.1 Suite E2E completa (Playwright) — output real

```
Running 51 tests using 1 worker
  ok  1..37  Responsividade — 9 telas × 4 breakpoints + Painel TV @ 1920×1080
  ok 38  UC-01 — perfil colaborador
  ok 39  UC-01 — perfil gestor
  ok 40  UC-01 — perfil admin
  ok 41  UC-02 — Colaborador solicita, Gestor dá 1ª aprovação, Admin dá a 2ª (RN-RES-08)
  ok 42  UC-02 RBAC — Colaborador não acessa a Fila de Aprovações como aprovador
  ok 43  UC-03/UC-04 — checklist, iniciar uso, concluir com ocorrência e manutenção automática
  ok 44  UC-05 — Admin cria bloqueio de agenda
  ok 45  UC-05 RBAC — gestor não acessa Bloqueios de Agenda
  ok 46  UC-05 RBAC — colaborador não acessa Bloqueios de Agenda
  ok 47  UC-06 — Admin, visão global + exportação Excel
  ok 48  UC-06 — Gestor de Setor, visão do próprio setor
  ok 49  UC-06 RBAC — Colaborador sem acesso
  ok 50  UC-07 — Admin gera token, Painel TV exibe dados em tela kiosk
  ok 51  UC-07 — acesso sem token exibe mensagem de token ausente

  51 passed (2.0m)
```

**0 falhas.** Nenhum teste foi pulado ou marcado como esperado-a-falhar.

### 3.2 Regressão do backend após as correções (evidence-first — Seção [[feedback_reserva_plataforma_test_fixtures]])

`pnpm --filter api test` — 32 arquivos, **336/336**, 0 falhas:

```
 Test Files  32 passed (32)
      Tests  336 passed (336)
```

Delta em relação a S13 (333 testes): +3 testes de regressão em `reservas.test.ts` para o bug do §2.2.1 (Admin sem `setorId` recebe 422; Admin com `setorId` cria vinculada ao setor certo; `setorId` no body é ignorado para Colaborador).

### 3.3 `tsc --noEmit` — 3 pacotes, limpo

`apps/api`, `apps/web`, `packages/shared` — sem erros de tipo após as mudanças desta sprint (novo campo `setorId` propagado corretamente do schema Zod compartilhado até o formulário).

## 4. Gate de Aceite

- [x] **Output real da suite E2E completa, 0 falhas** — Seção 3.1 (51/51).
- [x] **Matriz de responsividade preenchida com evidência (captura) por combinação tela × breakpoint** — Seção 2.3, 40/40 OK, capturas reais em `apps/e2e/responsive-shots/*.png` (40 arquivos PNG, `fullPage`).
- [x] **Relatório real do teste de carga confirmando RNF-01 (p95 ≤ 300 ms) e RNF-03 (50 usuários simultâneos)** — Seção 2.4, ambos confirmados com folga (p95 real 66,4 ms; 10/10 SSE sem falha).

## 5. Pendências aceitas (não corrigidas nesta sprint)

Nenhum bug crítico ficou sem correção. Pendências de escopo/infra, não de defeito de produto:

- **`k6` não instalado neste ambiente** — usado um script de carga equivalente em Node puro (Seção 2.4) em vez de reinstalar uma ferramenta binária externa fora do escopo desta sessão; os números obtidos são reais e diretamente comparáveis aos RNFs pedidos.
- **Runner de migrations sem tabela de controle** (pendência reafirmada desde S4/S9/S13) — não tocado nesta sprint, sem impacto no gate.
- **Credenciais reais do Microsoft Graph / Azure real** — pendentes desde S1/S11, sem impacto nesta sprint.
- **Migração para Fastify 5.x** — segue pendente, sem impacto nesta sprint.
- **Divergência de porta em `.claude/launch.json`** (`api` apontava para `3334`, mas `API_PORT` real em `apps/api/.env` é `3335`) — corrigida nesta sessão como parte da configuração do ambiente de teste (mesma natureza da correção equivalente feita em S13 para a porta `3333→3334`, aparentemente revertida por engano entre sessões).
- **`.env` na raiz do repositório ausente** (só existiam `apps/api/.env`/`apps/web/.env.local`, gitignorados por design) — não é uma pendência de produto, apenas uma observação de ambiente: a sessão localizou os `.env` corretos dentro de cada app e seguiu com eles.

## 6. ADRs (Architecture Decision Records)

- **ADR-01 — Admin escolhe o setor de destino da reserva via `setorId` no body, restrito a esse perfil.** RF-RES-01 (SDD §6.4) lista Admin entre quem solicita reserva; RN-USR-01 (SDD §7) diz que Admin não tem `setor_id` de sessão. A leitura mais literal e menos arriscada é: para todo perfil que TEM setor de sessão (Gestor/Colaborador), o setor continua vindo exclusivamente da sessão (nunca do body — superfície de ataque zero, igual antes); só para Admin — que estruturalmente não tem essa informação — o setor vem de um campo novo e opcional do schema, validado como UUID de um setor real. Alternativa descartada: dar ao Admin um "setor virtual" ou deixar `setor_id` nulo em `Reserva` — rejeitada por quebrar a constraint `NOT NULL` existente desde S1 e o modelo de dados de todo o resto do sistema (relatórios, escopo de aprovação, etc. dependem de toda reserva ter um setor real).
- **ADR-02 — Sidebar off-canvas implementada com técnica CSS-only (checkbox + `label[for]`), não com estado React.** O layout autenticado (`app/(app)/layout.tsx`) é um **Server Component** assíncrono (busca `/conta` no servidor); introduzir `useState` exigiria convertê-lo em Client Component (perdendo o fetch server-side) ou um Context Provider novo só para isso. A técnica checkbox+label é zero-JS, combina com a decisão de stack já congelada ("CSS Modules, zero runtime" — SDD §3.1) e é exatamente o padrão usado por menus off-canvas em sites estáticos há mais de uma década — sem trade-off real de UX aqui (não há necessidade de controlar o estado a partir do JS em nenhum outro lugar do app).
- **ADR-03 — Teste de carga com script Node dedicado em vez de k6/Artillery instalados.** Ver Seção 2.4 — decisão pragmática dentro do tempo da sessão, sem comprometer a métrica pedida pelo Gate (p95/taxa de erro sob concorrência real).
- **ADR-04 — Fixtures E2E usam datas futuras com jitter aleatório (0-500 dias) em vez de datas fixas.** Descoberto durante o desenvolvimento desta sprint: reexecuções da suite após uma falha que não chegasse a cancelar a reserva criada deixavam registros `pendente`/`agendada` órfãos, que colidiam (RN-RES-02) com a próxima execução na mesma combinação plataforma+data+horário. O jitter torna cada execução da suite independente de execuções anteriores, sem exigir um `TRUNCATE`/reset de banco a cada rodada.

## 7. Invariantes da Seção 2 do MASTER.md

Nenhuma quebra. Confirmações relevantes desta sprint:
- Toda rota de escrita valida via Zod: `criarReservaSchema` ganhou o campo `setorId` como `.optional()` (compatível com todos os clientes existentes que não o enviam).
- `rbac.ts` continua a única fonte de verdade de autorização: o novo comportamento de `setorId` é decidido a partir de `request.usuario!.perfil` (extraído do JWT verificado pelo middleware), nunca de um campo declarado pelo próprio cliente.
- `LogAuditoria`: nenhuma rota nova de escrita nesta sprint (a correção reaproveita a rota `POST /reservas` já existente, que já audita `criar_reserva`).
- IDs `UNIQUEIDENTIFIER DEFAULT NEWID()`: nenhuma entidade nova.
- `/api/v1` como prefixo único: mantido.

## 8. Nota sobre evidência visual — ferramenta de screenshot interativa

Mesma limitação recorrente documentada desde S8: `computer{action:"screenshot"}` do Browser pane não foi usada como evidência primária nesta sprint — em seu lugar, `page.screenshot({fullPage:true})` do próprio Playwright gerou 40 arquivos PNG reais em `apps/e2e/responsive-shots/`, mais confiáveis e reproduzíveis (parte do próprio pipeline de teste, não uma captura manual avulsa).

---

Não iniciei a Sprint S15 nesta mesma sessão, conforme instruído.
