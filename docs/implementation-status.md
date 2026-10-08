# Status de implementação (continuidade)

## Concluído (não refazer)

- Configurações: upsert + migration 0027; limites centralizados (duração máx. 720h).
- RBAC lê perfil/setor/ativo do banco a cada requisição (`middlewares/rbac.ts`).
- Gestor: lista/cadastra usuários (colaborador/gestor); migration 0028 (`Plataforma.criado_por_id`).
- Minha Conta: rótulo de perfil corrigido.
- Etapa 1 — reservas de vários dias (migration 0029; `periodoReserva.ts`; API, web, testes).
- Etapas 2–5 (migration 0030):
  - `Plataforma.setor_id` (Admin escolhe; Gestor = setor dele; antigas ficam NULL).
  - Regra única `services/gestaoPlataforma.service.ts` (admin | criador | setor | responsável).
  - `PlataformaResponsavel` + rotas `routes/responsaveisPlataforma.ts` + área em Configurações.
  - Política `politica_substituicao_reserva_urgente` (aprovação, análise, auditoria, Configurações).
  - Auditoria operacional do Gestor (escopo no WHERE, payload sanitizado, sem export).

## Testes executados (última rodada)

- Typecheck shared/api/web ✓; unit API 383 ✓; unit web 32 ✓.
- Integração (12 suítes das áreas alteradas): 250 ✓.
- Builds API e web ✓.
- Verificação visual headless (Chromium, desktop 1366 e celular 390): 15/15 ✓, 0 erros de console/5xx.

## Falhas de integração ANTERIORES a este trabalho

- Login do admin seedado sem credenciais (422): aprovacao, auditoria, auditoria_evidencia,
  configuracoes, dashboard, historico, plataformas, reservas, setores, refinamento, otp_email_flow.
- Categoria 'sala' removida na migration 0026: anexos, bloqueios, comentarios, eventos,
  notificacoes, ocorrencias, relatorios, aprovacao_dupla.
- Coluna `checklist_template_id` inexistente: checklist, checklist_config_automacao.

## Próximo passo

- Nenhum pendente de implementação. Para o servidor: copiar arquivos, `migrate:up` (0027–0030), build e reinício.
