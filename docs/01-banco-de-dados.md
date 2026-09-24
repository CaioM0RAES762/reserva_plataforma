# Banco de Dados — Estrutura e Funcionamento

---

## 1. Visão geral

| Item | Valor |
|---|---|
| SGBD | Microsoft SQL Server 2022, Developer Edition |
| Banco | `PlataformaRes` |
| Driver | `mssql` (tedious) — [pool.ts](../apps/api/src/db/pool.ts) |
| ORM | **Nenhum.** SQL escrito à mão, sempre parametrizado (`.input(...)`) |
| Migrations | Runner próprio — [migrate.ts](../apps/api/src/db/migrate.ts), controle em `SchemaMigracao` |
| Tabelas | 19 |
| Views / procedures / functions / triggers / sequences | **0** |

Não existe camada de repositório: as rotas e os services falam SQL direto pelo pool
(`getPool()`). Chaves primárias são sempre `UNIQUEIDENTIFIER DEFAULT NEWID()` e datas são
`DATETIME2` em UTC (`SYSUTCDATETIME()`).

**Fuso horário.** `Reserva.data` (DATE) e `hora_inicio`/`hora_fim` (TIME) guardam horário
**civil de Brasília**. `BloqueioAgenda.data_inicio`/`data_fim` e todos os `criado_em` guardam
**instantes UTC reais**. A conversão entre os dois mundos é feita por
`combinarDataHoraBrasilia()` em [datetime.ts](../packages/shared/src/datetime.ts) — nunca por
`GETDATE()` do servidor.

---

## 2. Tabelas

### Núcleo operacional

## `Setor`

**Objetivo**

Áreas da planta (TI, Manutenção, Produção…). É a unidade de escopo do sistema inteiro:
Gestor e Colaborador só enxergam dados do próprio setor.

**Relacionamentos**

Pai de `Usuario` e `Reserva`. Nunca é excluído — só desativado (`ativo = 0`).

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `nome` | NVARCHAR(80) | Sim | UQ | Nome exibido; único no sistema |
| `cor_hex` | CHAR(7) | Sim | | Cor `#RRGGBB` usada na legenda do Calendário |
| `ativo` | BIT | Sim (def. 1) | | Setor inativo some do formulário de reserva |

### Utilizada por

`routes/setores.ts`; legenda do Calendário; seletor de setor no autocadastro e em Nova Reserva.

### Observações

Desativar um setor com usuário ativo vinculado é bloqueado pela rota (RN-USR-02), não por constraint.

---

## `Usuario`

**Objetivo**

Contas de acesso. Guarda perfil, setor e o hash bcrypt da senha.

**Relacionamentos**

Filho de `Setor` (nullable — Admin não tem setor). Referenciado por praticamente todas as
tabelas que registram autoria.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `nome` | NVARCHAR(120) | Sim | | Nome completo |
| `email` | NVARCHAR(160) | Sim | UQ | Login; obrigatoriamente `@metalsider.com.br` |
| `senha_hash` | VARCHAR(60) | Sim | | bcrypt, 12 rounds. Nunca sai da API |
| `perfil` | VARCHAR(20) | Sim | | `admin`, `gestor_setor` ou `colaborador` |
| `setor_id` | UNIQUEIDENTIFIER | Não | FK→Setor | NULL para Admin (RN-USR-01) |
| `ativo` | BIT | Sim (def. 1) | | Soft delete — preserva histórico de reservas |
| `email_verificado` | BIT | Sim (def. 0) | | Só 1 após ativar a conta com o código |
| `criado_em` | DATETIME2 | Sim | | Criação da conta (UTC) |
| `ultimo_login` | DATETIME2 | Não | | Atualizado a cada login bem-sucedido |

### Utilizada por

`routes/auth.ts`, `routes/usuarios.ts`, `routes/conta.ts`, `middlewares/rbac.ts` (o JWT
carrega `sub`, `email`, `perfil`, `setorId`).

### Observações

