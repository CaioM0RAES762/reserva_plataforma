-- Migration 0029_reserva_varios_dias
-- PlataformaRes
--
-- Reserva de vários dias. Até aqui uma reserva era sempre de um único dia (data + hora_inicio
-- + hora_fim, com hora_fim > hora_inicio), então nunca passava da meia-noite — um equipamento
-- não podia ficar reservado por uma semana. Agora o período vai de (data, hora_inicio) até
-- (data_fim, hora_fim). Reserva de um dia só continua igual: data_fim = data.
--
-- inicio_local / fim_local: o mesmo período como DATETIME2 no horário civil de Brasília (o
-- referencial de data/hora_inicio/hora_fim). Calculadas pelo banco a partir das colunas
-- acima — nunca gravadas pela aplicação —, para que toda checagem de sobreposição seja uma
-- comparação simples de intervalos, sem remontar data+hora em cada consulta.
--
-- inicio_real_em / fim_real_em: instante real (Brasília) de início e fim do uso, com DATA.
-- hora_inicio_real/hora_fim_real (TIME) continuam sendo gravadas, mas sozinhas não dizem
-- quantos dias o uso durou — o horímetro passa a usar estas colunas.

-- ==UP==

IF COL_LENGTH('Reserva', 'data_fim') IS NULL
    ALTER TABLE Reserva ADD data_fim DATE NULL;
GO

UPDATE Reserva SET data_fim = data WHERE data_fim IS NULL;
GO

ALTER TABLE Reserva ALTER COLUMN data_fim DATE NOT NULL;
GO

IF OBJECT_ID('CK_Reserva_horario', 'C') IS NOT NULL
    ALTER TABLE Reserva DROP CONSTRAINT CK_Reserva_horario;
GO

ALTER TABLE Reserva ADD CONSTRAINT CK_Reserva_periodo
    CHECK (data_fim > data OR (data_fim = data AND hora_fim > hora_inicio));
GO

ALTER TABLE Reserva ADD
    inicio_local AS DATEADD(MINUTE, DATEPART(HOUR, hora_inicio) * 60 + DATEPART(MINUTE, hora_inicio),
                            CAST(data AS DATETIME2(0))) PERSISTED,
    fim_local AS DATEADD(MINUTE, DATEPART(HOUR, hora_fim) * 60 + DATEPART(MINUTE, hora_fim),
                         CAST(data_fim AS DATETIME2(0))) PERSISTED;
GO

ALTER TABLE Reserva ADD inicio_real_em DATETIME2(0) NULL, fim_real_em DATETIME2(0) NULL;
GO

-- Histórico: toda reserva anterior era de um dia só. O fim real "antes" do início real só
-- acontecia quando o encerramento manual passava da meia-noite — ele cai no dia seguinte
-- (mesma regra que calcularMinutosDeUso aplicava).
UPDATE Reserva
SET inicio_real_em = DATEADD(MINUTE, DATEPART(HOUR, hora_inicio_real) * 60 + DATEPART(MINUTE, hora_inicio_real),
                             CAST(data AS DATETIME2(0)))
WHERE hora_inicio_real IS NOT NULL AND inicio_real_em IS NULL;

UPDATE Reserva
SET fim_real_em = DATEADD(MINUTE, DATEPART(HOUR, hora_fim_real) * 60 + DATEPART(MINUTE, hora_fim_real),
                          CAST(CASE WHEN hora_inicio_real IS NOT NULL AND hora_fim_real < hora_inicio_real
                                    THEN DATEADD(DAY, 1, data) ELSE data END AS DATETIME2(0)))
WHERE hora_fim_real IS NOT NULL AND fim_real_em IS NULL;
GO

-- Sobreposição por plataforma: "começa antes do fim pedido e termina depois do início pedido".
CREATE INDEX IX_Reserva_plataforma_periodo ON Reserva(plataforma_id, inicio_local, fim_local) INCLUDE (status);
GO

-- ==DOWN==

-- Só reverte se nenhuma reserva de vários dias existir: o modelo antigo não as representa.
IF EXISTS (SELECT 1 FROM Reserva WHERE data_fim <> data)
    THROW 50000, 'Existem reservas de vários dias; a migration 0029 não pode ser revertida sem perdê-las.', 1;
GO

DROP INDEX IF EXISTS IX_Reserva_plataforma_periodo ON Reserva;
ALTER TABLE Reserva DROP COLUMN inicio_real_em, fim_real_em, inicio_local, fim_local;
ALTER TABLE Reserva DROP CONSTRAINT CK_Reserva_periodo;
ALTER TABLE Reserva ADD CONSTRAINT CK_Reserva_horario CHECK (hora_fim > hora_inicio);
ALTER TABLE Reserva DROP COLUMN data_fim;
GO
