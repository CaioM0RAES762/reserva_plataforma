# Sprint S5 — Calendário + Histórico + Exportação CSV

| Campo | Valor |
|---|---|
| Sprint | S5 |
| Status | ✅ Concluída |
| Data | 2026-07-10 |
| Depende de | S4 (✅ Concluída, confirmado no início desta sessão) |

## 1. O que foi implementado

### Migration `0003_indice_reserva_data.sql`
`CREATE INDEX IX_Reserva_data ON Reserva(data)`. O índice já existente desde S1 (`IX_Reserva_plataforma_data`) lidera por `plataforma_id`, pouco útil para as novas *range queries* de Calendário/Histórico, que varrem `Reserva.data` sem filtro fixo de plataforma. Testada `up` → `down` → `up` diretamente contra o banco de desenvolvimento (ver ADR-01, mesmo padrão de S4).

### `GET /api/v1/historico` e `GET /api/v1/historico/export` (`apps/api/src/routes/historico.ts`)
- Filtros: `q` (texto — busca em setor/responsável/plataforma/motivo), `setor` (só Admin filtra livre; Colaborador é **sempre** restrito ao próprio setor, mesmo enviando `?setor=<outro>`), `plataforma`, `status`, `dateFrom`/`dateTo`. Validados via `historicoQuerySchema` (`packages/shared`).
- `montarWhereHistorico()` resolve o escopo de setor primeiro (RN de escopo do usuário) e só depois aplica os demais filtros — o parâmetro `setor` da query é ignorado por completo para não-Admin.
- `/export` reaproveita a mesma função de filtro, monta o CSV manualmente (`;` como separador, célula de motivo escapada com aspas duplicadas), prefixa com BOM UTF-8 (`﻿`) e responde com `Content-Type: text/csv; charset=utf-8` e `Content-Disposition: attachment`.
- `SELECT_RESERVA`, `FROM_RESERVA` e `mapReserva` de `reservas.ts` (S3/S4) foram exportados e reaproveitados em vez de duplicados.

### `GET /api/v1/reservas` estendida (S3/S4 → S5)
Passou a aceitar `dateFrom`/`dateTo` (além do `data` exato já existente), usado pelo Calendário para buscar a semana inteira em uma única chamada.

### `GET /api/v1/setores` (`apps/api/src/routes/setores.ts`) — novo
Rota mínima somente-leitura (`id`, `nome`, `corHex`), autenticada, sem `requireRole`. Necessária para a legenda por setor do Calendário (RF-CAL-01) e para o seletor de setor do Histórico — o CRUD completo de setores (criar/editar/desativar) permanece fora de escopo até S12. Ver ADR-02.

### `Plataforma.status = 'reservada'` derivado (RN-PLAT-03)
Recálculo de `Plataforma.status = 'reservada'` no S5 é o mesmo mecanismo herdado da S4, sem alteração: função reutilizável em tempo de leitura (`sqlStatusPlataformaDerivado`, S4), agora consumida também de forma indireta pelo Histórico/Calendário através dos dados de `Reserva` já retornados por `GET /reservas`/`GET /historico`.

### Frontend
- **`CalendarioClient.tsx`** (novo): porta `getWeekDates()`, `renderCalendar()`, `changeWeek()`, `goToToday()` do protótipo. Busca `GET /reservas?dateFrom=&dateTo=` para a semana exibida + `GET /setores` para a legenda de cores. Clique num evento abre o `ReservaDetalheModal` (reaproveitado de S4) — mesmas ações de aprovar/rejeitar/iniciar uso/concluir/cancelar já disponíveis diretamente no Calendário.
- **`HistoricoClient.tsx`** (novo): porta `filterHistory()`. Debounce de 250 ms nos filtros de texto/data, seletor de setor visível só para Admin (Colaborador nunca vê o filtro de setor na UI, reforçando no frontend a mesma regra já garantida no backend). Botão "Exportar CSV" chama `GET /historico/export` via `fetch()` direto (não `apiFetch`, pois a resposta é um `Blob`, não JSON) e dispara o download no navegador.
- **`ReservaDetalheModal.tsx`**: interface `ReservaDetalhe` estendida com `criadoEm` (necessário para exibir "Data/Hora Reserva" na tabela de Histórico).
- **`Sidebar.tsx`**: itens "Calendário" e "Histórico" trocados de `disponivel: false` para `true`; tag de versão atualizada para "PlataformaRes — S5".

## 2. Decisão de arquitetura sobre setores (fora do PASSO A PASSO original)

O prompt da sprint não previa uma nova rota, mas RF-CAL-01 exige "legenda por setor" com cor — informação que só existe em `Setor.cor_hex`, sem rota de leitura até então (CRUD completo é escopo de S12). Criei `GET /api/v1/setores` como leitura mínima, documentada abaixo como ADR-02.

## 3. Evidência do Gate de Aceite

### 3.1 Output real dos testes de filtro