- `CK_Usuario_email_dominio` só aceita `%@metalsider.com.br`.
- `CK_Usuario_perfil` é o **contrato canônico de perfis** — nenhum outro valor entra.

---

## `Plataforma`

**Objetivo**

O ativo reservável: plataforma elevatória, andaime ...

**Relacionamentos**

Pai de `Reserva`, `Ocorrencia` e `BloqueioAgenda`.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `codigo` | VARCHAR(30) | Sim | UQ | Código de patrimônio (`PLT-001`), normalizado em maiúsculas |
| `nome` | NVARCHAR(120) | Sim | | Nome exibido no card |
| `localizacao` | NVARCHAR(160) | Não | | Onde fica ("Galpão A, Piso 1") |
| `capacidade` | INT | Não | | **Carga em kg** — não confundir com pessoas |
| `capacidade_operadores` | INT | Não | | **Pessoas** — é o que valida `Reserva.quantidade_pessoas` |
| `status` | VARCHAR(20) | Sim (def. `disponivel`) | | `disponivel`, `reservada`, `manutencao`, `inativa` |
| `observacoes` | NVARCHAR(500) | Não | | Texto livre |
| `categoria` | VARCHAR(20) | Sim (def. `outro`) | | `elevatoria`, `andaime`, `sala`, `patio`, `veiculo`, `outro` |
| `risco` | VARCHAR(10) | Sim (def. `baixo`) | | `baixo`, `medio`, `alto` |
| `imagem_url` | NVARCHAR(500) | Não | | **Chave do blob** no Azure, nunca URL pública |
| `tipo_equipamento` | NVARCHAR(80) | Não | | Ex.: "Tesoura elétrica" |
| `altura_maxima_m` | DECIMAL(4,1) | Não | | > 2 m ⇒ selo NR-35 no card |
| `horimetro_horas` | INT | Não | | Atualizado à mão pelo Admin (sem telemetria) |
| `inicio_automatico_padrao` | BIT | Sim (def. 1) | | Pré-preenche a nova reserva |
| `fim_automatico_padrao` | BIT | Sim (def. 1) | | Pré-preenche a nova reserva |
| `telefone_emergencia` | NVARCHAR(40) | Não | | Quem ligar se der problema **com o equipamento** |
| `criado_em` / `atualizado_em` | DATETIME2 | Sim | | Auditoria de cadastro |

### Utilizada por

`routes/plataformas.ts`, `services/plataforma.service.ts` (status derivado, utilização 30d,
evento em destaque, selos NR).

### Observações

- **`status = 'reservada'` nunca é persistido.** É derivado em tempo de leitura
  (`sqlStatusPlataformaDerivado`) a partir de uma reserva `agendada`/`em_uso` acontecendo agora.
  Por isso a rota de status só aceita `disponivel`, `manutencao` e `inativa`.
- `utilizacao30d` e `normas` (NR-18/NR-35) também são calculados na leitura — não são colunas.

---

## `Reserva`

**Objetivo**

O agendamento em si. Núcleo do sistema: quem, qual equipamento, quando, para quê.

**Relacionamentos**

