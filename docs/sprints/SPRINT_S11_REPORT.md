# Sprint S11 — Anexos, Comentários e Ocorrências

| Campo | Valor |
|---|---|
| Sprint | S11 |
| Status | ✅ Concluída |
| Data | 2026-07-13 |
| Depende de | S8 (✅ Concluída, confirmado no início desta sessão) |
| Natureza | Enriquece a reserva com evidências (anexos reais no Azure Blob Storage), comunicação assíncrona (comentários) e apuração de avarias (ocorrências que podem bloquear a plataforma automaticamente) |

## 1. Objetivo

Implementar `Anexo` (upload real com validação de mime via magic bytes, SAS de curta duração), `Comentario` (thread cronológica com notificação ao(s) outro(s) participante(s)) e `Ocorrencia` (gravidade + opção de abrir manutenção automática da plataforma, RN-PLAT-04) — usando a infraestrutura de notificação in-app/e-mail de S10, e migrando definitivamente o armazenamento de fotos de checklist (S8, disco local provisório) para Azure Blob Storage real.

## 2. O que foi implementado

### 2.1 Schema (migration `0009`)

- **`0009_anexo_comentario_ocorrencia.sql`**: cria `Anexo` (`reserva_id`, `nome_arquivo`, `url_blob` — chave do blob, não URL pública —, `tipo_mime`, `tamanho_bytes` com `CHECK` ≤10MB, `enviado_por_id`), `Comentario` (`reserva_id`, `usuario_id`, `mensagem`, `criado_em`) e `Ocorrencia` (`reserva_id`, `plataforma_id`, `reportado_por_id`, `descricao`, `gravidade` `CHECK IN ('baixa','media','alta')`, `gera_manutencao`). Aplicada via driver `mssql`/Node (evita o mojibake de `sqlcmd` sem `-f 65001`, registrado como prática desde S8/ADR-05); verificada via `INFORMATION_SCHEMA.TABLES`.

### 2.2 `packages/shared`

- `schemas/anexo.ts`, `schemas/comentario.ts`, `schemas/ocorrencia.ts` (novos): `criarAnexoSchema` (nome + data URL base64), `anexoPublicoSchema` (inclui `url` — SAS assinado, nunca persistido), `criarComentarioSchema`/`comentarioPublicoSchema`, `criarOcorrenciaSchema` (`gravidade` + `geraManutencao`)/`ocorrenciaPublicaSchema`.

### 2.3 `storage.service.ts` — reescrito para Azure Blob Storage real (ADR-01)

- Troca completa da implementação de S8 (disco local) por `@azure/storage-blob` real: `BlobServiceClient.fromConnectionString`, container privado (`createIfNotExists`, sem acesso público — RNF-09), upload via `uploadData`.
- **Validação de mime real via magic bytes** (`detectarMimeReal`): assinaturas binárias verificadas nos primeiros bytes do buffer para `image/jpeg`, `image/png`, `image/gif`, `application/pdf` (`%PDF`), e `image/webp` (RIFF/WEBP em offset separado) — nunca confia no `Content-Type`/prefixo da data URL declarado pelo cliente. `MimeNaoPermitidoError` se o conteúdo real não bater com nenhuma assinatura permitida.
- **Limite de 10 MB** (`ArquivoExcedeLimiteError`), verificado sobre o buffer real, não sobre o tamanho declarado.
- **SAS de leitura de curta duração** (`gerarUrlAcesso`): `generateBlobSASQueryParameters` com `BlobSASPermissions.parse("r")`, `expiresOn` = agora + 1h (RNF-09 — "SAS ≤ 1 hora"), `startsOn` 5 min no passado (tolerância de relógio). Gerado sob demanda a cada leitura — nunca persistido, nunca "eterno" se vazado.
- **Migração do checklist de S8**: `salvarFotoBase64` mantém a mesma assinatura pública, agora reimplementada sobre `salvarArquivo` — nenhuma mudança em `checklist.service.ts` nem nas rotas de checklist, exatamente como planejado no ADR-03 de S8. `checklist.ts` (GET) agora gera um SAS fresco para cada `fotoUrl` na resposta, em vez de retornar um path local `/uploads/...`.
- `routes/uploads.ts` (S8, servidor estático local autenticado) **removido** — substituído por URLs SAS diretas ao Blob Storage, que já carregam sua própria autorização (assinatura + expiração), dispensando um proxy da API.

