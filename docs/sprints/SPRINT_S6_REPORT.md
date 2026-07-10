# Sprint S6 — RBAC, Auditoria (Persistência) e Hardening Inicial

| Campo | Valor |
|---|---|
| Sprint | S6 |
| Status | ✅ Concluída |
| Data | 2026-07-10 |
| Depende de | S5 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Sprint de **revisão e fechamento** da Fase 1 (MVP) — sem feature nova |

## 1. Objetivo

Fechar a Fase 1 (MVP) com segurança revisada de ponta a ponta: mapear e testar a matriz RBAC de todas as rotas criadas em S1-S5, auditar a gravação de `LogAuditoria`, configurar headers de segurança e tratar vulnerabilidades de dependências.

## 2. Matriz de rotas x perfil (SDD §2.3 / §11)

Perfis ativos no sistema nesta sprint: **Admin** e **Colaborador**. O terceiro perfil (`gestor_setor`) só é introduzido em S7 — não existe ainda no enum `Usuario.perfil` nem nas rotas, portanto a matriz abaixo cobre 2 perfis, como já registrado no ADR-S4 (S4, reafirmado aqui).

| Rota | Método | Perfil esperado | Mecanismo de aplicação |
|---|---|---|---|
| `/api/v1/health` | GET | Público | nenhum |
| `/api/v1/auth/login` | POST | Público | nenhum |
| `/api/v1/auth/logout` | POST | Público | nenhum |
| `/api/v1/auth/ativar-conta` | POST | Público | nenhum |
| `/api/v1/auth/recuperar-senha` | POST | Público | nenhum |
| `/api/v1/auth/recuperar-senha/confirmar` | POST | Público | nenhum |
| `/api/v1/conta` | GET | Todos autenticados | `autenticar` |
| `/api/v1/conta/senha` | PATCH | Todos autenticados | `autenticar` |
| `/api/v1/dashboard/kpis` | GET | Todos autenticados | `autenticar` |
| `/api/v1/setores` | GET | Todos autenticados | `autenticar` |
| `/api/v1/plataformas` | GET | Todos autenticados | `autenticar` |
| `/api/v1/plataformas` | POST | Admin | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/plataformas/:id` | PUT | Admin | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/plataformas/:id/status` | PATCH | Admin | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/reservas` | POST | Todos autenticados (setor da sessão) | `autenticar` |
| `/api/v1/reservas` | GET | Todos autenticados (escopo por setor) | `autenticar` + filtro SQL condicional |
| `/api/v1/reservas/conflitos` | GET | Todos autenticados | `autenticar` |
| `/api/v1/reservas/:id/aprovar` | POST | Admin (ADR-S4 — `gestor_setor` entra em S7) | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/reservas/:id/rejeitar` | POST | Admin (ADR-S4) | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/reservas/:id/status` | PATCH | Admin (ADR-S4) | `autenticar` + `requireRole(["admin"])` |
| `/api/v1/reservas/:id/cancelar` | POST | Todos autenticados — Admin qualquer setor, Colaborador só o próprio | `autenticar` + checagem inline de escopo |
| `/api/v1/historico` | GET | Todos autenticados (escopo por setor) | `autenticar` + filtro SQL condicional |
| `/api/v1/historico/export` | GET | Todos autenticados (escopo por setor) | `autenticar` + filtro SQL condicional |

23 rotas mapeadas (6 públicas + 17 autenticadas). Todas cobertas pela suite `rbac.test.ts` (ver Seção 4).

## 3. Auditoria de `LogAuditoria` (RN-AUD-01)

Revisão manual de toda rota de escrita criada em S1-S5, confirmando gravação de `LogAuditoria` **na mesma transação** da operação:

| Rota de escrita | Ação registrada | Transação | Situação |
|---|---|---|---|
| `POST /auth/ativar-conta` | `ativar_conta` | Sim | ✅ já conforme |
| `POST /auth/recuperar-senha/confirmar` | `redefinir_senha` | Sim | ✅ já conforme |
| `PATCH /conta/senha` | `trocar_senha` | Sim | ✅ já conforme |
| `POST /plataformas` | `criar_plataforma` | Sim | ✅ já conforme |
| `PUT /plataformas/:id` | `editar_plataforma` | Sim | ✅ já conforme |
| `PATCH /plataformas/:id/status` | `alterar_status_plataforma` | Sim | ✅ já conforme |
| `POST /reservas` | `criar_reserva` | Sim | ✅ já conforme |
| `POST /reservas/:id/aprovar` | `aprovar_reserva` | Sim | ✅ já conforme |
| `POST /reservas/:id/rejeitar` | `rejeitar_reserva` | Sim | ✅ já conforme |
| `PATCH /reservas/:id/status` | `iniciar_uso_reserva` / `concluir_reserva` | Sim | ✅ já conforme |
| `POST /reservas/:id/cancelar` | `cancelar_reserva` | Sim | ✅ já conforme |

**Nenhuma correção de código foi necessária** — todas as rotas de escrita já gravavam `LogAuditoria` corretamente desde as sprints originais. Único ponto documentado (não é uma falha): `POST /auth/recuperar-senha` (a *solicitação* do código, antes da confirmação) não grava `LogAuditoria`, por decisão consistente com a lista explícita de RN-AUD-01 no MASTER.md — a lista cita "redefinição" (a mudança de senha em si), não a solicitação do código; a rota `/recuperar-senha/confirmar`, que efetivamente altera a senha, grava.

## 4. Suite `rbac.test.ts` — matriz completa

Arquivo: [`apps/api/src/tests/integration/rbac.test.ts`](../../apps/api/src/tests/integration/rbac.test.ts).

Cobre as 23 rotas mapeadas: rotas públicas (sem barreira 401), rotas "Todos autenticados" (Admin e Colaborador acessam, sem cookie → 401), rotas restritas a Admin (Colaborador → 403, Admin → 200/201, sem cookie → 401), e a rota de cancelamento com escopo por setor (Colaborador de outro setor → 403, Colaborador do próprio setor e Admin → 200).

Output real (100% das rotas cobertas, 0 falhas):

```
✓ src/tests/integration/rbac.test.ts (50 tests) 2731ms
  RBAC (S6) — rotas públicas, sem barreira de autenticação (6 tests)
  RBAC (S6) — GET /api/v1/conta e PATCH /api/v1/conta/senha (Todos autenticados) (5 tests)
  RBAC (S6) — GET /api/v1/dashboard/kpis (Todos autenticados) (3 tests)
  RBAC (S6) — GET /api/v1/setores (Todos autenticados) (3 tests)
  RBAC (S6) — GET /api/v1/plataformas (Todos autenticados) (3 tests)
  RBAC (S6) — POST/PUT/PATCH /api/v1/plataformas (Admin apenas) (7 tests)
  RBAC (S6) — POST/GET /api/v1/reservas e /reservas/conflitos (Todos autenticados) (7 tests)
  RBAC (S6) — POST /reservas/:id/aprovar e /rejeitar (Admin apenas — ADR-S4) (4 tests)
  RBAC (S6) — PATCH /reservas/:id/status (Admin apenas — ADR-S4) (2 tests)
  RBAC (S6) — POST /reservas/:id/cancelar (Todos autenticados, com escopo por setor) (3 tests)
  RBAC (S6) — GET /api/v1/historico e /historico/export (Todos autenticados, escopo por setor) (6 tests)
