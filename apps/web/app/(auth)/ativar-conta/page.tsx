"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Check } from "lucide-react";
import { apenasDigitosTelefone, MENSAGEM_TELEFONE_INVALIDO, telefoneValido } from "@plataformares/shared";
import styles from "../../../components/auth/AuthForm.module.css";
import { AuthStepper } from "../../../components/auth/AuthStepper";
import { CodeField, PasswordField, SelectField, TextField } from "../../../components/auth/AuthFields";
import { PasswordStrength, senhaAtendeRequisitos } from "../../../components/auth/PasswordStrength";
import { useResendCooldown } from "../../../components/auth/useResendCooldown";
import { mascararEmail } from "../../../components/auth/mascararEmail";
import { DicaCaixaOutros } from "../../../components/auth/DicaCaixaOutros";
import { apiFetch, mensagemDeErro } from "../../../lib/api";

const ETAPAS = ["Identificação", "Código e senha", "Conta ativa"];

type Etapa = 0 | 1 | 2;

interface Setor {
  id: string;
  nome: string;
}

interface AtivarContaResponse {
  mensagem: string;
  nome?: string;
  setorNome?: string | null;
}

export default function AtivarContaPage() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<Etapa>(0);
  const [nome, setNome] = useState("");
  const [setorId, setSetorId] = useState("");
  const [email, setEmail] = useState("");
  const [telefone, setTelefone] = useState("");
  const [telefoneTocado, setTelefoneTocado] = useState(false);
  const [codigo, setCodigo] = useState("");
  const [senha, setSenha] = useState("");
  const [confirmarSenha, setConfirmarSenha] = useState("");
  const [setores, setSetores] = useState<Setor[]>([]);
  // "erro" existe porque o estado antigo (fetch falha uma vez, dropdown fica vazio para
  // sempre, sem nenhum aviso) é indistinguível, do lado do usuário, de "os setores
  // simplesmente não carregaram" — parecia um bug intermitente porque cada teste novo
  // (aba nova, F5) tinha uma nova chance de dar certo, mas uma aba que pegou a falha uma
  // vez ficava presa nesse estado até ser recarregada manualmente.
  const [setoresStatus, setSetoresStatus] = useState<"carregando" | "ok" | "erro">("carregando");
  // Espelha `setoresStatus` num ref: o listener de foco/visibilidade é anexado uma única
  // vez (deps `[]`) e leria sempre o valor inicial da state via closure obsoleta —
  // refazendo fetch a cada vez que a aba ganha foco, mesmo já tendo carregado com sucesso.
  const setoresStatusRef = useRef(setoresStatus);
  setoresStatusRef.current = setoresStatus;
  const [erro, setErro] = useState<string | null>(null);
  const [erroCodigo, setErroCodigo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  // Separado de `carregando` (que pertence ao formulário da etapa): sem isto, dois cliques
  // rápidos em "Reenviar código" disparavam duas requisições antes do cooldown existir —
  // o backend agora coalesce isso (lock de 30s em otp.service.ts), mas o clique duplo
  // também não deveria nem sair do navegador.
  const [reenviando, setReenviando] = useState(false);
  const [setorNomeFinal, setSetorNomeFinal] = useState<string | null>(null);
  const cooldown = useResendCooldown();

  // Setores vêm da lista pública (GET /setores/publicos) — nunca hardcoded. Obrigatório:
  // o autocadastro (POST /auth/cadastrar) precisa de um setor real para criar a conta como
  // colaborador (RN-USR-01). Com retry automático (3 tentativas) e refetch ao voltar para a
  // aba: sem isso, uma falha de rede/timing na primeira tentativa (API ainda subindo, rede
  // instável) deixava o dropdown vazio pelo resto da vida daquela aba, sem nenhum aviso —
  // o usuário só via "não tem nada pra selecionar" e um F5 (ou aba nova) mascarava o
  // problema, fazendo parecer que "às vezes funciona, às vezes não".
  useEffect(() => {
    const controlador = new AbortController();
    let cancelado = false;

    async function carregarSetores() {
      setSetoresStatus("carregando");
      const TENTATIVAS = 3;
      for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
        try {
          const dados = await apiFetch<Setor[]>("/api/v1/setores/publicos", { signal: controlador.signal });
          if (cancelado) return;
          setSetores(dados);
          setSetoresStatus("ok");
          return;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (tentativa < TENTATIVAS) {
            await new Promise((resolve) => setTimeout(resolve, tentativa * 800));
            continue;
          }
          if (!cancelado) setSetoresStatus("erro");
        }
      }
    }

    carregarSetores();

    // Aba deixada aberta desde antes da API subir (ou de uma falha de rede) se recupera
    // sozinha ao voltar o foco — sem exigir que o usuário perceba o problema e dê F5.
    function aoVoltarFoco() {
      if (document.visibilityState === "visible" && setoresStatusRef.current !== "ok") {
        carregarSetores();
      }
    }
    document.addEventListener("visibilitychange", aoVoltarFoco);
    window.addEventListener("focus", aoVoltarFoco);

    return () => {
      cancelado = true;
      controlador.abort();
      document.removeEventListener("visibilitychange", aoVoltarFoco);
      window.removeEventListener("focus", aoVoltarFoco);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clique manual em "Tentar novamente" (só aparece quando setoresStatus === "erro"):
  // tentativa avulsa, sem o retry embutido do efeito acima (o usuário já pediu de novo).
  async function tentarNovamenteSetores(): Promise<void> {
    setSetoresStatus("carregando");
    try {
      const dados = await apiFetch<Setor[]>("/api/v1/setores/publicos");
      setSetores(dados);
      setSetoresStatus("ok");
    } catch {
      setSetoresStatus("erro");
    }
  }

  // Etapa 0: autocadastro — cria a conta (perfil sempre colaborador) se ainda não existir,
  // ou reenvia se já houver um cadastro pendente. Antes disso exigia um Admin ter criado a
  // conta primeiro; agora o próprio usuário se cadastra e o código já sai automaticamente.
  async function cadastrar(): Promise<void> {
    await apiFetch("/api/v1/auth/cadastrar", {
      method: "POST",
      // Normalizado (só dígitos) — a máscara "(31) 99999-9999" é só apresentação; o
      // dado persistido não carrega formatação, que pode variar por como cada pessoa digita.
      body: JSON.stringify({
        nome: nome.trim(),
        email: email.trim(),
        telefone: apenasDigitosTelefone(telefone),
        setorId,
      }),
    });
  }

  // Etapa 1: reenvio para uma conta que já existe (criada pela etapa 0 ou por um Admin).
  async function reenviarCodigo(): Promise<void> {
    await apiFetch("/api/v1/auth/ativar-conta/reenviar", {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), nome: nome.trim(), setorId }),
    });
  }

  async function handleEnviarCodigo(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      await cadastrar();
      cooldown.iniciar();
      setEtapa(1);
    } catch (err) {
      // A API só responde sucesso depois de o e-mail sair de fato, então uma falha aqui
      // significa que o código não chegará — o usuário fica nesta etapa em vez de ser
      // mandado para uma tela pedindo um código inexistente.
      setErro(mensagemDeErro(err, "Não foi possível enviar o código. Tente novamente."));
    } finally {
      setCarregando(false);
    }
  }

  async function handleReenviar() {
    if (reenviando || cooldown.emCooldown) return;
    setErro(null);
    setAviso(null);
    setReenviando(true);
    try {
      await reenviarCodigo();
      cooldown.iniciar();
      setAviso("Código enviado para seu e-mail.");
    } catch (err) {
      setErro(mensagemDeErro(err, "Não foi possível enviar o código. Tente novamente."));
    } finally {
      setReenviando(false);
    }
  }

  async function handleAtivar(event: FormEvent) {
    event.preventDefault();
    setErro(null);
    setErroCodigo(null);
    if (senha !== confirmarSenha) {
      setErro("As senhas não coincidem.");
      return;
    }
    setCarregando(true);
    try {
      const resposta = await apiFetch<AtivarContaResponse>("/api/v1/auth/ativar-conta", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), codigo, senha }),
      });
      setSetorNomeFinal(resposta.setorNome ?? null);
      setEtapa(2);
    } catch (err) {
      const mensagem = mensagemDeErro(err, "Não foi possível ativar a conta.");
      // Erros sobre o código aparecem junto do campo; o resto vai para o alerta do topo.
      if (/código/i.test(mensagem)) setErroCodigo(mensagem);
      else setErro(mensagem);
    } finally {
      setCarregando(false);
    }
  }

  const erroTelefone = !telefone.trim()
    ? "Informe um telefone."
    : !telefoneValido(telefone)
      ? MENSAGEM_TELEFONE_INVALIDO
      : null;
  const erroTelefoneExibido = telefoneTocado ? erroTelefone : null;

  if (etapa === 2) {
    return (
      <>
        <AuthStepper etapas={ETAPAS} etapaAtual={2} />
        <span className={styles.successIcon} aria-hidden="true">
          <Check size={22} strokeWidth={2.5} />
        </span>
        <div className={styles.header}>
          <h1 className={styles.title}>Conta ativada</h1>
          <p className={styles.subtitle}>
            {setorNomeFinal
              ? `Seu acesso ao setor ${setorNomeFinal} foi liberado. Você já pode acessar a plataforma e reservar equipamentos.`
              : "Seu acesso foi liberado. Você já pode acessar a plataforma e reservar equipamentos."}
          </p>
        </div>
        <div className={styles.successActions}>
          <button className={styles.submit} type="button" onClick={() => router.push("/login")}>
            Ir para o login
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <AuthStepper etapas={ETAPAS} etapaAtual={etapa} />

      {etapa === 0 && (
        <>
          <div className={styles.header}>
            <h1 className={styles.title}>Criar conta</h1>
            <p className={styles.subtitle}>
              Informe seus dados de operação com seu e-mail corporativo. Enviaremos um código de
              verificação de 6 dígitos para confirmar que é você.
            </p>
          </div>

          <form className={styles.form} onSubmit={handleEnviarCodigo} noValidate>
            {erro && (
              <div className={styles.alertErro} role="alert">
                <AlertCircle size={16} />
                <span>{erro}</span>
              </div>
            )}

            <div className={styles.pairGrid}>
              <TextField
                id="nome"
                label="Nome completo"
                value={nome}
                onChange={setNome}
                placeholder="Caio Moraes"
                autoComplete="name"
                autoFocus
              />
              <SelectField
                id="setor"
                label="Setor"
                value={setorId}
                onChange={setSetorId}
                opcoes={setores.map((setor) => ({ value: setor.id, label: setor.nome }))}
                placeholder={setoresStatus === "carregando" ? "Carregando setores…" : "Selecione…"}
                disabled={setoresStatus !== "ok"}
                hint={
                  setoresStatus === "erro" ? (
                    <>
                      Não foi possível carregar a lista de setores.{" "}
                      <button type="button" className={styles.linkButton} onClick={tentarNovamenteSetores}>
                        Tentar novamente
                      </button>
                    </>
                  ) : undefined
                }
              />
            </div>

            <TextField
              id="email"
              label="E-mail corporativo"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="nome@metalsider.com.br"
              value={email}
              onChange={setEmail}
            />

            <TextField
              id="telefone"
              label="Número de celular / contato"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="(31) 99999-9999"
              value={telefone}
              onChange={setTelefone}
              erro={erroTelefoneExibido}
            />

            <div className={styles.actions}>
              <button
                className={styles.submit}
                type="submit"
                onClick={() => setTelefoneTocado(true)}
                disabled={carregando || !nome.trim() || !setorId || !email.trim() || !!erroTelefone}
              >
                {carregando && <span className={styles.spinner} aria-hidden="true" />}
                {carregando ? "Enviando código..." : "Enviar código"}
              </button>
              <Link href="/login" className={styles.inlineLink}>
                Voltar ao login
              </Link>
            </div>
          </form>
        </>
      )}

      {etapa === 1 && (
        <>
          <div className={styles.header}>
            <h1 className={styles.title}>Confirme e defina sua senha</h1>
            <p className={styles.subtitle}>
              Enviamos um código de 6 dígitos para{" "}
              <span className={styles.maskedEmail}>{mascararEmail(email)}</span>. Informe-o e crie a
              senha do seu primeiro acesso.
            </p>
            <DicaCaixaOutros />
          </div>

          <form className={styles.form} onSubmit={handleAtivar} noValidate>
            {erro && (
              <div className={styles.alertErro} role="alert">
                <AlertCircle size={16} />
                <span>{erro}</span>
              </div>
            )}
            {aviso && !erro && (
              <div className={styles.alertOk} role="status">
                <Check size={16} />
                <span>{aviso}</span>
              </div>
            )}

            <CodeField
              id="codigo"
              label="Código de verificação"
              value={codigo}
              onChange={(valor) => {
                setCodigo(valor);
                setErroCodigo(null);
              }}
              autoFocus
              erro={erroCodigo}
              hint="Válido por 15 minutos, uso único."
            />

            <div className={styles.pairGrid}>
              <PasswordField
                id="senha"
                label="Nova senha"
                value={senha}
                onChange={setSenha}
                autoComplete="new-password"
              />
              <PasswordField
                id="confirmarSenha"
                label="Confirmar senha"
                value={confirmarSenha}
                onChange={setConfirmarSenha}
                autoComplete="new-password"
              />
            </div>

            <PasswordStrength senha={senha} />

            <div className={styles.actions}>
              <button
                className={styles.submit}
                type="submit"
                disabled={
                  carregando ||
                  codigo.length !== 6 ||
                  !senhaAtendeRequisitos(senha) ||
                  senha !== confirmarSenha
                }
              >
                {carregando && <span className={styles.spinner} aria-hidden="true" />}
                {carregando ? "Ativando..." : "Ativar conta"}
              </button>
              <button
                type="button"
                className={styles.linkButton}
                onClick={handleReenviar}
                disabled={cooldown.emCooldown || reenviando}
              >
                {cooldown.emCooldown
                  ? `Reenviar código em ${cooldown.segundosRestantes}s`
                  : reenviando
                    ? "Enviando..."
                    : "Reenviar código"}
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
