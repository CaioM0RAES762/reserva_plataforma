-- Migration 0020_reserva_empresa_terceirizada
-- PlataformaRes
--
-- Reserva feita para o setor "Terceirizados" passa a registrar a EMPRESA terceirizada que vai
-- usar a plataforma (a regra vive em packages/shared/src/empresaTerceirizada.ts e é aplicada
-- por POST /reservas — o banco só guarda o dado).
--
-- NULL e não '' (nem um default): reservas anteriores a esta migration e reservas de setores
-- internos genuinamente não têm o dado, e NULL diz exatamente isso. Também não há CHECK que
-- amarre a coluna ao setor: a obrigatoriedade depende do NOME do setor (não existe flag no
-- cadastro), então ela é decidida na rota — um CHECK aqui não teria como enxergá-lo.
--
-- Aditiva e idempotente: só cria a coluna quando ela ainda não existe e não toca em nenhum
-- dado. 120 = EMPRESA_TERCEIRIZADA_MAX (shared), o mesmo teto que a rota valida.

-- ==UP==

IF COL_LENGTH('dbo.Reserva', 'empresa_terceirizada') IS NULL
    ALTER TABLE dbo.Reserva ADD empresa_terceirizada NVARCHAR(120) NULL
GO

-- ==DOWN==

-- Remove só a coluna criada por esta migration. A checagem de existência mantém o DOWN
-- seguro num ambiente em que o UP nunca chegou a rodar.
IF COL_LENGTH('dbo.Reserva', 'empresa_terceirizada') IS NOT NULL
    ALTER TABLE dbo.Reserva DROP COLUMN empresa_terceirizada
GO
