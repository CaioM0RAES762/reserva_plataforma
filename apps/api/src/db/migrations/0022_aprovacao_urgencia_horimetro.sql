-- Migration 0022_aprovacao_urgencia_horimetro
-- PlataformaRes
--
-- Três mudanças de domínio, todas ADITIVAS (nenhum dado existente é reescrito):
--
--   1. Retorno da aprovação. 'pendente' e 'rejeitada' nunca saíram do CHECK de status
--      (migration 0018 os manteve como legado), e aprovado_por_id / motivo_rejeicao também
--      continuam na tabela — por isso o fluxo volta sem nenhuma alteração de status aqui.
--
--   2. Substituição por urgência. A reserva substituída NÃO ganha status novo: ela é
--      'cancelada' (estado terminal já existente) com o vínculo para a reserva urgente que a
--      substituiu e o motivo gravado. A relação inversa ("quem esta urgente substituiu?") é
--      uma consulta por substituida_por_id — rastreável nos dois sentidos sem duplicar dado.
--
--   3. Horímetro automático. Plataforma.horimetro_horas (valor cadastrado manualmente)
--      permanece intocado como BASELINE. O uso contabilizado pelo sistema acumula em
--      horimetro_uso_minutos; o horímetro atual exibido é baseline + uso. Na reserva,
--      uso_contabilizado_minutos é ao mesmo tempo o valor contabilizado e a trava de
--      idempotência: só é preenchido uma vez (UPDATE ... WHERE uso_contabilizado_minutos IS
--      NULL), então nenhuma reserva incrementa o horímetro duas vezes.
--      Reservas concluídas ANTES desta migration ficam com NULL e nunca são contabilizadas —
--      já estão refletidas no valor manual que virou baseline.

-- ==UP==

ALTER TABLE Reserva ADD
    substituida_por_id        UNIQUEIDENTIFIER NULL,
    motivo_cancelamento       NVARCHAR(500)    NULL,
    uso_contabilizado_minutos INT              NULL;
GO

ALTER TABLE Reserva ADD CONSTRAINT FK_Reserva_SubstituidaPor
    FOREIGN KEY (substituida_por_id) REFERENCES Reserva(id);
GO

ALTER TABLE Reserva ADD CONSTRAINT CK_Reserva_uso_contabilizado
    CHECK (uso_contabilizado_minutos IS NULL OR uso_contabilizado_minutos >= 0);
GO

CREATE INDEX IX_Reserva_substituida_por ON Reserva(substituida_por_id)
    WHERE substituida_por_id IS NOT NULL;
GO

ALTER TABLE Plataforma ADD
    horimetro_uso_minutos INT NOT NULL CONSTRAINT DF_Plataforma_horimetro_uso DEFAULT 0;
GO

-- Notificação in-app para o solicitante cuja reserva foi substituída por uma urgente.
ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada', 'reserva_substituida',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO

-- ==DOWN==

ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

DELETE FROM Notificacao WHERE tipo = 'reserva_substituida';
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO

ALTER TABLE Plataforma DROP CONSTRAINT DF_Plataforma_horimetro_uso;
GO

ALTER TABLE Plataforma DROP COLUMN horimetro_uso_minutos;
GO

DROP INDEX IX_Reserva_substituida_por ON Reserva;
GO

ALTER TABLE Reserva DROP CONSTRAINT CK_Reserva_uso_contabilizado;
GO

ALTER TABLE Reserva DROP CONSTRAINT FK_Reserva_SubstituidaPor;
GO

ALTER TABLE Reserva DROP COLUMN substituida_por_id, motivo_cancelamento, uso_contabilizado_minutos;
GO
