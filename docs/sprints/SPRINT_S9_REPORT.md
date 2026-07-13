# Sprint S9 — Bloqueios de Agenda + Reservas Recorrentes

| Campo | Valor |
|---|---|
| Sprint | S9 |
| Status | ✅ Concluída |
| Data | 2026-07-13 |
| Depende de | S7 (✅ Concluída, confirmado no início desta sessão — S9 não depende de S8) |
| Natureza | Feature nova da Fase 2 (Expansão) |

## 1. Objetivo

Permitir planejamento de manutenção preventiva/feriados via bloqueios de agenda (globais ou por plataforma) que impedem a criação de reservas no período, e permitir agendamento recorrente semanal (até 12 ocorrências), com cancelamento em lote da série.

## 2. O que foi implementado

### 2.1 Schema (migration `0007`)

- **`0007_bloqueio_recorrencia.sql`**: cria `BloqueioAgenda` (`plataforma_id` nulo = bloqueio global, `data_inicio`/`data_fim` DATETIME2, `CK_BloqueioAgenda_datas CHECK (data_fim > data_inicio)`) e `ReservaRecorrencia` (`dia_semana` TINYINT 0–6, `quantidade_ocorrencias` TINYINT com `CHECK` 2–12, `frequencia` fixa em `'semanal'`). Adiciona `Reserva.recorrencia_id` (FK nullable) em um `GO` separado (mesmo padrão ADR-02 de S7 — evita "Invalid column name" ao resolver a FK sobre uma tabela criada no mesmo script).
- Aplicada via `sqlcmd -f 65001 -i 0007_up.sql` contra o banco de desenvolvimento — desta vez já usando a flag de codepage UTF-8 desde o início (lição aprendida do bug de mojibake documentado no relatório de S8), evitando reintroduzir aquele problema nos textos de `motivo`.
- Confirmação real (colada, não resumida):

```
TABLE_NAME
--------------------------------------------------------------------------------------------------------------------------------
BloqueioAgenda
ReservaRecorrencia

(2 linhas afetadas)
COLUMN_NAME
--------------------------------------------------------------------------------------------------------------------------------
recorrencia_id

(1 linhas afetadas)
```

### 2.2 `packages/shared` (contratos compartilhados)

- `schemas/bloqueio.ts` (novo): `criarBloqueioSchema` (`plataformaId` nulo/ausente = global, `dataInicio`/`dataFim` no formato de `<input type="datetime-local">`, `confirmar` opcional default `false`, `refine` garantindo `dataFim > dataInicio`), `bloqueioPublicoSchema`, `reservaConflitanteBloqueioSchema`.
- `schemas/reserva.ts`: `reservaPublicaSchema` ganha `recorrenciaId` (nullable); novo `recorrenciaInputSchema` (`quantidadeOcorrencias` entre 2 e 12); `criarReservaSchema` ganha o campo opcional `recorrencia`; `conflitoRespostaSchema` ganha `motivo` (mensagem pronta para exibição, cobrindo tanto conflito de reserva quanto bloqueio de agenda).

### 2.3 `conflito.service.ts` — estendido para RN-RES-11/RN-BLK-01

Sem alterar a lógica existente de S3 (`encontrarConflito`/`horarioValido`), adicionadas três novas funções puras (100% unit-testáveis, sem I/O):

- `combinarDataHora(data, hora)`: combina `data` (YYYY-MM-DD) + `hora` (HH:mm) num único instante UTC, usado como eixo de tempo comum para comparar contra o intervalo `DATETIME2` de um bloqueio.
- `encontrarBloqueioConflitante(bloqueios, plataformaId, horario)`: RN-RES-11 — bloqueio ativo (mesma plataforma OU global, `plataformaId === null`) cobrindo o horário solicitado. Mesma regra de sobreposição de RN-RES-02 (`NOT (fim <= inicio_existente OR inicio >= fim_existente)`), extraída para um helper interno `intervalosSeSobrepoe` reaproveitado pela função seguinte.
- `reservasDentroDoIntervalo(reservas, intervalo)`: RN-BLK-01 — usada na criação de um bloqueio para achar reservas `agendada`/`em_uso` que colidem com o novo período.

