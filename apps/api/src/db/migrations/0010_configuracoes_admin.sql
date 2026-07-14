-- Migration 0010_configuracoes_admin
-- PlataformaRes | Sprint S12
-- Insere as chaves de ConfiguracaoSistema (tabela criada em 0005/S7) usadas pelas novas
-- regras configuraveis de reserva (RF-CFG-01/02, RN-RES-03/05/06) e pela tela
-- "Configuracoes do Sistema". Valores padrao conforme SDD Sec 17.10.

-- ==UP==

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('antecedencia_minima_horas', '2', 'Antecedencia minima, em horas, para solicitar uma nova reserva (RN-RES-03/RF-CFG-01).');

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('duracao_maxima_horas', '12', 'Duracao maxima permitida, em horas, para uma unica reserva (RN-RES-03/RF-CFG-01).');

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('max_pendentes_por_setor', '5', 'Numero maximo de reservas simultaneamente pendentes por setor (RN-RES-05/RF-CFG-01).');

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('horario_expediente_inicio', '06:00', 'Horario (HH:mm) de inicio do expediente para bloqueio de reservas fora do horario, exceto prioridade urgente (RN-RES-06/RF-CFG-02).');

INSERT INTO ConfiguracaoSistema (chave, valor, descricao) VALUES
    ('horario_expediente_fim', '22:00', 'Horario (HH:mm) de fim do expediente para bloqueio de reservas fora do horario, exceto prioridade urgente (RN-RES-06/RF-CFG-02).');

-- ==DOWN==

DELETE FROM ConfiguracaoSistema WHERE chave IN (
    'antecedencia_minima_horas',
    'duracao_maxima_horas',
    'max_pendentes_por_setor',
    'horario_expediente_inicio',
    'horario_expediente_fim'
);
