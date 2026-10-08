-- Migration 0031_notificacao_reserva_criada
-- PlataformaRes
--
-- Novo tipo de notificação: confirmação ao SOLICITANTE quando a reserva é criada (agendada)
-- ou registrada como solicitação (pendente). Até aqui só os aprovadores eram avisados na
-- criação, e o solicitante nunca recebia comprovante por e-mail. Só amplia o CHECK.

-- ==UP==

ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_criada', 'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada', 'reserva_substituida', 'reserva_cancelada',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO

-- ==DOWN==

ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

DELETE FROM Notificacao WHERE tipo = 'reserva_criada';
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada', 'reserva_substituida', 'reserva_cancelada',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO
