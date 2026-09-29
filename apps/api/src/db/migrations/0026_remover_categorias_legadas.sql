-- Migration 0026_remover_categorias_legadas
-- PlataformaRes
--
-- Remove DE FATO (DELETE, não desativação) as categorias semeadas pela 0025 que não serão
-- usadas: Andaime, Veículo, Sala / espaço compartilhado, Pátio e Outro. Fica somente
-- "Plataforma elevatória" ('elevatoria'); novas categorias são cadastradas pelo Admin.
--
-- Referências, na ordem certa para nunca deixar FK inválida:
--   1. Plataforma.categoria (FK_Plataforma_categoria → CategoriaEquipamento.codigo): as
--      plataformas que usavam uma das categorias removidas passam para 'elevatoria', a única
--      que permanece (nenhuma categoria nova é inventada).
--   2. DEFAULT da coluna Plataforma.categoria era 'outro' (constraint com nome gerado pelo
--      SQL Server na 0004): passa a ser 'elevatoria' — senão um INSERT sem categoria
--      violaria a FK.
--   3. Só então as 5 linhas saem de CategoriaEquipamento.
-- A remoção é por CÓDIGO (estável), não por nome — vale mesmo se o Admin tiver renomeado.
-- A 0025 continua semeando as 6 num banco novo; esta migration roda logo depois e as remove,
-- então nenhum ambiente termina com elas.
-- Fora do escopo (não são FK para CategoriaEquipamento): ChecklistTemplate /
-- ChecklistItemTemplate.categoria_plataforma, histórico legado do checklist NR-18/35.

-- ==UP==

UPDATE Plataforma
SET categoria = 'elevatoria', atualizado_em = SYSUTCDATETIME()
WHERE categoria IN ('andaime', 'veiculo', 'sala', 'patio', 'outro');
GO

-- Sem ";" no fim das linhas: o runner (migrate.ts) divide o lote nesse ponto, e a variável
-- precisa viver no mesmo lote que o EXEC.
DECLARE @df sysname = (
    SELECT dc.name
    FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID('Plataforma') AND c.name = 'categoria'
)
IF @df IS NOT NULL
    EXEC ('ALTER TABLE Plataforma DROP CONSTRAINT [' + @df + ']')
GO

ALTER TABLE Plataforma ADD CONSTRAINT DF_Plataforma_categoria DEFAULT 'elevatoria' FOR categoria;
GO

DELETE FROM CategoriaEquipamento WHERE codigo IN ('andaime', 'veiculo', 'sala', 'patio', 'outro');
GO

-- ==DOWN==

-- Recria as linhas (as plataformas migradas para 'elevatoria' não voltam: a categoria
-- original de cada uma não foi guardada) e o DEFAULT antigo, para a 0025 poder ser desfeita.
INSERT INTO CategoriaEquipamento (codigo, nome, ordem)
SELECT v.codigo, v.nome, v.ordem
FROM (VALUES
    ('andaime', N'Andaime', 2),
    ('veiculo', N'Veículo', 3),
    ('sala', N'Sala / espaço compartilhado', 4),
    ('patio', N'Pátio', 5),
    ('outro', N'Outro', 6)
) AS v (codigo, nome, ordem)
WHERE NOT EXISTS (SELECT 1 FROM CategoriaEquipamento c WHERE c.codigo = v.codigo);
GO

ALTER TABLE Plataforma DROP CONSTRAINT DF_Plataforma_categoria;
GO

ALTER TABLE Plataforma ADD DEFAULT 'outro' FOR categoria;
GO
