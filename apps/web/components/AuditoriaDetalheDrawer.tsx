"use client";

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import {
  alteracaoEmTexto,
  detalhesComplementares,
  formatarDetalhesAuditoria,
  traduzirAcao,
  traduzirRecurso,
} from "@plataformares/shared";
import styles from "./AuditoriaDetalheDrawer.module.css";
import { useModalAcessivel } from "../lib/useModalAcessivel";
import {
  ICONES_AUDITORIA,
  PERFIS_LEGIVEIS,
  formatarCarimboCompleto,
  formatarDataExtensa,
  identificarRecurso,
  type RegistroAuditoria,
} from "../lib/auditoria";

export interface AuditoriaDetalheDrawerProps {
  registro: RegistroAuditoria;
  onClose: () => void;
}

/** Botão de copiar para identificadores — o UUID existe para ser levado a outro lugar. */
function BotaoCopiar({ valor, rotulo }: { valor: string; rotulo: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(valor);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    } catch {
      // Clipboard bloqueado (contexto não seguro / permissão negada): o valor continua
      // selecionável na tela, então não vale interromper o usuário com um erro.
    }
  }

  return (
    <button type="button" className={styles.copiar} onClick={copiar} aria-label={`Copiar ${rotulo}`}>
      {copiado ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.75} />}
      {copiado ? "Copiado" : "Copiar"}
    </button>
  );
}

/**
 * Detalhe de um evento de auditoria, em drawer lateral.
 *
 * A separação em duas camadas é o ponto do componente: acima, a leitura administrativa
 * (quem, o quê, em qual recurso, o que mudou); no fim, colapsado, o registro técnico
 * intacto — código interno da ação, entidade, UUID e payload. O suporte continua tendo
 * tudo o que precisa sem que o administrador precise atravessar isso para entender o que
 * aconteceu.
 */
export function AuditoriaDetalheDrawer({ registro, onClose }: AuditoriaDetalheDrawerProps) {
  const { refDialogo, propsDialogo, idTitulo, aoClicarNoOverlay } = useModalAcessivel(onClose, "auditoria-detalhe");

  const meta = traduzirAcao(registro.acao);
  const recurso = identificarRecurso(registro);
  const alteracao = formatarDetalhesAuditoria(registro.acao, registro.detalhes as never, {
    entidade: registro.entidade,
  });
  const complementares = detalhesComplementares(registro.detalhes as never);
  const Icone = ICONES_AUDITORIA[meta.icone];
  const automatico = !registro.usuarioNome;
  const temAlteracao = Boolean(alteracao.de || alteracao.para || alteracao.resumo);

  const payload =
    registro.detalhes === null || registro.detalhes === undefined
      ? null
      : typeof registro.detalhes === "string"
        ? registro.detalhes
        : JSON.stringify(registro.detalhes, null, 2);

  return (
    <div className={styles.overlay} onClick={aoClicarNoOverlay}>
      <div className={styles.drawer} ref={refDialogo} {...propsDialogo}>
        <header className={styles.cabecalho}>
          <div className={styles.cabecalhoTexto}>
            <span className={`${styles.eyebrow} ${styles[`tom_${meta.tom}`]}`}>
              <Icone size={13} strokeWidth={1.75} aria-hidden="true" />
              {meta.categoria}
            </span>
            <h2 id={idTitulo} className={styles.titulo}>
              {meta.titulo}
            </h2>
            <p className={styles.dataExtensa}>{formatarDataExtensa(registro.criadoEm)}</p>
          </div>
          <button type="button" className={styles.fechar} onClick={onClose} aria-label="Fechar">
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.corpo}>
          {meta.descricao && <p className={styles.descricao}>{meta.descricao}</p>}

          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Responsável</h3>
            <p className={styles.valorForte}>{registro.usuarioNome ?? "Sistema"}</p>
            <p className={styles.valorFraco}>
              {automatico
                ? "Ação automática, executada pelo próprio sistema"
                : PERFIS_LEGIVEIS[registro.usuarioPerfil ?? ""] ?? "Perfil não informado"}
            </p>
          </section>

          <section className={styles.bloco}>
            <h3 className={styles.blocoTitulo}>Recurso</h3>
            <p className={styles.valorForte}>{recurso.nome ?? recurso.tipo}</p>
            <p className={styles.valorFraco}>
              {recurso.nome ? [recurso.tipo, recurso.detalhe].filter(Boolean).join(" · ") : "Sem recurso associado"}
            </p>
          </section>

          {temAlteracao && (
            <section className={styles.bloco}>
              <h3 className={styles.blocoTitulo}>Alteração</h3>
              {alteracao.de || alteracao.para ? (
                // Transição empilhada: no detalhe há espaço para o "de" e o "para"
                // ocuparem linhas próprias, o que lê melhor que a seta horizontal da
                // listagem.
                <div className={styles.transicao}>
                  <span className={styles.transicaoDe}>{alteracao.de || "—"}</span>
                  <span className={styles.transicaoSeta} aria-hidden="true">
                    ↓
                  </span>
                  <span className={styles.transicaoPara}>{alteracao.para || "—"}</span>
                  <span className={styles.visuallyHidden}>
                    De {alteracao.de || "não informado"} para {alteracao.para || "não informado"}
                  </span>
                </div>
              ) : (
                <p className={styles.valorForte}>{alteracaoEmTexto(alteracao)}</p>
              )}
            </section>
          )}

          {complementares.length > 0 && (
            <section className={styles.bloco}>
              <h3 className={styles.blocoTitulo}>Contexto</h3>
              <dl className={styles.listaCampos}>
                {complementares.map((campo) => (
                  <div key={campo.rotulo} className={styles.campo}>
                    <dt>{campo.rotulo}</dt>
                    <dd>{campo.valor}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Camada 2: o registro como está no banco. Colapsado por padrão — está aqui
              para suporte e investigação técnica, não para leitura administrativa. */}
          <details className={styles.tecnico}>
            <summary>Detalhes técnicos</summary>
            <dl className={styles.listaCampos}>
              <div className={styles.campo}>
                <dt>Ação interna</dt>
                <dd className={styles.mono}>{registro.acao}</dd>
              </div>
              <div className={styles.campo}>
                <dt>Entidade</dt>
                <dd>
                  {registro.entidade} <span className={styles.valorFraco}>({traduzirRecurso(registro.entidade)})</span>
                </dd>
              </div>
              <div className={styles.campo}>
                <dt>Registrado em</dt>
                <dd className={styles.mono}>{formatarCarimboCompleto(registro.criadoEm)}</dd>
              </div>
              {registro.entidadeId && (
                <div className={styles.campo}>
                  <dt>Identificador interno</dt>
                  <dd>
                    <span className={styles.uuid}>{registro.entidadeId}</span>
                    <BotaoCopiar valor={registro.entidadeId} rotulo="identificador interno" />
                  </dd>
                </div>
              )}
              <div className={styles.campo}>
                <dt>ID do registro</dt>
                <dd>
                  <span className={styles.uuid}>{registro.id}</span>
                  <BotaoCopiar valor={registro.id} rotulo="ID do registro" />
                </dd>
              </div>
            </dl>
            {payload && (
              <>
                <p className={styles.payloadRotulo}>Payload</p>
                <pre className={styles.payload}>{payload}</pre>
              </>
            )}
          </details>
        </div>
      </div>
    </div>
  );
}
