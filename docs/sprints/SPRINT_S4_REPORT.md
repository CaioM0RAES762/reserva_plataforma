# Sprint S4 — Aprovação Simples (Admin) + Máquina de Estados

| Campo | Valor |
|---|---|
| Sprint | S4 |
| Status | ✅ Concluída |
| Data | 2026-07-09 |
| Depende de | S3 (✅ Concluída, confirmado no início desta sessão) |

## 1. O que foi implementado

### Migration `0002_reserva_aprovacao.sql`
Adiciona à `Reserva`: `aprovado_por_id` (FK nullable → `Usuario`), `motivo_rejeicao` (nvarchar nullable), `hora_inicio_real`/`hora_fim_real` (TIME nullable). `segunda_aprovacao_por_id` e as colunas de risco/categoria/aprovação automática **não** foram adicionadas — pertencem à S7 (dupla aprovação), conforme já registrado no SDD e no schema original da S1. Testada `up` e `down` diretamente contra o banco de desenvolvimento antes de ser aplicada definitivamente (ver ADR-01 sobre o runner de migrations).

### `aprovacao.service.ts` (`apps/api/src/services/aprovacao.service.ts`)
Função pura `transicionar(statusAtual, acao)` implementando a máquina de estados do SDD §8.1:
```
pendente --aprovar--> agendada
pendente --rejeitar--> rejeitada
agendada --iniciar_uso--> em_uso
em_uso --concluir--> concluida
pendente|agendada|em_uso --cancelar--> cancelada
```
Qualquer transição fora dessa lista lança `TransicaoInvalidaError` (mapeada para `409` nas rotas). Helper `estadoFinal()` identifica `concluida`/`cancelada`/`rejeitada` (RN-RES-04).

### Rotas (`apps/api/src/routes/reservas.ts`)
- `POST /api/v1/reservas/:id/aprovar` — Admin apenas; `pendente → agendada`, grava `aprovado_por_id`; dispara e-mail "Reserva aprovada" ao solicitante.
- `POST /api/v1/reservas/:id/rejeitar` — Admin apenas; motivo obrigatório (mín. 5 caracteres, `rejeitarReservaSchema`); `pendente → rejeitada`, grava `motivo_rejeicao`; dispara e-mail "Reserva rejeitada" com o motivo.
- `PATCH /api/v1/reservas/:id/status` — Admin apenas; body `{ acao: "iniciar_uso" | "concluir" }`; grava `hora_inicio_real`/`hora_fim_real` com `CAST(GETDATE() AS TIME)`.
- `POST /api/v1/reservas/:id/cancelar` — qualquer perfil autenticado; Admin cancela qualquer reserva, Colaborador só as do próprio setor (RF-RES-11); `403` se fora de escopo.