```

Suíte completa do backend (`pnpm --filter api test`), 12 arquivos, 0 falhas — **147/147**:

```
✓ src/tests/unit/aprovacao.test.ts (20 tests) 13ms
✓ src/tests/unit/conflito.test.ts (13 tests) 7ms
✓ src/tests/unit/plataforma.test.ts (7 tests) 6ms
✓ src/tests/unit/password.test.ts (10 tests) 1729ms
✓ src/tests/integration/seguranca.test.ts (1 test) 107ms
✓ src/tests/integration/auth.test.ts (4 tests) 969ms
✓ src/tests/integration/plataformas.test.ts (6 tests) 1005ms
✓ src/tests/integration/reservas.test.ts (8 tests) 1416ms
✓ src/tests/integration/historico.test.ts (11 tests) 1564ms
✓ src/tests/integration/aprovacao.test.ts (15 tests) 1664ms
✓ src/tests/integration/auditoria_evidencia.test.ts (2 tests) 2710ms
✓ src/tests/integration/rbac.test.ts (50 tests) 2731ms

 Test Files  12 passed (12)
      Tests  147 passed (147)
```

(94 pré-existentes de S1-S5 + 50 novos de `rbac.test.ts` + 2 novos de `auditoria_evidencia.test.ts` + 1 novo de `seguranca.test.ts` = 147.)

## 5. Query real — `LogAuditoria` populado por tipo de ação (RN-AUD-01)

Teste dedicado [`apps/api/src/tests/integration/auditoria_evidencia.test.ts`](../../apps/api/src/tests/integration/auditoria_evidencia.test.ts) exercita, via API real (não mock), uma ocorrência de cada uma das 12 ações sensíveis já implementadas, e então consulta `LogAuditoria` diretamente. Output real (query `GROUP BY acao`):

```
=== EVIDÊNCIA S6 — LogAuditoria agrupado por ação (query real) ===
┌─────────┬─────────────────────────────┬───────┐
│ (index) │ acao                        │ total │
├─────────┼─────────────────────────────┼───────┤
│ 0       │ 'alterar_status_plataforma' │ 1     │
│ 1       │ 'aprovar_reserva'           │ 1     │
│ 2       │ 'ativar_conta'              │ 1     │
│ 3       │ 'cancelar_reserva'          │ 1     │
│ 4       │ 'concluir_reserva'          │ 1     │
│ 5       │ 'criar_plataforma'          │ 1     │
│ 6       │ 'criar_reserva'             │ 3     │
│ 7       │ 'editar_plataforma'         │ 1     │
│ 8       │ 'iniciar_uso_reserva'       │ 1     │
│ 9       │ 'redefinir_senha'           │ 1     │
│ 10      │ 'rejeitar_reserva'          │ 1     │
│ 11      │ 'trocar_senha'              │ 1     │
└─────────┴─────────────────────────────┴───────┘
```

Linhas reais em ordem cronológica (recorte — IDs e timestamps reais gerados pelo SQL Server de desenvolvimento):

```
=== EVIDÊNCIA S6 — Linhas reais de LogAuditoria (ordem cronológica) ===
┌─────────┬─────────────────────────────┬──────────────┬──────────────────────────────────────┬──────────────────────────────────────┬───────────────────────────┐
│ (index) │ acao                        │ entidade     │ entidade_id                           │ usuario_id                            │ criado_em                 │
├─────────┼─────────────────────────────┼──────────────┼──────────────────────────────────────┼──────────────────────────────────────┼───────────────────────────┤
│ 0       │ 'criar_plataforma'          │ 'Plataforma' │ '30C07223-5BE0-480D-BC21-23BDE546E342'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.340Z  │
│ 1       │ 'editar_plataforma'         │ 'Plataforma' │ '30C07223-5BE0-480D-BC21-23BDE546E342'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.369Z  │
│ 2       │ 'alterar_status_plataforma' │ 'Plataforma' │ '30C07223-5BE0-480D-BC21-23BDE546E342'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.386Z  │
│ 3       │ 'criar_reserva'             │ 'Reserva'    │ 'C86BFC57-9490-4334-B80A-950471511B39'│ '86223184-128F-4BEC-8986-488F96B60BC8'│ 2026-07-10T18:53:43.414Z  │
│ 4       │ 'aprovar_reserva'           │ 'Reserva'    │ 'C86BFC57-9490-4334-B80A-950471511B39'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.435Z  │
│ 5       │ 'iniciar_uso_reserva'       │ 'Reserva'    │ 'C86BFC57-9490-4334-B80A-950471511B39'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.452Z  │
│ 6       │ 'concluir_reserva'          │ 'Reserva'    │ 'C86BFC57-9490-4334-B80A-950471511B39'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.469Z  │
│ 7       │ 'criar_reserva'             │ 'Reserva'    │ '2CB2B440-5270-4F8A-8636-ABEE1936B638'│ '86223184-128F-4BEC-8986-488F96B60BC8'│ 2026-07-10T18:53:43.489Z  │
│ 8       │ 'rejeitar_reserva'          │ 'Reserva'    │ '2CB2B440-5270-4F8A-8636-ABEE1936B638'│ '2752D242-316D-4717-BCB6-41B91F04E1B7'│ 2026-07-10T18:53:43.510Z  │
│ 9       │ 'criar_reserva'             │ 'Reserva'    │ 'C6D8EB0A-0352-4C55-B936-AFA40AE61A44'│ '86223184-128F-4BEC-8986-488F96B60BC8'│ 2026-07-10T18:53:43.530Z  │
│ 10      │ 'cancelar_reserva'          │ 'Reserva'    │ 'C6D8EB0A-0352-4C55-B936-AFA40AE61A44'│ '86223184-128F-4BEC-8986-488F96B60BC8'│ 2026-07-10T18:53:43.547Z  │
│ 11      │ 'trocar_senha'              │ 'Usuario'    │ '86223184-128F-4BEC-8986-488F96B60BC8'│ '86223184-128F-4BEC-8986-488F96B60BC8'│ 2026-07-10T18:53:43.970Z  │
│ 12      │ 'ativar_conta'              │ 'Usuario'    │ '28924B3C-CD50-4888-8095-28752886527D'│ '28924B3C-CD50-4888-8095-28752886527D'│ 2026-07-10T18:53:44.204Z  │
│ 13      │ 'redefinir_senha'           │ 'Usuario'    │ '28924B3C-CD50-4888-8095-28752886527D'│ '28924B3C-CD50-4888-8095-28752886527D'│ 2026-07-10T18:53:44.442Z  │
└─────────┴─────────────────────────────┴──────────────┴──────────────────────────────────────┴──────────────────────────────────────┴───────────────────────────┘
```

O teste também asserta programaticamente que as 12 ações esperadas estão presentes (`expect(acoesEncontradas).toContain(acao)` para cada uma) — passou.

## 6. Hardening

### 6.1 Headers de segurança (Helmet)
`@fastify/helmet@11.1.1` registrado em [`apps/api/src/app.ts`](../../apps/api/src/app.ts) (versão compatível com Fastify 4.x — a v13 mais recente exige Fastify 5, que não é usado aqui). HSTS habilitado apenas em produção (`NODE_ENV=production`, `maxAge` 1 ano, `includeSubDomains`, `preload`) — desabilitado em desenvolvimento/teste para não confundir ambientes HTTP locais, conforme RNF do SDD §13 ("HTTPS obrigatório, HSTS em produção").

Evidência real (teste dedicado, [`seguranca.test.ts`](../../apps/api/src/tests/integration/seguranca.test.ts)):
```
✓ Segurança (S6) — headers Helmet presentes nas respostas (1 test)
  ✓ GET /api/v1/health retorna headers de segurança padrão do Helmet
    x-content-type-options: nosniff
    x-frame-options: SAMEORIGIN
    x-dns-prefetch-control: off
    strict-transport-security: (ausente em teste — NODE_ENV=test, comportamento esperado)
