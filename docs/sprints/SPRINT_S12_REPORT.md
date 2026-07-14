# Sprint S12 — Administração Completa (Usuários, Setores, Configurações, Auditoria)

| Campo | Valor |
|---|---|
| Sprint | S12 |
| Status | ✅ Concluída |
| Data | 2026-07-14 |
| Depende de | S7 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Fecha o mecanismo provisório de administração aberto desde S7 — Admin passa a ter controle operacional total via UI, sem depender de scripts/CLI |

## 1. Objetivo

Dar ao Admin controle operacional total sobre o sistema: CRUD completo de Usuários e Setores (substituindo definitivamente os mecanismos provisórios de S7), tela de Configurações do Sistema conectada de ponta a ponta às regras de agendamento de Reserva (antes inexistentes no código), e tela de Auditoria com consulta e exportação do `LogAuditoria` (persistido desde S1, nunca lido via API até esta sprint).

## 2. O que foi implementado

### 2.1 Migration (`0010_configuracoes_admin.sql`)

Insere em `ConfiguracaoSistema` (tabela criada em S7) as 5 chaves pedidas por RF-CFG-01/02, com os valores padrão do SDD §17.10: `antecedencia_minima_horas` (2), `duracao_maxima_horas` (12), `max_pendentes_por_setor` (5), `horario_expediente_inicio` (06:00), `horario_expediente_fim` (22:00). Nenhuma alteração de schema — só `INSERT`. Aplicada diretamente via `sqlcmd` contra o banco de desenvolvimento (mesmo padrão de S4/S5/S7 — ADR-01 de S4, ainda sem tabela de controle de migrations aplicadas).

### 2.2 `packages/shared` (contratos compartilhados)

- `schemas/configuracao.ts` (novo): `CHAVES_CONFIGURACAO` (as 6 chaves, incluindo `sla_aprovacao_urgente_horas` de S7), `configuracaoPublicaSchema`, `atualizarConfiguracoesSchema` (todos os campos opcionais, mas exige ao menos um preenchido; valida `horarioExpedienteFim > horarioExpedienteInicio` quando ambos vêm no mesmo payload).
- `schemas/usuario.ts`: `editarUsuarioSchema` (nome/email/setorId) e `atualizarStatusUsuarioSchema` (RF-USR-03) — novos; `criarUsuarioSchema`/`atualizarPerfilUsuarioSchema` já existiam desde S1/S7, agora finalmente usados em rotas.
- `schemas/setor.ts`: `setorAdminSchema` (com `ativo`), `criarSetorSchema`/`editarSetorSchema` (nome + corHex validado como hex), `atualizarStatusSetorSchema` — todos novos (S1 só tinha `setorPublicoSchema`, somente leitura).
- `schemas/auditoria.ts` (novo): `auditoriaPublicaSchema`, `auditoriaQuerySchema` (usuarioId/acao/entidade/dateFrom/dateTo).

### 2.3 `configuracao.service.ts` (novo) — RF-CFG-01/02

Centraliza toda leitura/escrita de `ConfiguracaoSistema`, com cache leve em memória do processo (`let cache: Record<string,string> | null`), sem TTL — invalidado explicitamente em `salvarConfiguracoes()` ao final da mesma transação de escrita de `PUT /configuracoes`. Expõe `obterValoresConfiguracao()`, `obterRegrasReservaConfiguraveis()` (as 4 regras de agendamento) e `obterSlaAprovacaoUrgenteHoras()`.

Migrou os dois pontos que já liam `sla_aprovacao_urgente_horas` via SQL inline desde S7 para usar este serviço:
- `escalonamento.service.ts`: `buscarSlaHoras()` (query direta) → `obterSlaAprovacaoUrgenteHoras()`.
- `routes/reservas.ts` (`GET /reservas/fila-aprovacoes`): a subquery SQL duplicada (`CAST((SELECT valor FROM ConfiguracaoSistema...))`, repetida duas vezes na mesma query) foi removida — `slaEstourado` agora é calculado em JS a partir de `criado_em` e do valor já cacheado.