### 2.4 `recorrencia.service.ts` (novo)

- `diaSemanaDe(data)`: dia da semana (0–6, UTC) de uma data ISO.
- `gerarDatasRecorrencia(dataBase, diaSemana, quantidade)`: gera as N datas semanais (dataBase + 7·i dias). Valida que `dataBase` realmente cai no `diaSemana` informado (`DataBaseInvalidaError`) e que `quantidade` está entre 2 e 12 (`RangeError`) — a rota sempre deriva `diaSemana` da própria `dataBase` antes de chamar, então a validação nunca deveria disparar na prática; existe como salvaguarda defensiva.

### 2.5 Rotas `bloqueios.ts` (novo arquivo)

- `GET /api/v1/bloqueios` — **liberado a todos os perfis autenticados**, não só Admin. Decisão deliberada (ADR-01, ver Seção 7): tanto a tela administrativa de bloqueios quanto o Calendário (RF-CAL-01 — "Todos" devem ver os bloqueios de forma visualmente distinta) precisam da mesma leitura; criar duas rotas para o mesmo dado seria duplicação sem benefício, já que a rota não expõe nada sensível.
- `POST /api/v1/bloqueios` — Admin apenas. Valida existência da plataforma (se informada); busca candidatas de `Reserva` `agendada`/`em_uso` no range de datas via SQL (filtro grosso) e refina com `reservasDentroDoIntervalo` (sobreposição exata). Se houver conflitantes e `confirmar !== true`, retorna **200** (não erro) com `{ requerConfirmacao: true, reservasConflitantes: [...] }` — o frontend reenvia com `confirmar: true` para efetivar. Grava `LogAuditoria` (`criar_bloqueio`) na mesma transação do `INSERT`.
- `DELETE /api/v1/bloqueios/:id` — Admin apenas; RF-BLK-02 — só remove bloqueios cuja `data_inicio` ainda não começou (`409` caso contrário).

### 2.6 `reservas.ts` — disponibilidade unificada e séries recorrentes

- Novo helper `verificarDisponibilidade({ plataformaId, data, horaInicio, horaFim, ignorarReservaId? })`: reúne RN-RES-02 (conflito com outra reserva) **e** RN-RES-11 (bloqueio de agenda) num único ponto, usado tanto por `POST /reservas` quanto por `GET /reservas/conflitos` — elimina a duplicação que existiria entre criação e checagem em tempo real do formulário.
- `POST /api/v1/reservas` estendido: quando o body inclui `recorrencia`, calcula `datasOcorrencias = gerarDatasRecorrencia(data, diaSemanaDe(data), quantidadeOcorrencias)` e valida a disponibilidade de **todas** as datas antes de inserir qualquer uma (tudo ou nada — RF-RES-03). Se tudo estiver livre, insere `ReservaRecorrencia` + N linhas de `Reserva` (cada uma com seu próprio `LogAuditoria`) na mesma transação; cada ocorrência segue seu próprio fluxo de aprovação individual (nenhuma lógica nova em `aprovacao.service.ts` — cada `Reserva` nasce `pendente` normalmente). Resposta: `{ recorrenciaId, reservas: [...] }` quando recorrente, ou o objeto de reserva único quando não.
- `GET /api/v1/reservas/conflitos` agora retorna `{ conflito, motivo, reserva }` — `motivo` cobre tanto o texto de conflito com outra reserva quanto o de bloqueio de agenda, evitando o frontend montar a mensagem.
- **Nova rota `POST /api/v1/reservas/recorrencia/:recorrenciaId/cancelar`**: cancela todas as ocorrências futuras `pendente`/`agendada` de uma série de uma vez (uma transação, uma `Reserva.status = 'cancelada'` + `LogAuditoria` por ocorrência). Escopo verificado pela primeira ocorrência da série (todas pertencem ao mesmo setor, pois nascem de uma única submissão).

### 2.7 Frontend

