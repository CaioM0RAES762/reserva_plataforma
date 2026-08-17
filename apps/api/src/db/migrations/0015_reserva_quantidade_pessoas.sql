-- Migration 0015_reserva_quantidade_pessoas
-- PlataformaRes | Correções da área de Reservas
--
-- Adiciona a quantidade de pessoas que vai usar a plataforma/recurso reservado — hoje o
-- formulário de Nova Reserva não coleta essa informação e não há como validar contra a
-- capacidade máxima já cadastrada em Plataforma.capacidade (migration 0001).
--
-- DEFAULT 1 (não NULL): toda reserva, inclusive as já existentes, envolve pelo menos uma
-- pessoa — 1 é o valor mínimo válido do próprio campo (ver CK abaixo), não um placeholder
-- arbitrário. `ALTER TABLE ... ADD ... NOT NULL DEFAULT 1` no SQL Server já reescreve as
-- linhas existentes com o default, então reservas antigas ficam consistentes sem exigir
-- um UPDATE separado nem deixar a coluna NULLABLE.

-- ==UP==

ALTER TABLE Reserva ADD quantidade_pessoas INT NOT NULL DEFAULT 1;
GO

ALTER TABLE Reserva ADD CONSTRAINT CK_Reserva_quantidade_pessoas CHECK (quantidade_pessoas > 0);
GO

-- ==DOWN==

ALTER TABLE Reserva DROP CONSTRAINT CK_Reserva_quantidade_pessoas;
GO

ALTER TABLE Reserva DROP COLUMN quantidade_pessoas;
GO