### 2.4 ADR — Azure Blob Storage real via Azurite (sem conta Azure disponível)

Não há credenciais de conta Azure real disponíveis nesta sessão (mesma lacuna já registrada para o Microsoft Graph desde S1). Em vez de mockar o SDK, a decisão foi rodar o **emulador oficial Azurite** (`azurite-blob`, pacote `azurite` da própria Microsoft) localmente, com o SDK real (`@azure/storage-blob`) apontando para ele via `AZURE_STORAGE_CONNECTION_STRING` (connection string padrão pública, documentada pela Microsoft para desenvolvimento local — não é um segredo). Isso significa que **todo o código de upload, validação de magic bytes e geração de SAS roda exatamente como rodaria contra uma conta Azure de produção** — só o endpoint HTTP muda. Documentado em `.env.example`; instância local iniciada com `--skipApiVersionCheck` (flag oficial da Microsoft) porque o SDK 12.33.0 é mais novo que a API version suportada pelo Azurite 3.35.0.

### 2.5 Rotas

- `GET/POST /api/v1/reservas/:id/anexos` (`routes/anexos.ts`): escopo via `usuarioNoEscopoDaReserva` (S7); POST valida schema, decodifica a data URL, chama `armazenamentoService.salvarArquivo`, grava `Anexo` + `LogAuditoria` em transação; GET gera SAS fresco por item.
- `GET/POST /api/v1/reservas/:id/comentarios` (`routes/comentarios.ts`): mesmo escopo; POST identifica "outro(s) participante(s) da conversa" (solicitante da reserva + qualquer autor anterior de comentário na mesma reserva, excluindo quem está comentando agora), grava `Comentario` + `Notificacao` (`comentario_novo`) por participante na mesma transação, publica `notificacao.nova` via SSE e enfileira e-mail (`templateComentarioNovo`) após o commit.
- `POST /api/v1/reservas/:id/ocorrencia` (`routes/ocorrencias.ts`): mesmo escopo; grava `Ocorrencia`; se `geraManutencao=1`, `UPDATE Plataforma SET status='manutencao'` **na mesma transação**, com `LogAuditoria` próprio (`alterar_status_plataforma`); se `gravidade='alta'`, grava `Notificacao` (`ocorrencia_reportada`) para todos os Admins ativos, sempre — independente de `geraManutencao`. Após o commit: publica `plataforma.status_alterado` (se mudou) e `notificacao.nova` via SSE, enfileira e-mail (`templateOcorrenciaGrave`) para gravidade alta.

### 2.6 RN-PLAT-04 — correção de uma lacuna real em RN-PLAT-01

A checagem de `POST /reservas` (desde S2/S3) só bloqueava `plataforma_status === "inativa"`, nunca `"manutencao"` — apesar de `sqlStatusPlataformaDerivado` (`plataforma.service.ts`) já tratar os dois como "estados especiais" desde S4. Isso significa que, antes desta sprint, uma plataforma em manutenção **podia** ser reservada normalmente — um gap real na regra RN-PLAT-04 ("bloqueia novas reservas até reversão manual pelo Admin"), não hipotético: confirmado tentando reservar a plataforma logo após a ocorrência automática e recebendo `201` em vez de `409` antes da correção. **Corrigido** em `reservas.ts`: `POST /reservas` agora rejeita `inativa` OU `manutencao`, com mensagem específica para cada caso.

### 2.7 Notificações (RF-RES-15/16, infraestrutura de S10)

- `templateComentarioNovo`, `templateOcorrenciaGrave` (novos, `email.service.ts`).
- `comentario_novo` e `ocorrencia_reportada` já existiam no enum `TIPOS_NOTIFICACAO` desde S10 (`schemas/notificacao.ts`) — usados agora pela primeira vez.

### 2.8 Frontend