- **`ReservaModal.tsx`**: toggle "Repetir semanalmente" + seletor de quantidade (2–12); mensagem de conflito agora usa o campo `motivo` da API diretamente (cobre bloqueio e reserva sem lógica de composição no cliente); botão muda para "Criar Série" quando a recorrência está ativa.
- **`ReservaDetalheModal.tsx`** / **`ReservasClient.tsx`**: nova ação "Cancelar Série", visível apenas quando `reserva.recorrenciaId` está presente e o status ainda é `pendente`/`agendada`.
- **`BloqueiosClient.tsx`** (novo) + rota `/plataformas/bloqueios` (novo, Admin apenas, redireciona não-Admin): listagem de bloqueios (plataforma ou "Global"), formulário de criação com o fluxo de confirmação dupla (mostra a lista de reservas conflitantes e exige um segundo clique explícito), remoção de bloqueios futuros. Acessível via item "Bloqueios de Agenda" na Sidebar (Admin) e via atalho no header de "Plataformas".
- **`CalendarioClient.tsx`**: busca `GET /api/v1/bloqueios` junto com reservas/setores; cada célula hora×dia cobertta por um bloqueio ganha a classe `calCellBlocked` (hachurado diagonal via `repeating-linear-gradient`, CSS puro — distinto do bloco sólido colorido por setor das reservas) e um rótulo `🚫 <plataforma ou "Global">` com tooltip explicando o motivo. Legenda do calendário ganhou o item "Bloqueio de agenda".

## 3. Testes obrigatórios — confirmação

### 3.1 Unitário — geração de ocorrências recorrentes (`tests/unit/recorrencia.test.ts`, novo arquivo, 8 testes)

Output real:

```
✓ src/tests/unit/recorrencia.test.ts > diaSemanaDe > calcula o dia da semana (0=domingo) a partir de uma data ISO 1ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > gera exatamente 12 ocorrências semanais a partir da data-base, todas na mesma semana do mês 3ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > todas as datas geradas caem no mesmo dia da semana da data-base 0ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > gera o número mínimo de 2 ocorrências corretamente 0ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > rejeita quantidade abaixo de 2 0ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > rejeita quantidade acima de 12 0ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > rejeita data-base cujo dia da semana não confere com o informado 0ms
✓ src/tests/unit/recorrencia.test.ts > gerarDatasRecorrencia > atravessa corretamente a virada de mês/ano 0ms

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

O teste "gera exatamente 12 ocorrências semanais" asserta explicitamente **as 12 datas geradas** (não apenas o `length`):

```ts
expect(datas).toEqual([
  "2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31",
  "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28",
  "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26",
]);
```

### 3.2 Unitário — bloqueio de agenda (`tests/unit/conflito.test.ts`, estendido, +9 testes novos)

`encontrarBloqueioConflitante` (bloqueio global cobre qualquer plataforma; bloqueio específico só afeta a própria plataforma; NÃO conflita com outra plataforma; NÃO conflita fora do período; adjacência exata NÃO é conflito; lista vazia → null) e `reservasDentroDoIntervalo` (RN-BLK-01, 3 cenários). Arquivo completo (14 testes herdados de S3 + 9 novos = 22):

```
✓ src/tests/unit/conflito.test.ts (22 tests) 7ms
```

### 3.3 Integração — bloqueios e recorrência (`tests/integration/bloqueios.test.ts`, novo arquivo, 16 testes)

Cobre exatamente os dois cenários exigidos pelo PASSO A PASSO — criação de reserva dentro de bloqueio ativo rejeitada, e criação de bloqueio sobre reserva `agendada` exigindo confirmação explícita — mais RBAC, remoção de bloqueio futuro/passado, e o ciclo completo de reservas recorrentes (criação de 12 ocorrências, tentativa duplicada tudo-ou-nada, cancelamento de série). Output real:

```
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Admin cria um bloqueio de agenda para a plataforma de teste (dia inteiro) 134ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > POST /reservas dentro do período bloqueado é rejeitada (409) com o motivo explicado 40ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > GET /reservas/conflitos também reporta o bloqueio para o mesmo horário 11ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > POST /reservas em outra plataforma (não coberta pelo bloqueio específico) é aceita 72ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Colaborador não pode criar bloqueio (403) 1ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Colaborador consegue LISTAR bloqueios (leitura liberada a todos, RF-CAL-01) 12ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Colaborador não pode remover bloqueio (403) 1ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Admin remove o bloqueio futuro com sucesso (204) 28ms
✓ Bloqueios de Agenda (S9) — RN-RES-11: reserva dentro de bloqueio ativo é rejeitada > Após a remoção, a mesma reserva antes bloqueada agora é aceita 77ms
✓ Bloqueios de Agenda (S9) — RN-BLK-01: confirmação dupla sobre reserva já agendada > cria e aprova uma reserva (agendada) na plataforma de teste 204ms
✓ Bloqueios de Agenda (S9) — RN-BLK-01: confirmação dupla sobre reserva já agendada > POST /bloqueios sobre o mesmo período SEM confirmar retorna a lista de conflitantes (200, não cria) 29ms
✓ Bloqueios de Agenda (S9) — RN-BLK-01: confirmação dupla sobre reserva já agendada > BloqueioAgenda NÃO foi criado após a tentativa sem confirmação 9ms
✓ Bloqueios de Agenda (S9) — RN-BLK-01: confirmação dupla sobre reserva já agendada > POST /bloqueios com confirmar=true efetiva o bloqueio mesmo com a reserva agendada (201) 7ms
✓ Reservas recorrentes (S9 — RF-RES-03) > POST /reservas com recorrencia cria 12 ocorrências semanais vinculadas pelo mesmo recorrenciaId 253ms
✓ Reservas recorrentes (S9 — RF-RES-03) > uma segunda tentativa de série sobre as MESMAS datas é rejeitada por inteiro (tudo ou nada) — nenhuma nova reserva criada 31ms
✓ Reservas recorrentes (S9 — RF-RES-03) > Cancelar série cancela todas as ocorrências futuras pendente/agendada de uma vez 95ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
```

**Bug real encontrado e corrigido durante a escrita destes testes** (ver Seção 6): a query SQL de `POST /bloqueios` retornava colunas `hora_inicio`/`hora_fim` (snake_case) mas `reservasDentroDoIntervalo` esperava `horaInicio`/`horaFim` (camelCase, conforme a interface `ReservaComData`) — o TypeScript não pegou porque a anotação `.query<T>()` é apenas uma asserção de tipo, sem checagem em tempo de execução. O sintoma real foi um `500` (`TypeError: Cannot read properties of undefined (reading 'split')`) nos dois testes de confirmação dupla, só descoberto ao rodar os testes de verdade — exatamente o tipo de erro que a disciplina evidence-first existe para pegar.

### 3.4 Suíte completa do backend

`pnpm --filter api test` — 18 arquivos, **244/244**, 0 falhas:

```
Test Files  18 passed (18)
     Tests  244 passed (244)
