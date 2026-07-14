"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./Admin.module.css";
import { apiFetch } from "../lib/api";

interface Configuracao {
  chave: string;
  valor: string;
  descricao: string | null;
  atualizadoEm: string;
  atualizadoPorId: string | null;
}

const CAMPOS: Array<{ chave: string; label: string; tipo: "numero" | "hora"; sufixo?: string }> = [
  { chave: "antecedencia_minima_horas", label: "Antecedência mínima para reserva", tipo: "numero", sufixo: "horas" },
  { chave: "duracao_maxima_horas", label: "Duração máxima por reserva", tipo: "numero", sufixo: "horas" },
  { chave: "max_pendentes_por_setor", label: "Máximo de pendentes por setor", tipo: "numero", sufixo: "reservas" },
  { chave: "horario_expediente_inicio", label: "Início do expediente", tipo: "hora" },
  { chave: "horario_expediente_fim", label: "Fim do expediente", tipo: "hora" },
  { chave: "sla_aprovacao_urgente_horas", label: "SLA de aprovação urgente", tipo: "numero", sufixo: "horas" },
];

const CAMPO_PARA_CAMPO_API: Record<string, string> = {
  antecedencia_minima_horas: "antecedenciaMinimaHoras",
  duracao_maxima_horas: "duracaoMaximaHoras",
  max_pendentes_por_setor: "maxPendentesPorSetor",
  horario_expediente_inicio: "horarioExpedienteInicio",
  horario_expediente_fim: "horarioExpedienteFim",
  sla_aprovacao_urgente_horas: "slaAprovacaoUrgenteHoras",
};

export function ConfiguracoesClient() {
  const [configuracoes, setConfiguracoes] = useState<Record<string, Configuracao>>({});
  const [valores, setValores] = useState<Record<string, string>>({});
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await apiFetch<Configuracao[]>("/api/v1/configuracoes");
      const mapa: Record<string, Configuracao> = {};
      const valoresIniciais: Record<string, string> = {};
      for (const item of dados) {
        mapa[item.chave] = item;
        valoresIniciais[item.chave] = item.valor;
      }
      setConfiguracoes(mapa);
      setValores(valoresIniciais);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao carregar configurações.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleSalvar() {
    setErro(null);
    setMensagem(null);
    setSalvando(true);
    try {
      const corpo: Record<string, number | string> = {};
      for (const campo of CAMPOS) {
        const campoApi = CAMPO_PARA_CAMPO_API[campo.chave];
        const valor = valores[campo.chave];
        if (valor === undefined) continue;
        corpo[campoApi] = campo.tipo === "numero" ? Number(valor) : valor;
      }
      await apiFetch("/api/v1/configuracoes", {
        method: "PUT",
        body: JSON.stringify(corpo),
      });
      setMensagem("Configurações salvas com sucesso. As novas regras já valem para a próxima reserva criada.");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar configurações.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section>
      <div className={styles.header}>
        <div>
          <h1>Configurações do Sistema</h1>
          <p>Parâmetros aplicados em tempo real na criação de reservas (RF-CFG-01/02)</p>
        </div>
        <button className={styles.btnPrimary} onClick={handleSalvar} disabled={salvando || carregando}>
          {salvando ? "Salvando..." : "Salvar Alterações"}
        </button>
      </div>

      {erro && <div className={styles.error}>{erro}</div>}
      {mensagem && <div className={styles.success}>{mensagem}</div>}

      {carregando ? (
        <div className={styles.empty}>Carregando...</div>
      ) : (
        <div className={styles.configGrid}>
          {CAMPOS.map((campo) => {
            const config = configuracoes[campo.chave];
            return (
              <div key={campo.chave} className={styles.configCard}>
                <label htmlFor={`cfg-${campo.chave}`}>{campo.label}</label>
                <input
                  id={`cfg-${campo.chave}`}
                  type={campo.tipo === "numero" ? "number" : "time"}
                  min={campo.tipo === "numero" ? 0 : undefined}
                  value={valores[campo.chave] ?? ""}
                  onChange={(e) => setValores((atual) => ({ ...atual, [campo.chave]: e.target.value }))}
                />
                {config?.descricao && <small>{config.descricao}</small>}
                {config && (
                  <span className={styles.configMeta}>
                    Última atualização: {new Date(config.atualizadoEm).toLocaleString("pt-BR")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
