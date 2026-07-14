Especificação Técnica — Dashboard PlataformaRes
1. Paleta de Cores (OKLCH)
Toda a paleta é definida em src/styles.css via @theme inline + :root. Nenhum valor é hard-coded nos componentes — tudo passa por tokens semânticos.

1.1 Base — Papel & Tinta
Token	Valor OKLCH	Aproximação HEX	Uso
--paper	oklch(0.982 0.004 85)	#FBFAF6	Fundo principal da página (off-white quente)
--paper-elev	oklch(0.995 0.003 85)	#FEFDFB	Cards, superfícies elevadas
--ink	oklch(0.19 0.012 65)	#221F1B	Texto primário, botões primários
--ink-muted	oklch(0.48 0.014 65)	#6E6961	Texto secundário, labels
--hairline	oklch(0.88 0.008 75)	#DEDAD1	Todas as bordas (1px)
1.2 Sinalização (Signal Colors)
Token	Valor	HEX aprox	Uso
--safety	oklch(0.68 0.16 55)	#D97A3B	Âmbar industrial — ações críticas, NR-18/35, badge do logo
--safety-soft	oklch(0.94 0.06 70)	#F7E6D0	Fundo do card de checklist pendente
--hazard	oklch(0.58 0.21 27)	#D9412A	Vermelho de risco — alertas, SLA atrasado, marcador "AGORA"
--signal	oklch(0.62 0.14 155)	#3E9E6A	Verde disponível — status disponível, tendência positiva
--caution	oklch(0.75 0.14 90)	#D4B341	Amarelo cautela (reserva)
1.3 Charts (Recharts)
Token	Valor	Uso
--chart-1	var(--safety)	Série "Reservas" (âmbar)
--chart-2	var(--signal)	"Concluídas" alternativo
--chart-3	oklch(0.5 0.09 240)	Azul industrial — série "Concluídas" e badge "Em uso"
--chart-4	var(--caution)	Amarelo
--chart-5	var(--hazard)	Vermelho
1.4 Sidebar (tema escuro embarcado)
Token	Valor	Uso
--sidebar	oklch(0.16 0.01 65)	Fundo grafite (quase preto quente)
--sidebar-foreground	oklch(0.86 0.008 75)	Texto padrão dos itens
--sidebar-accent	oklch(0.22 0.012 65)	Fundo do item ativo / hover
--sidebar-border	oklch(0.26 0.012 65)	Divisores internos
--sidebar-primary	var(--safety)	Barra lateral do item ativo, badge do logo
2. Tipografia
2.1 Famílias carregadas
Carregadas via <link> no __root.tsx (Google Fonts):

IBM Plex Sans     400, 500, 600, 700   — UI, corpo
IBM Plex Mono     400, 500, 600        — números, códigos (PLT-001), horários, KPIs
Instrument Serif  400 (regular)        — display / hero
Tokens:

--font-sans: "IBM Plex Sans"
--font-mono: "IBM Plex Mono"
--font-display: "Instrument Serif"
2.2 Escala aplicada
Elemento	Fonte	Tamanho	Peso	Tracking	Uso
H1 hero	Display (serif)	text-5xl md / text-6xl lg (48–60px)	400	tracking-tight (-0.01em)	"Boa tarde, Ricardo."
H2 seções	Display (serif)	text-2xl (24px)	400	normal	"Agenda em curso", "Status em tempo real"
Logo brand	Display (serif)	text-lg (18px)	400	normal	"PlataformaRes"
Eyebrow / label	Sans	text-[10px] / text-[11px]	400	tracking-[0.2em] uppercase	"OPERAÇÕES · HOJE"
Corpo padrão	Sans	text-sm (14px)	400	normal	Texto de lista, tabela
Meta / hint	Sans	text-[11px] (11px)	400	normal	Subtítulos cinza
KPI número	Mono	text-3xl (30px)	400, tabular-nums	normal	"4", "1", "3"
Códigos / hora	Mono	text-[11px]–text-sm	400	normal	"PLT-001", "18:30", "14:37"
Botões	Sans	text-sm (14px)	500	normal	Todos os CTAs
Kbd (⌘K)	Mono	text-[10px]	400	normal	Atalho de busca
Font features: body { font-feature-settings: "ss01","cv11" } + .tabular-nums { font-variant-numeric: tabular-nums } em todos os números para alinhar as colunas.

3. Espessuras, Raios e Escala de Espaço
3.1 Bordas
Espessura única: 1px (border)
Cor sempre --hairline (via * { border-color: var(--color-border) })
Nenhum card usa sombra — a hierarquia vem de bordas + variação de fundo (--paper vs --paper-elev)
Marcador vertical de destaque: barra w-1 (4px) na cor do sinal — usada no card de conformidade e no item ativo do sidebar (w-0.5, 2px, na cor --safety)
3.2 Border radius (deliberadamente pequeno = feel industrial)
--radius: 0.375rem  (6px, base)
--radius-sm: 2px    (usado na maioria dos cards, botões, badges)
--radius-md: 4px
--radius-lg: 6px
Praticamente todo componente usa rounded-sm (2px). Avatares circulares são rounded-full.

