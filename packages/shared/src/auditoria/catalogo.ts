/* Catálogo de eventos de auditoria — a camada de apresentação entre o log bruto e a UI.
 *
 * O LogAuditoria grava códigos técnicos (`criar_reserva`, `alterar_status_plataforma`)
 * e payloads em camelCase (`statusAnterior`, `todosConformes`). Isso está certo e não
 * muda: é o registro histórico, e renomear qualquer chave quebraria a leitura de tudo
 * que já foi gravado. O que muda é que nada disso chega aos olhos de quem administra o
 * sistema.
 *
 * Este arquivo vive em `shared` — e não no frontend — porque a exportação CSV é gerada
 * pela API. Com o catálogo aqui, tela e planilha usam exatamente os mesmos nomes: o que
 * o Admin lê como "Reserva aprovada" não vira "Aprovar Reserva" no arquivo baixado.
 */

/** Tom = o quanto o evento pede atenção. Alimenta a cor do indicador na listagem. */
export type TomAuditoria = "neutro" | "sucesso" | "atencao" | "critico";

/**
 * Relevância separa "o que aconteceu de importante" de "o sistema registrou atividade".
 * Rascunhos de checklist são gravados a cada salvamento e podem sozinhos dominar a
 * listagem — continuam auditados, mas não competem visualmente com uma aprovação.
 */
export type RelevanciaAuditoria = "informativa" | "normal" | "importante";

export const CATEGORIAS_AUDITORIA = [
  "Reservas",
  "Frota",
  "Usuários",
  "Segurança",
  "Configurações",
  "Sistema",
] as const;
export type CategoriaAuditoria = (typeof CATEGORIAS_AUDITORIA)[number];

/**
 * Ícone é referenciado por nome, não importado: `shared` não depende de lucide-react (é
 * consumido também pela API, que não tem React). O frontend faz o de-para nome → componente.
 */
export type IconeAuditoria =
  | "CalendarClock"
  | "Construction"
  | "UserRound"
  | "ClipboardCheck"
  | "TriangleAlert"
  | "Settings"
  | "Ban"
  | "Paperclip"
  | "MessageSquare"
  | "Building2"
  | "ShieldCheck"
  | "Activity"
  | "Pencil"
  | "Trash2"
  | "CircleCheck";

export interface AuditoriaEventoMeta {
  /** Frase pronta para leitura humana, no passado — é o que a coluna EVENTO mostra. */
  titulo: string;
  categoria: CategoriaAuditoria;
  tom: TomAuditoria;
  relevancia: RelevanciaAuditoria;
  icone: IconeAuditoria;
  /** Contexto de uma linha no detalhe expandido, quando o título não se explica sozinho. */
  descricao?: string;
}

/**
 * Fonte única de nomenclatura. Cada chave é um código realmente gravado hoje pelo
 * backend — levantado por varredura de todos os `INSERT INTO LogAuditoria` do projeto,
 * não a partir de exemplos.
 *
 * O tom não é decorativo: verde só onde algo foi liberado/aprovado, vermelho onde algo
 * foi negado/desativado, âmbar onde alguém precisa reagir. O grosso do catálogo é
 * neutro de propósito — se tudo tem cor, nada tem.
 */
