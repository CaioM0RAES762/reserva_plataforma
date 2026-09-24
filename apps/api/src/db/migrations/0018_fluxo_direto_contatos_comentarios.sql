-- Migration 0018_fluxo_direto_contatos_comentarios
-- PlataformaRes
--
-- Mudança de domínio: a reserva deixa de passar por aprovação humana e por checklist.
--
--   ANTES:  pendente → (checklist) → aprovada → em_uso → concluida
--   AGORA:  agendada → em_uso → concluida        (cancelada = terminal alternativo)
--
-- Três eixos, na mesma migration porque tocam as mesmas tabelas e precisam ser atômicos
-- entre si (uma reserva migrada para 'agendada' já precisa ter telefone de contato válido):
--
--   1. Contatos      — telefone de emergência na plataforma, telefone do solicitante na reserva.
--   2. Fluxo direto  — reservas ativas ainda 'pendente' passam a 'agendada'.
--   3. Comentários   — tipo (comentário/não conformidade) + imagens vinculadas ao comentário.
--
-- ---------------------------------------------------------------------------
-- DECISÃO SOBRE HISTÓRICO (importante, ver também packages/shared/src/enums.ts)
-- ---------------------------------------------------------------------------
--
-- NADA é apagado. Especificamente:
--
--   * 'pendente' e 'rejeitada' CONTINUAM aceitos pelo CHECK constraint. São status
--     legados: nenhuma reserva nova nasce assim, mas registros terminais antigos
--     (rejeitadas) precisam continuar existindo, legíveis e exportáveis. Remover os
--     valores do CHECK quebraria a leitura do histórico e a auditoria — que é justamente
--     o oposto do que uma auditoria deve permitir.
--
--   * aprovado_por_id / segunda_aprovacao_por_id / motivo_rejeicao permanecem nas
--     colunas. Nenhuma escrita nova acontece neles; são evidência de decisões tomadas
--     sob as regras vigentes à época.
--
--   * As tabelas de checklist (ChecklistTemplate, ChecklistPreenchido, ChecklistResposta)
--     permanecem intactas com todo o histórico de execuções NR-18/35 já realizadas. O que
--     sai é o ACOPLAMENTO com a reserva: Plataforma.exige_checklist deixa de ser lido no
--     fluxo, e nenhuma reserva volta a ser bloqueada por checklist.
--
--   * Anexo e Ocorrencia permanecem com seus dados. A UI passa a apresentá-los dentro da
--     timeline de comentários como eventos históricos (ver §31/§29 da especificação da
--     mudança) em vez de abas próprias.
--
-- Só as reservas ATIVAS são migradas: 'pendente' vira 'agendada'. Canceladas, rejeitadas
-- e concluídas ficam como estão — reescrever um estado terminal seria falsificar o
-- histórico.

-- ==UP==

-- ---------------------------------------------------------------------------
-- 1. Contatos
-- ---------------------------------------------------------------------------

-- NVARCHAR e não um tipo numérico: telefone brasileiro carrega formatação significativa
-- (+55, DDD entre parênteses, hífen) e ramal corporativo ("3333-4455 ramal 221"). Guardar
-- como número perderia tudo isso e ainda quebraria o zero à esquerda do DDD.
ALTER TABLE Plataforma ADD telefone_emergencia NVARCHAR(40) NULL;
GO

-- NOT NULL com default vazio seria mentira: reservas anteriores a esta migration
-- genuinamente não têm o dado. NULL diz "não informado", que é a verdade; a
-- obrigatoriedade é aplicada na criação (schema zod + rota), não retroativamente.
ALTER TABLE Reserva ADD telefone_contato NVARCHAR(40) NULL;
GO

-- ---------------------------------------------------------------------------
-- 2. Fluxo direto — reservas ativas pendentes viram agendadas
-- ---------------------------------------------------------------------------