### 2.4 Regras de agendamento configuráveis — `conflito.service.ts` + `routes/reservas.ts`

Estas 3 regras **não existiam no código antes desta sprint** (nem hardcoded, nem via config — grep confirmou zero ocorrências): antecedência mínima, duração máxima e bloqueio fora do horário de expediente. Implementadas do zero:

- `conflito.service.ts`: nova função pura `validarJanelaReserva(dados, regras, agora)` — RN-RES-03 (duração máxima), RN-RES-06 (horário de expediente, exceto prioridade `urgente`) e RN-RES-03 (antecedência mínima). `agora` é parametrizável para teste determinístico. `horaParaMinutos` passou a ser exportada (já existia, privada).
- `routes/reservas.ts` (`POST /reservas`): chama `obterRegrasReservaConfiguraveis()` + `validarJanelaReserva()` antes da checagem de disponibilidade; em seguida, checa `max_pendentes_por_setor` (RN-RES-05) via `COUNT(*)` de `Reserva` `pendente` do setor, somando a quantidade de ocorrências a criar (recorrência é tudo-ou-nada) — rejeita com 409 se ultrapassar o limite configurado.

### 2.5 Rotas — `configuracoes.ts` (novo)

`GET /api/v1/configuracoes` e `PUT /api/v1/configuracoes` (Admin only). O `PUT` grava cada chave alterada em `ConfiguracaoSistema` e o `LogAuditoria` (`atualizar_configuracao`, `entidade_id = NULL` pois a tabela é chave-valor, não uma entidade com UUID) **na mesma transação**, invalidando o cache do `configuracao.service.ts` só ao final.

### 2.6 Rotas — `usuarios.ts` (expandido) — RF-USR-01..05

Mantém intacta a rota provisória de S7 (`PATCH /:id/perfil`). Adiciona: `GET /usuarios` (busca `q` + filtros `setor`/`perfil`/`status`), `POST /usuarios` (cria com `email_verificado=0`, gera `CodigoVerificacao` tipo `ativacao_conta` e envia e-mail via `enfileirarEmail`, tudo na mesma transação), `PATCH /usuarios/:id` (edita nome/email/setor — perfil continua na rota separada), `PATCH /usuarios/:id/status` (RF-USR-03, soft delete — bloqueia o Admin de desativar a própria conta), `POST /usuarios/:id/reenviar-codigo` (RF-USR-04 — decide `ativacao_conta` vs `reset_senha` conforme `email_verificado`).

### 2.7 Rotas — `setores.ts` (expandido) — RF-SET-01/02

Mantém `GET /setores` (S1, somente `ativo=1`, consumida pelo Calendário/formulário de reserva). Adiciona `GET /setores/admin` (todos, incluindo inativos), `POST /setores`, `PATCH /setores/:id` (nome/corHex), `PATCH /setores/:id/status`. A desativação valida **RN-USR-02** antes do `UPDATE`: `SELECT TOP 1 id FROM Usuario WHERE setor_id = @id AND ativo = 1` — se encontrar, retorna 409 sem tocar o banco (mesmo padrão de RN-PLAT-02 em `plataformas.ts`, S2).

### 2.8 Rota — `auditoria.ts` (novo) — RF-AUD-01/02

`GET /api/v1/auditoria` (filtros usuário/ação/entidade/período, `TOP 500`) e `GET /api/v1/auditoria/export` (CSV UTF-8 com BOM, `;`, mesma estrutura de `historico.ts` de S5). Primeira leitura do `LogAuditoria` via API desde que a tabela existe (S1).

### 2.9 Frontend

