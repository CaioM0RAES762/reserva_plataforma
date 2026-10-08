-- Migration 0027_reparar_configuracao_sistema
-- PlataformaRes
--
-- Repõe as chaves de ConfiguracaoSistema semeadas em 0005/0010/0023 quando estão ausentes.
-- Um banco recriado/baselinado sem esses seeds ficava com a tabela vazia: a tela de
-- Configurações aparecia em branco e o PUT não gravava nada (fazia só UPDATE por chave).
-- Idempotente: só insere a chave que não existe, nunca sobrescreve valor já configurado.

-- ==UP==

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'sla_aprovacao_urgente_horas')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('sla_aprovacao_urgente_horas', '2', 'Horas maximas para decisao de reserva urgente antes do escalonamento automatico ao Admin (RN-RES-09).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'antecedencia_minima_horas')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('antecedencia_minima_horas', '2', 'Antecedencia minima, em horas, para solicitar uma nova reserva (RN-RES-03/RF-CFG-01).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'duracao_maxima_horas')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('duracao_maxima_horas', '12', 'Duracao maxima permitida, em horas, para uma unica reserva (RN-RES-03/RF-CFG-01).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'max_pendentes_por_setor')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('max_pendentes_por_setor', '5', 'Numero maximo de reservas simultaneamente pendentes por setor (RN-RES-05/RF-CFG-01).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'horario_expediente_inicio')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('horario_expediente_inicio', '06:00', 'Horario (HH:mm) de inicio do expediente para bloqueio de reservas fora do horario, exceto prioridade urgente (RN-RES-06/RF-CFG-02).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'horario_expediente_fim')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('horario_expediente_fim', '22:00', 'Horario (HH:mm) de fim do expediente para bloqueio de reservas fora do horario, exceto prioridade urgente (RN-RES-06/RF-CFG-02).');

IF NOT EXISTS (SELECT 1 FROM ConfiguracaoSistema WHERE chave = 'modo_aprovacao_reservas')
    INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
        ('modo_aprovacao_reservas', 'manual',
         'Aprovação de reservas de colaboradores: manual (pendente até Gestor/Admin decidir) ou automatica (reserva válida já nasce agendada).');
GO

-- ==DOWN==

-- Sem reversão: as linhas repostas podem já ter sido editadas pelo Admin, e removê-las
-- recriaria exatamente o defeito que esta migration corrige.
SELECT 1;
GO
