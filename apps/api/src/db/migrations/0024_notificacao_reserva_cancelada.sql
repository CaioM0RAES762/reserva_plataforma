-- Migration 0024_notificacao_reserva_cancelada
-- PlataformaRes
--
-- Novo tipo de notificação: o responsável é avisado (sino + e-mail) quando OUTRA pessoa
-- cancela a reserva dele. Só amplia o CHECK — nenhum dado existente muda.

-- ==UP==

ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada', 'reserva_substituida', 'reserva_cancelada',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO

-- ==DOWN==

ALTER TABLE Notificacao DROP CONSTRAINT CK_Notificacao_tipo;
GO

DELETE FROM Notificacao WHERE tipo = 'reserva_cancelada';
GO

ALTER TABLE Notificacao ADD CONSTRAINT CK_Notificacao_tipo CHECK (tipo IN (
    'reserva_pendente', 'reserva_aprovada', 'reserva_rejeitada', 'reserva_substituida',
    'checklist_pendente', 'ocorrencia_reportada', 'bloqueio_criado', 'comentario_novo'
));
GO
