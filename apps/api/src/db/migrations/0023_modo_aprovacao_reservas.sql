-- Migration 0023_modo_aprovacao_reservas
-- PlataformaRes
--
-- Política de aprovação de reservas, configurável pelo Admin em Configurações:
--   'manual'     — reserva de Colaborador nasce pendente e espera Admin/Gestor (padrão, é o
--                  comportamento em vigor desde a migration 0022);
--   'automatica' — reserva válida de Colaborador nasce agendada.
-- Em qualquer modo, reserva URGENTE que conflita com reserva existente nasce pendente e
-- exige decisão manual (a substituição nunca é automática) — regra aplicada em POST /reservas.
--
-- Mesma tabela/infra das demais configurações (ConfiguracaoSistema + PUT /configuracoes).
-- A linha precisa existir porque salvarConfiguracoes() faz UPDATE por chave.

-- ==UP==

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'modo_aprovacao_reservas')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao)
    VALUES ('modo_aprovacao_reservas', 'manual',
            'Aprovação de reservas de colaboradores: manual (pendente até Gestor/Admin decidir) ou automatica (reserva válida já nasce agendada).')
GO

-- ==DOWN==

DELETE FROM ConfiguracaoSistema WHERE chave = 'modo_aprovacao_reservas'
GO
