import { vi } from "vitest";

// Rede de segurança GLOBAL (vitest.config → setupFiles): nenhum teste coloca e-mail na fila
// BullMQ `email` de verdade. Essa fila é real (Redis local) e é drenada pelo worker do
// servidor de desenvolvimento via SMTP real — jobs criados por testes acabariam entregues a
// caixas reais (aprovadores do banco de dev). Rotas de reserva, comentário, ocorrência e
// checklist chamam enfileirarEmail; aqui ele vira um mock inspecionável. Suítes que já
// declaram o próprio vi.mock de queue.js continuam valendo (o delas substitui este).
vi.mock("../../services/queue.js", () => ({
  enfileirarEmail: vi.fn(async () => {}),
}));
