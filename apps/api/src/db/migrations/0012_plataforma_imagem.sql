-- Migration 0012_plataforma_imagem
-- PlataformaRes | Frota em cards
-- Plataforma.imagem_url guarda a CHAVE do blob (não URL pública), mesmo padrão de
-- Anexo.url_blob (migration 0009) — leitura sempre via SAS gerado em tempo de leitura
-- (armazenamentoService.gerarUrlAcesso), nunca uma URL persistida. Nullable: plataforma
-- sem imagem cadastrada continua válida (card exibe placeholder).

-- ==UP==

ALTER TABLE Plataforma ADD imagem_url NVARCHAR(500) NULL;

-- ==DOWN==

ALTER TABLE Plataforma DROP COLUMN imagem_url;
