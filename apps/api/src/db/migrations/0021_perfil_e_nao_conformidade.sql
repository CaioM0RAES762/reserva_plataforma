-- Migration 0021_perfil_e_nao_conformidade
-- PlataformaRes
--
-- Três adições independentes, agrupadas nesta migration porque decorrem do mesmo pedido de
-- revisão e nenhuma sozinha justificaria um arquivo próprio:
--
--   1. Perfil do usuário   — telefone de contato e marcação de senha provisória.
--   2. Comentário          — edição (atualizado_em) e exclusão (soft delete).
--   3. Não Conformidade    — status/tratamento como entidade 1:1 de Comentario.
--
-- Nenhum dado existente é apagado ou reescrito (mesma postura da migration 0018). Todas as
-- colunas novas são NULL/DEFAULT seguro para linhas já existentes; a obrigatoriedade de
-- telefone em cadastros/criações novas é aplicada na camada de aplicação (zod + rota), não
-- retroativamente.

-- ==UP==

-- ---------------------------------------------------------------------------
-- 1. Perfil do usuário
-- ---------------------------------------------------------------------------

-- NVARCHAR e não numérico: mesmo motivo de Reserva.telefone_contato/Plataforma.telefone_emergencia
-- (migration 0018) — telefone brasileiro carrega formatação significativa (DDD, hífen, ramal).
IF COL_LENGTH('dbo.Usuario', 'telefone') IS NULL
    ALTER TABLE dbo.Usuario ADD telefone NVARCHAR(40) NULL
GO

-- Marca quando a senha ainda é a inicial definida pelo Admin (ex.: "metal@40"), para forçar a
-- troca no primeiro login. DEFAULT 0: usuários existentes já escolheram a própria senha via
-- ativação por e-mail, não são afetados por esta coluna.
IF COL_LENGTH('dbo.Usuario', 'senha_provisoria') IS NULL
    ALTER TABLE dbo.Usuario ADD senha_provisoria BIT NOT NULL
        CONSTRAINT DF_Usuario_senha_provisoria DEFAULT 0
GO

-- ---------------------------------------------------------------------------
-- 2. Comentário — edição e exclusão (soft delete)
-- ---------------------------------------------------------------------------

IF COL_LENGTH('dbo.Comentario', 'atualizado_em') IS NULL
    ALTER TABLE dbo.Comentario ADD atualizado_em DATETIME2 NULL
GO

-- Soft delete — nada é apagado (mesma decisão de 0018 para o resto do domínio). A leitura
-- (GET) passa a filtrar excluido_em IS NULL; o registro e as imagens associadas continuam
-- existindo para auditoria/histórico.
IF COL_LENGTH('dbo.Comentario', 'excluido_em') IS NULL
    ALTER TABLE dbo.Comentario ADD excluido_em DATETIME2 NULL
GO

IF COL_LENGTH('dbo.Comentario', 'excluido_por') IS NULL
    ALTER TABLE dbo.Comentario ADD excluido_por UNIQUEIDENTIFIER NULL
GO

IF OBJECT_ID('dbo.FK_Comentario_ExcluidoPor', 'F') IS NULL
   AND COL_LENGTH('dbo.Comentario', 'excluido_por') IS NOT NULL
    ALTER TABLE dbo.Comentario ADD CONSTRAINT FK_Comentario_ExcluidoPor
        FOREIGN KEY (excluido_por) REFERENCES dbo.Usuario(id)
GO

-- ---------------------------------------------------------------------------
-- 3. Não Conformidade — status/tratamento (entidade 1:1 de Comentario)
-- ---------------------------------------------------------------------------

-- Comentario.tipo (migration 0018) já identifica QUE um comentário é uma não conformidade —
-- esta tabela não duplica isso, só guarda o que Comentario nunca teve nem deveria ter: um
-- estado de tratamento. 1:1 via comentario_id UNIQUE; só existe linha aqui quando o comentário
-- É uma não conformidade (criada no mesmo INSERT da rota).
CREATE TABLE NaoConformidade (
    id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    comentario_id UNIQUEIDENTIFIER NOT NULL,
    status        VARCHAR(20) NOT NULL CONSTRAINT DF_NaoConformidade_status DEFAULT 'aberta',
    resolvido_em  DATETIME2 NULL,
    resolvido_por UNIQUEIDENTIFIER NULL,
    criado_em     DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    atualizado_em DATETIME2 NULL,
    CONSTRAINT UQ_NaoConformidade_comentario UNIQUE (comentario_id),
    CONSTRAINT FK_NaoConformidade_Comentario FOREIGN KEY (comentario_id) REFERENCES Comentario(id),
    CONSTRAINT FK_NaoConformidade_ResolvidoPor FOREIGN KEY (resolvido_por) REFERENCES Usuario(id),
    CONSTRAINT CK_NaoConformidade_status CHECK (status IN ('aberta', 'em_analise', 'resolvida'))
);
GO

CREATE INDEX IX_NaoConformidade_status ON NaoConformidade(status, criado_em);
GO

-- Backfill: toda não conformidade já registrada antes desta migration nasce 'aberta' — é a
-- leitura mais honesta possível sem nenhum dado de tratamento anterior (não havia estado algum
-- até agora, por decisão deliberada documentada em dashboard.ts).
INSERT INTO NaoConformidade (comentario_id, status, criado_em)
SELECT c.id, 'aberta', c.criado_em
FROM Comentario c
WHERE c.tipo = 'nao_conformidade'
GO

-- ==DOWN==

DROP INDEX IX_NaoConformidade_status ON NaoConformidade;
GO

DROP TABLE IF EXISTS NaoConformidade;
GO

ALTER TABLE Comentario DROP CONSTRAINT FK_Comentario_ExcluidoPor;
GO

ALTER TABLE Comentario DROP COLUMN excluido_por;
GO

ALTER TABLE Comentario DROP COLUMN excluido_em;
GO

ALTER TABLE Comentario DROP COLUMN atualizado_em;
GO

ALTER TABLE Usuario DROP CONSTRAINT DF_Usuario_senha_provisoria;
GO

ALTER TABLE Usuario DROP COLUMN senha_provisoria;
GO

ALTER TABLE Usuario DROP COLUMN telefone;
GO
