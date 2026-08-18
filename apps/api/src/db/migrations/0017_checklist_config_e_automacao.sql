-- Migration 0017_checklist_config_e_automacao
-- PlataformaRes
--
-- Dois problemas estruturais, resolvidos juntos porque tocam as mesmas tabelas:
--
-- (1) "Exige checklist" era DERIVADO da categoria da plataforma: 0016 criou um
--     ChecklistTemplate "padrão" apenas para as categorias que já tinham itens seedados em
--     0006 ('elevatoria' e 'andaime'), e a resolução caía nesse default por categoria
--     quando a plataforma não tinha override. Como o formulário da Frota nunca expôs
--     `categoria` (toda plataforma criada pela UI nasce 'outro'), na prática só a única
--     plataforma cadastrada como 'elevatoria' — a "Plataforma Elevatória Demo S8" — exigia
--     checklist. A regra passa a ser uma configuração EXPLÍCITA da plataforma
--     (exige_checklist + checklist_template_id), nunca inferida do nome/código/categoria.
--
-- (2) A execução do checklist não guardava snapshot: ChecklistResposta só apontava para o
--     item do template (FK), então editar/remover uma questão reescrevia retroativamente
--     checklists já realizados. As respostas passam a carregar uma cópia do enunciado e das
--     regras do item no momento da execução.
--
-- Mais as colunas de automação de início/fim de reserva (worker BullMQ), que precisam de um
-- índice próprio para a varredura periódica não fazer table scan.

-- ==UP==

-- ---------------------------------------------------------------------------
-- 1. Checklist por configuração da plataforma (não mais por categoria)
-- ---------------------------------------------------------------------------

ALTER TABLE Plataforma
    ADD exige_checklist BIT NOT NULL CONSTRAINT DF_Plataforma_exige_checklist DEFAULT 0;
GO

-- Backfill preservando EXATAMENTE o comportamento vigente: quem resolvia para um template
-- ativo (override explícito OU default da categoria) continua exigindo checklist, e o
-- template resolvido é materializado em checklist_template_id. A partir daqui a coluna é a
-- fonte de verdade — nenhuma consulta volta a inferir o template pela categoria.
UPDATE p
SET p.exige_checklist = 1,
    p.checklist_template_id = COALESCE(p.checklist_template_id, resolvido.id)
FROM Plataforma p
CROSS APPLY (
    SELECT TOP 1 tpl.id
    FROM ChecklistTemplate tpl
    WHERE tpl.ativo = 1
      AND (
        (p.checklist_template_id IS NOT NULL AND tpl.id = p.checklist_template_id)
        OR (p.checklist_template_id IS NULL AND tpl.categoria_plataforma = p.categoria)
      )
    ORDER BY tpl.criado_em ASC
) resolvido;
GO

-- ---------------------------------------------------------------------------
-- 2. Templates administráveis (nome já existia; faltavam descrição e as regras por questão)
-- ---------------------------------------------------------------------------

ALTER TABLE ChecklistTemplate ADD descricao NVARCHAR(400) NULL;
GO

-- "Obrigatória" e "não conformidade bloqueia aprovação" são regras DIFERENTES e precisavam
-- ser separadas: uma questão pode exigir resposta para finalizar o checklist sem que uma
-- resposta não conforme nela impeça a aprovação da reserva (ex.: "Documentação disponível").
-- Default 1 mantém a semântica anterior, em que todo item obrigatório bloqueava.
ALTER TABLE ChecklistItemTemplate
    ADD bloqueia_aprovacao BIT NOT NULL CONSTRAINT DF_ChecklistItemTemplate_bloqueia DEFAULT 1;
GO

-- categoria_plataforma em ChecklistItemTemplate ficou redundante em 0016 (o item passou a
-- pertencer a um template, que já carrega a categoria) e continuava NOT NULL sem default —
-- o INSERT de POST /checklist-templates, que não a informa, falharia. Some o índice por
-- categoria junto: toda leitura de itens hoje é por template_id (IX_ChecklistItemTemplate_template).
DROP INDEX IX_ChecklistItemTemplate_categoria ON ChecklistItemTemplate;
GO

ALTER TABLE ChecklistItemTemplate ALTER COLUMN categoria_plataforma VARCHAR(20) NULL;
GO

-- ---------------------------------------------------------------------------
-- 3. Snapshot da execução (RF-CHK — checklist histórico é imutável)
-- ---------------------------------------------------------------------------