3.3 Espaçamento
Contexto	Valor Tailwind	Pixels
Padding lateral do main	px-8	32px
Padding vertical do main	py-8	32px
Gap entre seções principais	space-y-8	32px
Gap do grid principal	gap-6	24px
Padding interno de card (header)	px-6 pt-5 pb-4	24 / 20 / 16
Padding interno de card (body)	p-6 ou px-6 py-4	24 / 16
Gap em listas	divide-y + py-3/py-4	12–16px vertical
Height do TopBar	h-16	64px
Height dos botões	h-10 (grande) / h-8 (inline)	40 / 32
3.4 Largura máxima
Página principal: max-w-[1600px] no <main>
Barra de busca: w-96 (384px)
4. Layout Geral
4.1 Estrutura raiz
<div class="flex min-h-screen">
  <Sidebar />        ← w-64 (256px), fixa
  <div flex-1 flex-col min-w-0>
    <TopBar />       ← h-16 sticky top-0 z-20
    <main>           ← px-8 py-8, space-y-8
      <Hero />
      <KpiStrip />
      <grid cols-12 gap-6>
        <TodayOperations col-span-8 />
        <FleetStatus     col-span-4 />
      </grid>
      <grid cols-12 gap-6>
        <ApprovalsQueue  col-span-8 />
        <ChecklistAlert  col-span-4 />
      </grid>
      <grid cols-12 gap-6>
        <TrendCard       col-span-7 />
        <UtilizationCard col-span-5 />
      </grid>
      <SectorTable />
      <Footer />
    </main>
  </div>
</div>
Grade base: 12 colunas em todas as fileiras (grid-cols-12), com breakpoint lg: (1024px) para promover para multi-coluna. No mobile, tudo empilha em col-span-12.

4.2 Sidebar (w-64 fixa, tema escuro)
Estrutura vertical em 4 blocos separados por border-b border-sidebar-border/60:

Brand (px-5 pt-6 pb-5) — quadrado 36×36 âmbar com "PR" em mono + wordmark serif + eyebrow uppercase.
Perfil (px-5 py-4) — avatar circular 36×36 + nome + turno.
Nav (px-3 py-4, flex-1 overflow-y-auto) — 2 grupos ("Operação" / "Administração") separados por eyebrow com tracking-[0.2em]. Itens têm ícone 16×16 (strokeWidth={1.75}), texto text-sm, badge opcional mono text-[10px]. Item ativo: fundo sidebar-accent + barra vertical w-0.5 h-4 âmbar à direita.
System status (px-5 py-4) — dot verde pulsante + versão + SLA em mono text-[11px].
4.3 TopBar (h-16, sticky, bg-paper/80 backdrop-blur, z-20)
Grade em duas metades (justify-between):

Esquerda: breadcrumb ("CENTRAL › Visão do Administrador") + campo de busca w-96 com ícone lucide Search 16px + input transparente + kbd ⌘K.
Direita: relógio ao vivo em mono com dot verde pulsante · sino com dot vermelho no canto · divisor border-l · nome + role + avatar 32×32 preto.
Divisores verticais entre grupos usam border-l border-hairline pl-4.

4.4 Hero
Grade grid-cols-12. Coluna 8: eyebrow uppercase (data + semana) + H1 serif em duas linhas — segunda linha em itálico text-ink-muted (contexto acionável). Coluna 4: dois botões alinhados à direita (Exportar briefing outline + Abrir fila de aprovações sólido escuro com seta).

4.5 KPI Strip
Uma única faixa grid-cols-6 (desktop) dentro de um card com borda. Cada célula:

Barra de acento superior h-0.5 w-8 na cor do KPI (signal / safety / hazard / chart-3 / ink)
Label eyebrow · Número mono 30px · Sub em cinza · Trend em mono 11px
Divisores verticais via border-l border-hairline (não bordas duplas)
4.6 Card de operações (Timeline)
Header: eyebrow + H2 + legenda de cores à direita
Régua de horas 07:00–17:00 (11 slots), calculada por posição relativa: left = ((h + m/60 - 7) / 11) * 100%
Lane: h-16, com barras absolutas coloridas por status (bg-chart-3/90 em uso, bg-signal/25 concluída, bg-safety/20 checklist)
Marcador AGORA: linha vertical w-px bg-hazard posicionada em nowX% com label mono flutuante
Lista abaixo em divide-y com horário mono à esquerda + descrição + pill de status à direita
4.7 Card de frota
Lista divide-y. Cada linha: dot colorido + código mono à esquerda; label de status + detalhe temporal à direita. Rodapé com "última sincronização" e link com ArrowUpRight.