export const EVENTOS_AUDITORIA: Record<string, AuditoriaEventoMeta> = {
  // ---------------------------------------------------------------- Reservas
  criar_reserva: {
    titulo: "Reserva criada",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "normal",
    icone: "CalendarClock",
  },
  /* Fluxo de aprovação (retomado na migration 0022): Colaborador solicita, Admin/Gestor
     decide. Registros antigos destes mesmos códigos continuam legíveis. */
  aprovar_reserva: {
    titulo: "Reserva aprovada",
    categoria: "Reservas",
    tom: "sucesso",
    relevancia: "importante",
    icone: "CalendarClock",
    descricao: "Solicitação pendente aprovada por Admin ou Gestor — a disponibilidade foi revalidada no momento da aprovação.",
  },
  rejeitar_reserva: {
    titulo: "Reserva rejeitada",
    categoria: "Reservas",
    tom: "critico",
    relevancia: "importante",
    icone: "CalendarClock",
  },
  substituir_reserva: {
    titulo: "Reserva substituída por urgência",
    categoria: "Reservas",
    tom: "critico",
    relevancia: "importante",
    icone: "CalendarClock",
    descricao: "Reserva cancelada para liberar o horário a uma reserva urgente, com confirmação explícita do aprovador.",
  },
  cancelar_reserva: {
    titulo: "Reserva cancelada",
    categoria: "Reservas",
    tom: "atencao",
    relevancia: "normal",
    icone: "CalendarClock",
  },
  cancelar_serie_reserva: {
    titulo: "Série de reservas cancelada",
    categoria: "Reservas",
    tom: "atencao",
    relevancia: "importante",
    icone: "CalendarClock",
    descricao: "Cancelamento em bloco das ocorrências futuras de uma reserva recorrente.",
  },
  /* Início e conclusão são, no fluxo novo, quase sempre automáticos por horário. O
     catálogo distingue os dois casos porque a pergunta "isso foi o sistema ou alguém?" é
     exatamente o tipo de coisa que se investiga numa auditoria — e a coluna Responsável
     sozinha ("Sistema") não diz se houve intervenção manual em seguida. */
  iniciar_uso_reserva: {
    titulo: "Uso da reserva iniciado",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "normal",
    icone: "CalendarClock",
  },
  concluir_reserva: {
    titulo: "Reserva concluída",
    categoria: "Reservas",
    tom: "sucesso",
    relevancia: "normal",
    icone: "CalendarClock",
  },
  iniciar_uso_reserva_automatico: {
    titulo: "Reserva iniciada automaticamente",
    categoria: "Sistema",
    tom: "neutro",
    relevancia: "informativa",
    icone: "CalendarClock",
    descricao: "O horário de início foi atingido e o sistema colocou a reserva em uso.",
  },
  concluir_reserva_automatico: {
    titulo: "Reserva concluída automaticamente",
    categoria: "Sistema",
    tom: "neutro",
    relevancia: "informativa",
    icone: "CalendarClock",
    descricao: "O horário final foi atingido e o sistema encerrou a reserva.",
  },
  migrar_reserva_fluxo_direto: {
    titulo: "Reserva migrada para o fluxo direto",
    categoria: "Sistema",
    tom: "neutro",
    relevancia: "normal",
    icone: "Activity",
    descricao: "Reserva que aguardava aprovação foi convertida em agendada ao fim do fluxo de aprovação.",
  },
  escalonar_sla_urgente: {
    titulo: "Reserva urgente escalonada",
    categoria: "Sistema",
    tom: "atencao",
    relevancia: "importante",
    icone: "TriangleAlert",
    descricao:
      "Legado: reserva urgente ficou sem decisão além do prazo. O escalonamento existia " +
      "para o fluxo de aprovação e foi descontinuado.",
  },

  /* ------------------------------------------------- Segurança
     Os eventos de checklist são LEGADO a partir da migration 0018: o checklist deixou de
     fazer parte do fluxo de reserva. Nenhum novo é gravado, mas as execuções NR-18/35 já
     realizadas continuam no histórico e precisam continuar legíveis. */
  finalizar_checklist: {
    titulo: "Checklist finalizado",
    categoria: "Segurança",
    tom: "sucesso",
    relevancia: "importante",
    icone: "ClipboardCheck",
  },
  salvar_rascunho_checklist: {
    titulo: "Rascunho do checklist salvo",
    categoria: "Segurança",
    tom: "neutro",
    // Gravado a cada salvamento parcial: alto volume, baixa consequência.
    relevancia: "informativa",
    icone: "ClipboardCheck",
  },
  criar_checklist_template: {
    titulo: "Modelo de checklist criado",
    categoria: "Segurança",
    tom: "neutro",
    relevancia: "normal",
    icone: "ClipboardCheck",
  },
  editar_checklist_template: {
    titulo: "Modelo de checklist atualizado",
    categoria: "Segurança",
    tom: "neutro",
    relevancia: "normal",
    icone: "ClipboardCheck",
  },
  criar_checklist_item_template: {
    titulo: "Item adicionado ao modelo de checklist",
    categoria: "Segurança",
    tom: "neutro",
    relevancia: "informativa",
    icone: "ClipboardCheck",
  },
  remover_checklist_item_template: {
    titulo: "Item removido do modelo de checklist",
    categoria: "Segurança",
    tom: "atencao",
    relevancia: "normal",
    icone: "ClipboardCheck",
  },
  reportar_ocorrencia: {
    titulo: "Ocorrência registrada",
    categoria: "Segurança",
    tom: "atencao",
    relevancia: "importante",
    icone: "TriangleAlert",
  },

  // ---------------------------------------------------------------- Frota
  criar_plataforma: {
    titulo: "Plataforma cadastrada",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "normal",
    icone: "Construction",
  },
  alterar_modo_aprovacao: {
    titulo: "Modo de aprovação de reservas alterado",
    categoria: "Configurações",
    tom: "atencao",
    relevancia: "importante",
    icone: "Settings",
    descricao: "Política de aprovação das reservas de colaboradores (manual ou automática).",
  },
  corrigir_horimetro: {
    titulo: "Horímetro corrigido manualmente",
    categoria: "Frota",
    tom: "atencao",
    relevancia: "importante",
    icone: "Pencil",
    descricao: "O Admin redefiniu o horímetro; o uso contabilizado até então foi incorporado ao novo valor.",
  },
  editar_plataforma: {
    titulo: "Dados da plataforma atualizados",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "normal",
    icone: "Construction",
  },
  alterar_status_plataforma: {
    titulo: "Status da plataforma alterado",
    categoria: "Frota",
    tom: "atencao",
    relevancia: "importante",
    icone: "Construction",
  },
  criar_bloqueio: {
    titulo: "Bloqueio de agenda criado",
    categoria: "Frota",
    tom: "atencao",
    relevancia: "importante",
    icone: "Ban",
  },
  remover_bloqueio: {
    titulo: "Bloqueio de agenda removido",
    categoria: "Frota",
    tom: "sucesso",
    relevancia: "normal",
    icone: "Ban",
  },

  // ---------------------------------------------------------------- Usuários
  criar_usuario: {
    titulo: "Usuário cadastrado",
    categoria: "Usuários",
    tom: "neutro",
    relevancia: "importante",
    icone: "UserRound",
  },
  editar_usuario: {
    titulo: "Dados do usuário atualizados",
    categoria: "Usuários",
    tom: "neutro",
    relevancia: "normal",
    icone: "UserRound",
  },
  alterar_status_usuario: {
    titulo: "Status do usuário alterado",
    categoria: "Usuários",
    tom: "atencao",
    relevancia: "importante",
    icone: "UserRound",
  },
  alterar_perfil_usuario: {
    titulo: "Perfil de acesso alterado",
    categoria: "Usuários",
    tom: "atencao",
    relevancia: "importante",
    icone: "ShieldCheck",
    descricao: "Mudança no nível de permissão do usuário dentro do sistema.",
  },
  reenviar_codigo_usuario: {
    titulo: "Código de ativação reenviado",
    categoria: "Usuários",
    tom: "neutro",
    relevancia: "informativa",
    icone: "UserRound",
  },
  autocadastro: {
    titulo: "Conta criada pelo próprio usuário",
    categoria: "Usuários",
    tom: "neutro",
    relevancia: "importante",
    icone: "UserRound",
  },
  ativar_conta: {
    titulo: "Conta ativada",
    categoria: "Usuários",
    tom: "sucesso",
    relevancia: "normal",
    icone: "UserRound",
  },
  redefinir_senha: {
    titulo: "Senha redefinida",
    categoria: "Usuários",
    tom: "atencao",
    relevancia: "importante",
    icone: "ShieldCheck",
    descricao: "Redefinição feita pelo fluxo de recuperação por e-mail.",
  },
  trocar_senha: {
    titulo: "Senha alterada",
    categoria: "Usuários",
    tom: "neutro",
    relevancia: "normal",
    icone: "ShieldCheck",
  },

  // ---------------------------------------------------------------- Setores / configurações
  criar_setor: {
    titulo: "Setor criado",
    categoria: "Configurações",
    tom: "neutro",
    relevancia: "normal",
    icone: "Building2",
  },
  editar_setor: {
    titulo: "Setor atualizado",
    categoria: "Configurações",
    tom: "neutro",
    relevancia: "normal",
    icone: "Building2",
  },
  alterar_status_setor: {
    titulo: "Status do setor alterado",
    categoria: "Configurações",
    tom: "atencao",
    relevancia: "importante",
    icone: "Building2",
  },
  atualizar_configuracao: {
    titulo: "Configurações do sistema alteradas",
    categoria: "Configurações",
    tom: "atencao",
    relevancia: "importante",
    icone: "Settings",
    descricao: "Parâmetros aplicados na criação e aprovação de reservas.",
  },

  // ---------------------------------------------------------------- Anexos e comentários
  anexar_arquivo: {
    titulo: "Arquivo anexado",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Paperclip",
  },
  comentar_reserva: {
    titulo: "Comentário adicionado",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "informativa",
    icone: "MessageSquare",
  },
  /* Não conformidade é um comentário classificado, não uma entidade paralela — mas ganha
     evento próprio na auditoria porque a pergunta "o que deu errado nesta operação?" tem
     que ser respondível sem ler toda a timeline. */
  registrar_nao_conformidade: {
    titulo: "Não conformidade registrada",
    categoria: "Segurança",
    tom: "critico",
    relevancia: "importante",
    icone: "TriangleAlert",
  },
  editar_comentario: {
    titulo: "Comentário editado",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Pencil",
  },
  excluir_comentario: {
    titulo: "Comentário excluído",
    categoria: "Reservas",
    tom: "atencao",
    relevancia: "normal",
    icone: "Trash2",
  },
  atualizar_status_nao_conformidade: {
    titulo: "Status de não conformidade atualizado",
    categoria: "Segurança",
    tom: "sucesso",
    relevancia: "normal",
    icone: "CircleCheck",
  },
  anexar_imagem_comentario: {
    titulo: "Imagem adicionada ao comentário",
    categoria: "Reservas",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Paperclip",
  },
  atualizar_telefone_emergencia: {
    titulo: "Telefone de emergência atualizado",
    categoria: "Frota",
    tom: "atencao",
    relevancia: "importante",
    icone: "Construction",
    descricao: "Contato acionado em caso de problema com o equipamento durante o uso.",
  },

  // Marca, galeria e categorias de equipamento (migration 0025).
  alterar_marca_plataforma: {
    titulo: "Marca da plataforma alterada",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "normal",
    icone: "Pencil",
  },
  adicionar_imagem_plataforma: {
    titulo: "Imagem adicionada à plataforma",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Paperclip",
  },
  substituir_imagem_plataforma: {
    titulo: "Imagem da plataforma substituída",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Paperclip",
  },
  remover_imagem_plataforma: {
    titulo: "Imagem removida da plataforma",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "normal",
    icone: "Trash2",
  },
  definir_imagem_principal: {
    titulo: "Imagem principal da plataforma alterada",
    categoria: "Frota",
    tom: "neutro",
    relevancia: "informativa",
    icone: "Paperclip",
  },
  criar_categoria_equipamento: {
    titulo: "Categoria de equipamento criada",
    categoria: "Configurações",
    tom: "neutro",
    relevancia: "normal",
    icone: "Settings",
  },
  editar_categoria_equipamento: {
    titulo: "Categoria de equipamento renomeada",
    categoria: "Configurações",
    tom: "neutro",
    relevancia: "normal",
    icone: "Pencil",
  },
  ativar_categoria_equipamento: {
    titulo: "Categoria de equipamento ativada",
    categoria: "Configurações",
    tom: "sucesso",
    relevancia: "normal",
    icone: "CircleCheck",
  },
  desativar_categoria_equipamento: {
    titulo: "Categoria de equipamento desativada",
    categoria: "Configurações",
    tom: "atencao",
    relevancia: "normal",
    icone: "Ban",
    descricao: "Deixa de aparecer em novos cadastros; plataformas que já a usam não mudam.",
  },
  excluir_categoria_equipamento: {
    titulo: "Categoria de equipamento excluída",
    categoria: "Configurações",
    tom: "atencao",
    relevancia: "normal",
    icone: "Trash2",
    descricao: "Só é possível excluir categoria que nenhuma plataforma usa.",
  },
};