-- Apenas 'pendente'. Estados terminais não são tocados.
--
-- OUTPUT INTO não pode mirar a própria LogAuditoria: ela tem um CHECK constraint
-- habilitado (CK_LogAuditoria_detalhes_json, migration 0001), e o SQL Server proíbe
-- OUTPUT INTO em tabela com CHECK/regra/trigger ativos. Por isso o UPDATE grava as linhas
-- alteradas numa variável de tabela primeiro, e um INSERT separado lê dessa variável para
-- popular a auditoria.
--
-- Os dois statements precisam compartilhar o escopo da variável — mas o runner deste
-- projeto (apps/api/src/db/migrate.ts) fatia cada lote GO em statements separados a cada
-- ";" de fim de linha, executados um a um, e uma variável declarada num statement não
-- sobreviveria até o próximo. Por isso não há ";" entre DECLARE/UPDATE/INSERT abaixo:
-- T-SQL não exige o separador (salvo poucas exceções, nenhuma aplicável aqui), e omiti-lo
-- mantém as três instruções como um único statement, com a variável viva do início ao fim.
--
-- OUTPUT captura exatamente as linhas que ESTE UPDATE alterou. Identificar as migradas
-- depois, por "atualizado_em recente", seria uma corrida: qualquer outra escrita
-- concorrente na janela entraria no lote e a auditoria registraria uma transição que não
-- aconteceu. usuario_id NULL = ação do sistema, mesma convenção do escalonamento.
DECLARE @migradas TABLE (id UNIQUEIDENTIFIER PRIMARY KEY)

UPDATE Reserva
SET status = 'agendada',
    atualizado_em = SYSUTCDATETIME()
OUTPUT INSERTED.id INTO @migradas
WHERE status = 'pendente'

INSERT INTO LogAuditoria (usuario_id, acao, entidade, entidade_id, detalhes)
SELECT NULL,
       'migrar_reserva_fluxo_direto',
       'Reserva',
       m.id,
       '{"statusAnterior":"pendente","statusNovo":"agendada","origem":"MIGRACAO"}'
FROM @migradas m
GO

-- O DEFAULT da coluna ainda era 'pendente' (migration 0001). A rota passa a informar o
-- status explicitamente, mas deixar o default antigo no schema seria uma armadilha: um
-- INSERT futuro que omitisse a coluna ressuscitaria silenciosamente o fluxo removido.
-- O nome da constraint precisa ser descoberto em tempo de execução porque 0001 a criou
-- sem nome explícito (o SQL Server gerou um sufixo aleatório).
--
-- Sem ";" entre o DECLARE e o IF de propósito: o runner desta migration (migrate.ts)
-- fatia cada lote GO em statements separados a cada ";" de fim de linha, e uma variável
-- declarada num statement não sobreviveria até o próximo. T-SQL não exige ";" entre
-- statements (salvo poucas exceções, nenhuma aplicável aqui) — omitir o separador mantém
-- DECLARE e IF/EXEC como um único statement, com a variável viva do início ao fim.
DECLARE @nomeDefaultStatus SYSNAME = (
    SELECT dc.name
    FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('Reserva') AND c.name = 'status'
)
IF @nomeDefaultStatus IS NOT NULL
    EXEC('ALTER TABLE Reserva DROP CONSTRAINT ' + @nomeDefaultStatus)
GO

ALTER TABLE Reserva ADD CONSTRAINT DF_Reserva_status DEFAULT 'agendada' FOR status;
GO

-- Automação passa a ser o comportamento PADRÃO, não um opt-in: no fluxo novo ninguém
-- precisa clicar para uma reserva começar ou terminar no horário marcado.
ALTER TABLE Reserva
    DROP CONSTRAINT DF_Reserva_inicio_automatico, DF_Reserva_fim_automatico;
GO

ALTER TABLE Reserva
    ADD CONSTRAINT DF_Reserva_inicio_automatico DEFAULT 1 FOR inicio_automatico;
GO

ALTER TABLE Reserva
    ADD CONSTRAINT DF_Reserva_fim_automatico DEFAULT 1 FOR fim_automatico;
GO

-- Reservas ainda no futuro herdam o novo padrão. As passadas ficam como foram criadas —
-- ligar automação retroativamente faria o sincronizador reprocessar janelas antigas.
UPDATE Reserva
SET inicio_automatico = 1, fim_automatico = 1
WHERE status = 'agendada';
GO

ALTER TABLE Plataforma
    DROP CONSTRAINT DF_Plataforma_inicio_auto_padrao, DF_Plataforma_fim_auto_padrao;
GO

ALTER TABLE Plataforma
    ADD CONSTRAINT DF_Plataforma_inicio_auto_padrao DEFAULT 1 FOR inicio_automatico_padrao;
GO

ALTER TABLE Plataforma
    ADD CONSTRAINT DF_Plataforma_fim_auto_padrao DEFAULT 1 FOR fim_automatico_padrao;
GO

UPDATE Plataforma SET inicio_automatico_padrao = 1, fim_automatico_padrao = 1;
GO

-- O sincronizador ganha um caso novo (janela inteira já vencida com a reserva ainda
-- 'agendada' → concluir direto), que varre por data passada. O índice de automação criado
-- em 0017 já cobre (status, data) e continua servindo.