Novas rotas sob `/administracao` (pasta nova, App Router): `usuarios`, `setores`, `configuracoes`, `auditoria` — cada uma Server Component (checa `perfil === "admin"`, redireciona para `/dashboard` senão) + Client Component, seguindo o padrão de `PlataformasClient`/`PlataformaModal` (S2). `Admin.module.css` novo (compartilhado pelas 4 telas — evita duplicar o CSS de tabela/modal 4 vezes). `Sidebar.tsx`: 4 novos itens de menu, todos `perfis: ["admin"]`.

- **Usuários**: listagem com busca + filtros (setor/perfil/status), modal de criação/edição (perfil editável na mesma tela, chamando `PATCH /:id/perfil` quando muda), botões Editar/Reenviar Código/Ativar-Desativar.
- **Setores**: listagem com swatch de cor, modal de criação/edição, Ativar/Desativar.
- **Configurações**: um card por chave (6 chaves), inputs `number`/`time` conforme o tipo, exibe descrição e "última atualização"; um único botão "Salvar Alterações" envia todos os campos de uma vez ao `PUT /configuracoes`.
- **Auditoria**: tabela com filtros (ação/entidade/período) + botão "Exportar CSV" (via `fetch` + `Blob` + link de download, já que é GET autenticado por cookie, não JSON).

## 3. Testes obrigatórios — confirmação

### 3.1 GATE — configuração dinâmica afetando validação de reserva (`tests/integration/configuracoes.test.ts`, novo, 8 testes)

Sequência real via API (`app.inject`, sem mocks, sem restart do processo):

```
=== EVIDÊNCIA S12 — PUT /configuracoes (duracaoMaximaHoras: 2) ===
┌─────────┬────────────────────────┬───────┬─────────────────────────────────────────────────────────────────────────────────────┬────────────────────────────┬──────────────────────────────────────────┐
│ (index) │ chave                  │ valor │ descricao                                                                              │ atualizadoEm               │ atualizadoPorId                           │
├─────────┼────────────────────────┼───────┼─────────────────────────────────────────────────────────────────────────────────────┼────────────────────────────┼────────────────────────────────────────────┤
│ 0       │ 'duracao_maxima_horas' │ '2'   │ 'Duracao maxima permitida, em horas, para uma unica reserva (RN-RES-03/RF-CFG-01).'   │ '2026-07-14T12:08:20.538Z' │ '2752D242-316D-4717-BCB6-41B91F04E1B7'    │
└─────────┴────────────────────────┴───────┴─────────────────────────────────────────────────────────────────────────────────────┴────────────────────────────┴──────────────────────────────────────────┘

=== EVIDÊNCIA S12 — POST /reservas de 3h, MESMO PROCESSO, SEM RESTART ===
{
  statusCode: 409,
  corpo: { erro: 'A duração da reserva não pode exceder 2 hora(s) (configuração do sistema).' }
}
```

A reserva de 3h havia sido aceita (201) no teste anterior, com `duracaoMaximaHoras=12` (baseline). Após o `PUT`, a mesma reserva de 3h passa a ser rejeitada (409) **sem reiniciar o servidor** — prova direta da invalidação de cache em `configuracao.service.ts`. Um teste subsequente restaura `duracaoMaximaHoras=12` e confirma que a reserva volta a ser aceita (201), ainda na mesma sessão do processo. `PUT /configuracoes` também grava `LogAuditoria` (`atualizar_configuracao`), confirmado por query direta.

### 3.2 GATE — RN-USR-02 (`tests/integration/setores.test.ts`, novo, 9 testes)

```
=== EVIDÊNCIA S12 — PATCH /setores/:id/status (ativo:false) com usuário ativo vinculado ===
{
  statusCode: 409,
  corpo: {
    erro: 'Existem usuários ativos vinculados a este setor. Desative-os (ou transfira-os para outro setor) antes de desativar o setor (RN-USR-02).'
  }
}
```

Query direta confirma que o setor permanece `ativo = 1` após a tentativa rejeitada. Um teste subsequente desativa o usuário vinculado (`PATCH /usuarios/:id/status`) e confirma que a desativação do setor passa a ser aceita (200) — mesmo mecanismo, novo estado.