Filha de `Setor`, `Usuario` (solicitante) e `Plataforma`. Pai de `Comentario`, `Anexo`,
`Ocorrencia` e `ChecklistPreenchido`. Opcionalmente pertence a uma `ReservaRecorrencia`.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `setor_id` | UNIQUEIDENTIFIER | Sim | FK→Setor | Setor que reservou — base de todo o escopo |
| `solicitante_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Quem criou |
| `plataforma_id` | UNIQUEIDENTIFIER | Sim | FK→Plataforma | Equipamento reservado |
| `data` | DATE | Sim | | Dia da reserva (civil, Brasília) |
| `hora_inicio` / `hora_fim` | TIME | Sim | | Janela planejada; `hora_fim > hora_inicio` |
| `hora_inicio_real` / `hora_fim_real` | TIME | Não | | Preenchidos na transição real de uso |
| `quantidade_pessoas` | INT | Sim (def. 1) | | Validado contra `capacidade_operadores` |
| `motivo` | NVARCHAR(300) | Sim | | Por que a reserva existe |
| `telefone_contato` | NVARCHAR(40) | Não | | **Snapshot** do contato na criação. NULL só em reservas pré-0018 |
| `prioridade` | VARCHAR(10) | Sim (def. `normal`) | | `normal`, `alta`, `urgente` |
| `status` | VARCHAR(20) | Sim (def. `agendada`) | | Ver máquina de estados abaixo |
| `recorrencia_id` | UNIQUEIDENTIFIER | Não | FK→ReservaRecorrencia | Série semanal |
| `inicio_automatico` | BIT | Sim (def. 1) | | O worker inicia o uso no horário |
| `fim_automatico` | BIT | Sim (def. 1) | | O worker conclui no horário |
| `criado_em` / `atualizado_em` | DATETIME2 | Sim | | |

### Utilizada por

`routes/reservas.ts`, `routes/dashboard.ts`, `routes/historico.ts`, `routes/relatorios.ts`,
`services/automacaoReserva.service.ts`, `services/disponibilidade.service.ts`.

### Observações

`CK_Reserva_status` ainda aceita `pendente` e `rejeitada`. São **status legados**: nenhuma
reserva nova nasce assim, mas registros anteriores à migration 0018 precisam continuar
legíveis no Histórico e na Auditoria.

**Estado atual no banco inspecionado:** 1 `agendada`, 20 `concluida`, 33 `cancelada`,
0 `pendente`, 0 `rejeitada`.

---

## `ReservaRecorrencia`

**Objetivo**

Cabeçalho de uma série semanal (2 a 12 ocorrências) criada numa única submissão.

**Relacionamentos**

Pai de `Reserva` via `recorrencia_id`.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador da série |
| `criado_por_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Quem criou a série |
| `frequencia` | VARCHAR(10) | Sim (def. `semanal`) | | Só `semanal` é aceito |
| `dia_semana` | TINYINT | Sim | | 0–6, derivado da data da primeira ocorrência |
| `quantidade_ocorrencias` | TINYINT | Sim | | Entre 2 e 12 |
| `criado_em` | DATETIME2 | Sim | | |

### Utilizada por

`routes/reservas.ts` (criação da série e `POST /reservas/recorrencia/:id/cancelar`),
`services/recorrencia.service.ts`.

### Observações

0 linhas no ambiente inspecionado — a funcionalidade existe e está exposta na UI, mas nunca
foi usada neste banco.

---

## `BloqueioAgenda`

**Objetivo**

Janela em que a agenda fica fechada: manutenção preventiva, feriado, parada de planta.

**Relacionamentos**

Filha opcional de `Plataforma`. **`plataforma_id` NULL = bloqueio global** (todas).

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `plataforma_id` | UNIQUEIDENTIFIER | Não | FK→Plataforma | NULL ⇒ vale para toda a frota |
| `data_inicio` / `data_fim` | DATETIME2 | Sim | | Instantes UTC reais; `fim > inicio` |
| `motivo` | NVARCHAR(300) | Sim | | Aparece na mensagem de recusa da reserva |
| `criado_por_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Admin que criou |
| `criado_em` | DATETIME2 | Sim | | |

### Utilizada por

`routes/bloqueios.ts`, `services/disponibilidade.service.ts` (checado em toda criação de reserva).

---

### Comunicação e evidência

## `Comentario`

**Objetivo**

A timeline operacional da reserva. Substituiu a separação "Anexos | Comentários" —
um comentário pode ser classificado como **não conformidade**, que hoje é o ponto único de
registro do que deu errado.

**Relacionamentos**

Filha de `Reserva` e `Usuario`. Pai de `ComentarioImagem` (com `ON DELETE CASCADE`).

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `reserva_id` | UNIQUEIDENTIFIER | Sim | FK→Reserva | A qual reserva pertence |
| `usuario_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Autor |
| `mensagem` | NVARCHAR(1000) | Sim | | Texto |
| `tipo` | VARCHAR(20) | Sim (def. `comentario`) | | `comentario` ou `nao_conformidade` |
| `criado_em` | DATETIME2 | Sim | | Ordena a timeline |

