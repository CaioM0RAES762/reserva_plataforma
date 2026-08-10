import styles from "./AuthSidePanel.module.css";

// Vitrine institucional estática. Todo endpoint de plataformas/reservas exige sessão
// (RBAC), então não há fonte pública para alimentar estes números antes do login — e a
// autenticação não pode depender de uma busca de dados para renderizar. Os valores
// abaixo são ilustrativos do domínio, não leitura do banco.
const TOTAL_PLATAFORMAS = 14;
const EM_OPERACAO = 9;

const TURNOS = [
  { setor: "Laminação", codigo: "PTA-04", hora: "06:00", ativo: true },
  { setor: "Aciaria", codigo: "PTA-11", hora: "14:00", ativo: false },
  { setor: "Manutenção", codigo: "PTA-02", hora: "07:30", ativo: true },
  { setor: "Expedição", codigo: "PTA-07", hora: "22:00", ativo: false },
];

export function AuthSidePanel() {
  return (
    <div className={styles.panel}>
      <div className={styles.glowOrb} />
      <div className={styles.glowWash} />
      <div className={styles.edge} />

      <div className={styles.content}>
        <div className={styles.kicker}>
          <div className={styles.kickerLeft}>
            <span className={styles.pulseDot}>
              <span className={styles.pulseRing} />
              <span className={styles.pulseCore} />
            </span>
            <span className={styles.eyebrow55}>Frota interna</span>
          </div>
          <span className={styles.eyebrow30}>MetalSider</span>
        </div>

        <div className={styles.headlineBlock}>
          <h2 className={styles.headline}>Um só quadro para as plataformas de toda a planta.</h2>
        </div>

        <div className={styles.frotaBlock}>
          <div className={styles.frotaTopo}>
            <p className={styles.contador}>
              {EM_OPERACAO}
              <span className={styles.contadorTotal}>/{TOTAL_PLATAFORMAS}</span>
            </p>
            <p className={styles.eyebrow45}>Em operação</p>
          </div>
          <div className={styles.blocos}>
            {Array.from({ length: TOTAL_PLATAFORMAS }, (_, indice) => (
              <span
                key={indice}
                className={indice < EM_OPERACAO ? styles.blocoAtivo : styles.blocoInativo}
              />
            ))}
          </div>
        </div>

        <div className={styles.turnosBlock}>
          <div className={styles.turnosCabecalho}>
            <p className={styles.eyebrow45}>Turnos de hoje</p>
            <span className={styles.linhaFina} />
          </div>
          <ul className={styles.turnosLista}>
            <span className={styles.turnosTrilho} />
            {TURNOS.map((turno) => (
              <li key={turno.codigo} className={styles.turnoItem}>
                <span className={turno.ativo ? styles.turnoDot : styles.turnoDotSoft} />
                <span className={styles.turnoInfo}>
                  <span className={styles.turnoSetor}>{turno.setor}</span>
                  <span className={styles.turnoCodigo}>{turno.codigo}</span>
                </span>
                <span className={styles.turnoHora}>{turno.hora}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Rodapé dentro da mesma coluna flex do conteúdo: é o `mt-auto` da headline que
            distribui a folga vertical, e ele só funciona se todos os blocos — inclusive
            este — dividirem a mesma altura. Fora da coluna, a folga era calculada sobre
            uma altura menor e empurrava o painel inteiro para baixo. */}
        <div className={styles.rodapeWrap}>
          <div className={styles.rodapeLinha} />
          <p className={styles.rodapeTexto}>
            Atualizado a cada troca de turno · acesso restrito a operadores habilitados.
          </p>
        </div>
      </div>
    </div>
  );
}
