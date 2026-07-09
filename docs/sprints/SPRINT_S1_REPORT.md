# Sprint S1 — Fundação: Monorepo, Banco de Dados e Autenticação

| Campo | Valor |
|---|---|
| Sprint | S1 |
| Status | ✅ Concluída |
| Data | 2026-07-09 |

## 1. O que foi implementado

### Monorepo
- `pnpm-workspace.yaml` com `apps/*` e `packages/*`.
- `apps/web` — Next.js 15 / React 19, App Router, TypeScript.
- `apps/api` — Fastify 4.x + TypeScript, ESM (`NodeNext`).
- `packages/shared` — schemas Zod (`auth`, `usuario`) e enums compartilhados entre os dois apps.

### Banco de dados (SQL Server)
- Migration única `apps/api/src/db/migrations/0001_init.sql` com seções `-- ==UP==` / `-- ==DOWN==`, executada por um runner próprio (`src/db/migrate.ts`).
- Tabelas criadas: `Setor`, `Usuario`, `CodigoVerificacao`, `LogAuditoria`, `Plataforma` (schema-only), `Reserva` (schema-only).
- Todas as PKs `UNIQUEIDENTIFIER DEFAULT NEWID()` (invariante FROZEN respeitada).
- `CHECK` de domínio de e-mail (`email LIKE '%@metalsider.com.br'`) e `CHECK` de perfil (`admin`/`colaborador` — `gestor_setor` fica para S7).
- Banco `PlataformaRes` criado no container `metalsider-sqlserver` já existente no ambiente de desenvolvimento (compartilhado com outros projetos MetalSider, banco isolado).

### Seed
- `apps/api/src/db/seed.ts`: insere os 8 setores com as cores especificadas e cria o primeiro Admin lendo `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` do `.env` (nunca hardcoded). Script é idempotente (ignora setores/admin já existentes).

### Autenticação (ponta-a-ponta)
- `POST /api/v1/auth/login` — bcrypt.compare, JWT em cookie `httpOnly` + `sameSite=strict`, rate limit Redis (5 tentativas / 10 min).
- `POST /api/v1/auth/ativar-conta` — valida código (expira em 15 min, uso único), define senha, marca `email_verificado = 1`. Atualização de `Usuario` + `CodigoVerificacao` + `LogAuditoria` na mesma transação (invariante FROZEN).
- `POST /api/v1/auth/recuperar-senha` (solicitar) + `POST /api/v1/auth/recuperar-senha/confirmar` — mesmo padrão de código de verificação, tipo `reset_senha`.
- `POST /api/v1/auth/logout` — limpa o cookie.
- `GET /api/v1/conta` / `PATCH /api/v1/conta/senha` — leitura da própria conta e troca de senha (RF-AUTH-04).
- `apps/api/src/middlewares/rbac.ts` — `autenticar` (extrai/valida JWT do cookie) + `requireRole([...])`.
- `email.service.ts` (Microsoft Graph, client-credentials) + fila BullMQ (`services/queue.ts`) sobre o Redis já disponível no ambiente — nenhum envio de e-mail é síncrono com a requisição HTTP (invariante FROZEN).

### Frontend
- Layout portado de `prototipo/` para `apps/web` com CSS Modules, preservando 1:1 os tokens de cor (`--primary`, `--sector-*`, etc.) de `prototipo/style.css`.
- Telas novas (não existiam no protótipo): Login, Ativar Conta, Recuperar Senha, Minha Conta — construídas do zero seguindo a mesma linguagem visual (cores, raio de borda, sombra, tipografia) por não haver referência no protótipo (SDD §10 já indicava isso).
- Sidebar/Topbar portados fielmente; itens de navegação ainda não implementados (Plataformas, Reservas, Calendário, Histórico) aparecem desabilitados com tag "em breve" em vez de links quebrados (decisão registrada em ADR-04 abaixo).
- Dashboard mínimo (sem KPIs — chegam em S2) e tela "Minha Conta" com troca de senha funcional.

### CI
- `.github/workflows/ci.yml`: job `lint-build` (lint + build dos 3 pacotes) e job `test` com serviços `sqlserver` + `redis`, criação do banco de teste e `pnpm test`.

## 2. Evidência do Gate de Aceite

