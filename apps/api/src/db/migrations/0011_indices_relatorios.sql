-- Migration 0011_indices_relatorios
-- PlataformaRes | Sprint S13
-- Índices de suporte às agregações do módulo de Relatórios & Indicadores (SDD §6.7
-- RF-REL-*, §13 RNF-01 — relatórios agregados ≤ 1,5s mesmo sob cache frio). Reserva.data
-- já é indexada desde 0003 (IX_Reserva_data); faltam status (usado em todo filtro de
-- utilização/ranking/segurança, que restringe a pendente/agendada/em_uso/concluida/etc.)
-- e criado_em (usado no cálculo de SLA de aprovação, que ordena/filtra pela criação).

-- ==UP==

CREATE INDEX IX_Reserva_status ON Reserva(status);
CREATE INDEX IX_Reserva_criado_em ON Reserva(criado_em);

-- Composto (setor_id, data): consultas de relatório escopadas por setor (Gestor) e
-- filtradas por período — IX_Reserva_setor_id (0001) sozinho não cobre a faixa de data.
CREATE INDEX IX_Reserva_setor_data ON Reserva(setor_id, data);

-- ==DOWN==

DROP INDEX IX_Reserva_setor_data ON Reserva;
DROP INDEX IX_Reserva_criado_em ON Reserva;
DROP INDEX IX_Reserva_status ON Reserva;
