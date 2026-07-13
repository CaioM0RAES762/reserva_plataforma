-- Migration 0006_checklist_seguranca
-- PlataformaRes | Sprint S8
-- Checklist de segurança (SDD §4.3, §6.5, §7 RN-CHK-*): templates por categoria de
-- plataforma, preenchimento por reserva e respostas item a item. requer_checklist
-- (RN-RES-12) é derivado de Plataforma.categoria em ('elevatoria','andaime') em tempo
-- de leitura/aplicação — não uma coluna nova (ver checklist.service.ts, requerChecklist).

-- ==UP==

CREATE TABLE ChecklistItemTemplate (
    id                    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    categoria_plataforma  VARCHAR(20)   NOT NULL,
    descricao             NVARCHAR(300) NOT NULL,
    ordem                 INT           NOT NULL,
    obrigatorio           BIT           NOT NULL DEFAULT 1,
    ativo                 BIT           NOT NULL DEFAULT 1,
    CONSTRAINT CK_ChecklistItemTemplate_categoria
        CHECK (categoria_plataforma IN ('elevatoria', 'andaime', 'veiculo', 'outro'))
);

CREATE INDEX IX_ChecklistItemTemplate_categoria ON ChecklistItemTemplate(categoria_plataforma, ativo);

CREATE TABLE ChecklistPreenchido (
    id                  UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    reserva_id          UNIQUEIDENTIFIER NOT NULL,
    preenchido_por_id   UNIQUEIDENTIFIER NOT NULL,
    todos_conformes     BIT           NOT NULL DEFAULT 0,
    preenchido_em       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ChecklistPreenchido_reserva UNIQUE (reserva_id),
    CONSTRAINT FK_ChecklistPreenchido_Reserva FOREIGN KEY (reserva_id) REFERENCES Reserva(id),
    CONSTRAINT FK_ChecklistPreenchido_Usuario FOREIGN KEY (preenchido_por_id) REFERENCES Usuario(id)
);

CREATE TABLE ChecklistResposta (
    id                       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    checklist_preenchido_id  UNIQUEIDENTIFIER NOT NULL,
    item_id                  UNIQUEIDENTIFIER NOT NULL,
    conforme                 BIT           NOT NULL,
    -- RN-CHK-01: observacao obrigatória quando conforme = 0 — aplicado em checklist.service.ts,
    -- não via CHECK constraint (evita duplicar a regra condicional em T-SQL).
    observacao               NVARCHAR(300) NULL,
    -- RF-CHK-04: evidência fotográfica opcional por item. Armazenamento simplificado
    -- nesta sprint (storage.service.ts local, isolado atrás de interface) — Azure Blob
    -- definitivo entra em S11 (apenas troca a implementação, não este campo).
    foto_url                 NVARCHAR(500) NULL,
    CONSTRAINT UQ_ChecklistResposta_preenchido_item UNIQUE (checklist_preenchido_id, item_id),
    CONSTRAINT FK_ChecklistResposta_Preenchido FOREIGN KEY (checklist_preenchido_id) REFERENCES ChecklistPreenchido(id),
    CONSTRAINT FK_ChecklistResposta_Item FOREIGN KEY (item_id) REFERENCES ChecklistItemTemplate(id)
);

CREATE INDEX IX_ChecklistResposta_preenchido_id ON ChecklistResposta(checklist_preenchido_id);

-- Seed — SDD §17.9 (categoria "elevatoria", redação literal do anexo).
INSERT INTO ChecklistItemTemplate (categoria_plataforma, descricao, ordem, obrigatorio) VALUES
    ('elevatoria', 'Guarda-corpo e rodapé instalados e íntegros', 1, 1),
    ('elevatoria', 'Sistema de freio/travamento testado', 2, 1),
    ('elevatoria', 'Ausência de vazamentos hidráulicos visíveis', 3, 1),
    ('elevatoria', 'Sinalização de área e isolamento realizados', 4, 1),
    ('elevatoria', 'EPI do operador conforme (capacete, cinto, botina)', 5, 1),
    ('elevatoria', 'Carga a transportar dentro do limite de capacidade da plataforma', 6, 1);

-- Seed — categoria "andaime", itens equivalentes adaptados a NR-18 (base/travamento,
-- contraventamento, guarda-corpo, distância de rede elétrica, EPI de trabalho em altura).
INSERT INTO ChecklistItemTemplate (categoria_plataforma, descricao, ordem, obrigatorio) VALUES
    ('andaime', 'Base nivelada e travada, com sapatas ou rodízios travados', 1, 1),
    ('andaime', 'Escoras e contraventamentos instalados conforme projeto', 2, 1),
    ('andaime', 'Guarda-corpo e rodapé completos em todos os níveis de trabalho', 3, 1),
    ('andaime', 'Distância segura mantida de rede elétrica energizada', 4, 1),
    ('andaime', 'EPI do operador conforme (capacete, cinto de segurança tipo paraquedista, botina)', 5, 1);

-- ==DOWN==

DROP TABLE IF EXISTS ChecklistResposta;
DROP TABLE IF EXISTS ChecklistPreenchido;
DROP TABLE IF EXISTS ChecklistItemTemplate;