### Utilizada por

`routes/comentarios.ts`; KPI "não conformidades nos últimos 30 dias" do Dashboard.

---

## `ComentarioImagem`

**Objetivo**

Fotos que pertencem a um comentário específico — responde "essa foto é de qual observação?".

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `comentario_id` | UNIQUEIDENTIFIER | Sim | FK→Comentario **ON DELETE CASCADE** | Dono |
| `nome_arquivo` | NVARCHAR(200) | Sim | | Nome original |
| `url_blob` | NVARCHAR(500) | Sim | | Chave do blob; SAS gerado sob demanda |
| `tipo_mime` | VARCHAR(100) | Sim | | Só `image/jpeg`, `image/png`, `image/webp` |
| `tamanho_bytes` | INT | Sim | | > 0 e ≤ 10 MB |
| `criado_em` | DATETIME2 | Sim | | |

### Observações

Única FK do banco com `ON DELETE CASCADE` — a imagem não tem existência fora do comentário.

---

## `Anexo`

**Objetivo**

Arquivos (foto, PDF, ART) por reserva. **Modelo anterior**: a UI atual não cria novos anexos,
mas os existentes continuam sendo exibidos na timeline como entradas históricas.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `reserva_id` | UNIQUEIDENTIFIER | Sim | FK→Reserva | |
| `nome_arquivo` | NVARCHAR(200) | Sim | | |
| `url_blob` | NVARCHAR(500) | Sim | | Chave do blob |
| `tipo_mime` | VARCHAR(100) | Sim | | Validado por magic bytes |
| `tamanho_bytes` | INT | Sim | | > 0 e ≤ 10 MB |
| `enviado_por_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | |
| `criado_em` | DATETIME2 | Sim | | |

### Utilizada por

`routes/anexos.ts` (ainda ativa na API) e a UNION da timeline em `routes/comentarios.ts`.

---

## `Ocorrencia`

**Objetivo**

Avaria/incidente reportado durante o uso. **Modelo anterior** — consolidado hoje em
`Comentario.tipo = 'nao_conformidade'`.

### Colunas

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | Identificador |
| `reserva_id` | UNIQUEIDENTIFIER | Sim | FK→Reserva | Durante qual reserva |
| `plataforma_id` | UNIQUEIDENTIFIER | Sim | FK→Plataforma | Qual equipamento |
| `reportado_por_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Quem reportou |
| `descricao` | NVARCHAR(1000) | Sim | | O que aconteceu |
| `gravidade` | VARCHAR(10) | Sim | | `baixa`, `media`, `alta` |
| `gera_manutencao` | BIT | Sim (def. 0) | | 1 ⇒ move a plataforma para `manutencao` |
| `criado_em` | DATETIME2 | Sim | | |

### Observações

`gravidade = 'alta'` notifica todos os Admins (in-app + e-mail). `gera_manutencao = 1` altera
`Plataforma.status` **na mesma transação** — por rota, não por trigger.

---

### Checklist de segurança (NR-18 / NR-35) — histórico

> As quatro tabelas abaixo estão **fora do fluxo de reserva** desde a migration 0018. As rotas da API continuam funcionando, mas a UI não
> tem mais tela de checklist e nenhuma reserva é bloqueada por ele.

## `ChecklistTemplate`

**Objetivo** — Modelo nomeado e reutilizável de checklist, associado a uma categoria.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `nome` | NVARCHAR(150) | Sim | | Nome do modelo |
| `categoria_plataforma` | VARCHAR(20) | Sim | | Uma das 6 categorias |
| `descricao` | NVARCHAR(400) | Não | | |
| `ativo` | BIT | Sim (def. 1) | | |
| `criado_em` | DATETIME2 | Sim | | |

## `ChecklistItemTemplate`