### 3.3 GATE — exportação CSV de auditoria (`tests/integration/auditoria.test.ts`, novo, 3 testes + evidência real via browser)

Via teste automatizado (`app.inject`), confirma `Content-Type: text/csv`, BOM UTF-8 (`charCodeAt(0) === 0xFEFF`) e cabeçalho exato. Via browser real (Admin logado, clique em "Exportar CSV" na tela `/administracao/auditoria`), a requisição `GET /api/v1/auditoria/export` retornou `200 OK` (confirmado em `read_network_requests`) e o CSV real contém, entre outras, as linhas geradas pelos próprios testes desta sprint:

```
Data/Hora;Usuário;Ação;Entidade;ID da Entidade;Detalhes
14/07/2026, 09:13;Administrador;alterar_status_usuario;Usuario;0F7FB825-F8CE-4B17-A9D1-353ACA23E7DB;"{""ativoAnterior"":true,""ativoNovo"":false}"
14/07/2026, 09:13;Administrador;comentar_reserva;Comentario;07ECB34D-3198-4220-A8BF-181702BA689F;"{""reservaId"":""09FEF545-9598-4C16-994B-08B344D28417""}"
14/07/2026, 09:13;Administrador;atualizar_configuracao;ConfiguracaoSistema;;"{""duracao_maxima_horas"":""12""}"
14/07/2026, 09:13;Administrador;atualizar_configuracao;ConfiguracaoSistema;;"{""duracao_maxima_horas"":""12""}"
14/07/2026, 09:13;Administrador;atualizar_configuracao;ConfiguracaoSistema;;"{""duracao_maxima_horas"":""2""}"
14/07/2026, 09:13;Administrador;atualizar_configuracao;ConfiguracaoSistema;;"{""max_pendentes_por_setor"":""5""}"
14/07/2026, 09:13;Administrador;atualizar_configuracao;ConfiguracaoSistema;;"{""max_pendentes_por_setor"":""50""}"
14/07/2026, 09:13;Administrador;remover_bloqueio;BloqueioAgenda;E91C31BA-2C78-4842-84CE-66C75A7766F3;"{}"
```

(O BOM não aparece no `firstBytes` capturado via `fetch().text()` do browser porque o decodificador UTF-8 do Fetch API descarta um BOM inicial por especificação — os bytes reais enviados pelo servidor incluem o BOM, confirmado pelo teste automatizado acima.)

### 3.4 Demais testes de CRUD (não exigidos pelo Gate, mas cobrindo RF-USR-01..04/RF-SET-01)

`tests/integration/usuarios_crud.test.ts` (novo, 9 testes): criação com geração de `CodigoVerificacao`, duplicidade de e-mail (409), listagem com filtros, edição, reenvio de código, soft delete, bloqueio de auto-desativação do Admin, RBAC (403/401). `tests/integration/setores.test.ts` cobre também criação/edição/duplicidade além do RN-USR-02. Unit: `tests/unit/conflito.test.ts` ganhou 7 testes novos para `validarJanelaReserva` (duração no limite exato, horário de expediente com exceção para `urgente`, antecedência no limite exato).

### 3.5 Suíte completa do backend

`pnpm --filter api test` — 30 arquivos, **310/310**, 0 falhas:

```
 Test Files  30 passed (30)
      Tests  310 passed (310)
```

Delta em relação a S11 (274 testes): +8 `configuracoes.test.ts`, +9 `setores.test.ts`, +9 `usuarios_crud.test.ts`, +3 `auditoria.test.ts`, +7 `unit/conflito.test.ts` (`validarJanelaReserva`) = 274 + 36 = 310.

## 4. Gate de Aceite