- **`AnexosComentarios.tsx`** (novo componente): abas "Anexos" (contador de itens) e "Comentários" (contador de itens) embutidas no Detalhe da Reserva, mesmo padrão de seção auto-contida de `ChecklistSeguranca` (S8). Anexos: dropzone com drag&drop real (`onDrop`/`onDragOver`) + fallback de clique/`<input type=file>`, lê o arquivo como base64 no cliente, envia via `POST /anexos`, lista com preview de imagem (via SAS) ou ícone "PDF", nome, tamanho formatado, autor e data. Comentários: thread rolável, textarea + "Enviar".
- **`ReservaDetalheModal.tsx`**: embute `AnexosComentarios` para qualquer usuário no escopo, independente do status da reserva. Fluxo de conclusão (RF-RES-16/UC-04): clicar "Concluir" agora pergunta "Houve alguma ocorrência ou avaria durante o uso?" antes de finalizar — "Não" conclui direto; "Sim" abre um mini-formulário (descrição, gravidade, checkbox "abrir manutenção automática") que primeiro `POST /ocorrencia`, depois `PATCH /status {acao:"concluir"}`. Botão "Reservar Novamente" (RF-RES-13) aparece para reservas `concluida`/`cancelada` no escopo do usuário.
- **`ReservaModal.tsx`**: aceita `valoresIniciais` opcional (`plataformaId`, `motivo`, `prioridade` — **nunca** `data`/`horário`/`status`) para o fluxo de "Reservar Novamente"; título muda para "Reservar Novamente" quando pré-preenchido.
- **`ReservasClient.tsx`**: liga o botão "Reservar Novamente" do modal de detalhe ao `ReservaModal`, repassando os valores iniciais e limpando-os ao fechar/abrir uma "Nova Reserva" normal.
- `app.ts` (Fastify): `bodyLimit` elevado para 15 MB (data URL base64 de um anexo de 10 MB infla ~37% + overhead do JSON — o padrão de 1 MB do Fastify bloquearia qualquer anexo real).

## 3. Testes obrigatórios — confirmação

### 3.1 Unitário — rejeição de upload inválido (`tests/unit/storage.test.ts`, novo arquivo, 7 testes)

Importante: estes testes **não são mocks** — exercitam o SDK real do Azure Blob Storage (`@azure/storage-blob`) contra o Azurite local, incluindo upload real via HTTP e leitura real via SAS assinado. Output real:

```
✓ src/tests/unit/storage.test.ts (7 tests) 55ms
```

Smoke test isolado (executado antes de integrar às rotas, removido do repositório após validação), evidenciando o comportamento real ponta-a-ponta:

```
mime real detectado: image/png
salvo: {
  url: 'smoke-test/262f59b0-8bc0-4b13-8af1-e9ad7228f55f-pixel.png',
  tipoMimeReal: 'image/png',
  tamanhoBytes: 68
}
SAS url: http://127.0.0.1:10000/devstoreaccount1/anexos-reserva/smoke-test/...?sv=2026-06-06&st=...&se=...&sr=b&sp=r&sig=...
fetch status: 200
bytes lidos == bytes enviados: true
rejeitado corretamente (mime falso): Não foi possível identificar o tipo real do arquivo pelos primeiros bytes (declarado como "image/png") — upload recusado por segurança.
rejeitado corretamente (>10MB): Arquivo excede o limite de 10 MB (RNF-09).
```

### 3.2 Integração — ocorrência gera manutenção automática e bloqueia reservas (`tests/integration/ocorrencias.test.ts`, novo arquivo, 3 testes)

Via API real (`app.inject`, sem mocks), banco real. Output real:

```
✓ src/tests/integration/ocorrencias.test.ts (3 tests) 1706ms
  ✓ POST /reservas/:id/ocorrencia — RF-RES-16/RN-PLAT-04 > gravidade alta + gera_manutencao=1 muda Plataforma.status para 'manutencao' e bloqueia nova reserva
  ✓ POST /reservas/:id/ocorrencia — RF-RES-16/RN-PLAT-04 > gravidade baixa + gera_manutencao=0 NÃO altera Plataforma.status
  ✓ POST /reservas/:id/ocorrencia — RF-RES-16/RN-PLAT-04 > usuário fora do escopo do setor da reserva recebe 403
```

O primeiro teste comprova, na mesma execução: `Plataforma.status` muda de `disponivel` para `manutencao` sem nenhum `PATCH` manual; uma nova tentativa de `POST /reservas` na mesma plataforma retorna `409` com a mensagem de RN-PLAT-04; e uma `Notificacao` real (`ocorrencia_reportada`) é gravada para o Admin.