**Objetivo** — Uma questão dentro de um modelo.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `template_id` | UNIQUEIDENTIFIER | Sim | FK→ChecklistTemplate | Modelo dono |
| `descricao` | NVARCHAR(300) | Sim | | O enunciado |
| `ordem` | INT | Sim | | Posição na lista |
| `obrigatorio` | BIT | Sim (def. 1) | | Precisa ser respondido para finalizar |
| `bloqueia_aprovacao` | BIT | Sim (def. 1) | | "Não conforme" aqui era impeditivo |
| `ativo` | BIT | Sim (def. 1) | | |
| `categoria_plataforma` | VARCHAR(20) | Não | | **Redundante** desde 0016 (o template já carrega) |

## `ChecklistPreenchido`

**Objetivo** — A execução do checklist de uma reserva. `UNIQUE(reserva_id)` — no máximo uma por reserva.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `reserva_id` | UNIQUEIDENTIFIER | Sim | FK→Reserva, **UQ** | |
| `preenchido_por_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | |
| `todos_conformes` | BIT | Sim (def. 0) | | Nenhum item impeditivo não conforme |
| `preenchido_em` | DATETIME2 | Sim | | Reescrito a cada rascunho salvo |
| `finalizado_em` | DATETIME2 | Não | | NULL = rascunho; preenchido = finalizado |

## `ChecklistResposta`

**Objetivo** — A resposta a uma questão, **com snapshot** do enunciado no momento da execução.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `checklist_preenchido_id` | UNIQUEIDENTIFIER | Sim | FK, UQ(+item) | Execução dona |
| `item_id` | UNIQUEIDENTIFIER | Sim | FK→ChecklistItemTemplate | Questão original |
| `resultado` | VARCHAR(20) | Sim | | `conforme`, `nao_conforme`, `nao_aplicavel` |
| `observacao` | NVARCHAR(300) | Não | | Obrigatória quando `nao_conforme` (regra na rota) |
| `foto_url` | NVARCHAR(500) | Não | | Chave do blob da evidência |
| `item_descricao` | NVARCHAR(300) | Não | | **Snapshot** do enunciado |
| `item_ordem` | INT | Não | | **Snapshot** |
| `item_obrigatorio` | BIT | Não | | **Snapshot** |
| `item_bloqueia_aprovacao` | BIT | Não | | **Snapshot** |

### Observações

O snapshot existe para que editar um template hoje não reescreva um checklist assinado ontem.
As 4 colunas `item_*` são nullable apenas por causa das respostas anteriores à migration 0017.

---

### Suporte, segurança e auditoria

## `CodigoVerificacao`

**Objetivo**

Código OTP de 6 dígitos para ativar conta ou redefinir senha. Validade de 15 minutos.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `usuario_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Dono do código |
| `codigo` | CHAR(6) | Sim | | Gerado com `crypto.randomInt` |
| `tipo` | VARCHAR(20) | Sim | | `ativacao_conta` ou `reset_senha` |
| `expira_em` | DATETIME2 | Sim | | Criação + 15 min |
| `utilizado` | BIT | Sim (def. 0) | | Emitir um novo invalida o anterior do mesmo tipo |
| `criado_em` | DATETIME2 | Sim | | |

### Utilizada por

`services/otp.service.ts` — ponto único de emissão, com lock de 30 s no Redis.

---

## `Notificacao`

**Objetivo**

Notificação in-app consumida pelo sino do topo e publicada em tempo real por SSE.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `usuario_id` | UNIQUEIDENTIFIER | Sim | FK→Usuario | Destinatário |
| `tipo` | VARCHAR(30) | Sim | | 3 valores no CHECK (ver observação) |
| `titulo` | NVARCHAR(160) | Sim | | |
| `mensagem` | NVARCHAR(500) | Sim | | |
| `link` | NVARCHAR(200) | Não | | Rota do frontend ao clicar |
| `lida` | BIT | Sim (def. 0) | | |
| `criado_em` | DATETIME2 | Sim | | |

### Observações

`CK_Notificacao_tipo` aceita `ocorrencia_reportada`, `bloqueio_criado` e `comentario_novo`.

