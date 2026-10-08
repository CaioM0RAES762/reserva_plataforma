-- Migration 0030_plataforma_setor_responsaveis
-- PlataformaRes
--
-- Gestão de plataformas por setor e por responsabilidade direta:
--  * Plataforma.setor_id — setor responsável. Novas plataformas sempre têm (Gestor: o setor dele;
--    Admin: escolhido no cadastro). As existentes ficam NULL: nenhum setor é inferido sem o
--    Admin decidir — uma associação automática errada daria gestão a quem não deveria ter.
--  * PlataformaResponsavel — gestores atribuídos diretamente (N:N), por qualquer categoria de
--    equipamento. Só o Admin atribui/remove; vale enquanto o usuário estiver ativo e Gestor.
--  * politica_substituicao_reserva_urgente — quem autoriza substituir reservas por uma urgente.
--    Padrão 'todos_aprovadores' = comportamento anterior (Admin ou qualquer Gestor).

-- ==UP==

IF COL_LENGTH('Plataforma', 'setor_id') IS NULL
    ALTER TABLE Plataforma ADD setor_id UNIQUEIDENTIFIER NULL
        CONSTRAINT FK_Plataforma_setor FOREIGN KEY REFERENCES Setor(id);
GO

CREATE INDEX IX_Plataforma_setor ON Plataforma(setor_id);
GO

CREATE TABLE PlataformaResponsavel (
    id               UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    plataforma_id    UNIQUEIDENTIFIER NOT NULL,
    gestor_id        UNIQUEIDENTIFIER NOT NULL,
    atribuido_por_id UNIQUEIDENTIFIER NOT NULL,
    atribuido_em     DATETIME2        NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_PlataformaResponsavel_plataforma FOREIGN KEY (plataforma_id) REFERENCES Plataforma(id) ON DELETE CASCADE,
    CONSTRAINT FK_PlataformaResponsavel_gestor FOREIGN KEY (gestor_id) REFERENCES Usuario(id),
    CONSTRAINT FK_PlataformaResponsavel_atribuido_por FOREIGN KEY (atribuido_por_id) REFERENCES Usuario(id),
    CONSTRAINT UQ_PlataformaResponsavel UNIQUE (plataforma_id, gestor_id)
);
GO

-- Consulta "de quais plataformas este gestor é responsável" (permissão e auditoria do Gestor).
CREATE INDEX IX_PlataformaResponsavel_gestor ON PlataformaResponsavel(gestor_id) INCLUDE (plataforma_id);
GO

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'politica_substituicao_reserva_urgente')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao)
    VALUES ('politica_substituicao_reserva_urgente', 'todos_aprovadores',
            'Quem autoriza substituir reservas por uma urgente: todos_aprovadores (Admin ou qualquer Gestor) ou responsaveis_plataforma_ou_admin (Admin ou Gestor responsável direto pela plataforma).');
GO

-- ==DOWN==

DELETE FROM ConfiguracaoSistema WHERE chave = 'politica_substituicao_reserva_urgente';
DROP TABLE IF EXISTS PlataformaResponsavel;
DROP INDEX IF EXISTS IX_Plataforma_setor ON Plataforma;
IF OBJECT_ID('FK_Plataforma_setor', 'F') IS NOT NULL
    ALTER TABLE Plataforma DROP CONSTRAINT FK_Plataforma_setor;
IF COL_LENGTH('Plataforma', 'setor_id') IS NOT NULL
    ALTER TABLE Plataforma DROP COLUMN setor_id;
GO
