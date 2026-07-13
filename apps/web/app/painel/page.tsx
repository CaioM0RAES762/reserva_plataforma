import { Suspense } from "react";
import { PainelClient } from "./PainelClient";

// RF-TV-01: rota isolada, sem sidebar/topbar (fora do grupo (app), que exige cookie de
// sessão) — autenticação é por token de dispositivo na querystring, não por usuário.
export default function PainelPage() {
  return (
    <Suspense fallback={null}>
      <PainelClient />
    </Suspense>
  );
}