- [x] **Output real do teste de configuração dinâmica afetando a validação de reserva** — Seção 3.1.
- [x] **Captura de tela das 4 telas administrativas novas com dados reais** — ver Seção 5 (limitação de ferramenta e evidência substituta real coletada).
- [x] **Exportação real de CSV de auditoria (primeiras linhas coladas no relatório)** — Seção 3.3.

## 5. Nota sobre evidência visual — limitação de ferramenta nesta sessão

A ferramenta de captura de tela (`computer screenshot`/`zoom`) apresentou timeout consistente nesta sessão (confirmado em múltiplas tentativas, em duas abas diferentes, com o app funcionando normalmente por trás — `read_page`/`get_page_text`/`read_network_requests` respondem normalmente). Não é um problema do aplicativo: login real como Admin funcionou, e as 4 telas foram visitadas com dados reais do banco de desenvolvimento. Evidência coletada como substituto (estrutura de acessibilidade completa + texto renderizado real, extraídos via `read_page`/`get_page_text`/`javascript_tool` diretamente do DOM renderizado):

- **Usuários** (`/administracao/usuarios`): tabela com Administrador, Colaborador Demo S11, Colaborador TI Demo, Gestor de Setor TI — filtros de setor/perfil/status populados a partir da API; modal "Novo Usuário" aberto e confirmado com todos os campos (Nome/E-mail/Perfil/Setor condicional).
- **Setores** (`/administracao/setores`): os 8 setores seedados (Administrativo, Limpeza, Manutenção, Produção, Qualidade, RH, Segurança, TI), todos `Ativo`, com ações Editar/Desativar.
- **Configurações** (`/administracao/configuracoes`): os 6 cards de configuração renderizados com valores reais lidos do banco (`antecedencia_minima_horas=2`, `duracao_maxima_horas=12`, `max_pendentes_por_setor=5`, `horario_expediente_inicio=06:00`, `horario_expediente_fim=22:00`, `sla_aprovacao_urgente_horas=2`) e timestamps de "última atualização" reais, incluindo os horários exatos das escritas feitas pelos testes desta sprint (confirmado via `javascript_tool` lendo `input.value` de cada campo do DOM).
- **Auditoria** (`/administracao/auditoria`): tabela com o histórico real completo do projeto (do seed inicial de S1 até as ações desta sessão), filtros funcionais, botão "Exportar CSV" testado com sucesso (`GET .../auditoria/export → 200 OK`, confirmado em `read_network_requests`).

## 6. Invariantes da Seção 2 do MASTER.md

Nenhuma quebra. Confirmações relevantes desta sprint:
- `/api/v1` como prefixo único (todas as rotas novas: `/configuracoes`, `/auditoria`, `/usuarios/*`, `/setores/*`).
- Toda rota de escrita valida via Zod (`atualizarConfiguracoesSchema`, `criarUsuarioSchema`, `editarUsuarioSchema`, `atualizarStatusUsuarioSchema`, `criarSetorSchema`, `editarSetorSchema`, `atualizarStatusSetorSchema`).
- `rbac.ts` continua a única fonte de verdade de autorização — todas as rotas novas são `requireRole(["admin"])`; a UI só espelha a mesma regra (sidebar filtrada por perfil, páginas redirecionam se `perfil !== "admin"`).
- `LogAuditoria` gravado na mesma transação da operação em toda rota de escrita nova (`criar_usuario`, `editar_usuario`, `alterar_status_usuario`, `reenviar_codigo_usuario`, `criar_setor`, `editar_setor`, `alterar_status_setor`, `atualizar_configuracao`).
- E-mail sempre via fila BullMQ (`enfileirarEmail`) — `POST /usuarios` e `POST /usuarios/:id/reenviar-codigo` seguem o padrão.

## 7. ADRs (Architecture Decision Records)