```

Composição do delta em relação a S8 (211 testes): +9 em `unit/conflito.test.ts` (bloqueio), +8 em `unit/recorrencia.test.ts` (novo), +16 em `integration/bloqueios.test.ts` (novo) → 211 + 9 + 8 + 16 = 244.

`tsc --noEmit` limpo nos três pacotes (`apps/api`, `apps/web`, `packages/shared`) — sem output/erros.

## 4. Gate de Aceite

- [x] **Output real do teste de geração de reservas recorrentes com as 12 datas corretas** — Seção 3.1, teste `gera exatamente 12 ocorrências semanais a partir da data-base, todas na mesma semana do mês`, com as 12 datas explicitamente asseradas via `toEqual`.

- [x] **Curl comprovando rejeição de reserva dentro de bloqueio ativo, com mensagem explicando o motivo** — evidência real contra o servidor de desenvolvimento rodando (`localhost:3334`), login real, bloqueio real criado via API, reserva real rejeitada e depois limpa:

```
=== 1) Login Admin ===
{"token":"eyJhbGciOiJIUzI1NiIs...","usuario":{...}}

=== 2) Buscar uma plataforma ativa qualquer ===
{"id":"8FEC71A0-5F76-4FEB-927E-80C1294CFDB3","codigo":"PLT-001","nome":"Plataforma Elevatória A", ...}

