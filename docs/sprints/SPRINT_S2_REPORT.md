# Sprint S2 — Plataformas (CRUD) + Dashboard Básico

| Campo | Valor |
|---|---|
| Sprint | S2 |
| Status | ✅ Concluída |
| Data | 2026-07-09 |
| Depende de | S1 (✅ Concluída, confirmado no início desta sessão) |

## 1. O que foi implementado

### Schema de `Plataforma`
Já existia (schema-only) desde a migration `0001_init.sql` da S1: `id, codigo (único), nome, localizacao, capacidade, status, observacoes, criado_em, atualizado_em`, exatamente conforme o PASSO A PASSO item 1 desta sprint. **Nenhuma nova migration foi necessária** — apenas confirmado que os campos batem com a especificação (ver ADR-01).

### Schemas Zod (`packages/shared/src/schemas/plataforma.ts`)
- `plataformaPublicaSchema` (formato de resposta)
- `criarPlataformaSchema` / `editarPlataformaSchema` (código, nome, localização, capacidade, observações)
- `atualizarStatusPlataformaSchema` — restrito a `disponivel | manutencao | inativa` (RN-PLAT-03: `reservada` é sempre derivado, nunca definido manualmente — ver ADR-02)
- `dashboardKpisSchema`

### Rotas (`apps/api/src/routes/plataformas.ts`)
- `GET /api/v1/plataformas` — filtros `q` (nome/código/localização) e `status`; qualquer perfil autenticado.
- `POST /api/v1/plataformas` — somente Admin (`requireRole(["admin"])`); valida código único (pré-checagem + captura de violação de constraint UNIQUE como fallback contra condição de corrida); grava `LogAuditoria` na mesma transação.
- `PUT /api/v1/plataformas/:id` — somente Admin; mesma validação de unicidade de código; audita.
- `PATCH /api/v1/plataformas/:id/status` — somente Admin; ao definir `inativa`, valida ausência de reservas em `pendente/agendada/em_uso` na tabela `Reserva` (RN-PLAT-02) — validação estrutural já funcional mesmo sem rotas de escrita de Reserva ainda (chegam em S3); audita.

### Dashboard (`apps/api/src/routes/dashboard.ts`)
- `GET /api/v1/dashboard/kpis` — retorna `{ totalPlataformas, disponiveis }` agregados via `COUNT`/`SUM` direto no banco.

### Frontend
- **Tela "Plataformas"** (`apps/web/app/(app)/plataformas/`): lista com busca (`q`) e filtro de status batendo na API real (debounce de 250ms), botão "Nova Plataforma" (Admin), modal de criação/edição, ação de ativar/desativar por linha — fiel ao comportamento de `filterPlatforms()`, `openPlatformModal()`, `submitPlatform()` e `togglePlatformStatus()` do protótipo, agora sem `state.platforms` local.
- **Dashboard**: cards de KPI reais (Plataformas/Disponíveis) substituindo o texto placeholder da S1; grade "Status das Plataformas" com dados reais, equivalente a `platformStatusGrid`.
- **Sidebar**: item "Plataformas" habilitado (`disponivel: true`), removendo o selo "em breve".
- Componente novo `StatusBadge` compartilhado entre Dashboard e Plataformas para evitar duplicar o mapeamento de cor/label de status (ver ADR-03).

## 2. Evidência do Gate de Aceite

### 2.1 Output real dos testes de integração do CRUD (`pnpm -r --if-present test`, 0 falhas)

```
apps/api test:  ✓ src/tests/unit/plataforma.test.ts (7 tests) 3ms
apps/api test:  ✓ src/tests/unit/password.test.ts (10 tests) 1412ms
apps/api test:  ✓ src/tests/integration/auth.test.ts (4 tests) 1000ms
apps/api test:  ✓ src/tests/integration/plataformas.test.ts (6 tests) 1219ms
apps/api test:  Test Files  4 passed (4)
apps/api test:       Tests  27 passed (27)
apps/api test:    Duration  4.02s
apps/api test: Done
```

Log real das requisições do teste de integração de Plataformas (contra o SQL Server real, `PlataformaRes`):

