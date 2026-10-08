-- Migration 0028_plataforma_criado_por
-- PlataformaRes
--
-- Autoria do cadastro de plataforma. O Gestor de Setor passa a poder cadastrar plataformas,
-- mas só edita (dados, status, imagens) as que ele mesmo cadastrou — a regra precisa saber
-- quem criou cada uma. Plataformas já existentes ficam com NULL: só o Admin as edita.

-- ==UP==

IF COL_LENGTH('Plataforma', 'criado_por_id') IS NULL
    ALTER TABLE Plataforma ADD criado_por_id UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_Plataforma_criado_por FOREIGN KEY REFERENCES Usuario(id);
GO

-- ==DOWN==

IF OBJECT_ID('FK_Plataforma_criado_por', 'F') IS NOT NULL
    ALTER TABLE Plataforma DROP CONSTRAINT FK_Plataforma_criado_por;
IF COL_LENGTH('Plataforma', 'criado_por_id') IS NOT NULL
    ALTER TABLE Plataforma DROP COLUMN criado_por_id;
GO