### 3.3 Testes adicionais (além do mínimo exigido) — anexos e comentários reais

- **`tests/integration/anexos.test.ts`** (4 testes): upload real de um PNG válido com leitura de volta via SAS byte-a-byte idêntica; rejeição de mime mentindo (texto disfarçado de PNG) → 422; escopo (403 fora do setor); listagem com URL válida.
- **`tests/integration/comentarios.test.ts`** (3 testes): comentário gera notificação in-app real ao outro participante; thread em ordem cronológica; rejeição de mensagem vazia.

### 3.4 Suíte completa do backend

`pnpm --filter api test` — 26 arquivos, **274/274**, 0 falhas:

```
 Test Files  26 passed (26)
      Tests  274 passed (274)
   Duration  69.73s
```

Composição do delta em relação a S10 (257 testes): +7 (`unit/storage.test.ts`) + 3 (`integration/ocorrencias.test.ts`) + 4 (`integration/anexos.test.ts`) + 3 (`integration/comentarios.test.ts`) = 257 + 17 = 274.

## 4. Gate de Aceite

- [x] **Output real do teste de rejeição de upload inválido** — Seção 3.1 (7/7, incluindo o smoke test ponta-a-ponta contra o Azure Blob SDK real) e `integration/anexos.test.ts` (422 para mime mentindo, via rota HTTP real).

- [x] **Prova (teste + captura) de que a plataforma muda para `manutencao` automaticamente após ocorrência grave e que novas reservas nela são bloqueadas** — Seção 3.2 (teste de integração) **e** sessão real no navegador (Seção 5): reserva real criada/aprovada/iniciada/concluída como Colaborador+Admin, formulário real "Houve ocorrência?" preenchido com gravidade Alta + "Abrir manutenção automática", `Plataforma Demo S11` mudou de `Disponível` para `Em Manutenção` na tela de Plataformas sem nenhuma ação manual adicional, e uma tentativa real de "Reservar Novamente" na mesma plataforma retornou o erro real `"Esta plataforma está em manutenção e não pode ser reservada (RN-PLAT-04)."` diretamente na UI.

- [x] **Captura de tela da thread de comentários e da aba de anexos com um arquivo real enviado e acessível via SAS token** — Seção 5: comentário real postado pelo Admin e exibido na thread com timestamp real; anexo real (`evidencia-real.png`) enviado, listado na aba "Anexos" com thumbnail carregada de fato do Azurite via URL assinada (`GET .../anexos-reserva/...?sv=...&sig=...` → `200 OK`, confirmado via `read_network_requests`).

## 5. Evidência de UI — sessão real no navegador

**Ferramenta de screenshot indisponível nesta sessão**: `computer{action:"screenshot"}` voltou a retornar timeout (mesmo problema recorrente de S8/S9/S10). Evidência abaixo é o dump real da árvore de acessibilidade/texto da página (`get_page_text`/`read_page`) e o log real de requisições de rede (`read_network_requests`) após interações reais do mouse/teclado — não é simulação nem resumo.

Passos executados de fato no navegador (servidor Next.js reiniciado limpo antes do teste; API já rodando com o código desta sprint via `tsx watch`, auto-reload confirmado):

