-- Migration 0001_init
-- PlataformaRes | Sprint S1
-- Formato: seções delimitadas por marcadores lidos pelo runner em src/db/migrate.ts
-- IDs sempre UNIQUEIDENTIFIER DEFAULT NEWID() (invariante FROZEN, MASTER.md Seção 2)

-- ==UP==

CREATE TABLE Setor (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    nome        NVARCHAR(80)  NOT NULL,
    cor_hex     CHAR(7)       NOT NULL,
    ativo       BIT           NOT NULL DEFAULT 1,
    CONSTRAINT UQ_Setor_nome UNIQUE (nome)
);

CREATE TABLE Usuario (
    id                UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    nome              NVARCHAR(120) NOT NULL,
    email             NVARCHAR(160) NOT NULL,
    senha_hash        VARCHAR(60)   NOT NULL,
    perfil            VARCHAR(20)   NOT NULL,
    setor_id          UNIQUEIDENTIFIER NULL,
    ativo             BIT           NOT NULL DEFAULT 1,
    email_verificado  BIT           NOT NULL DEFAULT 0,
    criado_em         DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    ultimo_login      DATETIME2     NULL,
    CONSTRAINT UQ_Usuario_email UNIQUE (email),
    CONSTRAINT CK_Usuario_email_dominio CHECK (email LIKE '%@metalsider.com.br'),
    -- gestor_setor entra em S7 (MASTER.md Seção 2 / SDD §17.4)
    CONSTRAINT CK_Usuario_perfil CHECK (perfil IN ('admin', 'colaborador')),
    CONSTRAINT FK_Usuario_Setor FOREIGN KEY (setor_id) REFERENCES Setor(id)
);

CREATE INDEX IX_Usuario_setor_id ON Usuario(setor_id);

CREATE TABLE CodigoVerificacao (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    usuario_id  UNIQUEIDENTIFIER NOT NULL,
    codigo      CHAR(6)       NOT NULL,
    tipo        VARCHAR(20)   NOT NULL,
    expira_em   DATETIME2     NOT NULL,
    utilizado   BIT           NOT NULL DEFAULT 0,
    criado_em   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_CodigoVerificacao_tipo CHECK (tipo IN ('ativacao_conta', 'reset_senha')),
    CONSTRAINT FK_CodigoVerificacao_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuario(id)
);

CREATE INDEX IX_CodigoVerificacao_usuario_id ON CodigoVerificacao(usuario_id);

-- usuario_id nulo permitido: ações disparadas pelo sistema (ex.: job de escalonamento
-- de SLA, a partir de S7) não têm um ator humano associado (ADR registrado no relatório S1)
CREATE TABLE LogAuditoria (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    usuario_id  UNIQUEIDENTIFIER NULL,
    acao        VARCHAR(60)   NOT NULL,
    entidade    VARCHAR(60)   NOT NULL,
    entidade_id UNIQUEIDENTIFIER NULL,
    detalhes    NVARCHAR(MAX) NULL,
    criado_em   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_LogAuditoria_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuario(id),
    CONSTRAINT CK_LogAuditoria_detalhes_json CHECK (detalhes IS NULL OR ISJSON(detalhes) = 1)
);

CREATE INDEX IX_LogAuditoria_usuario_id ON LogAuditoria(usuario_id);
CREATE INDEX IX_LogAuditoria_entidade ON LogAuditoria(entidade, entidade_id);

-- Schema-only nesta sprint (SDD §4.2/§6.3) — sem rotas/endpoints até S2
CREATE TABLE Plataforma (
    id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    codigo        VARCHAR(30)   NOT NULL,
    nome          NVARCHAR(120) NOT NULL,
    localizacao   NVARCHAR(160) NULL,
    capacidade    INT           NULL,
    status        VARCHAR(20)   NOT NULL DEFAULT 'disponivel',
    observacoes   NVARCHAR(500) NULL,
    criado_em     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    atualizado_em DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Plataforma_codigo UNIQUE (codigo),
    CONSTRAINT CK_Plataforma_status CHECK (status IN ('disponivel', 'reservada', 'manutencao', 'inativa'))
);

-- Schema-only nesta sprint (SDD §4.2/§6.4) — sem rotas/endpoints até S3
CREATE TABLE Reserva (
    id             UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    setor_id       UNIQUEIDENTIFIER NOT NULL,
    solicitante_id UNIQUEIDENTIFIER NOT NULL,
    plataforma_id  UNIQUEIDENTIFIER NOT NULL,
    data           DATE          NOT NULL,
    hora_inicio    TIME          NOT NULL,
    hora_fim       TIME          NOT NULL,
    motivo         NVARCHAR(300) NOT NULL,
    prioridade     VARCHAR(10)   NOT NULL DEFAULT 'normal',
    status         VARCHAR(20)   NOT NULL DEFAULT 'pendente',
    criado_em      DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    atualizado_em  DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Reserva_prioridade CHECK (prioridade IN ('normal', 'alta', 'urgente')),
    CONSTRAINT CK_Reserva_status CHECK (status IN ('pendente', 'agendada', 'em_uso', 'concluida', 'cancelada', 'rejeitada')),
    CONSTRAINT CK_Reserva_horario CHECK (hora_fim > hora_inicio),
    CONSTRAINT FK_Reserva_Setor FOREIGN KEY (setor_id) REFERENCES Setor(id),
    CONSTRAINT FK_Reserva_Solicitante FOREIGN KEY (solicitante_id) REFERENCES Usuario(id),
    CONSTRAINT FK_Reserva_Plataforma FOREIGN KEY (plataforma_id) REFERENCES Plataforma(id)
);

CREATE INDEX IX_Reserva_plataforma_data ON Reserva(plataforma_id, data);
CREATE INDEX IX_Reserva_setor_id ON Reserva(setor_id);

-- ==DOWN==

DROP TABLE IF EXISTS Reserva;
DROP TABLE IF EXISTS Plataforma;
DROP TABLE IF EXISTS LogAuditoria;
DROP TABLE IF EXISTS CodigoVerificacao;
DROP TABLE IF EXISTS Usuario;
DROP TABLE IF EXISTS Setor;
