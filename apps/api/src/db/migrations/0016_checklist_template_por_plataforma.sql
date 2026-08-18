-- Migration 0016_checklist_template_por_plataforma
-- PlataformaRes
-- Redesenha o checklist de seguranca: templates viram entidades nomeadas e reutilizaveis
-- (nao mais uma lista solta de itens por categoria), plataformas podem referenciar um
-- template especifico (override) alem do default por categoria, respostas passam a ter
-- 3 estados (conforme/nao_conforme/nao_aplicavel) em vez de um bit, e o preenchimento
-- distingue rascunho (em preenchimento) de finalizado — necessario para o checklist virar
-- um portao real antes da aprovacao da reserva, nao so antes do inicio de uso.

-- ==UP==

CREATE TABLE ChecklistTemplate (
    id                    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    nome                  NVARCHAR(150) NOT NULL,
    categoria_plataforma  VARCHAR(20)   NOT NULL,
    ativo                 BIT           NOT NULL DEFAULT 1,
    criado_em             DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ChecklistTemplate_categoria
        CHECK (categoria_plataforma IN ('elevatoria', 'andaime', 'sala', 'patio', 'veiculo', 'outro'))
);
GO

CREATE INDEX IX_ChecklistTemplate_categoria ON ChecklistTemplate(categoria_plataforma, ativo);
GO

-- Um template "padrao" por categoria ja existente em ChecklistItemTemplate, preservando os
-- itens seedados em 0006 sem duplicar texto.
INSERT INTO ChecklistTemplate (nome, categoria_plataforma)
SELECT DISTINCT 'Checklist padrao — ' + categoria_plataforma, categoria_plataforma
FROM ChecklistItemTemplate;
GO

ALTER TABLE ChecklistItemTemplate ADD template_id UNIQUEIDENTIFIER NULL;
GO

UPDATE it
SET it.template_id = t.id
FROM ChecklistItemTemplate it
JOIN ChecklistTemplate t ON t.categoria_plataforma = it.categoria_plataforma;
GO

ALTER TABLE ChecklistItemTemplate ALTER COLUMN template_id UNIQUEIDENTIFIER NOT NULL;
GO

ALTER TABLE ChecklistItemTemplate
    ADD CONSTRAINT FK_ChecklistItemTemplate_Template FOREIGN KEY (template_id) REFERENCES ChecklistTemplate(id);
GO

CREATE INDEX IX_ChecklistItemTemplate_template ON ChecklistItemTemplate(template_id, ativo);
GO

-- NULL = usa o template padrao da categoria da plataforma (comportamento de hoje,
-- preservado); preenchido = override explicito de um template especifico para esta
-- plataforma (RF-CHK-05 — "Plataforma Elevatoria A" pode ter um checklist proprio,
-- diferente da "Plataforma Elevatoria Demo S8", mesmo as duas sendo categoria elevatoria).
ALTER TABLE Plataforma ADD checklist_template_id UNIQUEIDENTIFIER NULL;
GO

ALTER TABLE Plataforma
    ADD CONSTRAINT FK_Plataforma_ChecklistTemplate FOREIGN KEY (checklist_template_id) REFERENCES ChecklistTemplate(id);
GO

-- Resposta tri-estado: "nao_aplicavel" nao existia (so conforme/nao_conforme via BIT) e
-- nao tinha como representar um item que nao se aplica aquela reserva sem forcar
-- conforme=true (mascarando o dado) ou nao_conforme=true (bloqueando aprovacao a toa).
ALTER TABLE ChecklistResposta ADD resultado VARCHAR(20) NULL;
GO

UPDATE ChecklistResposta SET resultado = CASE WHEN conforme = 1 THEN 'conforme' ELSE 'nao_conforme' END;
GO

ALTER TABLE ChecklistResposta ALTER COLUMN resultado VARCHAR(20) NOT NULL;
GO

ALTER TABLE ChecklistResposta
    ADD CONSTRAINT CK_ChecklistResposta_resultado CHECK (resultado IN ('conforme', 'nao_conforme', 'nao_aplicavel'));
GO

ALTER TABLE ChecklistResposta DROP COLUMN conforme;
GO

-- Rascunho (em preenchimento, sem gate ainda) vs finalizado (gate de aprovacao avalia
-- daqui). Antes so existia "existe ou nao existe" — cada PUT exigia TODOS os itens
-- obrigatorios respondidos, entao nao dava pra salvar progresso parcial ("8 de 12
-- preenchidos") nem mostrar essa situacao na lista de checklists.
ALTER TABLE ChecklistPreenchido ADD finalizado_em DATETIME2 NULL;
GO

-- Preenchimentos existentes ja tinham TODOS os obrigatorios respondidos sob a regra
-- antiga (o PUT so aceitava assim) — equivalem a "finalizado" desde sempre.
UPDATE ChecklistPreenchido SET finalizado_em = preenchido_em;
GO

-- ==DOWN==

ALTER TABLE ChecklistPreenchido DROP COLUMN finalizado_em;
GO

ALTER TABLE ChecklistResposta ADD conforme BIT NULL;
GO

UPDATE ChecklistResposta SET conforme = CASE WHEN resultado = 'conforme' THEN 1 ELSE 0 END;
GO

ALTER TABLE ChecklistResposta ALTER COLUMN conforme BIT NOT NULL;
GO

ALTER TABLE ChecklistResposta DROP CONSTRAINT CK_ChecklistResposta_resultado;
GO

ALTER TABLE ChecklistResposta DROP COLUMN resultado;
GO

ALTER TABLE Plataforma DROP CONSTRAINT FK_Plataforma_ChecklistTemplate;
GO

ALTER TABLE Plataforma DROP COLUMN checklist_template_id;
GO

DROP INDEX IX_ChecklistItemTemplate_template ON ChecklistItemTemplate;
GO

ALTER TABLE ChecklistItemTemplate DROP CONSTRAINT FK_ChecklistItemTemplate_Template;
GO

ALTER TABLE ChecklistItemTemplate DROP COLUMN template_id;
GO

DROP TABLE IF EXISTS ChecklistTemplate;
GO
