import { describe, expect, it } from "vitest";
import type { IntervaloOcupadoDisponibilidade } from "@plataformares/shared";
import {
  chaveCacheDisponibilidade,
  idsDeUsuarioIguais,
  intervaloPertenceAoUsuario,
} from "./disponibilidadeOwnership";

const USUARIO_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USUARIO_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const RESERVA_DE_A: IntervaloOcupadoDisponibilidade = {
  tipo: "reserva",
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  solicitanteId: USUARIO_A,
  inicioMin: 480,
  fimMin: 540,
  status: "agendada",
  setorNome: "TI",
};

describe("ownership da disponibilidade", () => {
  it("marca somente o solicitante real, mesmo para usuários do mesmo setor", () => {
    expect(intervaloPertenceAoUsuario(RESERVA_DE_A, USUARIO_A)).toBe(true);
    expect(intervaloPertenceAoUsuario(RESERVA_DE_A, USUARIO_B)).toBe(false);
  });

  it("compara UUID sem depender da capitalização retornada pelo driver", () => {
    expect(idsDeUsuarioIguais(USUARIO_A.toUpperCase(), USUARIO_A)).toBe(true);
  });

  it("isola A → B → A em chaves de cache por usuário", () => {
    const chaveA = chaveCacheDisponibilidade(USUARIO_A, "2026-09-22");
    const chaveB = chaveCacheDisponibilidade(USUARIO_B, "2026-09-22");
    const chaveANovamente = chaveCacheDisponibilidade(USUARIO_A, "2026-09-22");

    expect(chaveA).not.toBe(chaveB);
    expect(chaveANovamente).toBe(chaveA);
  });
});