```

### 6.2 Cookie de sessão
Revisado `COOKIE_OPTIONS` em [`auth.ts`](../../apps/api/src/routes/auth.ts) — já estava conforme desde S1: `httpOnly: true`, `secure: NODE_ENV === "production"`, `sameSite: "strict"`, `path: "/"`. **Nenhuma alteração necessária.**

### 6.3 `JWT_SECRET`
Adicionado guard em [`jwt.ts`](../../apps/api/src/utils/jwt.ts): a aplicação recusa subir (`throw` no import) se `NODE_ENV=production` e `JWT_SECRET` não estiver definido — o fallback `"changeme-dev-only"` só é aceitável fora de produção. Antes desta sprint, um deploy em produção sem a variável configurada silenciosamente assinaria tokens com um segredo conhecido publicamente (o próprio texto deste repositório).

## 7. `pnpm audit` — antes e depois

**Antes:** 43 vulnerabilidades (3 críticas, 17 altas, 18 moderadas, 5 baixas).

**Depois:** 3 vulnerabilidades (0 críticas, 1 alta, 1 moderada, 1 baixa) — todas no próprio `fastify` (ver justificativa abaixo).

```
3 vulnerabilities found
Severity: 1 low | 1 moderate | 1 high
```

### Ações tomadas
| Pacote | De | Para | Como |
|---|---|---|---|
| `next` (apps/web) | 15.0.3 | 15.5.20 | bump direto — fecha RCE crítico no React Flight Protocol, bypass de autorização em Middleware, e mais 10 advisories altas/moderadas/baixas |
| `vitest` (api + web, devDependency) | ^2.0.5 / ^2.1.9 | 3.2.7 | bump de major — fecha vulnerabilidade crítica de leitura arbitrária de arquivo via UI server do Vitest; config (`vitest.config.ts`) já era mínima e compatível, suite completa revalidada (147/147) |
| `tar` (transitivo, via `bcrypt`→`@mapbox/node-pre-gyp`) | <7.5.16 | >=7.5.16 | `pnpm.overrides` em `pnpm-workspace.yaml` — fecha 6 advisories altas de path traversal (uso só em build-time do binário nativo do bcrypt, nunca em runtime) |
| `fast-uri` (transitivo, via `fastify`) | <3.1.2 | >=3.1.2 | `pnpm.overrides` — fecha 2 advisories altas de path traversal/host confusion |
| `vite` (transitivo, via `vitest`) | resolvia 5.4.21 (vulnerável) | 6.4.3 (limite superior `<7` para respeitar o range de peer suportado por `vitest@3.2.7`) | `pnpm.overrides` — fecha advisory alta de bypass de `server.fs.deny` no Windows + 2 moderadas (esbuild, path traversal em `.map`) |
| `postcss` (transitivo, via `next`) | 8.4.31 (vulnerável) | 8.5.16 | `pnpm.overrides` — fecha XSS moderado; `next build` revalidado com sucesso após o override |

### Justificativa — vulnerabilidades remanescentes (todas em `fastify` diretamente)
| Severidade | Advisory | Motivo de não corrigir nesta sprint |
|---|---|---|
| Alta | Content-Type header com tab bypassa validação de body (GHSA-jx2c-rxcm-jvmq) | Corrigido apenas em Fastify `>=5.7.2` — **não existe patch retroportado para a linha 4.x** (última versão 4.x é `4.29.1`, já instalada). Migrar para Fastify 5 é uma mudança maior (major bump em `fastify`, `@fastify/cors`, `@fastify/cookie`, `@fastify/helmet`, possíveis mudanças de comportamento em toda rota), fora do escopo de uma sprint de hardening pontual. **Mitigação já em vigor:** toda rota de escrita valida o `body` via schema Zod imediatamente após o parse (`schema.safeParse`) — um bypass do Content-Type que altere como o body é parseado ainda cairia na validação Zod e retornaria 422, não processaria dados malformados. |
| Moderada | `request.protocol`/`request.host` falsificáveis via `X-Forwarded-*` (GHSA-444r-cwp2-x5xf) | Mesma causa raiz — só corrigido em Fastify `>=5.8.3`. Nenhuma rota do sistema atualmente decide autorização ou lógica de negócio com base em `request.protocol`/`request.host`, o que limita a superfície de exploração. |
| Baixa | DoS por alocação de memória não limitada em `sendWebStream` (GHSA-mrq3-vjjr-p77c) | Mesma causa raiz — corrigido em `>=5.7.3`. O sistema não usa `sendWebStream` (streams de resposta) em nenhuma rota atual. |

**Recomendação registrada para sprint futura:** migração dedicada para Fastify 5.x (fora do escopo de S6-S15 do roadmap atual do MASTER.md — sugerido como item de hardening da Fase 2 ou antes do deploy em produção em S15).

## 8. Testes obrigatórios — confirmação

- Integração: suite `rbac.test.ts` completa, matriz rota × perfil, **50/50 passando**, 100% das 23 rotas de S1-S5 cobertas.

## 9. Gate de Aceite

- [x] **Output real da suite `rbac.test.ts`, 100% das rotas existentes cobertas** — Seção 4.
- [x] **Query real no banco de teste mostrando `LogAuditoria` populado para cada tipo de ação já implementada** — Seção 5 (12/12 tipos de ação confirmados).
- [x] **Output de `pnpm audit` sem vulnerabilidades críticas/altas não tratadas (ou justificativa registrada)** — Seção 7 (0 críticas; 1 alta remanescente, justificada com mitigação documentada).

## 10. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

`UNIQUEIDENTIFIER DEFAULT NEWID()` mantido (nenhuma tabela nova nesta sprint). `rbac.ts` (middleware `autenticar`/`requireRole`) permanece a única fonte de verdade de autorização — nenhuma regra de escopo resolvida só no frontend, confirmado pela suite RBAC. `LogAuditoria` gravado na mesma transação da operação em 100% das rotas de escrita (auditoria confirmou, nenhuma correção necessária). Testes com evidência real (147/147 no total). `/api/v1` mantido como prefixo único. Nenhuma quebra de invariante a registrar.

## 11. ADRs (Architecture Decision Records)

- **ADR-01 — `@fastify/helmet@11.x`, não a versão mais recente (`13.x`).** A v13 exige Fastify `^5.x` como peer dependency; o projeto está congelado em Fastify `4.28.1`+ desde S1 (MASTER.md Seção 2). Instalar a v13 quebrava o boot da aplicação (`FastifyError: expected '5.x' fastify version`). A v11.1.1 é a major mais recente compatível com Fastify 4.x.
- **ADR-02 — `pnpm.overrides` movido de `package.json` para `pnpm-workspace.yaml`.** A versão do pnpm em uso (v11) não lê mais `pnpm.overrides` em `package.json` (aviso explícito no install: "no longer read by pnpm") — a chave correspondente em pnpm v10+ é `overrides` no `pnpm-workspace.yaml`. Usado para forçar `tar`, `fast-uri`, `vite` e `postcss` (transitivo de `next`) a versões patched sem esperar que os mantenedores diretos (`bcrypt`, `fastify`, `vitest`, `next`) atualizem suas próprias dependências.
- **ADR-03 — bump de `vitest` 2.x → 3.x tratado como correção de segurança, não como melhoria de tooling.** Normalmente um major bump de dependência de teste seria adiado, mas a vulnerabilidade crítica (leitura arbitrária de arquivo via UI server do Vitest, GHSA-5xrq-8626-4rwp) e a ausência de patch na linha 2.x justificam o bump nesta sprint de hardening. Risco de regressão mitigado por revalidação completa (147/147 testes, incluindo os 94 herdados de S1-S5) e por o `vitest.config.ts` do projeto ser mínimo (sem uso de APIs que mudaram entre major versions).
- **ADR-04 — vulnerabilidades remanescentes em `fastify` (1 alta, 1 moderada, 1 baixa) aceitas nesta sprint, com mitigação documentada, não corrigidas via major bump.** Ver Seção 7 para a análise completa e a mitigação em vigor (validação Zod pós-parse). Fastify 5 não existe como patch da linha 4.x — corrigir exigiria migração de major que tocaria `@fastify/cors`, `@fastify/cookie` e `@fastify/helmet` simultaneamente, risco desproporcional ao escopo desta sprint de revisão.
- **ADR-05 — teste de evidência de auditoria (`auditoria_evidencia.test.ts`) criado como arquivo dedicado, separado de `rbac.test.ts`.** Embora pudesse ser incorporado à suite RBAC, mantê-lo separado deixa claro no relatório qual arquivo prova qual item do Gate (RBAC vs. LogAuditoria), e evita que uma futura alteração em um dos dois quebre acidentalmente as asserções do outro.

## 12. Pendências para sprints futuras

- Migração para Fastify 5.x — recomendada para fechar as 3 vulnerabilidades remanescentes (ADR-04); requer também atualizar `@fastify/cors`, `@fastify/cookie`, `@fastify/helmet` e revalidar todas as rotas. Sugerida antes do deploy em produção (S15) ou como item de hardening da Fase 2.
- Runner de migrations sem tabela de controle (pendência registrada desde S4/S5) — segue sem tratamento; nenhuma migration nova foi necessária nesta sprint (S6 não alterou schema).
- Credenciais reais do Microsoft Graph continuam pendentes desde S1 (sem impacto nesta sprint).
- `GET /api/v1/setores` (ADR-02 de S5) segue como leitura mínima, aguardando CRUD completo em S12.

---

**Ao final desta sprint, o MVP (equivalente ao SDD v1.0) está funcionalmente completo — ponto de corte seguro caso o projeto precise entrar em produção antes da Fase 2.**

Não iniciei a Sprint S7 nesta sessão, conforme instruído.