1. Criada plataforma de demonstração `PLT-S11-DEMO` (categoria `patio`, sem exigência de checklist, para isolar o teste de anexos/comentários/ocorrência do fluxo de checklist de S8) e usuário `colaborador.s11.demo@metalsider.com.br` (setor TI) via script Node ad-hoc (removido após uso).
2. Login como Colaborador, criação de reserva real para `PLT-S11-DEMO` (20/07/2026, 08:00–09:00) → `Pendente`.
3. Login como Admin, aprovação real na Fila de Aprovações → `Agendada`.
4. Detalhe da reserva como Admin: abas "Anexos"/"Comentários" visíveis desde o primeiro carregamento (mesmo antes de iniciar o uso); comentário real postado ("Poderia confirmar o horário de chegada da equipe?") → thread atualizada com contagem "1", timestamp real `13/07/2026, 15:47:37`.
5. Upload real de anexo: `POST /reservas/:id/anexos` disparado com um PNG real (1×1, magic bytes reais) autenticado via cookie de sessão do próprio navegador — resposta `201`, `tipoMime: "image/png"`, `url` com `sig=` (SAS real). Reabertura do modal (para refletir o novo fetch) mostra `evidencia-real.png`, 68 B, "enviado por Administrador"; `read_network_requests` confirma `GET http://127.0.0.1:10000/devstoreaccount1/anexos-reserva/.../evidencia-real.png?...&sig=... → 200 OK` — a thumbnail `<img>` carregou de fato do Blob Storage via SAS, não de um placeholder.
6. "Iniciar Uso" real (sem checklist, categoria `patio`) → `Em Uso`, `INÍCIO REAL` gravado.
7. "Concluir" real: modal pergunta *"Houve alguma ocorrência ou avaria durante o uso? (RF-RES-16)"*; clique em "Sim, reportar ocorrência" abre o formulário; preenchido com descrição real, gravidade **Alta**, checkbox "Abrir manutenção automática" marcado; clique em "Registrar Ocorrência e Concluir" disparou `POST /ocorrencia` (`201`) seguido de `PATCH /status` (`concluir`) — reserva passou a `Concluída` na listagem.
8. Tela "Plataformas" (Admin): `PLT-S11-DEMO` agora exibe status **"Em Manutenção"** — mudança automática, sem qualquer `PATCH /plataformas/:id/status` manual chamado nesta sessão.
9. Sino de notificações do Admin: item real *"Ocorrência de gravidade alta — Ocorrência de gravidade alta reportada em Plataforma Demo S11 (...) (TI)."*, link para a reserva, timestamp real.
10. Sino de notificações do Colaborador (login novamente): item real *"Novo comentário — Administrador comentou na reserva de Plataforma Demo S11 (...): \"Poderia c[onfirmar...]\""* — confirma a notificação ao "outro participante da conversa" (RF-RES-15) funcionando de fato, cruzando as duas contas.
11. **"Reservar Novamente"** (RF-RES-13), testado com as duas contas: modal abre com título "Reservar Novamente", plataforma/prioridade/motivo pré-preenchidos (campo `motivo` confirmado via inspeção do DOM — mesmo texto da reserva original), campos de data/horário em branco (conforme especificado — nunca herdar data/status antigos). Ao submeter como Admin (sem setor) → erro esperado, não relacionado a esta feature; ao submeter como Colaborador (setor TI, plataforma já em manutenção pelo passo 7) → erro real da API exibido na própria UI: **`"Esta plataforma está em manutenção e não pode ser reservada (RN-PLAT-04)."`** — prova end-to-end de que a ocorrência grave bloqueou de fato novas reservas, sem nenhum atalho de teste.

## 6. Invariantes da Seção 2 do MASTER.md

Todas seguidas, sem exceções novas:

- IDs: `Anexo`/`Comentario`/`Ocorrencia` usam `UNIQUEIDENTIFIER DEFAULT NEWID()`.
- `/api/v1` como prefixo único — a rota estática `/uploads/*` (exceção deliberada de S8) foi **removida** nesta sprint, já que o acesso a anexos/fotos agora é sempre via URL SAS externa ao Blob Storage, não mais uma rota da própria API.
- Toda rota de escrita valida payload via Zod (`criarAnexoSchema`, `criarComentarioSchema`, `criarOcorrenciaSchema`).
- `rbac.ts`/`usuarioNoEscopoDaReserva` continuam a única fonte de verdade de escopo nas três novas rotas — mesmo padrão de checklist (S8).
- `LogAuditoria` gravado na mesma transação da operação (`anexar_arquivo`, `comentar_reserva`, `reportar_ocorrencia`, e `alterar_status_plataforma` quando a ocorrência abre manutenção).
- E-mail sempre via fila BullMQ, nunca síncrono (`templateComentarioNovo`, `templateOcorrenciaGrave`).
- Mudança de status da plataforma por ocorrência acontece **na mesma transação** da inserção da `Ocorrencia` — nunca em duas escritas separadas que pudessem divergir.
- Anexos **não** têm binário no banco relacional — só a chave do blob em `Anexo.url_blob`; nenhuma URL pública é persistida (SAS sempre gerado em tempo de leitura).