/** Meta usada quando o código gravado ainda não tem entrada no catálogo (ver `traduzirAcao`). */
export const EVENTO_DESCONHECIDO: AuditoriaEventoMeta = {
  titulo: "Evento do sistema",
  categoria: "Sistema",
  tom: "neutro",
  relevancia: "normal",
  icone: "Activity",
};

/**
 * Entidades do backend → substantivo que o usuário reconhece. "Recurso", não "entidade":
 * quem audita pensa em "qual reserva/plataforma", não em qual tabela.
 */
export const RECURSOS_AUDITORIA: Record<string, string> = {
  Reserva: "Reserva",
  Plataforma: "Plataforma",
  Usuario: "Usuário",
  Setor: "Setor",
  BloqueioAgenda: "Bloqueio de agenda",
  Checklist: "Checklist",
  ChecklistTemplate: "Modelo de checklist",
  ChecklistItemTemplate: "Item de checklist",
  Comentario: "Comentário",
  Ocorrencia: "Ocorrência",
  Anexo: "Anexo",
  ConfiguracaoSistema: "Configurações",
  CategoriaEquipamento: "Categoria de equipamento",
};

/**
 * Nomes de campo do payload → rótulo legível. Só é usado no caminho genérico: eventos com
 * semântica conhecida (mudança de status, checklist, SLA) viram frase em `formatarDetalhes`
 * e nunca chegam aqui. Existe para que um campo novo, ainda não tratado, apareça como
 * "Novo status" e não como `statusNovo`.
 */
