-- Migration 0025_categorias_marca_imagens_plataforma
-- PlataformaRes
--
-- (1) Categorias de equipamento passam a ser DADOS administráveis pelo Admin
--     (CategoriaEquipamento), no lugar do CHECK fixo em Plataforma.categoria. As seis
--     categorias de hoje são semeadas com o MESMO código ('elevatoria', 'andaime'...), então
--     nenhuma plataforma muda e tudo que lê o código (risco padrão, normas NR, templates de
--     checklist, relatórios) continua funcionando. Categoria não é excluída: é desativada.
-- (2) Plataforma.marca — texto livre, opcional (Dingli, JLG, Genie...).
-- (3) PlataformaImagem — de 0 a 4 imagens por plataforma. A imagem atual (imagem_url)
--     vira a primeira e principal; nenhuma reimportação necessária. A partir daqui a fonte
--     única é PlataformaImagem: a API deriva `imagemUrl` da principal e deixa de ler/gravar
--     Plataforma.imagem_url, que fica só como cópia congelada para o DOWN (não é apagada).
--     Limite de 4 garantido pelo banco: UNIQUE (plataforma_id, ordem) + CHECK ordem 0..3.
--     A principal é sempre a ordem 0 (a API mantém) e é única por plataforma (índice filtrado).

-- ==UP==

CREATE TABLE CategoriaEquipamento (
    id             UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_CategoriaEquipamento PRIMARY KEY DEFAULT NEWID(),
    codigo         VARCHAR(20)      NOT NULL,
    nome           NVARCHAR(60)     NOT NULL,
    ativo          BIT              NOT NULL CONSTRAINT DF_CategoriaEquipamento_ativo DEFAULT 1,
    ordem          INT              NOT NULL CONSTRAINT DF_CategoriaEquipamento_ordem DEFAULT 100,
    criado_em      DATETIME2        NOT NULL CONSTRAINT DF_CategoriaEquipamento_criado DEFAULT SYSUTCDATETIME(),
    atualizado_em  DATETIME2        NOT NULL CONSTRAINT DF_CategoriaEquipamento_atualizado DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CategoriaEquipamento_codigo UNIQUE (codigo),
    CONSTRAINT UQ_CategoriaEquipamento_nome UNIQUE (nome)
);
GO

INSERT INTO CategoriaEquipamento (codigo, nome, ordem) VALUES
    ('elevatoria', N'Plataforma elevatória', 1),
    ('andaime', N'Andaime', 2),
    ('veiculo', N'Veículo', 3),
    ('sala', N'Sala / espaço compartilhado', 4),
    ('patio', N'Pátio', 5),
    ('outro', N'Outro', 6);
GO

ALTER TABLE Plataforma DROP CONSTRAINT CK_Plataforma_categoria;
GO

ALTER TABLE Plataforma ADD CONSTRAINT FK_Plataforma_categoria
    FOREIGN KEY (categoria) REFERENCES CategoriaEquipamento(codigo);
GO

ALTER TABLE Plataforma ADD marca NVARCHAR(60) NULL;
GO

CREATE TABLE PlataformaImagem (
    id             UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_PlataformaImagem PRIMARY KEY DEFAULT NEWID(),
    plataforma_id  UNIQUEIDENTIFIER NOT NULL,
    -- Chave do blob (nunca URL pública) — leitura sempre por SAS gerado sob demanda.
    blob_path      NVARCHAR(500)    NOT NULL,
    ordem          INT              NOT NULL,
    principal      BIT              NOT NULL CONSTRAINT DF_PlataformaImagem_principal DEFAULT 0,
    criado_em      DATETIME2        NOT NULL CONSTRAINT DF_PlataformaImagem_criado DEFAULT SYSUTCDATETIME(),
    criado_por_id  UNIQUEIDENTIFIER NULL,
    CONSTRAINT FK_PlataformaImagem_plataforma FOREIGN KEY (plataforma_id) REFERENCES Plataforma(id) ON DELETE CASCADE,
    CONSTRAINT FK_PlataformaImagem_criado_por FOREIGN KEY (criado_por_id) REFERENCES Usuario(id),
    CONSTRAINT CK_PlataformaImagem_ordem CHECK (ordem BETWEEN 0 AND 3),
    CONSTRAINT UQ_PlataformaImagem_ordem UNIQUE (plataforma_id, ordem)
);
GO

CREATE UNIQUE INDEX UX_PlataformaImagem_principal ON PlataformaImagem(plataforma_id) WHERE principal = 1;
GO

-- Imagem única de hoje → primeira e principal. Nada é reenviado nem apagado.
INSERT INTO PlataformaImagem (plataforma_id, blob_path, ordem, principal, criado_em)
SELECT id, imagem_url, 0, 1, atualizado_em FROM Plataforma WHERE imagem_url IS NOT NULL AND imagem_url <> '';
GO

-- ==DOWN==

-- Volta a imagem principal para a coluna antiga antes de descartar a galeria.
UPDATE p SET imagem_url = i.blob_path
FROM Plataforma p JOIN PlataformaImagem i ON i.plataforma_id = p.id AND i.principal = 1;
GO

DROP TABLE PlataformaImagem;
GO

ALTER TABLE Plataforma DROP COLUMN marca;
GO

ALTER TABLE Plataforma DROP CONSTRAINT FK_Plataforma_categoria;
GO

-- Categorias criadas depois da 0025 não existem no CHECK antigo: voltam para 'outro'.
UPDATE Plataforma SET categoria = 'outro'
WHERE categoria NOT IN ('elevatoria', 'andaime', 'sala', 'patio', 'veiculo', 'outro');
GO

ALTER TABLE Plataforma ADD CONSTRAINT CK_Plataforma_categoria
    CHECK (categoria IN ('elevatoria', 'andaime', 'sala', 'patio', 'veiculo', 'outro'));
GO

DROP TABLE CategoriaEquipamento;
GO
