-- Migration 0007_bloqueio_recorrencia
-- PlataformaRes | Sprint S9
-- Bloqueios de agenda (manutenção preventiva/feriados) e reservas recorrentes semanais
-- (SDD §4.3, §6.3/6.4 RF-BLK/RF-RES-03, §7 RN-RES-11/RN-BLK-01).

-- ==UP==

CREATE TABLE BloqueioAgenda (
    id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    -- plataforma_id NULL = bloqueio global (todas as plataformas), conforme SDD §4.3.
    plataforma_id   UNIQUEIDENTIFIER NULL,
    data_inicio     DATETIME2     NOT NULL,
    data_fim        DATETIME2     NOT NULL,
    motivo          NVARCHAR(300) NOT NULL,
    criado_por_id   UNIQUEIDENTIFIER NOT NULL,
    criado_em       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_BloqueioAgenda_Plataforma FOREIGN KEY (plataforma_id) REFERENCES Plataforma(id),
    CONSTRAINT FK_BloqueioAgenda_Usuario FOREIGN KEY (criado_por_id) REFERENCES Usuario(id),
    CONSTRAINT CK_BloqueioAgenda_datas CHECK (data_fim > data_inicio)
);

CREATE INDEX IX_BloqueioAgenda_plataforma_periodo ON BloqueioAgenda(plataforma_id, data_inicio, data_fim);

CREATE TABLE ReservaRecorrencia (
    id                     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    criado_por_id          UNIQUEIDENTIFIER NOT NULL,
    -- v2.0 (SDD §4.3) suporta apenas frequência semanal.
    frequencia             VARCHAR(10)   NOT NULL DEFAULT 'semanal',
    dia_semana             TINYINT       NOT NULL,
    quantidade_ocorrencias TINYINT       NOT NULL,
    criado_em              DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ReservaRecorrencia_Usuario FOREIGN KEY (criado_por_id) REFERENCES Usuario(id),
    CONSTRAINT CK_ReservaRecorrencia_frequencia CHECK (frequencia = 'semanal'),
    CONSTRAINT CK_ReservaRecorrencia_dia_semana CHECK (dia_semana BETWEEN 0 AND 6),
    CONSTRAINT CK_ReservaRecorrencia_quantidade CHECK (quantidade_ocorrencias BETWEEN 2 AND 12)
);

GO

-- Batch separado (ADR-02 de S7): evita "Invalid column name" ao resolver a FK sobre
-- ReservaRecorrencia, criada no mesmo script, e permite indexar a coluna logo em seguida.
ALTER TABLE Reserva ADD recorrencia_id UNIQUEIDENTIFIER NULL
    CONSTRAINT FK_Reserva_ReservaRecorrencia REFERENCES ReservaRecorrencia(id);

CREATE INDEX IX_Reserva_recorrencia ON Reserva(recorrencia_id);

-- ==DOWN==

DROP INDEX IF EXISTS IX_Reserva_recorrencia ON Reserva;
ALTER TABLE Reserva DROP CONSTRAINT FK_Reserva_ReservaRecorrencia;
ALTER TABLE Reserva DROP COLUMN recorrencia_id;
DROP TABLE IF EXISTS ReservaRecorrencia;
DROP TABLE IF EXISTS BloqueioAgenda;