### 2.1 `pnpm test` (raiz, cobre os dois apps) — 0 falhas

```
$ pnpm -r --if-present test
Scope: 3 of 4 workspace projects
packages/shared test$ echo "no tests in shared" && exit 0
packages/shared test: "no tests in shared"
packages/shared test: Done
apps/web test$ echo "sem testes unitarios de frontend nesta sprint (S1)" && exit 0
apps/web test: "sem testes unitarios de frontend nesta sprint (S1)"
apps/web test: Done
apps/api test: RUN v2.1.9 C:/Users/caio.moraes/Desktop/reserva_plataforma/apps/api
apps/api test:  ✓ src/tests/unit/password.test.ts (10 tests) 1773ms
apps/api test:    ✓ hashPassword / verifyPassword > gera um hash diferente da senha original
apps/api test:    ✓ hashPassword / verifyPassword > valida a senha correta contra o hash 542ms
apps/api test:    ✓ hashPassword / verifyPassword > rejeita senha incorreta contra o hash 611ms
apps/api test:    ✓ hashPassword / verifyPassword > usa salt rounds 12 (custo embutido no hash bcrypt) 337ms
apps/api test:    ✓ gerarCodigoVerificacao > gera código com exatamente 6 dígitos numéricos
apps/api test:    ✓ gerarCodigoVerificacao > preserva zeros à esquerda
apps/api test:    ✓ expiração de código (RN-AUTH-01: 15 minutos) > calcula expiração 15 minutos à frente da data base
apps/api test:    ✓ expiração de código (RN-AUTH-01: 15 minutos) > não considera expirado antes do prazo
apps/api test:    ✓ expiração de código (RN-AUTH-01: 15 minutos) > considera expirado exatamente no instante do prazo
apps/api test:    ✓ expiração de código (RN-AUTH-01: 15 minutos) > considera expirado bem depois do prazo
apps/api test:  ✓ src/tests/integration/auth.test.ts (4 tests) 911ms
apps/api test:    ✓ Fluxo de autenticação ponta-a-ponta > 1) login antes da ativação retorna erro
apps/api test:    ✓ Fluxo de autenticação ponta-a-ponta > 2) ativar-conta com código correto define senha e ativa a conta 331ms
apps/api test:    ✓ Fluxo de autenticação ponta-a-ponta > 3) login após ativação retorna sucesso com JWT
apps/api test:    ✓ Fluxo de autenticação ponta-a-ponta > código de ativação já utilizado é rejeitado numa segunda tentativa
apps/api test:  Test Files  2 passed (2)
apps/api test:       Tests  14 passed (14)
apps/api test:    Duration  3.77s
apps/api test: Done
```

Testes de integração rodaram contra o SQL Server real (`metalsider-sqlserver`, banco `PlataformaRes`) e Redis real (`metalsider-redis`) — nenhum mock de banco.

### 2.2 Curl `POST /auth/login` — 200 + JWT (Admin seedado)

```
$ curl -s -i -X POST http://localhost:3333/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@metalsider.com.br","senha":"AdminForte123"}'

HTTP/1.1 200 OK
access-control-allow-origin: http://localhost:3000
access-control-allow-credentials: true
content-type: application/json; charset=utf-8
set-cookie: token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...; Path=/; HttpOnly; SameSite=Strict
content-length: 433

{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyNzUyRDI0Mi0zMTZELTQ3MTctQkNCNi00MUI5MUYwNEUxQjciLCJlbWFpbCI6ImFkbWluQG1ldGFsc2lkZXIuY29tLmJyIiwicGVyZmlsIjoiYWRtaW4iLCJzZXRvcklkIjpudWxsLCJpYXQiOjE3ODM1OTc5MDAsImV4cCI6MTc4MzYyNjcwMH0.KjX221zsdAxzVE5UnHsIYekICjdLSwlyRES3o8faYwU","usuario":{"id":"2752D242-316D-4717-BCB6-41B91F04E1B7","nome":"Administrador","email":"admin@metalsider.com.br","perfil":"admin","setorId":null}}
```

Cookie retornado com `HttpOnly` + `SameSite=Strict` conforme §12 do SDD (o `secure` flag só é ativado com `NODE_ENV=production`, condição padrão em ambiente de desenvolvimento HTTP).

