/* Limpeza pontual (24/09/2026): remove os 7 usuários `teste.*`, as plataformas PLT-S15-DASH e
 * PLT-S12-CONFIG e os setores "Setor Teste Dashboard S15 A/B" recriados pela execução da
 * suíte completa de testes, com TUDO que referencia esses registros (logs de auditoria,
 * notificações, códigos, reservas, comentários, bloqueios...). IDs fixos, conferidos antes.
 * Não toca em caio.moraes@, na Plataforma UTE, na reserva dela nem nos logs dela.
 * Transação única: se qualquer passo falhar, nada é apagado.
 *
 * Rodar em apps/api:  npx tsx scripts/limpar-residuos-testes-2026-09-24.mts */
import { closePool, getPool } from "../src/db/pool.js";

const lista = (ids: string[]) => ids.map((i) => `'${i}'`).join(",");
const U = lista([
  "C3DEA041-EF01-47BA-AE65-BFB0F7210D80", // teste.auditoria.s6@
  "285E1E2D-636F-4E48-9DC9-5D8BCA1DF475", // teste.auditoria.ativacao.s6@
  "32DBE3A1-881A-433F-A28C-104B0B033406", // teste.s15.dashboard.gestor.a@
  "EF51F0B0-03D0-4018-B147-9FE2BD296D0E", // teste.s15.dashboard.colaborador.a@
  "F9605FB7-DC4F-4C83-B5B4-85361B18A559", // teste.s15.dashboard.colaborador.b@
  "22F68264-9B37-4248-9C82-BBE8338AABA7", // teste.s12.configuracoes@
  "E856F5FF-7E97-483C-A1E2-9E2B724D9C18", // teste.s12.auditoria.colaborador@
]);
const P = lista([
  "3DDCA3BB-9F69-4928-ADCD-E7AEA12F3022", // PLT-S15-DASH
  "F4B40D92-EF3D-4934-AF22-0CC27F302960", // PLT-S12-CONFIG
]);
const SET = `SELECT id FROM Setor WHERE nome IN ('Setor Teste Dashboard S15 A','Setor Teste Dashboard S15 B')`;
const R = `SELECT id FROM Reserva WHERE plataforma_id IN (${P}) OR solicitante_id IN (${U}) OR setor_id IN (${SET})`;
const B = `SELECT id FROM BloqueioAgenda WHERE plataforma_id IN (${P}) OR criado_por_id IN (${U})`;
const O = `SELECT id FROM Ocorrencia WHERE plataforma_id IN (${P}) OR reportado_por_id IN (${U}) OR reserva_id IN (${R})`;

const pool = await getPool();
const tx = pool.transaction();
await tx.begin();
const apagados: Record<string, number> = {};
const run = async (nome: string, consulta: string) => {
  apagados[nome] = (await tx.request().query(consulta)).rowsAffected.reduce((a, b) => a + b, 0);
};
try {
  await run("logs_reservas", `DELETE FROM LogAuditoria WHERE entidade_id IN (${R})`);
  await run("anexos", `DELETE FROM Anexo WHERE reserva_id IN (${R}) OR enviado_por_id IN (${U})`);
  await run("comentarios", `DELETE FROM Comentario WHERE reserva_id IN (${R}) OR usuario_id IN (${U})`);
  await run("logs_ocorrencias", `DELETE FROM LogAuditoria WHERE entidade_id IN (${O})`);
  await run("ocorrencias", `DELETE FROM Ocorrencia WHERE id IN (${O})`);
  await run("checklists", `DELETE FROM ChecklistPreenchido WHERE reserva_id IN (${R}) OR preenchido_por_id IN (${U})`);
  await run("reservas", `DELETE FROM Reserva WHERE id IN (${R})`);
  await run("recorrencias", `DELETE FROM ReservaRecorrencia WHERE criado_por_id IN (${U})`);
  await run("logs_bloqueios", `DELETE FROM LogAuditoria WHERE entidade_id IN (${B})`);
  await run("bloqueios", `DELETE FROM BloqueioAgenda WHERE id IN (${B})`);
  await run(
    "logs_plataformas_usuarios_setores",
    `DELETE FROM LogAuditoria WHERE entidade_id IN (${P}) OR entidade_id IN (${U}) OR entidade_id IN (${SET}) OR usuario_id IN (${U})`
  );
  await run("plataformas", `DELETE FROM Plataforma WHERE id IN (${P})`); // imagens saem em cascata
  await run("notificacoes", `DELETE FROM Notificacao WHERE usuario_id IN (${U})`);
  await run("codigos", `DELETE FROM CodigoVerificacao WHERE usuario_id IN (${U})`);
  await run(
    "referencias_anuladas",
    `UPDATE PlataformaImagem SET criado_por_id = NULL WHERE criado_por_id IN (${U});
     UPDATE ConfiguracaoSistema SET atualizado_por_id = NULL WHERE atualizado_por_id IN (${U});
     UPDATE NaoConformidade SET resolvido_por = NULL WHERE resolvido_por IN (${U});
     UPDATE Comentario SET excluido_por = NULL WHERE excluido_por IN (${U})`
  );
  await run("usuarios", `DELETE FROM Usuario WHERE id IN (${U})`);
  await run("setores", `DELETE FROM Setor WHERE id IN (${SET})`);
  await tx.commit();
  console.log("Concluído:", apagados);
} catch (erro) {
  await tx.rollback();
  console.error("Nada foi apagado (rollback):", (erro as Error).message);
}

const q = async (consulta: string) => (await pool.request().query(consulta)).recordset;
console.log("Usuários:", await q("SELECT email FROM Usuario"));
console.log("Plataformas:", await q("SELECT codigo FROM Plataforma"));
console.log("Setores:", await q("SELECT nome FROM Setor ORDER BY nome"));
await closePool();