export const CAMPOS_AUDITORIA: Record<string, string> = {
  plataformaId: "Plataforma",
  plataformaCodigo: "Código da plataforma",
  plataformaNome: "Nome da plataforma",
  setorId: "Setor",
  reservaId: "Reserva",
  ocorrenciaId: "Ocorrência",
  recorrenciaId: "Série de reservas",
  templateId: "Modelo de checklist",
  checklistTemplateId: "Modelo de checklist",
  statusAnterior: "Status anterior",
  statusNovo: "Novo status",
  ativoAnterior: "Status anterior",
  ativoNovo: "Novo status",
  perfilAnterior: "Perfil anterior",
  perfilNovo: "Novo perfil",
  perfilAprovador: "Perfil do aprovador",
  totalRespostas: "Itens avaliados",
  todosConformes: "Todos os itens conformes",
  slaHoras: "Prazo de SLA",
  finalizar: "Finalizado",
  nome: "Nome",
  codigo: "Código",
  telefoneEmergencia: "Telefone de emergência",
  telefoneContato: "Telefone de contato",
  telefoneAnterior: "Telefone anterior",
  telefoneNovo: "Novo telefone",
  marcaAnterior: "Marca anterior",
  marcaNova: "Nova marca",
  nomeAnterior: "Nome anterior",
  nomeNovo: "Novo nome",
  posicao: "Posição na galeria",
  eraPrincipal: "Era a imagem principal",
  tipo: "Tipo",
  totalImagens: "Imagens",
  email: "E-mail",
  perfil: "Perfil",
  motivo: "Motivo",
  data: "Data",
  horaInicio: "Início",
  horaFim: "Término",
  prioridade: "Prioridade",
  gravidade: "Gravidade",
  geraManutencao: "Enviou para manutenção",
  nomeArquivo: "Arquivo",
  tipoMime: "Tipo do arquivo",
  tamanhoBytes: "Tamanho",
  corHex: "Cor",
  categoriaPlataforma: "Categoria",
  exigeChecklist: "Exige checklist",
  ativo: "Ativo",
  campo: "Etapa de aprovação",
  origem: "Origem",
  descricao: "Descrição",
  confirmadoComReservasConflitantes: "Criado sobre reservas existentes",
  /* Snapshot gravado em `criar_reserva` quando o setor é "Terceirizados" — ausente/vazio nos
     demais casos, e campos vazios já são descartados em detalhesComplementares. */
  empresaTerceirizada: "Empresa terceirizada",
  /* `atualizar_configuracao` grava o payload com as chaves em snake_case de
     ConfiguracaoSistema (não camelCase como o resto do log). Rotulados aqui só os horários de
     expediente, que a agenda passou a usar; as demais chaves seguem no fallback de
     humanizarCodigo. Os rótulos repetem os de ConfiguracoesClient para o Admin reconhecer o
     campo que acabou de editar. */
  horario_expediente_inicio: "Início do expediente",
  horario_expediente_fim: "Fim do expediente",
};

