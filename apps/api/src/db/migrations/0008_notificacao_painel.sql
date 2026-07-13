-- Migration 0008_notificacao_painel
-- PlataformaRes | Sprint S10
-- Notificacao (SDD §4.3): persistência das notificações in-app consumidas pelo sino do
-- topbar (RF-NOT-01/02) e publicadas em tempo real via SSE (evento notificacao.nova).
-- PainelToken: mecanismo de autenticação de dispositivo para o Painel TV (RF-TV-01/03),
-- decidido como tabela dedicada (não reaproveitando Usuario) — ver ADR no relatório S10:
-- um token de dispositivo não é uma identidade de pessoa (sem perfil/setor obrigatório,
-- sem senha, escopo de leitura por setor opcional), então forçar isso em Usuario exigiria
-- relaxar CHECKs pensados para contas humanas (ex.: domínio de e-mail, perfil).

-- ==UP==

CREATE TABLE Notificacao (
    id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    usuario_id  UNIQUEIDENTIFIER NOT NULL,
    tipo        VARCHAR(30)   NOT NULL,
    titulo      NVARCHAR(160) NOT NULL,
    mensagem    NVARCHAR(500) NOT NULL,
    link        NVARCHAR(200) NULL,
    lida        BIT           NOT NULL DEFAULT 0,
    criado_em   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Notificacao_Usuario FOREIGN KEY (usuario_id) REFERENCES Usuario(id),
    CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
        'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada',
        'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
    ))
);

CREATE INDEX IX_Notificacao_usuario_id_lida ON Notificacao(usuario_id, lida);

-- token_hash guarda SHA-256(token) — o token em texto puro só é exibido ao Admin uma vez,
-- no momento da criação (mesmo padrão de segredo de API key), nunca persistido em claro.
-- setor_id nullable = mesmo padrão de BloqueioAgenda.plataforma_id (S9): NULL = todos os
-- setores visíveis no painel; um valor = escopo restrito a um único setor/galpão.
CREATE TABLE PainelToken (
    id            UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID() PRIMARY KEY,
    nome          NVARCHAR(80)  NOT NULL,
    token_hash    CHAR(64)      NOT NULL,
    setor_id      UNIQUEIDENTIFIER NULL,
    ativo         BIT           NOT NULL DEFAULT 1,
    criado_por_id UNIQUEIDENTIFIER NOT NULL,
    criado_em     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    ultimo_uso_em DATETIME2     NULL,
    CONSTRAINT UQ_PainelToken_token_hash UNIQUE (token_hash),
    CONSTRAINT FK_PainelToken_Setor FOREIGN KEY (setor_id) REFERENCES Setor(id),
    CONSTRAINT FK_PainelToken_Usuario FOREIGN KEY (criado_por_id) REFERENCES Usuario(id)
);

CREATE INDEX IX_PainelToken_ativo ON PainelToken(ativo);

-- ==DOWN==

DROP TABLE IF EXISTS PainelToken;
DROP TABLE IF EXISTS Notificacao;