```
{"req":{"method":"POST","url":"/api/v1/plataformas"},"res":{"statusCode":403}}   // colaborador → 403
{"req":{"method":"POST","url":"/api/v1/plataformas"},"res":{"statusCode":201}}   // admin cria
{"req":{"method":"POST","url":"/api/v1/plataformas"},"res":{"statusCode":409}}   // código duplicado
{"req":{"method":"GET","url":"/api/v1/plataformas?q=PLT-S2-TESTE"},"res":{"statusCode":200}}
{"req":{"method":"PATCH","url":"/api/v1/plataformas/.../status"},"res":{"statusCode":200}}  // admin altera status
{"req":{"method":"PATCH","url":"/api/v1/plataformas/.../status"},"res":{"statusCode":403}}  // colaborador → 403
```

Os 6 testes de `plataformas.test.ts` cobrem exatamente o exigido: `POST → GET` reflete o registro criado, `PATCH /status` reflete corretamente, e RBAC de Admin vs. Colaborador nas duas rotas de escrita.

Unitário (`plataforma.test.ts`, rejeição de código duplicado):
```
✓ normalizarCodigoPlataforma > remove espaços nas extremidades e converte para maiúsculas
✓ normalizarCodigoPlataforma > é idempotente para um código já normalizado
✓ codigoJaCadastrado (rejeição de código duplicado) > rejeita código idêntico
✓ codigoJaCadastrado (rejeição de código duplicado) > rejeita código duplicado ignorando maiúsculas/minúsculas
✓ codigoJaCadastrado (rejeição de código duplicado) > rejeita código duplicado ignorando espaços
✓ codigoJaCadastrado (rejeição de código duplicado) > aceita código novo, não existente na lista
✓ codigoJaCadastrado (rejeição de código duplicado) > retorna falso para lista vazia
```

### 2.2 Captura de tela da tela "Plataformas" com registro criado via UI (não seed)

Fluxo real executado no navegador (Preview): login como Admin seedado → `/plataformas` → clique em "Nova Plataforma" → preenchimento do formulário (`PLT-001`, "Plataforma Elevatória A", "Galpão A, Piso 1", capacidade `500`, observações "Revisão trimestral em dia.") → "Salvar" → registro aparece imediatamente na listagem, com `Status = Disponível` e ações "Editar"/"Desativar" visíveis (perfil Admin). Nenhum dado veio de seed — a tabela `Plataforma` estava vazia antes desta ação (confirmado via `GET /api/v1/plataformas` retornando `[]` antes do teste).

Também validado ao vivo: clique em "Desativar" mudou o badge para `Inativa` e o botão para "Ativar" instantaneamente (sem F5), confirmando a integração real com `PATCH /plataformas/:id/status`; o Dashboard, ao ser recarregado, refletiu `1 Plataforma / 1 Disponível` e o card de status com os dados reais do registro criado.

### 2.3 Curl comprovando 403 ao tentar `POST /plataformas` autenticado como Colaborador

```
$ curl -s -i -X POST http://localhost:3333/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"colaborador.gate.s2@metalsider.com.br","senha":"SenhaForte123"}'

HTTP/1.1 200 OK
set-cookie: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; HttpOnly; SameSite=Strict
{"token":"...","usuario":{"id":"7B3E38EE-...","nome":"Colaborador Gate S2","email":"colaborador.gate.s2@metalsider.com.br","perfil":"colaborador","setorId":null}}

$ curl -s -i -X POST http://localhost:3333/api/v1/plataformas \
  -H "Content-Type: application/json" \
  -H "Cookie: token=<token-do-colaborador>" \
  --data-raw '{"codigo":"PLT-999","nome":"Nao deveria criar","localizacao":"N/A"}'

HTTP/1.1 403 Forbidden
content-type: application/json; charset=utf-8

{"erro":"Perfil sem permissão para este recurso."}
```

Usuário de teste (`colaborador.gate.s2@metalsider.com.br`) foi criado diretamente no banco só para esta evidência e removido (`DELETE`) logo em seguida — não permanece no ambiente.

## 3. Decisões técnicas (ADRs curtos)