=== 3) Admin cria bloqueio de agenda real (curl) ===
{"id":"37678721-458D-4B8C-B8EC-37195A0E591F","plataformaId":"8FEC71A0-5F76-4FEB-927E-80C1294CFDB3","plataformaNome":"Plataforma Elevatória A","dataInicio":"2026-12-15T03:00:00.000Z","dataFim":"2026-12-16T02:59:00.000Z","motivo":"EVIDENCIA S9 - Parada programada trimestral","criadoPorNome":"Administrador","criadoEm":"2026-07-13T15:04:28.205Z"}
HTTP_STATUS:201

=== 4) Login Colaborador ===
{"token":"eyJhbGciOiJIUzI1NiIs...","usuario":{"perfil":"colaborador", ...}}
HTTP_STATUS:200

=== 5) Colaborador tenta criar reserva DENTRO do bloqueio (curl) — deve ser 409 ===
{"erro":"Reserva bloqueada pela agenda: EVIDENCIA S9 - Parada programada trimestral (bloqueio de 2026-12-15 03:00 a 2026-12-16 02:59)."}
HTTP_STATUS:409

=== 6) GET /reservas/conflitos confirma o mesmo bloqueio em tempo real (checagem do formulario) ===
{"conflito":true,"motivo":"Reserva bloqueada pela agenda: EVIDENCIA S9 - Parada programada trimestral (bloqueio de 2026-12-15 03:00 a 2026-12-16 02:59).","reserva":null}
HTTP_STATUS:200
```

(O bloqueio de evidência foi removido logo depois via `DELETE /api/v1/bloqueios/{id}` → `204`, para não deixar dado de teste no ambiente de dev.)

- [x] **Captura de tela do Calendário com o bloqueio de agenda visualmente diferenciado** — evidência real via sessão de browser (login como Admin, navegação real até `/calendario`, 22 cliques em "Próxima semana" até a semana de 14–20/dez/2026 que contém o bloqueio criado no item anterior). Ver Seção 5 para a discussão completa sobre a limitação do tool de screenshot (mesmo problema já documentado no relatório de S8) e a evidência substituta coletada.

## 5. Evidência visual do Calendário — screenshot indisponível, substituída por evidência DOM/CSS computado

Assim como registrado no relatório de S8 (Seção 5), o tool `computer{action:"screenshot"}` voltou a apresentar timeout de 30s consistente nesta sessão — tentado duas vezes (`screenshot` e `zoom`), ambos falharam com o mesmo erro genérico ("Browser pane may be stuck"), sem erros de console e sem qualquer indício de que seja um problema do código desta sprint. Repito aqui a mesma disciplina evidence-first de sempre coletar prova real em vez de omitir o item do Gate:

1. **Texto renderizado da página** (`get_page_text`), confirmando a navegação real até a semana correta e o bloqueio aparecendo em todas as 15 linhas de hora da coluna de terça-feira (15/dez), cada uma rotulada `🚫 Plataforma Elevatória A`:

```
14 de dez. – 20 de dez.
...
Bloqueio de agenda
SEG 14 | TER 15 | QUA 16 | QUI 17 | SEX 18 | SÁB 19 | DOM 20
06:00
🚫 Plataforma Elevatória A
07:00
🚫 Plataforma Elevatória A
... (repete para todas as 15 linhas de hora, 06:00–20:00)
```

2. **CSS computado real** (via `javascript_tool`, uso de inspeção — não de implementação, a UI já estava pronta):

```json
{
  "totalCelulasBloqueadas": 16,
  "totalLabels": 15,
  "labelTexto": "🚫 Plataforma Elevatória A",
  "labelTitle": "Bloqueio: EVIDENCIA S9 - Parada programada trimestral (Plataforma Elevatória A)",
  "backgroundImageAplicado": "repeating-linear-gradient(135deg, rgb(237, 240, 244) 0px, rgb(237, 240, 244) 6px",
  "classeAplicada": "page_calLegendDot__34PHA page_calCellBlocked__77wgX"
}
```

Isso prova que o hachurado não é apenas uma classe CSS "morta" — o `background-image: repeating-linear-gradient(...)` está de fato computado e renderizado pelo navegador nas 15 células de hora da coluna bloqueada (+1 no swatch da legenda), visualmente distinto dos blocos sólidos coloridos por setor usados pelas reservas normais.

## 6. Correção incidental — bug real de nomeação de colunas em `POST /bloqueios`

Durante a escrita dos testes de integração (Seção 3.3), os dois testes de "confirmação dupla" (RN-BLK-01) falharam com `500` em vez do `200`/`201` esperado. Investigação revelou que a query SQL dentro de `routes/bloqueios.ts` aliasava as colunas de horário como `hora_inicio`/`hora_fim` (snake_case, seguindo o padrão do restante do banco), mas a função `reservasDentroDoIntervalo` (em `conflito.service.ts`) espera a interface `ReservaComData` com `horaInicio`/`horaFim` (camelCase — mesma convenção de `mapReserva`/`ReservaExistente` usada em todo o resto do domínio). O TypeScript não capturou o erro porque `.query<T>()` do driver `mssql` é apenas uma asserção de tipo sobre o `recordset` — não há checagem em tempo de execução de que as colunas retornadas realmente batem com `T`. O sintoma real era um `TypeError: Cannot read properties of undefined (reading 'split')` dentro de `combinarDataHora`, ao tentar fazer `.split(...)` num `horaInicio` que vinha `undefined`.

**Correção**: alterados os aliases da query para `horaInicio`/`horaFim` diretamente no SQL (`CONVERT(...) AS horaInicio`), eliminando o mapeamento manual e mantendo a interface `ReservaComData` como único formato entre a query e a função pura. Nenhuma outra rota foi afetada — este é o único lugar do código que constrói um `ReservaComData[]` a partir de uma query bruta com colunas renomeadas.

Este é exatamente o tipo de defeito que a disciplina evidence-first (rodar os testes de verdade, não assumir que "deve funcionar" porque o `tsc --noEmit` está limpo) existe para capturar — `tsc --noEmit` passou normalmente antes da correção, pois o erro só se manifesta em runtime.

## 7. Invariantes da Seção 2 do MASTER.md — nenhuma quebra, uma decisão de design registrada

Todas as invariantes seguidas. Uma decisão de design não trivial, documentada como ADR:

- **ADR-01 — `GET /api/v1/bloqueios` é acessível a todos os perfis autenticados, não restrito a Admin.** A tabela de RF-BLK-01/02/03 na SDD §6.3 lista "Admin" como perfil de todos os três requisitos de bloqueio, mas RF-CAL-01 (§6.6) exige que "Todos" vejam bloqueios de agenda visualmente distintos no Calendário. Interpretação: a restrição de perfil da SDD para BLK refere-se às ações de **escrita** (criar/editar/remover — de fato só Admin, via `requireRole(["admin"])` em `POST`/`DELETE`), não à leitura, que é dado operacional necessário para qualquer usuário planejar seu uso das plataformas. Criar uma segunda rota só para o Calendário duplicaria a mesma query sem nenhum ganho de segurança (o bloqueio não contém dado sensível — plataforma, período e motivo textual). Registrado aqui por precaução, já que não é uma leitura 100% literal da tabela de perfis do SDD.

Demais invariantes confirmadas: `/api/v1` como prefixo único (rotas novas: `GET/POST /bloqueios`, `DELETE /bloqueios/:id`, `POST /reservas/recorrencia/:id/cancelar`); IDs sempre `UNIQUEIDENTIFIER DEFAULT NEWID()` (`BloqueioAgenda`, `ReservaRecorrencia`); toda rota de escrita valida via Zod (`criarBloqueioSchema`, `recorrenciaInputSchema` embutido em `criarReservaSchema`); `rbac.ts` continua a única fonte de verdade de autorização (a UI em `BloqueiosClient.tsx`/`ReservaModal.tsx` apenas espelha as mesmas regras para não mostrar controles inúteis); `LogAuditoria` gravado na mesma transação da operação em toda rota de escrita nova (`criar_bloqueio`, `remover_bloqueio`, `criar_reserva` por ocorrência da série, `cancelar_serie_reserva`); e-mail sempre via fila BullMQ (`enfileirarEmail`) — cada ocorrência de uma série recorrente dispara sua própria notificação ao(s) Admin(s), replicando o comportamento de uma reserva avulsa.

## 8. ADRs (Architecture Decision Records)

- **ADR-01** — `GET /bloqueios` liberado a todos os perfis — ver Seção 7.
- **ADR-02 — `Reserva.recorrencia_id` em `GO` separado na migration `0007`**, mesmo padrão de S7 (ADR-02 daquele relatório): evita "Invalid column name" ao resolver a FK sobre `ReservaRecorrencia`, criada no mesmo script.
- **ADR-03 — Validação de disponibilidade da série recorrente é feita ANTES de abrir a transação de escrita** (loop síncrono de `verificarDisponibilidade` sobre todas as N datas, depois `transaction.begin()`). Alternativa descartada: inserir e fazer rollback ao encontrar a primeira data conflitante — mais caro (N inserts + rollback) e mais complexo de reportar qual data especificamente falhou. A checagem prévia também permite, no futuro (fora do escopo de S9), retornar a lista completa de datas conflitantes de uma vez, em vez de parar na primeira.
- **ADR-04 — Cada ocorrência da série recorrente dispara sua própria notificação de "reserva pendente" aos Admins**, em vez de um único e-mail resumindo a série inteira. Decisão alinhada ao próprio enunciado da sprint ("cada uma seguindo seu próprio fluxo de aprovação individual") — o Admin precisa aprovar/rejeitar cada ocorrência isoladamente, então um resumo agregado esconderia informação necessária para essa decisão. Trade-off consciente: até 12 e-mails por série criada: aceitável no volume esperado do sistema (reservas de plataforma internas, não um sistema de massa).
- **ADR-05 — `POST /reservas/recorrencia/:id/cancelar` não exige que a série inteira esteja em um único status** — cancela apenas as ocorrências que ainda estão `pendente`/`agendada`, ignorando silenciosamente as que já viraram `em_uso`/`concluida`/`cancelada`/`rejeitada`. Reflete literalmente o texto da sprint ("cancela todas as ocorrências futuras (pendente/agendada)") e evita um erro confuso quando o usuário cancela uma série parcialmente já em andamento.

## 9. Pendências para sprints futuras

- **UI de criação de plataforma ainda não expõe `categoria`/`risco`** (gap já registrado em S7/S8, reafirmado aqui) — usado apenas para escolher a plataforma de evidência via API/SQL direto, não é um problema introduzido por S9.
- **Tool de screenshot do Browser pane segue com timeout consistente** (mesmo comportamento documentado em S8) — nenhuma ação de código pode corrigir isso; recomendo reportar como problema de ambiente/infraestrutura da sessão, não do projeto.
- **`GET /reservas` não tem filtro por `recorrenciaId`** — não era necessário para o escopo desta sprint (a UI usa o campo já embutido em cada reserva da listagem/calendário), mas pode valer a pena adicionar se uma tela dedicada "ver toda a série" for pedida numa sprint futura de polimento (S14).
- **Notificação in-app (`tipo: 'bloqueio_criado'`, já previsto no enum de `Notificacao` da SDD §4.3) não foi implementada** — depende da infraestrutura de SSE/`Notificacao` que só chega em S10; a criação de bloqueio hoje não dispara nenhum e-mail/notificação (não era exigido pelo PASSO A PASSO desta sprint). Registrar como gancho para S10 conectar esse tipo de evento quando a tabela `Notificacao` existir.
- **Cancelar Série não está disponível a partir do Calendário/Fila de Aprovações** — `ReservaDetalheModal` recebe `onCancelarSerie` como prop opcional; apenas `ReservasClient.tsx` (tela "Reservas") a implementa nesta sprint. `CalendarioClient.tsx` e `FilaAprovacoesClient.tsx` continuam funcionando normalmente (o botão simplesmente não aparece ali), mas replicar a mesma função nesses dois componentes é uma melhoria de UX pendente, não bloqueante.
- Runner de migrations sem tabela de controle (pendência reafirmada desde S4) — ainda recomendado tratar antes de S15.
- Migração para Fastify 5.x — segue pendente, sem impacto nesta sprint.
- Credenciais reais do Microsoft Graph — pendente desde S1.

---

Não iniciei a próxima sprint nesta mesma sessão, conforme instruído.
