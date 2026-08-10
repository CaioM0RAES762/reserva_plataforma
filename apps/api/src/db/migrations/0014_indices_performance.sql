-- Migration 0014_indices_performance
-- PlataformaRes | Refinamento geral (pós-S14)
--
-- Índices para os caminhos quentes que sobraram sem cobertura. Cada um abaixo foi
-- escolhido a partir de uma consulta específica que hoje varre mais linhas do que
-- precisa — não são índices "por precaução".
--
-- 1) IX_Reserva_plataforma_data_status
--    Cobre a checagem de conflito de RN-RES-02 (buscarReservasConflitantes), executada
--    em TODA criação de reserva, a cada ocorrência de uma série recorrente (até 12) e a
--    cada digitação no formulário via GET /reservas/conflitos. IX_Reserva_plataforma_data
--    (0001) lidera por (plataforma_id, data) mas não inclui `status`, então o filtro
--    IN ('pendente','agendada','em_uso') exigia lookup na tabela para cada linha. Com
--    status na chave e os horários como colunas incluídas, a consulta é resolvida só
--    pelo índice. É também o índice sobre o qual o lock de intervalo (UPDLOCK/HOLDLOCK)
--    da criação atômica é tomado — quanto mais estreito o índice, menor o bloqueio.
--
-- 2) IX_Notificacao_usuario_naolida (filtrado)
--    O sino do topbar consulta as notificações do usuário logado a cada carregamento de
--    página e a cada reconexão SSE. O índice de 0008 é (usuario_id, lida); um índice
--    FILTRADO em lida = 0 é uma fração do tamanho e atende o contador de não lidas, que
--    é o dado exibido com mais frequência em todo o sistema.
--
-- 3) IX_LogAuditoria_criado_em
--    /auditoria ordena sempre por criado_em DESC e filtra por período. Sem índice, toda
--    consulta da tela de Auditoria faz varredura completa + sort de LogAuditoria, a
--    tabela que mais cresce no sistema (uma linha por operação sensível desde S1).
--
-- 4) IX_BloqueioAgenda_periodo
--    RN-RES-11 é checada junto com o conflito em toda criação de reserva.
--
-- 5) IX_Ocorrencia_plataforma_criado
--    OUTER APPLY do card da frota (sqlEventoAtivoPlataforma) busca a ocorrência mais
--    recente por plataforma — uma vez por linha da listagem de plataformas.

-- ==UP==

CREATE INDEX IX_Reserva_plataforma_data_status
  ON Reserva(plataforma_id, data, status)
  INCLUDE (hora_inicio, hora_fim, setor_id);
GO

CREATE INDEX IX_Notificacao_usuario_naolida
  ON Notificacao(usuario_id, criado_em DESC)
  WHERE lida = 0;
GO

CREATE INDEX IX_LogAuditoria_criado_em ON LogAuditoria(criado_em DESC);
GO

CREATE INDEX IX_BloqueioAgenda_periodo ON BloqueioAgenda(data_inicio, data_fim) INCLUDE (plataforma_id);
GO

CREATE INDEX IX_Ocorrencia_plataforma_criado ON Ocorrencia(plataforma_id, criado_em DESC);
GO

-- ==DOWN==

DROP INDEX IX_Ocorrencia_plataforma_criado ON Ocorrencia;
GO
DROP INDEX IX_BloqueioAgenda_periodo ON BloqueioAgenda;
GO
DROP INDEX IX_LogAuditoria_criado_em ON LogAuditoria;
GO
DROP INDEX IX_Notificacao_usuario_naolida ON Notificacao;
GO
DROP INDEX IX_Reserva_plataforma_data_status ON Reserva;
GO
