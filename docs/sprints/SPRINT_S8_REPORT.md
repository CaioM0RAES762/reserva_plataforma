# Sprint S8 — Checklist de Segurança

| Campo | Valor |
|---|---|
| Sprint | S8 |
| Status | ✅ Concluída |
| Data | 2026-07-13 |
| Depende de | S7 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Módulo de compliance NR-18/NR-35 — bloqueia `em_uso` sem checklist aprovado |

## 1. Objetivo

Implementar o checklist de segurança obrigatório (NR-18/NR-35) para plataformas de categoria `elevatoria`/`andaime`: templates por categoria, preenchimento por reserva com evidência fotográfica opcional, e bloqueio server-side da transição para `em_uso` enquanto o checklist não estiver aprovado (RF-RES-10/RN-RES-12).

## 2. O que foi implementado

### 2.1 Schema (migration `0006`)

- **`0006_checklist_seguranca.sql`**: cria `ChecklistItemTemplate` (`categoria_plataforma`, `descricao`, `ordem`, `obrigatorio`, `ativo`), `ChecklistPreenchido` (`reserva_id` único, `preenchido_por_id`, `todos_conformes`, `preenchido_em`) e `ChecklistResposta` (`checklist_preenchido_id`, `item_id`, `conforme`, `observacao`, `foto_url` — único par `checklist_preenchido_id`+`item_id`).
- Seed de templates: categoria `elevatoria` com os 6 itens literais do SDD §17.9, todos `obrigatorio=1`; categoria `andaime` com 5 itens adaptados a NR-18 (base/travamento, contraventamento, guarda-corpo completo, distância de rede elétrica, EPI de trabalho em altura), também todos `obrigatorio=1` — redação documentada no arquivo da migration.
- `requer_checklist` **não é uma coluna nova** — é derivado de `Plataforma.categoria` em tempo de execução via `requerChecklist()` em `checklist.service.ts` (`elevatoria`/`andaime` nesta sprint), conforme a nota do SDD §4.2 de que esse campo é "derivado da categoria".

### 2.2 `packages/shared`

- `schemas/checklist.ts` (novo): `checklistItemTemplateSchema`, `criarChecklistItemTemplateSchema`, `checklistRespostaInputSchema` (com `fotoBase64` opcional), `preencherChecklistSchema`, `checklistReservaSchema` (resposta agregada de `GET /reservas/:id/checklist`).
- `schemas/reserva.ts`: `reservaPublicaSchema` ganha `plataformaCategoria` — usado pelo frontend para decidir quando renderizar a seção de checklist e espelhar o bloqueio de "Iniciar Uso" (o backend é sempre a fonte de verdade).

### 2.3 `checklist.service.ts` (novo)

- `requerChecklist(categoria)`: `true` para `elevatoria`/`andaime` (RN-RES-12). `veiculo`/`outro` ficam fora do escopo desta sprint — SDD §2.4 os marca como "opcional (configurável)", tratamento adiado (ver Pendências).
- `validarRespostasChecklist(itensTemplate, respostas)`: RN-CHK-01 — lança `ItemObrigatorioNaoRespondidoError` se algum item `obrigatorio=1` não tiver resposta; lança `ObservacaoObrigatoriaError` se alguma resposta `conforme=false` não tiver `observacao` preenchida (com `.trim()`).
- `calcularTodosConformes(itensTemplate, respostas)`: RN-CHK-02 — `true` somente se **todas** as respostas de itens obrigatórios forem `conforme=true`; item obrigatório sem resposta conta como reprovação (não assume conforme por omissão); itens opcionais não entram no cálculo.

### 2.4 `storage.service.ts` (novo) — armazenamento simplificado, isolado atrás de interface

- `ArmazenamentoService` com um único método (`salvarFotoBase64`); implementação `ArmazenamentoLocalService` grava em `apps/api/uploads/checklist/<reservaId>/<uuid>.<ext>` a partir de um data URL base64, validando MIME (`image/*`) e limite de 10 MB (RNF-09).
- Nenhum código fora deste módulo conhece o detalhe de armazenamento em disco — a troca para Azure Blob Storage em S11 é uma reimplementação de `ArmazenamentoService`, sem tocar em `checklist.service.ts` nem nas rotas.
- `routes/uploads.ts` (novo): `GET /uploads/*` autenticado, serve os arquivos gravados (sem SAS token — isso entra com o Azure Blob em S11, RNF-09).

### 2.5 Rotas

- `GET /api/v1/checklist-templates?categoria=` (todos autenticados) e `POST /api/v1/checklist-templates` (Admin) — RF-CHK-01.
- `GET /api/v1/reservas/:id/checklist` — escopo via `usuarioNoEscopoDaReserva` (S7); se a plataforma não exige checklist, retorna `{ requerChecklist: false, itens: [] }` direto, sem consultar templates.
- `PUT /api/v1/reservas/:id/checklist` — valida escopo, `RN-RES-04` (reserva final é somente leitura), `requerChecklist`; roda `validarRespostasChecklist` (422 se falhar) e `calcularTodosConformes`; salva fotos via `armazenamentoService` fora da transação de banco, depois faz upsert de `ChecklistPreenchido`/`ChecklistResposta` (delete+reinsert das respostas) numa transação única com `LogAuditoria` (`preencher_checklist`).
- `PATCH /api/v1/reservas/:id/status` (rota de S4, já usada para `iniciar_uso`/`concluir`): antes de chamar `transicionar`, se `acao === "iniciar_uso"` e `requerChecklist(plataforma_categoria)`, busca `ChecklistPreenchido.todos_conformes`; sem registro → 409 "ainda não foi preenchido"; `todos_conformes=0` → 409 com a mensagem de RN-CHK-02. `buscarContextoReserva`/`SELECT_RESERVA`/`mapReserva` ganharam `plataforma_categoria`.

### 2.6 Notificação ao Admin (RF-CHK-03/RN-CHK-02)

- `templateChecklistNaoConforme` (novo, `email.service.ts`): ao salvar um checklist com `todosConformes=false`, a rota `PUT /checklist` enfileira e-mail (BullMQ, nunca síncrono) para todos os Admins ativos. **Sem mudança automática de status da plataforma** — só o alerta, conforme RN-CHK-02 ("manutenção sugerida ao Admin, não automática").

### 2.7 Frontend

- **`ChecklistSeguranca.tsx`** (novo componente): busca `GET /reservas/:id/checklist` ao montar; não renderiza nada se `requerChecklist=false`; por item, toggle Conforme/Não conforme, textarea de observação condicional (só aparece quando não conforme), input de foto (lido como base64 no cliente, enviado só no Salvar). Badge de status: "Pendente de preenchimento" / "Aprovado — libera Iniciar Uso" / "Reprovado — Iniciar Uso bloqueado".
- **`ReservaDetalheModal.tsx`**: embute `ChecklistSeguranca` quando `status` é `agendada`/`em_uso`/`concluida`; `podeIniciarUso` agora exige `checklistLiberaUso` (`true` se a plataforma não exige checklist, ou se `todosConformes===true`) além das checagens de escopo/status já existentes de S7 — mensagem explicativa aparece quando o botão está bloqueado só por causa do checklist.
- `somenteLeitura` do checklist: usuário fora do escopo do setor, ou reserva em estado final (`concluida`/`cancelada`/`rejeitada`).

## 3. Testes obrigatórios — confirmação

### 3.1 Unitário — `checklist.service.ts` (`tests/unit/checklist.test.ts`, 18 testes novos)

Cobre exatamente os três cenários exigidos pelo PASSO A PASSO — item obrigatório sem resposta, item não conforme sem observação, cálculo de `todosConformes` em cenários mistos — além de `requerChecklist` por categoria. Output real:

```
✓ src/tests/unit/checklist.test.ts (18 tests) 4ms
```

### 3.2 Integração — bloqueio de `em_uso` (`tests/integration/checklist.test.ts`, novo arquivo, 10 testes)

Via API real (`app.inject`, sem mocks). Output real:

```
✓ src/tests/integration/checklist.test.ts (10 tests) 2969ms
   ✓ GET /checklist-templates — RF-CHK-01 > categoria elevatória tem 6 itens, todos obrigatórios (SDD §17.9)
   ✓ GET /reservas/:id/checklist — plataforma sem exigência de checklist > plataforma categoria 'sala' -> requerChecklist=false, sem itens
   ✓ PUT /reservas/:id/checklist — RN-CHK-01 (validação) > item obrigatório sem resposta -> 422
   ✓ PUT /reservas/:id/checklist — RN-CHK-01 (validação) > item não conforme sem observação -> 422
   ✓ PUT /reservas/:id/checklist — RN-CHK-01 (validação) > todos os itens conformes -> 200, todosConformes=true
   ✓ PUT /reservas/:id/checklist — RN-CHK-01 (validação) > um item não conforme com observação -> 200, todosConformes=false (cenário misto)
   ✓ PATCH /reservas/:id/status (iniciar_uso) — RF-RES-10/RN-RES-12 > plataforma elevatória sem checklist preenchido -> 409, erro explícito
   ✓ PATCH /reservas/:id/status (iniciar_uso) — RF-RES-10/RN-RES-12 > plataforma elevatória com checklist reprovado (item não conforme) -> 409
   ✓ PATCH /reservas/:id/status (iniciar_uso) — RF-RES-10/RN-RES-12 > plataforma elevatória com checklist aprovado (todos conformes) -> 200, em_uso
   ✓ PATCH /reservas/:id/status (iniciar_uso) — RF-RES-10/RN-RES-12 > plataforma 'sala' (sem exigência) inicia uso normalmente sem checklist

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

### 3.3 Suíte completa do backend

`pnpm --filter api test` — 16 arquivos, **211/211**, 0 falhas:

```
 Test Files  16 passed (16)
      Tests  211 passed (211)
   Duration  44.25s