/** Valores enumerados do domínio → rótulo humano, por família de campo. */
export const VALORES_AUDITORIA: Record<string, Record<string, string>> = {
  statusPlataforma: {
    disponivel: "Disponível",
    reservada: "Reservada",
    manutencao: "Em manutenção",
    inativa: "Inativa",
  },
  statusReserva: {
    pendente: "Pendente",
    agendada: "Agendada",
    em_uso: "Em uso",
    concluida: "Concluída",
    cancelada: "Cancelada",
    rejeitada: "Rejeitada",
  },
  perfil: {
    admin: "Administrador",
    gestor_setor: "Gestor de Setor",
    colaborador: "Colaborador",
  },
  prioridade: {
    normal: "Normal",
    alta: "Alta",
    urgente: "Urgente",
  },
  gravidade: {
    baixa: "Baixa",
    media: "Média",
    alta: "Alta",
  },
  categoriaPlataforma: {
    elevatoria: "Elevatória",
    andaime: "Andaime",
    sala: "Sala técnica",
    patio: "Pátio",
    veiculo: "Veículo",
    outro: "Outro",
  },
  origem: {
    AUTOMATICA: "Automática",
    MANUAL: "Manual",
    MIGRACAO: "Migração de versão",
  },
  tipoComentario: {
    comentario: "Comentário",
    nao_conformidade: "Não conformidade",
  },
  campo: {
    aprovado_por_id: "1ª aprovação",
    segunda_aprovacao_por_id: "2ª aprovação",
  },
};