Na prática, `comentario_novo` e `ocorrencia_reportada` possuem escritor ativo no código.

---

## `LogAuditoria`

**Objetivo**

Trilha append-only de toda operação sensível. Fonte da tela de Auditoria.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `id` | UNIQUEIDENTIFIER | Sim | PK | |
| `usuario_id` | UNIQUEIDENTIFIER | Não | FK→Usuario | **NULL = ação do sistema** (worker, migration) |
| `acao` | VARCHAR(60) | Sim | | Código do evento (`criar_reserva`, `cancelar_reserva`…) |
| `entidade` | VARCHAR(60) | Sim | | `Reserva`, `Plataforma`, `Usuario`, `Setor`… |
| `entidade_id` | UNIQUEIDENTIFIER | Não | | Id do registro afetado (sem FK — é polimórfico) |
| `detalhes` | NVARCHAR(MAX) | Não | | JSON com o antes/depois; validado por `ISJSON` |
| `criado_em` | DATETIME2 | Sim | | |

### Utilizada por

`routes/auditoria.ts` (leitura/exportação) e **todas** as rotas de escrita, que gravam o log
na mesma transação da operação.

### Observações

`entidade_id` é intencionalmente sem FK: aponta para tabelas diferentes conforme `entidade`.
A tela resolve o nome do recurso por `LEFT JOIN` condicionado, não por consulta por linha.

A tabela `PainelToken` foi removida, mas o histórico de auditoria foi preservado:
17 eventos `criar_painel_token` e 7 `revogar_painel_token` continuam registrados.

---

## `ConfiguracaoSistema`

**Objetivo**

Parâmetros ajustáveis pelo Admin em tempo de execução. Chave-valor, com PK na própria chave.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `chave` | VARCHAR(60) | Sim | **PK** | Identificador da configuração |
| `valor` | NVARCHAR(200) | Sim | | Sempre texto; convertido no service |
| `descricao` | NVARCHAR(300) | Não | | Texto exibido no card da tela |
| `atualizado_em` | DATETIME2 | Sim | | |
| `atualizado_por_id` | UNIQUEIDENTIFIER | Não | FK→Usuario | Quem alterou por último |

**As 4 chaves existentes:**

| Chave | Valor atual | Efeito real hoje |
|---|---|---|
| `antecedencia_minima_horas` | 2 | ✅ Aplicada na criação de reserva |
| `duracao_maxima_horas` | 12 | ✅ Aplicada na criação de reserva |
| `horario_expediente_inicio` | 06:00 | ✅ Aplicada (exceto prioridade urgente) |
| `horario_expediente_fim` | 22:00 | ✅ Aplicada (exceto prioridade urgente) |

---

## `SchemaMigracao`

**Objetivo**

Controle do runner de migrations. Não faz parte do domínio.

| Coluna | Tipo | Obrigatório | Chave | Descrição |
|---|---|---|---|---|
| `nome` | VARCHAR(200) | Sim | PK | Nome do arquivo `.sql` |
| `checksum` | CHAR(64) | Sim | | SHA-256 do arquivo — detecta edição pós-aplicação |
| `aplicada_em` | DATETIME2 | Sim | | |

**18 linhas — todas as migrations de `0001` a `0018` estão aplicadas.**

---

## 3. Relacionamentos importantes

**Setor é a espinha dorsal do escopo.** `Reserva.setor_id` é o que o backend usa para decidir
o que Gestor e Colaborador podem ver e fazer. Admin ignora esse filtro.

**Plataforma ↔ Reserva é o par que define disponibilidade.** O índice
`IX_Reserva_plataforma_data_status` cobre exatamente a checagem de conflito e é sobre ele que
o lock de intervalo (`UPDLOCK, HOLDLOCK`) é tomado na criação.

**BloqueioAgenda com `plataforma_id` NULL é global.** Essa nullability é a regra de negócio,
não uma frouxidão do modelo.

**LogAuditoria com `usuario_id` NULL é ação do sistema.** É como o worker de automação e a
própria migration 0018 assinam o que fizeram.

