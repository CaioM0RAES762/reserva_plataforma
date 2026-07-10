-- Migration 0003_indice_reserva_data
-- PlataformaRes | Sprint S5
-- IX_Reserva_plataforma_data (S1) lidera por plataforma_id, pouco útil para as novas
-- range queries de Calendário/Histórico que varrem Reserva.data por si só (sem filtro
-- fixo de plataforma). Adiciona índice dedicado a data.

-- ==UP==

CREATE INDEX IX_Reserva_data ON Reserva(data);

-- ==DOWN==

DROP INDEX IX_Reserva_data ON Reserva;
