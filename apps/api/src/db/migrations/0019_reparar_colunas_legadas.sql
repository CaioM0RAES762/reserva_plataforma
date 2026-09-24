-- Migration 0019_reparar_colunas_legadas
--
-- Repara ambientes que receberam um baseline incorreto: as migrations 0002 e 0004
-- aparecem em SchemaMigracao, mas parte de suas colunas nunca foi criada (ou foi
-- removida fora do fluxo de migrations). As colunas continuam necessárias para ler o
-- histórico anterior ao fluxo direto introduzido pela migration 0018.
--
-- Cada alteração é protegida por uma consulta ao catálogo. Isso torna a migration segura
-- tanto no ambiente afetado quanto em bancos que já têm o schema completo.

-- ==UP==

IF COL_LENGTH('dbo.Reserva', 'aprovado_por_id') IS NULL
    ALTER TABLE dbo.Reserva ADD aprovado_por_id UNIQUEIDENTIFIER NULL
GO

IF COL_LENGTH('dbo.Reserva', 'motivo_rejeicao') IS NULL
    ALTER TABLE dbo.Reserva ADD motivo_rejeicao NVARCHAR(500) NULL
GO

IF COL_LENGTH('dbo.Reserva', 'hora_inicio_real') IS NULL
    ALTER TABLE dbo.Reserva ADD hora_inicio_real TIME NULL
GO

IF COL_LENGTH('dbo.Reserva', 'hora_fim_real') IS NULL
    ALTER TABLE dbo.Reserva ADD hora_fim_real TIME NULL
GO

IF COL_LENGTH('dbo.Reserva', 'segunda_aprovacao_por_id') IS NULL
    ALTER TABLE dbo.Reserva ADD segunda_aprovacao_por_id UNIQUEIDENTIFIER NULL
GO

IF OBJECT_ID('dbo.FK_Reserva_AprovadoPor', 'F') IS NULL
   AND COL_LENGTH('dbo.Reserva', 'aprovado_por_id') IS NOT NULL
    ALTER TABLE dbo.Reserva ADD CONSTRAINT FK_Reserva_AprovadoPor
        FOREIGN KEY (aprovado_por_id) REFERENCES dbo.Usuario(id)
GO

IF OBJECT_ID('dbo.FK_Reserva_SegundaAprovacaoPor', 'F') IS NULL
   AND COL_LENGTH('dbo.Reserva', 'segunda_aprovacao_por_id') IS NOT NULL
    ALTER TABLE dbo.Reserva ADD CONSTRAINT FK_Reserva_SegundaAprovacaoPor
        FOREIGN KEY (segunda_aprovacao_por_id) REFERENCES dbo.Usuario(id)
GO

IF COL_LENGTH('dbo.Plataforma', 'categoria') IS NULL
    ALTER TABLE dbo.Plataforma ADD categoria VARCHAR(20) NOT NULL
        CONSTRAINT DF_Plataforma_categoria_reparo DEFAULT 'outro' WITH VALUES
GO

IF COL_LENGTH('dbo.Plataforma', 'risco') IS NULL
    ALTER TABLE dbo.Plataforma ADD risco VARCHAR(10) NOT NULL
        CONSTRAINT DF_Plataforma_risco_reparo DEFAULT 'baixo' WITH VALUES
GO

IF COL_LENGTH('dbo.Plataforma', 'aprovacao_automatica') IS NULL
    ALTER TABLE dbo.Plataforma ADD aprovacao_automatica BIT NOT NULL
        CONSTRAINT DF_Plataforma_aprovacao_automatica DEFAULT 0 WITH VALUES
GO

IF OBJECT_ID('dbo.CK_Plataforma_categoria', 'C') IS NULL
   AND COL_LENGTH('dbo.Plataforma', 'categoria') IS NOT NULL
    ALTER TABLE dbo.Plataforma ADD CONSTRAINT CK_Plataforma_categoria
        CHECK (categoria IN ('elevatoria', 'andaime', 'sala', 'patio', 'veiculo', 'outro'))
GO

IF OBJECT_ID('dbo.CK_Plataforma_risco', 'C') IS NULL
   AND COL_LENGTH('dbo.Plataforma', 'risco') IS NOT NULL
    ALTER TABLE dbo.Plataforma ADD CONSTRAINT CK_Plataforma_risco
        CHECK (risco IN ('baixo', 'medio', 'alto'))
GO

-- ==DOWN==

-- Reparo de integridade sem DOWN destrutivo: remover estas colunas apagaria evidências
-- históricas e voltaria a quebrar as consultas da API. O rollback apenas desregistra a
-- migration; um UP posterior verifica o catálogo novamente.
SELECT 1
GO