```

Composição do delta em relação a S7 (183 testes): +18 em `unit/checklist.test.ts`, +10 em `integration/checklist.test.ts` (novo arquivo) → 183 + 18 + 10 = 211.

## 4. Gate de Aceite

- [x] **Output real dos testes do `checklist.service.ts`** — Seção 3.1 (18/18) + Seção 3.3 (suíte completa 211/211).

- [x] **Curl/teste comprovando o bloqueio de `em_uso` sem checklist aprovado** — Seção 3.2 (testes de integração via `app.inject`) e, adicionalmente, chamada HTTP real via `fetch` (login real + `PATCH` real) contra a API rodando em `localhost:3334`, numa reserva de demonstração cujo checklist foi reprovado via UI (Seção 5):

```
=== Login Admin === 200
=== PATCH /reservas/:id/status (iniciar_uso) — checklist reprovado ===
HTTP 409
{
  "erro": "O checklist de segurança desta reserva tem item obrigatório não conforme — início de uso bloqueado até revisão da plataforma (RN-CHK-02)."
}
```

- [x] **Captura do checklist com item marcado não conforme, mostrando o bloqueio refletido na UI** — coletada via browser real (login efetivo como Colaborador TI Demo e como Admin, navegação real para `/reservas`, preenchimento real do formulário). Ver Seção 5 para o texto completo da página e a ressalva sobre a ferramenta de screenshot.

## 5. Evidência de UI — sessão real no browser

**Ferramenta de screenshot indisponível nesta sessão**: `computer{action:"screenshot"}` e `computer{action:"zoom"}` retornaram timeout de forma consistente (inclusive numa aba nova, numa página em branco de login, sem qualquer relação com o código desta sprint — não há erro no console do navegador). Na ausência de captura de pixel, a evidência abaixo é o dump real da árvore de acessibilidade/texto da página (`get_page_text`/`read_page`) após interações reais do mouse/teclado — não é um resumo nem uma simulação.

Passos executados de fato no browser:
1. Login como `colaborador.ti@metalsider.com.br` (setor TI), criação de uma plataforma `Plataforma Elevatória Demo S8` (categoria ajustada para `elevatoria`/`alto` via SQL — **o formulário de cadastro de Plataforma na UI ainda não expõe os campos categoria/risco/aprovação automática**, pendência já registrada em S7 e adiada para S12).
2. Criação de reserva real via "Nova Reserva" para essa plataforma, aprovação real como Admin na Fila de Aprovações (`agendada`).
3. Abertura do Detalhe da Reserva como Colaborador: seção "Checklist de Segurança (NR-18/NR-35)" renderizada com os 6 itens da categoria elevatória, badge "Pendente de preenchimento", sem botão de Iniciar Uso.
4. Marcação do item 1 ("Guarda-corpo e rodapé instalados e íntegros") como **Não conforme**, com observação obrigatória preenchida; demais 5 itens marcados **Conforme**; clique em "Salvar Checklist".
5. Texto real da página após salvar (Colaborador):

```
Checklist de Segurança (NR-18/NR-35)
Reprovado — Iniciar Uso bloqueado
Guarda-corpo e rodapé instalados e íntegros*
Conforme / Não conforme
...
Último preenchimento por Colaborador TI Demo em 13/07/2026, 11:27:00.
O botão "Iniciar Uso" fica bloqueado até o checklist de segurança acima ser preenchido com
todos os itens obrigatórios conformes (RN-RES-12).
```

6. Reabertura da mesma reserva como **Admin**: mesmo badge "Reprovado — Iniciar Uso bloqueado", nenhum botão "Iniciar Uso" disponível — confirma que o bloqueio na UI vale para qualquer perfil aprovador, não só para quem preencheu.
7. Notificação ao Admin: o job de e-mail `PlataformaRes — Checklist com não conformidade (Plataforma Elevatória Demo S8)` foi enfileirado de fato (verificado na fila BullMQ/Redis, `bull:email:809`) e falhou apenas por `GRAPH_SENDER_EMAIL não configurado` — mesma pendência de credenciais do Microsoft Graph registrada desde S1, não um defeito desta sprint (mesmo padrão de falha dos e-mails de "Nova reserva pendente"/"Reserva aprovada" já existentes).

## 6. Correção incidental — mojibake (double-encoding UTF-8) no seed da migration `0006`

Ao aplicar a migration via `sqlcmd -i arquivo.sql` (mesmo padrão de S4/S5/S7, ADR-01 de S7) sem especificar o code page de entrada, os `INSERT` dos textos acentuados (`é`, `í`, `ç`, `ã`, `á`) foram gravados como UTF-8 duplamente codificado (`Ã©`, `Ã­` etc.) — confirmado via consulta direta com o driver `mssql` do Node (que não depende do code page do terminal), não um problema de exibição do `sqlcmd`. **Corrigido** com `UPDATE` direto via driver `mssql`/Node (que envia os parâmetros como `NVARCHAR` sem qualquer conversão de code page), para os 3 itens afetados de `elevatoria` e 4 de `andaime`; verificado depois via `SELECT` pelo mesmo driver e via UI real (Seção 5) — texto correto em ambos.

**Nota para sprints futuras**: o mesmo problema já existe, pré-existente, em dados de S1 (`Setor.nome` como "Manutenção"/"Produção"/"Segurança" também aparecem com mojibake quando consultados via `sqlcmd` sem `-f 65001`) — não é uma regressão desta sprint, mas reforça que **migrations com texto acentuado devem ser aplicadas com `sqlcmd ... -f 65001`**, ou (mais robusto) via um script Node com o driver `mssql`, que não depende do code page do console. Registrado como pendência para tratar de forma sistemática (ver Seção 8).

## 7. Invariantes da Seção 2 do MASTER.md

Todas seguidas, sem exceções novas:

- IDs: `ChecklistItemTemplate`/`ChecklistPreenchido`/`ChecklistResposta` usam `UNIQUEIDENTIFIER DEFAULT NEWID()`.
- `/api/v1` como prefixo único (`/uploads/*` é a única exceção deliberada, fora do prefixo por ser um endpoint de arquivo estático, não de API REST — mesmo raciocínio se aplicaria à futura URL de SAS token do Azure Blob em S11).
- Toda rota de escrita valida payload via Zod (`preencherChecklistSchema`, `criarChecklistItemTemplateSchema`).
- `rbac.ts` continua a única fonte de verdade de autorização — a UI só espelha a mesma regra de escopo (`usuarioNoEscopoDaReserva`) para não mostrar campos inúteis; o backend sempre revalida.
- `LogAuditoria` gravado na mesma transação da operação (`preencher_checklist`, `criar_checklist_item_template`).
- E-mail sempre via fila BullMQ, nunca síncrono (`templateChecklistNaoConforme` via `enfileirarEmail`).
- Anexos (fotos do checklist) **não** estão no banco relacional — só a URL em `ChecklistResposta.foto_url`; o binário vive em disco (`apps/api/uploads/`), isolado atrás de `storage.service.ts` para a troca por Azure Blob em S11 sem migração de schema.

## 8. ADRs (Architecture Decision Records)

- **ADR-01 — `requerChecklist` é uma função pura sobre `Plataforma.categoria`, não uma coluna `requer_checklist` no banco.** Evita duas fontes de verdade (categoria vs. flag) que poderiam divergir; a única exceção prevista pelo SDD (`veiculo`/`outro` configuráveis pelo Admin) fica fora do escopo desta sprint — ver Pendências.
- **ADR-02 — Upsert do checklist via delete+reinsert de `ChecklistResposta`, não `MERGE`/update por item.** Mais simples de raciocinar e testar (sempre um snapshot completo e consistente das respostas atuais); o preço é perder o `id` de respostas antigas a cada novo salvamento — aceitável porque o histórico de checklist não é uma entidade auditável campo a campo nesta sprint (o `LogAuditoria` já registra `todosConformes` e a contagem de respostas a cada `PUT`).
- **ADR-03 — Armazenamento de fotos em disco local, isolado atrás de `ArmazenamentoService`.** Especificado explicitamente pelo prompt da sprint ("armazenamento simplificado... isole atrás de uma interface fácil de trocar"); a troca por Azure Blob Storage em S11 é uma nova implementação da mesma interface, sem tocar em `checklist.service.ts`, nas rotas ou no schema (`foto_url` já é só uma URL).
- **ADR-04 — `GET /uploads/*` fica fora do prefixo `/api/v1`.** É um endpoint de arquivo estático (imagem), não uma rota de API JSON; autenticado da mesma forma (cookie JWT) para não expor fotos de checklist publicamente — o SAS token de curta duração (RNF-09) só faz sentido quando o Azure Blob entrar em S11.
- **ADR-05 — Migrations com texto acentuado exigem `sqlcmd -f 65001` (ou aplicação via driver Node).** Ver Seção 6 — registrado como prática obrigatória daqui em diante, não uma mudança de invariante da Seção 2 do MASTER.md.

## 9. Pendências para sprints futuras

- **UI de cadastro/edição de Plataforma não expõe `categoria`/`risco`/`aprovacaoAutomatica`** (campos existem desde S7, mas o formulário do frontend não tem esses inputs) — pendência já citada implicitamente em S7, agora bloqueia também o fluxo natural de criar uma plataforma elevatória/andaime pela UI; recomendado tratar em S12 junto da administração completa.
- **Categorias `veiculo`/`outro` como "opcional (configurável)" (SDD §2.4)** não foram implementadas nesta sprint — `requerChecklist` hoje só retorna `true` para `elevatoria`/`andaime`, sem mecanismo de configuração por Admin. Se necessário, entra como campo extra em `Plataforma` ou em `ConfiguracaoSistema` numa sprint futura.
- **Runner de migrations sem tabela de controle** (ADR-01 de S4/S5/S7, reafirmado) — ainda pendente.
- **Credenciais reais do Microsoft Graph** — pendente desde S1 (afeta também a notificação de checklist não conforme desta sprint, mesmo padrão de falha das demais notificações).
- **SAS token / expiração de acesso a anexos (RNF-09)** — só relevante quando o Azure Blob Storage substituir o armazenamento local em S11.
- **Ferramenta de screenshot do browser instável nesta sessão** — considerar revalidar visualmente (captura de pixel) numa sessão futura se a ferramenta for restaurada; a evidência funcional (DOM real + chamadas HTTP reais) já comprova o comportamento.
- Bloqueios de Agenda/reservas recorrentes (S9) e o restante do roadmap seguem conforme MASTER.md Seção 5.

---

Não iniciei a Sprint S9 nesta sessão, conforme instruído.