-- ---------------------------------------------------------------------------
-- 3. Comentários: tipo + imagens
-- ---------------------------------------------------------------------------

-- Enum semântico numa coluna, não um punhado de booleanos espalhados: o comentário É de um
-- tipo. Default 'comentario' preserva a semântica de tudo o que já está gravado.
ALTER TABLE Comentario
    ADD tipo VARCHAR(20) NOT NULL CONSTRAINT DF_Comentario_tipo DEFAULT 'comentario';
GO

ALTER TABLE Comentario
    ADD CONSTRAINT CK_Comentario_tipo CHECK (tipo IN ('comentario', 'nao_conformidade'));
GO

-- Índice para "não conformidades desta reserva" e para os indicadores por período, que
-- passam a substituir as métricas de aprovação/checklist nos relatórios.
CREATE INDEX IX_Comentario_tipo ON Comentario(tipo, criado_em) INCLUDE (reserva_id);
GO

-- A imagem pertence ao COMENTÁRIO, não à reserva: é isso que responde "essa foto é de
-- qual observação?". Mesma estratégia de armazenamento do Anexo (binário em Blob Storage,
-- só a chave no relacional; SAS de leitura gerado sob demanda — RNF-09).
CREATE TABLE ComentarioImagem (
    id             UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    comentario_id  UNIQUEIDENTIFIER NOT NULL,
    nome_arquivo   NVARCHAR(200) NOT NULL,
    url_blob       NVARCHAR(500) NOT NULL,
    tipo_mime      VARCHAR(100)  NOT NULL,
    tamanho_bytes  INT           NOT NULL,
    criado_em      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    -- ON DELETE CASCADE: a imagem não tem existência própria fora do comentário.
    CONSTRAINT FK_ComentarioImagem_Comentario FOREIGN KEY (comentario_id)
        REFERENCES Comentario(id) ON DELETE CASCADE,
    CONSTRAINT CK_ComentarioImagem_tamanho CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 10485760),
    -- Só imagem: o composer de comentário não é um upload genérico de arquivos.
    CONSTRAINT CK_ComentarioImagem_mime CHECK (tipo_mime IN ('image/jpeg', 'image/png', 'image/webp'))
);
GO

CREATE INDEX IX_ComentarioImagem_comentario ON ComentarioImagem(comentario_id);
GO

-- ==DOWN==

DROP INDEX IX_ComentarioImagem_comentario ON ComentarioImagem;
GO

DROP TABLE IF EXISTS ComentarioImagem;
GO

DROP INDEX IX_Comentario_tipo ON Comentario;
GO

ALTER TABLE Comentario DROP CONSTRAINT CK_Comentario_tipo;
GO

ALTER TABLE Comentario DROP CONSTRAINT DF_Comentario_tipo;
GO

ALTER TABLE Comentario DROP COLUMN tipo;
GO

ALTER TABLE Plataforma DROP CONSTRAINT DF_Plataforma_inicio_auto_padrao, DF_Plataforma_fim_auto_padrao;
GO

ALTER TABLE Plataforma
    ADD CONSTRAINT DF_Plataforma_inicio_auto_padrao DEFAULT 0 FOR inicio_automatico_padrao;
GO

ALTER TABLE Plataforma
    ADD CONSTRAINT DF_Plataforma_fim_auto_padrao DEFAULT 0 FOR fim_automatico_padrao;
GO

ALTER TABLE Reserva DROP CONSTRAINT DF_Reserva_inicio_automatico, DF_Reserva_fim_automatico;
GO

ALTER TABLE Reserva
    ADD CONSTRAINT DF_Reserva_inicio_automatico DEFAULT 0 FOR inicio_automatico;
GO

ALTER TABLE Reserva
    ADD CONSTRAINT DF_Reserva_fim_automatico DEFAULT 0 FOR fim_automatico;
GO

-- O DOWN não restaura 'pendente': a informação de quais reservas eram pendentes antes do
-- UP está preservada no LogAuditoria (evento 'migrar_reserva_fluxo_direto'), e reverter em
-- massa colocaria em pendência reservas que podem ter avançado legitimamente desde então.

ALTER TABLE Reserva DROP CONSTRAINT DF_Reserva_status;
GO

ALTER TABLE Reserva ADD CONSTRAINT DF_Reserva_status DEFAULT 'pendente' FOR status;
GO

ALTER TABLE Reserva DROP COLUMN telefone_contato;
GO

ALTER TABLE Plataforma DROP COLUMN telefone_emergencia;
GO