Testes de integração de `historico.test.ts` (11 testes — filtros isolados, combinados, escopo por setor do Colaborador, exportação CSV):

```
✓ Histórico (S5) — filtros isolados > filtro de texto (q) encontra pela plataforma
✓ Histórico (S5) — filtros isolados > filtro de texto (q) encontra pelo motivo
✓ Histórico (S5) — filtros isolados > filtro de setor (Admin) restringe ao setor informado
✓ Histórico (S5) — filtros isolados > filtro de plataforma restringe à plataforma informada
✓ Histórico (S5) — filtros isolados > filtro de status restringe ao status informado
✓ Histórico (S5) — filtros isolados > filtro dateFrom/dateTo restringe ao intervalo informado
✓ Histórico (S5) — filtros combinados > setor + status combinados retornam apenas a interseção
✓ Histórico (S5) — filtros combinados > setor + status sem interseção retorna lista vazia
✓ Histórico (S5) — escopo por setor do Colaborador > Colaborador só vê registros do próprio setor por padrão
✓ Histórico (S5) — escopo por setor do Colaborador > Colaborador forçando ?setor=<outro setor> na query continua restrito ao próprio setor
✓ Histórico (S5) — exportação CSV > GET /historico/export retorna CSV com BOM UTF-8 e separador ;

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Suíte completa do backend (`pnpm --filter api test`), 0 falhas — 94/94 (83 pré-existentes de S1-S4 + 11 novos de S5):

```
✓ src/tests/unit/aprovacao.test.ts (20 tests)
✓ src/tests/unit/plataforma.test.ts (7 tests)
✓ src/tests/unit/conflito.test.ts (13 tests)
✓ src/tests/unit/password.test.ts (10 tests)
✓ src/tests/integration/auth.test.ts (4 tests)
✓ src/tests/integration/plataformas.test.ts (6 tests)
✓ src/tests/integration/reservas.test.ts (8 tests)
✓ src/tests/integration/historico.test.ts (11 tests)
✓ src/tests/integration/aprovacao.test.ts (15 tests)

 Test Files  9 passed (9)
      Tests  94 passed (94)
```

### 3.2 Arquivo CSV real gerado — BOM UTF-8 e acentuação

Reserva real criada via API (`Colaborador Gate S5`, setor Manutenção, plataforma "Elevatória Gate S5", motivo com acentuação pesada), aprovada pelo Admin, exportada via `GET /historico/export`:

Hexdump dos primeiros bytes, comprovando o BOM UTF-8 (`EF BB BF`) antes do cabeçalho:

```
00000000: efbb bf49 443b 4372 6961 6461 2065 6d3b  ...ID;Criada em;
00000010: 5365 746f 723b 5265 7370 6f6e 73c3 a176  Setor;Respons..v
00000020: 656c 3b50 6c61 7461 666f 726d 613b 4461  el;Plataforma;Da
```

Conteúdo real do arquivo (primeiras linhas, acentuação correta — `Responsável`, `Manutenção`, `Elevatória`, `Inspeção`, `segurança`, `região`, `elétrica`):

```
ID;Criada em;Setor;Responsável;Plataforma;Data;Início;Fim;Prioridade;Status;Motivo
89E6F87C-C16E-4CAF-9B80-8B0F2134BEAE;10/07/2026, 14:44;Manutenção;Colaborador Gate S5;Elevatória Gate S5;10/07/2026;09:00;10:00;alta;Agendada;"Inspeção de segurança e manutenção preventiva na região elétrica"
```

### 3.3 Captura do Calendário com reservas reais na grade semanal

A captura de tela via ferramenta de screenshot do navegador falhou de forma consistente nesta sessão (`computer{action:"screenshot"}` e `zoom` retornaram timeout mesmo após múltiplas tentativas e uma nova aba — limitação de infraestrutura do ambiente de preview, não do código). Como evidência equivalente e igualmente real, capturei a árvore de acessibilidade (`read_page`) e o texto renderizado (`get_page_text`) da página `/calendario` já autenticado como Admin, confirmando a grade semanal real com a reserva de evidência corretamente posicionada:

```
Calendário
Visualize a agenda de reservas por semana
06 de jul. – 12 de jul.
Hoje
Administrativo  Limpeza  Manutenção  Produção  Qualidade  RH  Segurança  TI   ← legenda de setores (GET /setores)
SEG 6  TER 7  QUA 8  QUI 9  SEX 10  SÁB 11  DOM 12
...
09:00
  button "Manutenção · Elevatória Gate S5 · 09:00–10:00"
    Elevatória Gate S5
    Manutenção
    09:00–10:00