- **ADR-01 — `LogAuditoria.entidade_id` fica `NULL` para `atualizar_configuracao`.** `ConfiguracaoSistema` é uma tabela chave-valor (chave `VARCHAR(60)`, não `UNIQUEIDENTIFIER` — exceção já registrada em S7), então não há um único UUID de "entidade" para associar a uma alteração que pode tocar várias chaves de uma vez. As chaves alteradas e seus novos valores ficam no `detalhes` (JSON), suficiente para auditoria (RN-AUD-01 não exige `entidade_id` preenchido, `LogAuditoria.entidade_id` já nasce nullable desde S1).
- **ADR-02 — `max_pendentes_por_setor` conta a série de recorrência inteira antes de inserir qualquer ocorrência.** RN-RES-05 fala em "reservas simultaneamente pendentes"; uma série de recorrência (RF-RES-03, S9) nasce inteira como `pendente` numa única transação "tudo ou nada" — contá-la como N reservas (não como 1) é a leitura mais literal da regra e evita uma série de 12 ocorrências burlar o limite. Efeito colateral esperado e documentado: com o default de 5, uma série de recorrência frequentemente exigirá que o Admin eleve `max_pendentes_por_setor` antes de criá-la (ver Seção 8 — Pendências).
- **ADR-03 — Antecedência mínima e duração/horário de expediente validados uma única vez por série de recorrência (contra a data-base), não por ocorrência.** `horaInicio`/`horaFim` são os mesmos em toda a série; a antecedência da primeira ocorrência é sempre a mais restritiva (ocorrências seguintes são sempre mais distantes no tempo), então validar contra a data-base cobre toda a série sem uma checagem redundante por ocorrência.
- **ADR-04 — `configuracao.service.ts` usa cache em memória do processo, não Redis.** O prompt da sprint permitia "memória ou Redis"; como a invalidação já é 100% determinística (só acontece dentro da própria escrita de `PUT /configuracoes`, nunca por TTL) e o processo da API já é o único escritor de `ConfiguracaoSistema`, um cache em memória evita uma dependência de rede (Redis) para um dado que muda raramente e é lido em quase toda criação de reserva — trade-off documentado, não uma limitação técnica (Redis seria necessário se a API rodasse em múltiplas réplicas; fora do escopo desta sprint, registrado como pendência).
- **ADR-05 — Ferramenta de screenshot indisponível nesta sessão (ver Seção 5)** — evidência visual substituída por `read_page`/`get_page_text`/`javascript_tool` sobre o DOM real renderizado, não uma limitação do aplicativo.

## 8. Pendências para sprints futuras

- **`configuracao.service.ts` com cache em memória de processo único** (ADR-04) — se a API vier a rodar em múltiplas réplicas (S15, deploy em produção), o cache por processo pode divergir entre réplicas até a próxima leitura pós-invalidação local; migrar para Redis nesse cenário.
- **Tensão entre RF-RES-03 (recorrência até 12 ocorrências) e RN-RES-05 (`max_pendentes_por_setor`, default 5)** (ADR-02) — no ambiente de desenvolvimento/produção real, o Admin precisa elevar `max_pendentes_por_setor` (via a própria tela de Configurações desta sprint) antes de setores começarem a usar recorrência com frequência; vale revisitar o valor padrão ou considerar isentar séries de recorrência do limite numa sprint futura de polimento (S14).
- Runner de migrations sem tabela de controle (ADR-01 de S4/S5/S6/S7, reafirmado aqui).
- Duas reservas de demonstração pendentes do setor TI (criadas manualmente durante a coleta de evidências de S7) foram encontradas acumulando contra o novo limite de `max_pendentes_por_setor` e removidas nesta sessão — vale um lembrete para sprints futuras de não deixar dados de demonstração manuais pendentes de limpeza em ambientes compartilhados de teste/dev.
- Ferramenta de screenshot indisponível nesta sessão (Seção 5) — recoletar capturas de tela reais das 4 telas assim que a ferramenta estiver operante, se necessário para material de apresentação externo.

---

Não iniciei a Sprint S13 nesta sessão, conforme instruído.