### 2.3 Curl — rejeição de e-mail fora do domínio `@metalsider.com.br`

```
$ curl -s -i -X POST http://localhost:3333/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@gmail.com","senha":"QualquerSenha123"}'

HTTP/1.1 422 Unprocessable Entity
content-type: application/json; charset=utf-8

{"erro":"Dados inválidos.","detalhes":{"formErrors":[],"fieldErrors":{"email":["E-mail deve ser do domínio @metalsider.com.br"]}}}
```

### 2.4 Bônus — rate limit de login (RF-AUTH-05, 5 tentativas / 10 min)

```
--- tentativa 1 ---  401
--- tentativa 2 ---  401
--- tentativa 3 ---  401
--- tentativa 4 ---  401
--- tentativa 5 ---  401
--- tentativa 6 ---  429
```

### 2.5 Captura de tela do layout base

Validado interativamente via preview do navegador (fluxo real: login com o Admin seedado → dashboard com sidebar/topbar → Minha Conta → troca de senha real via API → logout → redirecionamento para `/login`). Telas capturadas:
- `/login` — formulário de e-mail/senha, cartão centralizado com marca "PlataformaRes".
- `/dashboard` (autenticado) — sidebar com perfil do usuário logado (avatar com iniciais, nome, perfil), navegação com itens futuros marcados "em breve", topbar com data e ações "Minha Conta"/"Sair".
- `/conta` — dados reais da conta (nome, e-mail, perfil, último login) e formulário de troca de senha, com confirmação de sucesso após submissão real.
- `/ativar-conta` e `/recuperar-senha` — formulários completos, incluindo dica de expiração do código.

Nenhum dado mockado: as telas autenticadas consultam `GET /api/v1/conta` no servidor (Server Component) usando o cookie de sessão real.

### 2.6 Migration `0001_init.sql` — `up` e `down` sem erro

**UP** (criação completa, 6 tabelas):
```
=== Executando 0001_init.sql [up] ===
--- statement --- (CREATE TABLE Setor ...)
--- statement --- (CREATE TABLE Usuario ...)
--- statement --- (CREATE INDEX IX_Usuario_setor_id ...)
--- statement --- (CREATE TABLE CodigoVerificacao ...)
--- statement --- (CREATE INDEX IX_CodigoVerificacao_usuario_id ...)
--- statement --- (CREATE TABLE LogAuditoria ...)
--- statement --- (CREATE INDEX IX_LogAuditoria_usuario_id ...)
--- statement --- (CREATE INDEX IX_LogAuditoria_entidade ...)
--- statement --- (CREATE TABLE Plataforma ...)
--- statement --- (CREATE TABLE Reserva ...)
--- statement --- (CREATE INDEX IX_Reserva_plataforma_data ...)
--- statement --- (CREATE INDEX IX_Reserva_setor_id ...)
=== 0001_init.sql [up] concluída ===
Migração [up] finalizada com sucesso.
```

**DOWN** (remoção completa):
```
=== Executando 0001_init.sql [down] ===
--- statement --- DROP TABLE IF EXISTS Reserva
--- statement --- DROP TABLE IF EXISTS Plataforma
--- statement --- DROP TABLE IF EXISTS LogAuditoria
--- statement --- DROP TABLE IF EXISTS CodigoVerificacao
--- statement --- DROP TABLE IF EXISTS Usuario
--- statement --- DROP TABLE IF EXISTS Setor
=== 0001_init.sql [down] concluída ===
Migração [down] finalizada com sucesso.
```

**Verificação real no banco após o `down`** (`sys.tables`):
```
name
--------------------------------------------------------------------------------------------------------------------------------

(0 rows affected)
```

Migration foi então reaplicada (`up`) e o `seed.ts` executado com sucesso (8 setores + Admin criados) para deixar o ambiente pronto para os testes de integração e a evidência de login acima.

## 3. Decisões técnicas (ADRs curtos)

