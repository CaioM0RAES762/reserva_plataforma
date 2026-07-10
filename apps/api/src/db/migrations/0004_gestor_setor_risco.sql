-- Migration 0004_gestor_setor_risco
-- PlataformaRes | Sprint S7
-- Introduz o perfil gestor_setor (SDD §2.3/§17.4) e os campos de categoria/risco/aprovacao
-- automatica de Plataforma (SDD §4.2), alem da coluna de dupla aprovacao em Reserva.

-- ==UP==

ALTER TABLE Usuario DROP CONSTRAINT CK_Usuario_perfil;

ALTER TABLE Usuario ADD CONSTRAINT CK_Usuario_perfil CHECK (perfil IN ('admin', 'gestor_setor', 'colaborador'));

ALTER TABLE Plataforma ADD
    categoria             VARCHAR(20) NOT NULL DEFAULT 'outro',
    risco                 VARCHAR(10) NOT NULL DEFAULT 'baixo',
    aprovacao_automatica  BIT         NOT NULL DEFAULT 0;

ALTER TABLE Plataforma ADD CONSTRAINT CK_Plataforma_categoria
    CHECK (categoria IN ('elevatoria', 'andaime', 'sala', 'patio', 'veiculo', 'outro'));

ALTER TABLE Plataforma ADD CONSTRAINT CK_Plataforma_risco
    CHECK (risco IN ('baixo', 'medio', 'alto'));

ALTER TABLE Reserva ADD segunda_aprovacao_por_id UNIQUEIDENTIFIER NULL;

ALTER TABLE Reserva ADD CONSTRAINT FK_Reserva_SegundaAprovacaoPor FOREIGN KEY (segunda_aprovacao_por_id) REFERENCES Usuario(id);

-- ==DOWN==

ALTER TABLE Reserva DROP CONSTRAINT FK_Reserva_SegundaAprovacaoPor;
ALTER TABLE Reserva DROP COLUMN segunda_aprovacao_por_id;

ALTER TABLE Plataforma DROP CONSTRAINT CK_Plataforma_risco;
ALTER TABLE Plataforma DROP CONSTRAINT CK_Plataforma_categoria;
ALTER TABLE Plataforma DROP COLUMN categoria, risco, aprovacao_automatica;

ALTER TABLE Usuario DROP CONSTRAINT CK_Usuario_perfil;
ALTER TABLE Usuario ADD CONSTRAINT CK_Usuario_perfil CHECK (perfil IN ('admin', 'colaborador'));