-- A resposta passa a carregar o enunciado e as regras do item COMO ELES ERAM no momento da
-- execução. Sem isto, renomear uma questão reescrevia o histórico e desativar uma questão a
-- fazia sumir de checklists já realizados — a evidência de um checklist NR-18/35 assinado
-- ontem não pode mudar porque o template foi editado hoje.
ALTER TABLE ChecklistResposta ADD
    item_descricao          NVARCHAR(300) NULL,
    item_ordem              INT           NULL,
    item_obrigatorio        BIT           NULL,
    item_bloqueia_aprovacao BIT           NULL;
GO

-- Respostas anteriores a esta migration não têm snapshot próprio — a melhor aproximação
-- disponível é o estado atual do item que elas referenciam (que, até agora, era o único
-- estado que existia).
UPDATE cr
SET cr.item_descricao = it.descricao,
    cr.item_ordem = it.ordem,
    cr.item_obrigatorio = it.obrigatorio,
    cr.item_bloqueia_aprovacao = it.bloqueia_aprovacao
FROM ChecklistResposta cr
JOIN ChecklistItemTemplate it ON it.id = cr.item_id
WHERE cr.item_descricao IS NULL;
GO

-- ---------------------------------------------------------------------------
-- 4. Automação de início/finalização de reserva
-- ---------------------------------------------------------------------------

-- Padrão por plataforma: só pré-preenche o formulário de nova reserva. A decisão que o job
-- lê é sempre a da RESERVA (colunas abaixo) — assim, mudar o padrão da plataforma nunca
-- altera retroativamente reservas já criadas.
ALTER TABLE Plataforma ADD
    inicio_automatico_padrao BIT NOT NULL CONSTRAINT DF_Plataforma_inicio_auto_padrao DEFAULT 0,
    fim_automatico_padrao    BIT NOT NULL CONSTRAINT DF_Plataforma_fim_auto_padrao DEFAULT 0;
GO

ALTER TABLE Reserva ADD
    inicio_automatico BIT NOT NULL CONSTRAINT DF_Reserva_inicio_automatico DEFAULT 0,
    fim_automatico    BIT NOT NULL CONSTRAINT DF_Reserva_fim_automatico DEFAULT 0;
GO

-- O worker varre a cada minuto por (status, data) — sem este índice a varredura seria um
-- scan da tabela inteira de reservas a cada execução.
CREATE INDEX IX_Reserva_automacao ON Reserva(status, data)
    INCLUDE (hora_inicio, hora_fim, inicio_automatico, fim_automatico, plataforma_id);
GO

-- ==DOWN==

DROP INDEX IX_Reserva_automacao ON Reserva;
GO

ALTER TABLE Reserva DROP CONSTRAINT DF_Reserva_inicio_automatico, DF_Reserva_fim_automatico;
GO

ALTER TABLE Reserva DROP COLUMN inicio_automatico, fim_automatico;
GO

ALTER TABLE Plataforma DROP CONSTRAINT DF_Plataforma_inicio_auto_padrao, DF_Plataforma_fim_auto_padrao;
GO

ALTER TABLE Plataforma DROP COLUMN inicio_automatico_padrao, fim_automatico_padrao;
GO

ALTER TABLE ChecklistResposta DROP COLUMN item_descricao, item_ordem, item_obrigatorio, item_bloqueia_aprovacao;
GO

UPDATE ChecklistItemTemplate
SET categoria_plataforma = (
    SELECT TOP 1 t.categoria_plataforma FROM ChecklistTemplate t WHERE t.id = ChecklistItemTemplate.template_id
)
WHERE categoria_plataforma IS NULL;
GO

ALTER TABLE ChecklistItemTemplate ALTER COLUMN categoria_plataforma VARCHAR(20) NOT NULL;
GO

CREATE INDEX IX_ChecklistItemTemplate_categoria ON ChecklistItemTemplate(categoria_plataforma, ativo);
GO

ALTER TABLE ChecklistItemTemplate DROP CONSTRAINT DF_ChecklistItemTemplate_bloqueia;
GO

ALTER TABLE ChecklistItemTemplate DROP COLUMN bloqueia_aprovacao;
GO

ALTER TABLE ChecklistTemplate DROP COLUMN descricao;
GO

ALTER TABLE Plataforma DROP CONSTRAINT DF_Plataforma_exige_checklist;
GO

ALTER TABLE Plataforma DROP COLUMN exige_checklist;
GO
