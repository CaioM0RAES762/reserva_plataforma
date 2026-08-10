-- Migration 0013_plataforma_ficha_tecnica
-- PlataformaRes | Frota em cards (ficha técnica)
-- Campos técnicos exibidos no card da frota: tipo do equipamento (ex: "Tesoura
-- elétrica"), altura máxima (usada também para decidir a exigência de NR-35 —
-- trabalho em altura, > 2 m), capacidade em número de operadores, e horímetro
-- (atualizado manualmente pelo Admin, não há sensor/telemetria nesta versão).
-- Todos nullable: plataformas existentes continuam válidas sem esses dados.

-- ==UP==

ALTER TABLE Plataforma ADD
    tipo_equipamento      NVARCHAR(80)   NULL,
    altura_maxima_m       DECIMAL(4,1)   NULL,
    capacidade_operadores INT            NULL,
    horimetro_horas       INT            NULL;

-- ==DOWN==

ALTER TABLE Plataforma DROP COLUMN tipo_equipamento, altura_maxima_m, capacidade_operadores, horimetro_horas;