Todas as quatro rotas: buscam o contexto atual da reserva, chamam `transicionar()` (409 se inválida), executam `UPDATE` + `LogAuditoria` na mesma transação, e retornam a reserva completa recarregada. `SELECT_RESERVA`/`mapReserva` foram estendidos com `aprovadoPorNome` (LEFT JOIN），`motivoRejeicao`, `horaInicioReal`, `horaFimReal`.

### `Plataforma.status = 'reservada'` derivado (RN-PLAT-03)
Nova função `sqlStatusPlataformaDerivado()` em `plataforma.service.ts`, injetada como CTE em `GET /api/v1/plataformas`: se a plataforma não está `inativa`/`manutencao` e existe uma `Reserva` `agendada`/`em_uso` cobrindo a data e hora atuais, o status exibido é `reservada` — nunca persistido na tabela. Ver ADR-02 sobre a escolha entre leitura-derivada e job periódico.

### E-mail (`apps/api/src/services/email.service.ts`)
Dois novos templates: `templateReservaAprovada()` e `templateReservaRejeitada()` (motivo incluído), seguindo o padrão de `templateNovaReservaPendente()`. Ambos disparados via `enfileirarEmail()` (fila BullMQ existente).

### Frontend
- **`ReservaDetalheModal.tsx`** (novo): abre ao clicar em qualquer linha da tabela de Reservas. Mostra todos os campos (incluindo `aprovadoPorNome`, `motivoRejeicao`, `horaInicioReal`/`horaFimReal` quando presentes) e renderiza botões de ação condicionados a `status` + `perfil` do usuário logado:
  - `pendente` + Admin → **Aprovar** / **Rejeitar** (revela textarea de motivo antes de confirmar) / **Cancelar Reserva**.
  - `agendada` + Admin → **Iniciar Uso** / **Cancelar Reserva**.
  - `em_uso` + Admin → **Concluir** / **Cancelar Reserva**.
  - **Cancelar Reserva** também visível para Colaborador quando `reserva.setorId === setorId` da sessão.
  - `concluida`/`cancelada`/`rejeitada` → somente leitura, nenhum botão de ação.
- **`ReservasClient.tsx`**: linhas da tabela agora clicáveis, abrindo o modal de detalhe; ao concluir qualquer ação, o modal fecha e a listagem é recarregada.
- **`page.tsx`**: passa `perfil` e `setorId` (já retornados por `GET /conta` desde a S3) para `ReservasClient`.

## 2. Bug encontrado e corrigido durante a verificação em navegador

Ao testar "Aprovar" pela primeira vez no navegador, a requisição retornou `400 Bad Request`. Causa: `apiFetch()` sempre envia `Content-Type: application/json`, e as chamadas `aprovar`/`cancelar` originalmente não enviavam `body` — o parser JSON padrão do Fastify rejeita corpo vazio com esse *header* presente. Corrigido enviando `body: JSON.stringify({})` nessas duas chamadas. Reproduzido e confirmado via curl antes e depois da correção (abaixo).

## 3. Evidência do Gate de Aceite

### 3.1 Output real cobrindo todas as transições válidas e ao menos 3 inválidas

Testes unitários de `aprovacao.service.ts` (20 testes — 7 transições válidas, 7 inválidas incluindo as 3 exigidas pelo Gate nomeadas explicitamente, 6 de `estadoFinal`):

```
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > pendente --aprovar--> agendada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > pendente --rejeitar--> rejeitada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > agendada --iniciar_uso--> em_uso
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > em_uso --concluir--> concluida
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > pendente --cancelar--> cancelada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > agendada --cancelar--> cancelada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições válidas > em_uso --cancelar--> cancelada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > concluida → em_uso: reserva concluída não pode voltar a estar em uso
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > rejeitada → agendada: reserva rejeitada não pode ser aprovada retroativamente
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > cancelada → pendente: cancelada é estado final, nenhuma ação a reabre
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > mensagem de erro identifica claramente status atual e ação tentada
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > pendente → em_uso: não é permitido pular a etapa de aprovação
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > agendada → concluida: não é permitido pular a etapa de uso
✓ src/tests/unit/aprovacao.test.ts > transicionar — transições inválidas (mínimo 3 exigidas pelo Gate) > rejeitada é estado final, nenhuma ação a altera
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > concluida é estado final
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > cancelada é estado final
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > rejeitada é estado final
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > pendente NÃO é estado final
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > agendada NÃO é estado final
✓ src/tests/unit/aprovacao.test.ts > estadoFinal > em_uso NÃO é estado final

 Test Files  1 passed (1)
      Tests  20 passed (20)
```

Nota sobre `cancelada → pendente`: como nenhuma ação da máquina de estados tem `pendente` como destino (é sempre o estado inicial de criação), o teste cobre a intenção do caso do Gate verificando que **nenhuma** das 5 ações consegue transicionar uma reserva `cancelada` para qualquer estado — ela é terminal.

Testes de integração (`app.inject()` contra SQL Server real), cobrindo os dois fluxos completos exigidos:

```
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Colaborador cria a reserva (pendente)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Colaborador não pode aprovar (403)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Admin aprova a reserva (pendente → agendada)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Admin não pode aprovar de novo uma reserva já agendada (409)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Admin inicia o uso (agendada → em_uso)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Admin conclui o uso (em_uso → concluida)
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Reserva concluída é somente leitura: iniciar_uso retorna 409
✓ Reservas (S4) — fluxo pendente → agendada → em_uso → concluida > Reserva concluída é somente leitura: cancelar retorna 409
✓ Reservas (S4) — fluxo pendente → rejeitada > Colaborador cria a reserva (pendente)
✓ Reservas (S4) — fluxo pendente → rejeitada > Rejeitar sem motivo retorna 422
✓ Reservas (S4) — fluxo pendente → rejeitada > Admin rejeita com motivo (pendente → rejeitada)
✓ Reservas (S4) — fluxo pendente → rejeitada > Reserva rejeitada → agendada (via aprovar) retorna 409
✓ Reservas (S4) — cancelamento por escopo de setor > Colaborador cancela reserva pendente do próprio setor (200)
✓ Reservas (S4) — cancelamento por escopo de setor > Colaborador de outro setor não pode cancelar reserva alheia (403)
✓ Reservas (S4) — cancelamento por escopo de setor > Admin cancela reserva de qualquer setor (200)

 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Suíte completa do backend (`pnpm --filter api test`), 0 falhas:

```
✓ src/tests/unit/conflito.test.ts (13 tests)
✓ src/tests/unit/aprovacao.test.ts (20 tests)
✓ src/tests/unit/plataforma.test.ts (7 tests)
✓ src/tests/unit/password.test.ts (10 tests)
✓ src/tests/integration/auth.test.ts (4 tests)
✓ src/tests/integration/plataformas.test.ts (6 tests)
✓ src/tests/integration/reservas.test.ts (8 tests)
✓ src/tests/integration/aprovacao.test.ts (15 tests)

 Test Files  8 passed (8)
      Tests  83 passed (83)
```

### 3.2 Captura de tela do Detalhe da Reserva em 3 estados diferentes

Fluxo real executado no navegador (Preview), como Admin, sobre uma reserva real criada por um Colaborador (`Plataforma Elevatória A`, 20/09/2026, 08:00–10:00):

1. **Status `Pendente`** — botões **Fechar / Rejeitar / Aprovar / Cancelar Reserva** visíveis. Screenshot capturada.
2. Clique em "Aprovar" → **Status `Agendada`** — seção "Aprovado por: Administrador" aparece; botões **Iniciar Uso / Cancelar Reserva**. Screenshot capturada.
3. Clique em "Iniciar Uso" → **Status `Em Uso`** — seção "Início Real: 18:59" aparece; botões **Concluir / Cancelar Reserva**. Screenshot capturada.

As três capturas confirmam que o conjunto de botões exibido corresponde exatamente ao permitido pela máquina de estados para cada status, e que os campos derivados (`aprovadoPorNome`, `horaInicioReal`) refletem corretamente a ação executada.

### 3.3 Curl comprovando que editar uma reserva `concluida` retorna erro

Reserva levada a `concluida` via UI (clique em "Concluir" a partir do estado `em_uso`). Tentativa de reabrir via API:

```
$ curl -s -i -b cookies_admin.txt -X PATCH http://localhost:3333/api/v1/reservas/1DC1BA82-1274-4B28-B87D-CFEA7E6136A9/status \
  -H "Content-Type: application/json" \
  -d '{"acao":"iniciar_uso"}'

HTTP/1.1 409 Conflict
content-type: application/json; charset=utf-8

{"erro":"Não é possível executar a ação \"iniciar_uso\" numa reserva com status \"concluida\"."}
```

Confirmado também via `GET /api/v1/reservas`, mostrando a reserva com `"status":"concluida"`, `"horaInicioReal":"18:59"`, `"horaFimReal":"18:59"` — os horários reais gravados nas transições anteriores.

### 3.4 Evidência adicional: e-mails de decisão enfileirados (BullMQ)

Não exigido explicitamente pelo Gate desta sprint, mas verificado por completude (o passo 5 do prompt pede os templates). Inspeção do job `bull:email:22` no Redis, gerado pela aprovação da reserva de evidência:

```
destinatario: "colaborador.gate.s4@metalsider.com.br"
assunto: "PlataformaRes — Reserva aprovada (Plataforma Elevatória A)"
corpoHtml: contém "foi aprovada e está agendada", Data 2026-09-20, Horário 08:00 – 10:00
```

Confirma que `templateReservaAprovada()` foi corretamente populado com os dados da reserva e enfileirado de forma assíncrona (mesmo padrão de fila/retry usado desde a S1/S3).

## 4. Decisões técnicas (ADRs curtos)

- **ADR-01 — Migration `0002` aplicada diretamente via `sqlcmd`, não via `pnpm migrate:up`.** O runner atual (`src/db/migrate.ts`) não possui tabela de controle de migrations aplicadas — ele reexecuta todos os arquivos `.sql` do diretório em toda chamada. Como `0001_init.sql` não usa `IF NOT EXISTS`, rodar `migrate:up` agora recriaria tabelas já existentes e falharia. Optou-se por testar e aplicar apenas os statements novos (`0002`) diretamente contra o banco de desenvolvimento (mesmo padrão usado para validar migrations em sessões anteriores), preservando o arquivo de migration para documentação/histórico e para uso em um ambiente novo do zero. **Pendência registrada para uma sprint futura (sugestão: S6, já dedicada a hardening):** adicionar uma tabela `SchemaMigracao` de controle ao runner, para que `pnpm migrate:up` volte a ser idempotente e utilizável em CI/deploy.
- **ADR-02 — `Plataforma.status = 'reservada'` calculado em tempo de leitura (CTE), não persistido nem via job periódico.** RN-PLAT-03 exige que esse status nunca seja definido manualmente; a alternativa de um job BullMQ repeatable recalculando periodicamente foi descartada por adicionar latência (status ficaria desatualizado entre execuções) e complexidade operacional sem necessidade — a infraestrutura de jobs repetíveis só é introduzida oficialmente na S7. O cálculo via `EXISTS` correlacionado no `GET /api/v1/plataformas` é sempre consistente com o estado real das reservas no momento da consulta, ao custo de uma subquery por linha (aceitável no volume atual do MVP).
- **ADR-03 — `aprovar`/`rejeitar`/`iniciar_uso`/`concluir` restritos ao perfil Admin nesta sprint.** O SDD (RF-RES-06/07/09) já prevê o Gestor de Setor participando dessas ações, mas esse perfil só é introduzido na S7 (`CK_Usuario_perfil` ainda só aceita `admin`/`colaborador`). Restringir ao Admin é a única leitura consistente possível hoje; a autorização via `requireRole(["admin"])` será estendida para incluir `gestor_setor` (com as regras de escopo por setor da RN-RES-07/08) quando aquele perfil for introduzido, sem necessidade de reescrever a máquina de estados.
- **ADR-04 — Cancelamento (`POST /:id/cancelar`) não usa `requireRole`, escopo resolvido no corpo da rota.** Diferente das outras três ações, RF-RES-11 permite Colaborador cancelar reservas do próprio setor. Seguindo o padrão já estabelecido em `GET /reservas` (S3), o middleware `autenticar` garante autenticação e a regra de escopo (`admin` vê tudo, os demais só o próprio `setor_id`) é resolvida explicitamente no handler, retornando `403` quando fora de escopo.
- **ADR-05 — `PATCH /:id/status` aceita `{ acao }`, não `{ status }`.** Como já existem rotas dedicadas para `aprovar`/`rejeitar`/`cancelar`, essa rota genérica só precisa cobrir `iniciar_uso`/`concluir`. Usar `acao` (mapeado 1:1 para `AcaoReserva` da máquina de estados) evita duplicar a validação de "quais status-alvo são permitidos" em dois lugares (schema Zod + `aprovacao.service.ts`) e mantém o cliente alinhado à mesma linguagem do backend.
- **ADR-06 — Bug de `Content-Type: application/json` com corpo vazio corrigido no frontend.** Ver Seção 2. Registrado aqui porque é uma armadilha real do Fastify (parser JSON padrão rejeita string vazia mesmo com `Content-Type` presente) que pode se repetir em futuras chamadas de rotas sem payload — qualquer nova chamada `apiFetch` sem dados deve enviar `body: JSON.stringify({})` explicitamente enquanto `apiFetch` não for ajustado para omitir o header quando não há corpo.

## 5. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

`UNIQUEIDENTIFIER DEFAULT NEWID()` mantido (nenhuma tabela nova, apenas colunas adicionadas com `ALTER TABLE`). Validação Zod compartilhada (`packages/shared`) em `rejeitar`/`status`. `rbac.ts` aplicado em todas as rotas novas (`requireRole(["admin"])` em três delas; `autenticar` + escopo manual na quarta). `LogAuditoria` gravado na mesma transação de cada mudança de status. E-mails de aprovação/rejeição passam pela fila BullMQ, nunca síncronos. Nomenclatura de domínio em português. Testes com evidência real (20 unitários + 15 de integração novos, mais os 48 pré-existentes, 83/83 no total). `/api/v1` mantido como prefixo único.

## 6. Pendências para a próxima sprint (e além)

- S5 (Calendário + Histórico + exportação CSV) é a próxima sprint no roadmap do MASTER.md — não iniciada nesta sessão, conforme instrução explícita.
- Runner de migrations sem tabela de controle (ver ADR-01) — recomendado tratar na S6 (hardening).
- Restrição de `aprovar`/`rejeitar`/`iniciar_uso`/`concluir` ao Admin (ADR-03) precisará ser revisada na S7 para incluir o Gestor de Setor com as regras de escopo/dupla aprovação da RN-RES-07/08/09.
- `Plataforma.status = 'reservada'` (ADR-02) só é recalculado em `GET /api/v1/plataformas` — o card `disponiveis` do Dashboard (`GET /dashboard/kpis`, criado na S2) continua contando pelo status bruto persistido e não reflete `reservada` em tempo real; aceitável no MVP, mas deve ser revisitado se o KPI passar a ser usado operacionalmente antes da S7.
- Credenciais reais do Microsoft Graph continuam pendentes desde a S1 (envio de e-mail falha após enfileirar; comportamento esperado e já documentado nos relatórios anteriores).
- Testes desta sprint criaram e limparam usuários/reservas/jobs de fila reais no ambiente de desenvolvimento compartilhado — limpeza confirmada ao final da sessão (`total_reservas = 0`, `total_usuarios_teste = 0`, fila `email` livre de jobs de teste).
