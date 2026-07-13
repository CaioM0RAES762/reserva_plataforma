-- Migration 0009_anexo_comentario_ocorrencia
-- PlataformaRes | Sprint S11
-- Anexo (SDD §4.3/RF-RES-14): evidências (foto, PDF, ART) por reserva, binário em Azure
-- Blob Storage — só a referência (url_blob = chave do blob, não URL pública; SAS gerado
-- em tempo de leitura, RNF-09) fica no relacional.
-- Comentario (RF-RES-15): thread cronológica por reserva.
-- Ocorrencia (RF-RES-16/RN-PLAT-04): avaria reportada ao concluir o uso; gera_manutencao=1
-- dispara a mudança automática de Plataforma.status para 'manutencao' (feita em transação
-- pela rota, não por trigger — mesmo padrão de todas as demais mudanças de status do sistema).

-- ==UP==

CREATE TABLE Anexo (
    id              UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    reserva_id      UNIQUEIDENTIFIER NOT NULL,
    nome_arquivo    NVARCHAR(200) NOT NULL,
    url_blob        NVARCHAR(500) NOT NULL,
    tipo_mime       VARCHAR(100)  NOT NULL,
    tamanho_bytes   INT           NOT NULL,
    enviado_por_id  UNIQUEIDENTIFIER NOT NULL,
    criado_em       DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Anexo_Reserva FOREIGN KEY (reserva_id) REFERENCES Reserva(id),
    CONSTRAINT FK_Anexo_Usuario FOREIGN KEY (enviado_por_id) REFERENCES Usuario(id),
    CONSTRAINT CK_Anexo_tamanho CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 10485760)
);

CREATE INDEX IX_Anexo_reserva_id ON Anexo(reserva_id);

CREATE TABLE Comentario (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    reserva_id  UNIQUEIDENTIFIER NOT NULL,
    usuario_id  UNIQUEIDENTIFIER NOT NULL,
    mensagem    NVARCHAR(1000) NOT NULL,
    criado_em   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Comentario_Reserva FOREIGN KEY (reserva_id) REFERENCES Reserva(id),
    CONSTRAINT FK_Comentario_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuario(id)
);

CREATE INDEX IX_Comentario_reserva_id ON Comentario(reserva_id, criado_em);

CREATE TABLE Ocorrencia (
    id                UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    reserva_id        UNIQUEIDENTIFIER NOT NULL,
    plataforma_id     UNIQUEIDENTIFIER NOT NULL,
    reportado_por_id  UNIQUEIDENTIFIER NOT NULL,
    descricao         NVARCHAR(1000) NOT NULL,
    gravidade         VARCHAR(10)   NOT NULL,
    gera_manutencao   BIT           NOT NULL DEFAULT 0,
    criado_em         DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Ocorrencia_Reserva FOREIGN KEY (reserva_id) REFERENCES Reserva(id),
    CONSTRAINT FK_Ocorrencia_Plataforma FOREIGN KEY (plataforma_id) REFERENCES Plataforma(id),
    CONSTRAINT FK_Ocorrencia_Usuario FOREIGN KEY (reportado_por_id) REFERENCES Usuario(id),
    CONSTRAINT CK_Ocorrencia_gravidade CHECK (gravidade IN ('baixa', 'media', 'alta'))
);

CREATE INDEX IX_Ocorrencia_plataforma_id ON Ocorrencia(plataforma_id);
CREATE INDEX IX_Ocorrencia_reserva_id ON Ocorrencia(reserva_id);

-- ==DOWN==

DROP TABLE IF EXISTS Ocorrencia;
DROP TABLE IF EXISTS Comentario;
DROP TABLE IF EXISTS Anexo;