- **ADR-01 — Nenhuma nova migration nesta sprint.** O schema de `Plataforma` já fora criado na migration `0001_init.sql` (S1) com todos os campos exigidos aqui (`codigo, nome, localizacao, capacidade, status, observacoes, criado_em, atualizado_em`). O texto do prompt desta sprint menciona de passagem que `categoria/risco/aprovacao_automatica` "já existem no schema desde S1" — isso está **incorreto**: essas três colunas não existem ainda (confirmado lendo `0001_init.sql`) e o próprio MASTER.md, na seção do prompt da S7 (linha 417), planeja adicioná-las via migration **futura**. Como SDD.md/realidade do schema prevalecem sobre o prompt em caso de ambiguidade, e o ESCOPO FORA desta sprint já exclui `categoria/risco/aprovacao_automatica` explicitamente, nenhuma coluna nova foi adicionada — isso fica para S7, conforme o roadmap real do MASTER.md Seção 5.
- **ADR-02 — `PATCH /status` nunca aceita `reservada`.** RN-PLAT-03 (SDD §7) determina que esse status é sempre derivado, nunca definido manualmente. O schema Zod (`atualizarStatusPlataformaSchema`) restringe as opções a `disponivel | manutencao | inativa`, e o formulário de edição no frontend replica a mesma restrição (idêntico ao protótipo, cujo `<select id="pf-status">` também nunca ofereceu "Reservada" como opção).
- **ADR-03 — Alteração de status via modal de edição dispara duas requisições sequenciais** (`PUT` para os campos básicos + `PATCH /status` se o status mudou), em vez de uma única rota fazer as duas coisas. Isso preserva a separação de rotas pedida explicitamente no PASSO A PASSO (`PUT` = editar; `PATCH /status` = ativar/desativar com validação RN-PLAT-02), garantindo que a checagem de reservas ativas seja sempre executada por um único caminho de código, mesmo quando o status é alterado a partir do formulário de edição em vez do botão dedicado "Ativar/Desativar" da tabela.
- **ADR-04 — Componente `StatusBadge` compartilhado** entre a tela Plataformas e o Dashboard (ambos precisam do mesmo mapeamento status→cor/label). Introduzido nesta sprint por já haver duplicação real de uso, não antecipando necessidade futura.
- **ADR-05 — Verificação de reservas ativas em `PATCH /status` consulta a tabela `Reserva` diretamente**, mesmo sem nenhuma rota de escrita de Reserva existir ainda (chegam em S3). A tabela existe desde S1 (schema-only) e está sempre vazia nesta sprint, então a query apenas nunca encontra resultados — não há necessidade de aguardar S3 para implementar a regra estrutural, evitando reabrir este arquivo depois só para adicionar a validação.

## 4. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

`UNIQUEIDENTIFIER DEFAULT NEWID()` mantido (nenhuma tabela nova criada). Validação Zod compartilhada (`packages/shared`) em `POST`/`PUT`/`PATCH status`. `rbac.ts` (`autenticar` + `requireRole(["admin"])`) aplicado em toda rota de escrita. `LogAuditoria` gravado na mesma transação em criação, edição e alteração de status de Plataforma. Nomenclatura de domínio em português. Testes com evidência real (unitário + integração contra banco real). `/api/v1` mantido como prefixo único.

## 5. Pendências para a próxima sprint (e além)

- S3 (Reservas: criação, conflito, notificação por e-mail) é a próxima sprint no roadmap do MASTER.md — não iniciada nesta sessão, conforme instrução explícita.
- A validação RN-PLAT-02 em `PATCH /status` (bloquear desativação com reservas ativas) está implementada e estruturalmente correta, mas só terá cobertura de teste "com dados reais" a partir de S3, quando existirem rotas de escrita de `Reserva` para popular o cenário.
- Pendências herdadas da S1 continuam abertas e não foram tratadas nesta sprint (fora de escopo): bundling de produção de `packages/shared` (ADR-06 da S1) e credenciais reais do Microsoft Graph.
- Durante a verificação manual desta sprint, foi necessário reiniciar o processo do servidor da API (rodando via `tsx` sem watch, herdado da sessão S1) para que as novas rotas fossem carregadas — o processo `tsx` não corrigido automaticamente. Não é um bug de código, apenas uma característica do processo de dev iniciado sem `--watch`; vale considerar `tsx watch` para sessões futuras que editem `apps/api` com o servidor já rodando em background.