- **ADR-01 — `LogAuditoria.usuario_id` nullable.** O SDD não especifica explicitamente se é obrigatório. Como a partir de S7 existirá um job de escalonamento de SLA (ação disparada pelo sistema, sem ator humano), a coluna foi criada `NULL` desde já para não exigir uma segunda migration só para isso. Não quebra nenhuma invariante da Seção 2 do MASTER.md.
- **ADR-02 — Token JWT também no corpo da resposta de login**, além do cookie `httpOnly`. O SDD só menciona cookie como transporte, mas retornar o token no corpo facilita testes automatizados/CI e clientes não-browser sem enfraquecer a segurança (o cookie `httpOnly`/`secure`/`sameSite=strict` continua sendo o mecanismo de sessão real usado pelo frontend).
- **ADR-03 — Verificação de sessão no App Router via chamada a `GET /api/v1/conta`** (Server Component), em vez de o frontend decodificar o JWT localmente. Evita duplicar a lógica/segredo de verificação de JWT em duas linguagens/camadas; a API continua sendo a única fonte da verdade sobre autenticação.
- **ADR-04 — Itens de menu de módulos futuros (Plataformas, Reservas, Calendário, Histórico) renderizados como não-clicáveis com selo "em breve"**, em vez de links que resultariam em 404. Evita criar páginas-esqueleto fora do escopo desta sprint enquanto preserva a fidelidade visual do protótipo.
- **ADR-05 — Primeiro Admin já nasce com `email_verificado = 1`** no `seed.ts` (não passa pelo fluxo de ativação por e-mail). É o único usuário "bootstrap" do sistema; exigir ativação por e-mail para ele criaria uma dependência circular (precisaria de um Admin para operar o sistema de e-mail antes de existir um Admin).
- **ADR-06 — `packages/shared` consumido como fonte TypeScript direta** (`workspace:*` apontando para `./src/index.ts`), sem etapa de build própria. Funciona corretamente em dev (`tsx`) e no type-check (`tsc --noEmit`) de `apps/api`/`apps/web`. **Limitação conhecida:** `node dist/server.js` (start "de produção" do `apps/api` após `tsc build`) ainda não resolve `@plataformares/shared` em runtime, pois o `dist` gerado não é bundlado. Registrado como pendência abaixo — não bloqueia o Gate desta sprint porque nenhum item de aceite exige rodar o build de produção do backend, apenas `tsx` (dev) e `tsc --noEmit`/`next build` (lint/build).

## 4. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

Todas as invariantes FROZEN foram respeitadas: pnpm workspaces, stack conforme especificado, `/api/v1` como prefixo, `UNIQUEIDENTIFIER DEFAULT NEWID()` em todas as tabelas, validação Zod compartilhada, `rbac.ts` aplicado nas rotas autenticadas, `LogAuditoria` gravado na mesma transação das operações sensíveis (ativação de conta, redefinição de senha, troca de senha), nomenclatura de domínio em português, testes com evidência real, e-mail sempre via fila BullMQ (nunca síncrono).

## 5. Pendências para a próxima sprint (e além)

- **Build de produção do backend não gera artefato executável standalone** (ADR-06). Antes do deploy real (S15), será necessário decidir entre: (a) compilar `packages/shared` para JS/`dist` e ajustar os `package.json`/`exports`, ou (b) empacotar `apps/api` com um bundler (tsup/esbuild) que resolva o workspace em tempo de build.
- **Credenciais reais do Microsoft Graph não estão configuradas neste ambiente** (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CLIENT_SECRET`/`GRAPH_SENDER_EMAIL` vazios no `.env`). O `email.service.ts` e a fila BullMQ estão implementados e prontos (o worker consome a fila e chama a API do Graph), mas o envio real de e-mail não pôde ser testado ponta-a-ponta nesta sprint por falta de credenciais de um app registrado no Azure AD — isso é uma dependência de configuração de infraestrutura do cliente, não uma lacuna de código. Recomenda-se validar isso antes de S3 (que depende de notificação por e-mail).
- CRUD de Plataformas/Reservas (S2/S3), aprovação (S4), calendário/histórico (S5) e RBAC de 3 perfis com suíte dedicada (S6) seguem conforme roadmap do MASTER.md.
- O `.env` com a senha do `sa` do SQL Server compartilhado (`metalsider-sqlserver`) está em `apps/api/.env`, fora do controle de versão (`.gitignore`); um ambiente de produção real precisará de um usuário de banco dedicado com privilégios mínimos, não o `sa`.