**ComentarioImagem é a única relação com cascade.** Tudo o mais é preservado: usuários e
setores são desativados, nunca excluídos.

---

## 4. Fluxo dos dados — criação de uma reserva

```text
Usuário preenche Nova Reserva
        ↓
POST /api/v1/reservas  (Zod valida o payload)
        ↓
Lê Plataforma: status, capacidade_operadores, padrões de automação
        ↓
Lê ConfiguracaoSistema (cache em memória) → antecedência, duração, expediente
        ↓
BEGIN TRANSACTION
   ├─ SELECT ... WITH (UPDLOCK, HOLDLOCK) em Reserva  → conflito de horário
   ├─ SELECT em BloqueioAgenda                        → agenda bloqueada?
   ├─ INSERT ReservaRecorrencia   (só se for série)
   ├─ INSERT Reserva status = 'agendada'   (1 por ocorrência)
   └─ INSERT LogAuditoria 'criar_reserva'
COMMIT
        ↓
Publica evento SSE 'reserva.criada' (best-effort, fora da transação)
        ↓
201 com a reserva recarregada por id
```

E depois, sem ninguém clicar em nada:

```text
Worker BullMQ (a cada 60s)
        ↓
hora_inicio chegou   → UPDATE Reserva SET status='em_uso'   + LogAuditoria
hora_fim chegou      → UPDATE Reserva SET status='concluida' + LogAuditoria
janela inteira venceu sem uso → concluida direto
```

---

## 5. Integridade e constraints

**Chaves primárias** — todas `UNIQUEIDENTIFIER DEFAULT NEWID()`, exceto
`ConfiguracaoSistema` (PK na `chave`) e `SchemaMigracao` (PK no `nome`).

**CHECK constraints que carregam regra de negócio**

| Constraint | Regra |
|---|---|
| `CK_Usuario_email_dominio` | Só e-mail `@metalsider.com.br` |
| `CK_Usuario_perfil` | Os 3 perfis do sistema — contrato canônico |
| `CK_Reserva_horario` | `hora_fim > hora_inicio` |
| `CK_Reserva_quantidade_pessoas` | `> 0` |
| `CK_Reserva_status` / `CK_Reserva_prioridade` | Domínio dos enums |
| `CK_BloqueioAgenda_datas` | `data_fim > data_inicio` |
| `CK_LogAuditoria_detalhes_json` | `detalhes` é JSON válido ou NULL |
| `CK_Anexo_tamanho` / `CK_ComentarioImagem_tamanho` | 0 < bytes ≤ 10 MB |
| `CK_ComentarioImagem_mime` | Só JPEG, PNG ou WebP |
| `CK_ReservaRecorrencia_quantidade` | Entre 2 e 12 ocorrências |
| `CK_Notificacao_tipo` | `ocorrencia_reportada`, `bloqueio_criado` ou `comentario_novo` |

**Regras que NÃO estão no banco** (vivem só no código, propositalmente):

- Conflito de horário entre reservas (RN-RES-02) — exigiria um índice de exclusão que o SQL Server não tem.
- Observação obrigatória em item não conforme — regra condicional, evitada em T-SQL.
- Bloqueio de desativação de setor com usuário ativo (RN-USR-02).
- Bloqueio de desativação de plataforma com reserva ativa (RN-PLAT-02).

**Índices** 

| Índice | Serve a |
|---|---|
| `IX_Reserva_plataforma_data_status` (INCLUDE horários, setor) | Checagem de conflito + lock de intervalo |
| `IX_Reserva_automacao` (status, data) | Varredura do worker a cada minuto |
| `IX_Reserva_setor_data` | Relatórios escopados por setor |
| `IX_Notificacao_usuario_naolida` (filtrado `lida = 0`) | Contador do sino |
| `IX_LogAuditoria_criado_em DESC` | Tela de Auditoria |
| `IX_BloqueioAgenda_periodo` | RN-RES-11 na criação de reserva |
| `IX_Ocorrencia_plataforma_criado DESC` | `OUTER APPLY` do card da Frota |

---