## 7. ADRs (Architecture Decision Records)

- **ADR-01 — Azure Blob Storage real via SDK, testado contra o emulador Azurite (não um mock), por falta de conta Azure real disponível nesta sessão.** Ver Seção 2.4. Mesma postura já adotada para o Microsoft Graph desde S1 (credenciais pendentes, mas o fluxo de fila/envio é real) — aqui a evidência é ainda mais forte, pois o Azurite permite exercitar upload, download e geração de SAS de ponta a ponta com o SDK de produção, não apenas até o ponto de falha de credencial.
- **ADR-02 — Upload trafega como data URL base64 no corpo JSON, não `multipart/form-data`.** Mantém consistência com o padrão já usado para fotos de checklist desde S8 (mesmo componente de leitura de arquivo no cliente, `FileReader.readAsDataURL`), evita introduzir `@fastify/multipart` como nova dependência, e torna os testes de rejeição de mime/tamanho triviais (buffers diretos, sem simular streaming multipart). O custo é ~37% de overhead de payload, compensado elevando `bodyLimit` para 15 MB.
- **ADR-03 — `foto_url`/`url_blob` armazenam a CHAVE do blob, nunca uma URL.** SAS de leitura é sempre gerado em tempo de resposta (`gerarUrlAcesso`), nunca persistido — cumpre RNF-09 ("nunca publicamente acessíveis") mesmo que o banco vaze, e permite trocar a política de expiração/permissão no futuro sem migração de dados.
- **ADR-04 — "Reservar Novamente" nunca herda `data`/`horário`/`status`.** Especificado explicitamente no prompt da sprint ("exceto data/status") — a única forma de a ação fazer sentido é o usuário escolher um novo horário; herdar o antigo (quase sempre no passado) só geraria erro de validação de data mínima.
- **ADR-05 — Notificação de ocorrência grave (`gravidade='alta'`) independe de `geraManutencao`.** O SDD lista os dois campos como independentes (RF-RES-16: "gravidade e opção de abrir manutenção automática") — uma ocorrência grave que o relator decide *não* transformar em manutenção automática (ex.: avaria cosmética grave mas sem risco operacional) ainda merece a atenção do Admin.
- **ADR-06 — RN-PLAT-01 corrigido para bloquear `manutencao`, não só `inativa`.** Ver Seção 2.6 — tratado como correção de um gap real da regra já especificada (RN-PLAT-04), não como mudança de escopo desta sprint.

## 8. Pendências para sprints futuras

- **Upload real de arquivo pela UI (`<input type=file>`/drag&drop) não pôde ser automatizado nesta sessão** — a ferramenta de browser desta sessão não expõe um mecanismo de "file upload" (diferente de outras integrações Chrome). O caminho completo (rota, SDK do Blob Storage, magic bytes, SAS) foi validado com evidência real via chamada HTTP autenticada disparada de dentro da própria página (mesma sessão de cookie do navegador) e via testes de integração reais — não é um mock, mas não é literalmente "arrastar um arquivo do disco do usuário". Recomenda-se revalidar manualmente numa sessão com um navegador real (fora desta automação) se necessário.
- **Conta Azure real / credenciais de produção** — pendente, mesma natureza da pendência de Microsoft Graph desde S1. Trocar `AZURE_STORAGE_CONNECTION_STRING` do Azurite para uma conta real é a única mudança necessária (nenhum código muda).
- **Ferramenta de screenshot do browser instável nesta sessão** — mesma observação recorrente desde S8; evidência funcional (DOM real + chamadas HTTP reais) documentada em detalhe na Seção 5.
- **Dados de demonstração desta sessão** (`PLT-S11-DEMO`, `colaborador.s11.demo@metalsider.com.br`, reserva concluída de teste) foram deixados no banco, seguindo o mesmo padrão de sprints anteriores (`PLT-S8-DEMO` etc.) — úteis como referência viva do fluxo; nenhum dado sensível.
- Relatórios & indicadores (BI, S13) e demais itens do roadmap seguem conforme MASTER.md Seção 5.

---

Não iniciei a Sprint S12 nesta sessão, conforme instruído.
