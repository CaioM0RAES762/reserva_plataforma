-- Migration 0005_configuracao_sistema
-- PlataformaRes | Sprint S7
-- Cria ConfiguracaoSistema (SDD §4.3) — schema completo ja nesta sprint; tela
-- administrativa completa so em S12. Seed de sla_aprovacao_urgente_horas (RN-RES-09).

-- ==UP==

CREATE TABLE ConfiguracaoSistema (
    chave              VARCHAR(60)   NOT NULL PRIMARY KEY,
    valor              NVARCHAR(200) NOT NULL,
    descricao          NVARCHAR(300) NULL,
    atualizado_em      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    atualizado_por_id  UNIQUEIDENTIFIER NULL,
    CONSTRAINT FK_ConfiguracaoSistema_Usuario FOREIGN KEY (atualizado_por_id) REFERENCES Usuario(id)
);

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('sla_aprovacao_urgente_horas', '2', 'Horas maximas para decisao de reserva urgente antes do escalonamento automatico ao Admin (RN-RES-09).');

-- ==DOWN==

DROP TABLE IF EXISTS ConfiguracaoSistema;