10:00
...
```

O evento aparece exatamente na célula Sex(10)/09:00 — coerente com a reserva real criada para `2026-07-10` (sexta-feira) das 09:00 às 10:00. A tela de Histórico foi verificada da mesma forma (mesma reserva listada com filtros de setor/plataforma/status populados a partir de `GET /setores` e `GET /plataformas`).

## 4. Decisões técnicas (ADRs curtos)

- **ADR-01 — Migration `0003` aplicada diretamente via `sqlcmd`, mesmo padrão de S4 (ver ADR-01 do relatório S4).** O runner (`src/db/migrate.ts`) continua sem tabela de controle de migrations aplicadas; pendência já registrada para S6.
- **ADR-02 — Nova rota `GET /api/v1/setores` (somente leitura), fora do escopo textual do prompt, necessária para RF-CAL-01.** O prompt da S5 não menciona setores, mas a legenda de cores exigida pelo SDD (§10 — tela Calendário: "legenda por setor") depende de `Setor.cor_hex`, que não tinha rota de leitura própria até agora (CRUD completo continua em S12). Optei por uma rota mínima (`id`, `nome`, `corHex`, sem `requireRole`, qualquer perfil autenticado lê) em vez de expandir `GET /conta` ou embutir os dados em `GET /reservas`, para manter a responsabilidade de cada rota única e reaproveitável (Histórico também usa `GET /setores` para o seletor de filtro). Quando S12 implementar o CRUD completo de setores, esta rota deve ser mantida como está (ela já é o `GET` de listagem que o CRUD completo vai usar).
- **ADR-03 — CSV gerado com concatenação manual de string, não com biblioteca de terceiros.** O formato exigido (`;` como separador, aspas duplas escapando apenas o campo de motivo, BOM UTF-8 no início) é simples o suficiente para não justificar uma dependência nova (ex.: `csv-stringify`). Mantém consistência com o padrão já usado no protótipo (`exportCSV()`), agora migrado para o backend.
- **ADR-04 — Extensão de `GET /api/v1/reservas` com `dateFrom`/`dateTo` em vez de uma rota nova dedicada ao Calendário.** A rota já aceitava um filtro de `data` exata (S3); adicionar um intervalo opcional é uma extensão natural e evita duplicar a lógica de escopo por setor/Admin já implementada ali. `GET /historico` continua sendo a rota dedicada a filtros de texto/status/plataforma/setor combinados — a distinção de responsabilidade entre as duas rotas é: `GET /reservas` = operacional (o que está agendado agora), `GET /historico` = analítico/auditável (pesquisa ampla com exportação).
- **ADR-05 (limitação de ambiente) — Screenshot do navegador indisponível nesta sessão.** A ferramenta `computer{action:"screenshot"}` e `computer{action:"zoom"}` retornaram timeout de forma consistente (múltiplas tentativas, inclusive em uma aba nova), enquanto `read_page`/`get_page_text` funcionaram normalmente e confirmaram a renderização correta. Documentado com transparência na Seção 3.3 em vez de simular ou omitir a evidência — a árvore de acessibilidade real, obtida contra a aplicação rodando de verdade (não mockada), foi usada como evidência equivalente.

## 5. Invariantes da Seção 2 do MASTER.md — nenhuma foi quebrada

`UNIQUEIDENTIFIER DEFAULT NEWID()` mantido (nenhuma tabela nova). Validação Zod compartilhada (`packages/shared`) em `historicoQuerySchema`. `rbac.ts` aplicado em todas as rotas novas via `autenticar` (leitura, sem necessidade de `requireRole` já que RF-CAL-01/RF-HIST-01 são "todos — escopo por setor"). Nenhuma escrita nova nesta sprint, logo nenhum `LogAuditoria` adicional é necessário (Calendário e Histórico são 100% leitura). Nomenclatura de domínio em português. Testes com evidência real (11 novos + 83 pré-existentes, 94/94 no total). `/api/v1` mantido como prefixo único.

## 6. Pendências para a próxima sprint (e além)

- S6 (RBAC, auditoria e hardening) é a próxima sprint no roadmap do MASTER.md — não iniciada nesta sessão, conforme instrução explícita ("Não inicie S6 nesta mesma sessão a menos que instruído").
- Runner de migrations sem tabela de controle (ADR-01 de S4/S5) — recomendado tratar em S6.
- `GET /api/v1/setores` (ADR-02) deve ser revisitada quando S12 implementar o CRUD completo — nenhuma mudança de contrato é esperada, apenas novas rotas de escrita ao lado dela.
- Captura de tela via ferramenta de navegador falhou nesta sessão (ADR-05) — recomendo, numa próxima sessão com o ambiente de preview saudável, capturar screenshots reais das telas de Calendário e Histórico para o acervo visual do projeto, já que a evidência funcional já está validada.
- Credenciais reais do Microsoft Graph continuam pendentes desde a S1 (sem impacto nesta sprint, que não envia e-mails).
- Testes desta sprint (via `historico.test.ts`) e a evidência manual do Gate criaram e limparam dados reais no ambiente de desenvolvimento compartilhado — limpeza confirmada ao final da sessão (`total_reservas = 0`, `total_usuarios_teste = 0`, `total_plataformas = 1`, apenas a `PLT-001` legítima de S2 permanece).
