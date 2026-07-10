-- Migration 0002_reserva_aprovacao
-- PlataformaRes | Sprint S4
-- Adiciona à Reserva os campos necessários à máquina de estados de aprovação/uso.
-- segunda_aprovacao_por_id (dupla aprovação) e demais colunas de S7 (Gestor de Setor,
-- risco, aprovacao_automatica) permanecem FORA desta migration — entram em S7 (MASTER.md Seção 1).

-- ==UP==

ALTER TABLE Reserva ADD
    aprovado_por_id   UNIQUEIDENTIFIER NULL,
    motivo_rejeicao   NVARCHAR(500)    NULL,
    hora_inicio_real  TIME             NULL,
    hora_fim_real     TIME             NULL;

ALTER TABLE Reserva ADD CONSTRAINT FK_Reserva_AprovadoPor FOREIGN KEY (aprovado_por_id) REFERENCES Usuario(id);

-- ==DOWN==

ALTER TABLE Reserva DROP CONSTRAINT FK_Reserva_AprovadoPor;
ALTER TABLE Reserva DROP COLUMN aprovado_por_id, motivo_rejeicao, hora_inicio_real, hora_fim_real;