4.8 Card de alerta (Checklist NR)
Borda border-safety/50, fundo bg-safety-soft/40, barra esquerda absoluta w-1 bg-safety
Ícone AlertTriangle 20px em quadrado âmbar 36×36
Corpo com detalhe da reserva + lista de itens do checklist com bullets circulares 1×1
Dois CTAs: "Iniciar checklist" sólido bg-ink text-paper + "Delegar" outline
4.9 Tabelas (Aprovações / Setores)
Header em eyebrow uppercase text-[10px] tracking-[0.16em] text-ink-muted
Linhas com hover:bg-secondary/50, divide-y divide-hairline
Números sempre em mono tabular-nums
Badges de risco: pill retangular rounded-sm com borda âmbar + fundo safety/15
Botões inline h-8 text-xs (Rever outline / Aprovar sólido escuro)
5. Configuração dos Gráficos (Recharts)
5.1 AreaChart — "Reservas x Concluídas"
<AreaChart data={trend} margin={{ top:10, right:20, left:20, bottom:10 }}>
  <defs>
    <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stopColor="oklch(0.68 0.16 55)" stopOpacity={0.35} />
      <stop offset="100%" stopColor="oklch(0.68 0.16 55)" stopOpacity={0}    />
    </linearGradient>
    <linearGradient id="gB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stopColor="oklch(0.5 0.09 240)" stopOpacity={0.25} />
      <stop offset="100%" stopColor="oklch(0.5 0.09 240)" stopOpacity={0}    />
    </linearGradient>
  </defs>
  <CartesianGrid strokeDasharray="2 4" stroke="oklch(0.88 0.008 75)" vertical={false} />
  <XAxis dataKey="m" stroke="oklch(0.48 0.014 65)" tickLine={false} axisLine={false} fontSize={11} />
  <YAxis          stroke="oklch(0.48 0.014 65)" tickLine={false} axisLine={false} fontSize={11} width={30} />
  <Tooltip contentStyle={{ background:"oklch(0.19 0.012 65)", border:"none", borderRadius:2, color:"#fff", fontSize:12 }} />
  <Area type="monotone" dataKey="reservas"   stroke="oklch(0.68 0.16 55)" strokeWidth={2} fill="url(#gA)" />
  <Area type="monotone" dataKey="concluidas" stroke="oklch(0.5 0.09 240)" strokeWidth={2} fill="url(#gB)" />
</AreaChart>
Container: h-72 (288px)
Grid: só horizontais, tracejado 2 4
Axes sem linhas nem ticks — só rótulos 11px cinza
Curva monotone, stroke 2px, preenchimento em degradê com opacidade descendente
Tooltip escuro (--ink) invertido — contrasta com o papel
5.2 Barras de utilização (custom, sem Recharts)
Cada linha: label mono + % mono à direita, seguida de trilho h-1.5 bg-secondary rounded-sm com fill colorido pela regra:

> 70% → bg-safety (âmbar — alta demanda)
> 40% → bg-chart-3 (azul — saudável)
≤ 40% → bg-ink/40 (cinza — subutilizado)
5.3 Barra de distribuição (Ranking de setores)
Trilho h-1 bg-secondary com fill bg-ink proporcional a share. Coluna ocupa 50% da largura da tabela.

6. Iconografia
Biblioteca: lucide-react
Tamanho padrão: 16px (h-4 w-4) na sidebar e botões, 20px (h-5 w-5) em alertas, 12px (h-3 w-3) em micro-badges
Peso: strokeWidth={1.75} na sidebar (linhas mais finas, feel editorial), padrão (2) nos outros
Ícones usados: LayoutDashboard, ConstructionIcon, CalendarDays, CalendarClock, ClipboardCheck, ClipboardList, History, BarChart3, Users, Building2, Settings, FileSearch, MonitorPlay, Ban, Bell, ChevronRight, ArrowUpRight, ArrowRight, AlertTriangle, ShieldCheck, CheckCircle2, Radio, Search, Command
7. Princípios de composição
Sem sombras. Hierarquia por bordas 1px + diferença de fundo papel/papel-elev.
Cantos quase retos (2px) — remete a equipamento industrial, não SaaS genérico.
Números em mono tabular em toda parte que envolva quantidade/hora/código.
Serif de display + sans neutra para tensão editorial × engenharia.
Uma cor de acento (âmbar) reservada a atenção; verde/vermelho só para semântica (disponível/risco).
Eyebrows uppercase com tracking-[0.2em] acima de todos os títulos de seção — vocabulário de relatório técnico.
Ações inline (Aprovar / Iniciar / Rever) direto nas linhas — o admin não precisa navegar para decidir.