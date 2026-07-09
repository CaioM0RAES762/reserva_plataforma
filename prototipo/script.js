/* ============================================
   PlataformaRes — Sistema de Reservas
   script.js — Lógica principal do protótipo
   ============================================ */

'use strict';

// ============================================================
// DADOS INICIAIS MOCKADOS
// ============================================================

const SECTORS = [
  { id: 'ti',             name: 'TI',             color: '#2563EB' },
  { id: 'manutencao',     name: 'Manutenção',      color: '#D97706' },
  { id: 'limpeza',        name: 'Limpeza',         color: '#16A34A' },
  { id: 'producao',       name: 'Produção',        color: '#DC2626' },
  { id: 'administrativo', name: 'Administrativo',  color: '#7C3AED' },
  { id: 'seguranca',      name: 'Segurança',       color: '#0E7490' },
  { id: 'rh',             name: 'RH',              color: '#BE185D' },
  { id: 'qualidade',      name: 'Qualidade',       color: '#065F46' },
];

const INITIAL_PLATFORMS = [
  { id: 'PLT001', code: 'PLT-001', name: 'Plataforma Elevatória A',     location: 'Galpão A, Piso 1', capacity: '500 kg',    status: 'disponivel',  notes: 'Revisão trimestral em dia.' },
  { id: 'PLT002', code: 'PLT-002', name: 'Plataforma Elevatória B',     location: 'Galpão A, Piso 2', capacity: '500 kg',    status: 'reservada',   notes: '' },
  { id: 'PLT003', code: 'PLT-003', name: 'Andaime Tubular 01',          location: 'Galpão B',         capacity: '10 pessoas',status: 'disponivel',  notes: 'Verificar fixação antes do uso.' },
  { id: 'PLT004', code: 'PLT-004', name: 'Andaime Tubular 02',          location: 'Galpão B',         capacity: '10 pessoas',status: 'manutencao',  notes: 'Aguardando peças para reparo.' },
  { id: 'PLT005', code: 'PLT-005', name: 'Plataforma Hidráulica X1',    location: 'Pátio Externo',    capacity: '800 kg',    status: 'disponivel',  notes: '' },
  { id: 'PLT006', code: 'PLT-006', name: 'Plataforma Hidráulica X2',    location: 'Pátio Externo',    capacity: '800 kg',    status: 'disponivel',  notes: 'Uso apenas por pessoal habilitado.' },
  { id: 'PLT007', code: 'PLT-007', name: 'Sala de Reuniões 01',         location: 'Bloco Adm, S.101', capacity: '12 pessoas',status: 'disponivel',  notes: '' },
  { id: 'PLT008', code: 'PLT-008', name: 'Sala de Reuniões 02',         location: 'Bloco Adm, S.102', capacity: '8 pessoas', status: 'inativa',     notes: 'Em reforma até próximo mês.' },
];

// Gera datas relativas ao dia de hoje para os mocks
function today(offsetDays = 0, h = '08', m = '00') {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const INITIAL_RESERVATIONS = [
  {
    id: 'RES001',
    sector: 'ti',
    responsible: 'Carlos Mendes',
    platformId: 'PLT001',
    date: today(0),
    timeStart: '08:00',
    timeEnd:   '11:00',
    motive: 'Manutenção em infraestrutura de rede no Galpão A — troca de cabeamento e patch panels.',
    priority: 'alta',
    status: 'em_uso',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: 'RES002',
    sector: 'producao',
    responsible: 'Ana Paula Silva',
    platformId: 'PLT002',
    date: today(0),
    timeStart: '13:00',
    timeEnd:   '17:00',
    motive: 'Instalação de novo equipamento de esteira no setor 3.',
    priority: 'normal',
    status: 'agendada',
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
  {
    id: 'RES003',
    sector: 'manutencao',
    responsible: 'Roberto Lima',
    platformId: 'PLT005',
    date: today(1),
    timeStart: '07:00',
    timeEnd:   '12:00',
    motive: 'Reparo em telhado do Galpão B — substituição de telhas danificadas.',
    priority: 'urgente',
    status: 'agendada',
    createdAt: new Date(Date.now() - 86400000 * 1).toISOString(),
  },
  {
    id: 'RES004',
    sector: 'seguranca',
    responsible: 'Fábio Alves',
    platformId: 'PLT006',
    date: today(1),
    timeStart: '14:00',
    timeEnd:   '16:00',
    motive: 'Inspeção e calibração de câmeras no perímetro externo.',
    priority: 'normal',
    status: 'agendada',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'RES005',
    sector: 'administrativo',
    responsible: 'Mariana Costa',
    platformId: 'PLT007',
    date: today(2),
    timeStart: '09:00',
    timeEnd:   '11:00',
    motive: 'Reunião trimestral de diretoria.',
    priority: 'alta',
    status: 'agendada',
    createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
  },
  {
    id: 'RES006',
    sector: 'qualidade',
    responsible: 'Patrícia Nunes',
    platformId: 'PLT003',
    date: today(3),
    timeStart: '10:00',
    timeEnd:   '14:00',
    motive: 'Auditoria interna de processos produtivos no Galpão B.',
    priority: 'normal',
    status: 'agendada',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: 'RES007',
    sector: 'limpeza',
    responsible: 'João Ferreira',
    platformId: 'PLT001',
    date: today(-3),
    timeStart: '06:00',
    timeEnd:   '09:00',
    motive: 'Limpeza e desinfecção de altura no Galpão A.',
    priority: 'normal',
    status: 'concluida',
    createdAt: new Date(Date.now() - 86400000 * 7).toISOString(),
  },
  {
    id: 'RES008',
    sector: 'ti',
    responsible: 'Lucas Souza',
    platformId: 'PLT005',
    date: today(-5),
    timeStart: '13:00',
    timeEnd:   '18:00',
    motive: 'Instalação de antenas de WiFi industrial no pátio.',
    priority: 'alta',
    status: 'concluida',
    createdAt: new Date(Date.now() - 86400000 * 10).toISOString(),
  },
  {
    id: 'RES009',
    sector: 'rh',
    responsible: 'Sandra Oliveira',
    platformId: 'PLT007',
    date: today(-2),
    timeStart: '14:00',
    timeEnd:   '16:00',
    motive: 'Treinamento de integração de novos colaboradores.',
    priority: 'normal',
    status: 'concluida',
    createdAt: new Date(Date.now() - 86400000 * 8).toISOString(),
  },
  {
    id: 'RES010',
    sector: 'producao',
    responsible: 'Eduardo Santos',
    platformId: 'PLT006',
    date: today(-1),
    timeStart: '07:00',
    timeEnd:   '09:00',
    motive: 'Manutenção preventiva de compressores externos.',
    priority: 'normal',
    status: 'cancelada',
    createdAt: new Date(Date.now() - 86400000 * 4).toISOString(),
  },
];

// ============================================================
// PERFIS DE USUÁRIO
// ============================================================

const PROFILES = [
  {
    id: 'admin',
    name: 'Administrador',
    role: 'Admin',
    sector: null,
    color: '#2563EB',
    canManagePlatforms: true,
    canViewAll: true,
    canCancelAny: true,
  },
  {
    id: 'ti',
    name: 'Carlos Mendes',
    role: 'Analista TI',
    sector: 'ti',
    color: '#2563EB',
    canManagePlatforms: false,
    canViewAll: false,
    canCancelAny: false,
  },
  {
    id: 'producao',
    name: 'Ana Paula Silva',
    role: 'Supervisora Produção',
    sector: 'producao',
    color: '#DC2626',
    canManagePlatforms: false,
    canViewAll: false,
    canCancelAny: false,
  },
  {
    id: 'manutencao',
    name: 'Roberto Lima',
    role: 'Técnico Manutenção',
    sector: 'manutencao',
    color: '#D97706',
    canManagePlatforms: false,
    canViewAll: false,
    canCancelAny: false,
  },
];

// ============================================================
// ESTADO DA APLICAÇÃO
// ============================================================

let state = {
  platforms: [],
  reservations: [],
  currentPage: 'dashboard',
  currentProfile: PROFILES[0],
  editingPlatformId: null,
  editingReservationId: null,
  calendarWeekOffset: 0,
};

// ============================================================
// PERSISTÊNCIA (localStorage)
// ============================================================

function saveState() {
  try {
    localStorage.setItem('plataformares_platforms', JSON.stringify(state.platforms));
    localStorage.setItem('plataformares_reservations', JSON.stringify(state.reservations));
  } catch (e) {
    console.warn('localStorage não disponível:', e);
  }
}

function loadState() {
  try {
    const p = localStorage.getItem('plataformares_platforms');
    const r = localStorage.getItem('plataformares_reservations');
    if (p) state.platforms = JSON.parse(p);
    else state.platforms = JSON.parse(JSON.stringify(INITIAL_PLATFORMS));
    if (r) state.reservations = JSON.parse(r);
    else state.reservations = JSON.parse(JSON.stringify(INITIAL_RESERVATIONS));
  } catch (e) {
    state.platforms = JSON.parse(JSON.stringify(INITIAL_PLATFORMS));
    state.reservations = JSON.parse(JSON.stringify(INITIAL_RESERVATIONS));
  }
}

// ============================================================
// UTILITÁRIOS
// ============================================================

function getSector(id) {
  return SECTORS.find(s => s.id === id) || { name: id, color: '#6B7280' };
}

function getPlatform(id) {
  return state.platforms.find(p => p.id === id);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateFull(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  const names = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return `${parseInt(d)} ${names[parseInt(m) - 1]} ${y}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function genId(prefix) {
  return prefix + Date.now().toString(36).toUpperCase();
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// ============================================================
// STATUS BADGE / PRIORIDADE
// ============================================================

const STATUS_LABELS = {
  disponivel:  'Disponível',
  reservada:   'Reservada',
  manutencao:  'Em Manutenção',
  inativa:     'Inativa',
  agendada:    'Agendada',
  em_uso:      'Em Uso',
  concluida:   'Concluída',
  cancelada:   'Cancelada',
};

function badge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="badge badge-${status}">${label}</span>`;
}

function priorityBadge(p) {
  const labels = { normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };
  return `<span class="priority-badge priority-${p}">${labels[p] || p}</span>`;
}

function sectorDot(sectorId, size = 8) {
  const s = getSector(sectorId);
  return `<span style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;background:${s.color};flex-shrink:0;"></span>`;
}

// ============================================================
// NAVEGAÇÃO
// ============================================================

function navigate(page) {
  state.currentPage = page;

  // Atualiza nav items
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Troca páginas
  document.querySelectorAll('.page').forEach(el => {
    el.classList.toggle('active', el.id === 'page-' + page);
  });

  // Título da topbar
  const titles = {
    dashboard: 'Dashboard',
    platforms: 'Plataformas',
    reservations: 'Reservas',
    calendar: 'Calendário',
    history: 'Histórico',
  };
  document.getElementById('topbarTitle').textContent = titles[page] || page;

  // Renderiza a página
  const renderers = {
    dashboard:    renderDashboard,
    platforms:    renderPlatformsTable,
    reservations: renderReservationsTable,
    calendar:     renderCalendar,
    history:      renderHistoryTable,
  };
  if (renderers[page]) renderers[page]();

  // Fecha sidebar no mobile
  if (window.innerWidth <= 900) {
    document.getElementById('sidebar').classList.remove('open');
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ============================================================
// PERFIS
// ============================================================

function openProfileModal() {
  const list = document.getElementById('profileList');
  list.innerHTML = PROFILES.map(p => `
    <div class="profile-option ${p.id === state.currentProfile.id ? 'active' : ''}" onclick="switchProfile('${p.id}')">
      <div class="profile-option-avatar" style="background:${p.color}">${p.name[0]}</div>
      <div class="profile-option-info">
        <div class="profile-option-name">${p.name}</div>
        <div class="profile-option-role">${p.role}${p.sector ? ' — ' + getSector(p.sector).name : ''}</div>
      </div>
      ${p.id === state.currentProfile.id ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
    </div>
  `).join('');
  openModal('profileModal');
}

function switchProfile(id) {
  const p = PROFILES.find(x => x.id === id);
  if (!p) return;
  state.currentProfile = p;

  document.getElementById('profileAvatar').textContent = p.name[0];
  document.getElementById('profileName').textContent = p.name;
  document.getElementById('profileRole').textContent = p.role;

  // Mostra/oculta botão de nova plataforma baseado no perfil
  const addBtn = document.getElementById('addPlatformBtn');
  if (addBtn) addBtn.style.display = p.canManagePlatforms ? '' : 'none';

  closeModal('profileModal');
  navigate(state.currentPage);
  showToast(`Perfil alterado: ${p.name}`, 'success');
}

function updateProfileUI() {
  const p = state.currentProfile;
  document.getElementById('profileAvatar').textContent = p.name[0];
  document.getElementById('profileName').textContent = p.name;
  document.getElementById('profileRole').textContent = p.role;
}

// ============================================================
// MODALS
// ============================================================

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// Fecha modal clicando no overlay
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
});

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {
  const todayDate = todayStr();
  const next7 = new Date();
  next7.setDate(next7.getDate() + 7);

  // KPIs
  const totalPlat = state.platforms.length;
  const available = state.platforms.filter(p => p.status === 'disponivel').length;
  const todayRes  = state.reservations.filter(r => r.date === todayDate && r.status !== 'cancelada');
  const upcoming  = state.reservations.filter(r => {
    const d = new Date(r.date);
    const now = new Date(todayDate);
    return d > now && d <= next7 && r.status !== 'cancelada';
  });

  document.getElementById('kpi-total-platforms').textContent = totalPlat;
  document.getElementById('kpi-available').textContent       = available;
  document.getElementById('kpi-today').textContent           = todayRes.length;
  document.getElementById('kpi-upcoming').textContent        = upcoming.length;

  // Data header
  const opts = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' };
  document.getElementById('dashDate').textContent  = new Date().toLocaleDateString('pt-BR', opts);
  document.getElementById('topbarDate').textContent = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('todayCount').textContent = todayRes.length;

  // Reservas de hoje
  const todayEl = document.getElementById('todayReservations');
  if (todayRes.length === 0) {
    todayEl.innerHTML = '<div class="panel-empty">Nenhuma reserva para hoje.</div>';
  } else {
    todayEl.innerHTML = todayRes.sort((a, b) => a.timeStart.localeCompare(b.timeStart)).map(r => {
      const plat = getPlatform(r.platformId);
      const sec = getSector(r.sector);
      return `
        <div class="panel-item" onclick="openReservationDetail('${r.id}')">
          <div class="panel-item-dot" style="background:${sec.color}"></div>
          <div class="panel-item-info">
            <div class="panel-item-main">${plat ? plat.name : r.platformId}</div>
            <div class="panel-item-sub">${sec.name} · ${r.responsible}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
            <div class="panel-item-time">${r.timeStart}–${r.timeEnd}</div>
            ${badge(r.status)}
          </div>
        </div>`;
    }).join('');
  }

  // Próximas reservas
  const upcomingEl = document.getElementById('upcomingReservations');
  const upcomingList = upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.timeStart.localeCompare(b.timeStart));
  if (upcomingList.length === 0) {
    upcomingEl.innerHTML = '<div class="panel-empty">Sem reservas nos próximos 7 dias.</div>';
  } else {
    upcomingEl.innerHTML = upcomingList.slice(0, 6).map(r => {
      const plat = getPlatform(r.platformId);
      const sec = getSector(r.sector);
      return `
        <div class="panel-item" onclick="openReservationDetail('${r.id}')">
          <div class="panel-item-dot" style="background:${sec.color}"></div>
          <div class="panel-item-info">
            <div class="panel-item-main">${plat ? plat.name : r.platformId}</div>
            <div class="panel-item-sub">${sec.name} · ${formatDate(r.date)}</div>
          </div>
          <div class="panel-item-time">${r.timeStart}</div>
        </div>`;
    }).join('');
  }

  // Status cards das plataformas
  const grid = document.getElementById('platformStatusGrid');
  grid.innerHTML = state.platforms.map(p => `
    <div class="plat-status-card" onclick="navigate('platforms')">
      <div class="plat-status-card-code">${p.code}</div>
      <div class="plat-status-card-name">${p.name}</div>
      <div class="plat-status-card-loc" style="margin-bottom:8px;">${p.location}</div>
      ${badge(p.status)}
    </div>
  `).join('');
}

// ============================================================
// PLATAFORMAS
// ============================================================

function renderPlatformsTable() {
  filterPlatforms();
  // Controle de visibilidade do botão "Nova Plataforma"
  const addBtn = document.getElementById('addPlatformBtn');
  if (addBtn) addBtn.style.display = state.currentProfile.canManagePlatforms ? '' : 'none';
}

function filterPlatforms() {
  const search = (document.getElementById('platformSearch')?.value || '').toLowerCase();
  const status = document.getElementById('platformStatusFilter')?.value || '';

  let list = state.platforms.filter(p => {
    const matchSearch = !search ||
      p.name.toLowerCase().includes(search) ||
      p.code.toLowerCase().includes(search) ||
      p.location.toLowerCase().includes(search);
    const matchStatus = !status || p.status === status;
    return matchSearch && matchStatus;
  });

  const tbody = document.getElementById('platformsTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-muted);">Nenhuma plataforma encontrada.</td></tr>`;
    return;
  }

  const isAdmin = state.currentProfile.canManagePlatforms;

  tbody.innerHTML = list.map(p => `
    <tr>
      <td><strong>${p.code}</strong></td>
      <td><strong>${p.name}</strong></td>
      <td>${p.location}</td>
      <td>${p.capacity || '—'}</td>
      <td>${badge(p.status)}</td>
      <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${p.notes || ''}">${p.notes || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>
        <div class="table-actions">
          <button class="btn-icon" title="Ver detalhes" onclick="openReservationsByPlatform('${p.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          ${isAdmin ? `
          <button class="btn-icon" title="Editar" onclick="openPlatformModal('${p.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon danger" title="${p.status === 'inativa' ? 'Ativar' : 'Desativar'}" onclick="togglePlatformStatus('${p.id}')">
            ${p.status === 'inativa'
              ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
              : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`
            }
          </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function openPlatformModal(id = null) {
  if (!state.currentProfile.canManagePlatforms) {
    showToast('Apenas administradores podem gerenciar plataformas.', 'error');
    return;
  }
  state.editingPlatformId = id;
  document.getElementById('platformModalTitle').textContent = id ? 'Editar Plataforma' : 'Nova Plataforma';
  document.getElementById('platformSubmitBtn').textContent  = id ? 'Salvar Alterações' : 'Salvar';

  if (id) {
    const p = getPlatform(id);
    if (!p) return;
    document.getElementById('pf-code').value     = p.code;
    document.getElementById('pf-name').value     = p.name;
    document.getElementById('pf-location').value = p.location;
    document.getElementById('pf-capacity').value = p.capacity || '';
    document.getElementById('pf-status').value   = p.status === 'reservada' ? 'disponivel' : p.status;
    document.getElementById('pf-notes').value    = p.notes || '';
  } else {
    document.getElementById('platformForm').reset();
    // Gera código automático
    const nextNum = state.platforms.length + 1;
    document.getElementById('pf-code').value = 'PLT-' + String(nextNum).padStart(3, '0');
  }
  openModal('platformModal');
}

function submitPlatform() {
  const code     = document.getElementById('pf-code').value.trim();
  const name     = document.getElementById('pf-name').value.trim();
  const location = document.getElementById('pf-location').value.trim();
  const capacity = document.getElementById('pf-capacity').value.trim();
  const status   = document.getElementById('pf-status').value;
  const notes    = document.getElementById('pf-notes').value.trim();

  if (!code || !name || !location) {
    showToast('Preencha os campos obrigatórios.', 'error');
    return;
  }

  if (state.editingPlatformId) {
    // Editar
    const idx = state.platforms.findIndex(p => p.id === state.editingPlatformId);
    if (idx >= 0) {
      state.platforms[idx] = { ...state.platforms[idx], code, name, location, capacity, status, notes };
      showToast('Plataforma atualizada com sucesso!', 'success');
    }
  } else {
    // Novo
    const codeDup = state.platforms.find(p => p.code.toLowerCase() === code.toLowerCase());
    if (codeDup) { showToast('Código já existe. Use um código diferente.', 'error'); return; }
    const newId = 'PLT' + Date.now().toString(36).toUpperCase();
    state.platforms.push({ id: newId, code, name, location, capacity, status, notes });
    showToast('Plataforma cadastrada com sucesso!', 'success');
  }

  saveState();
  closeModal('platformModal');
  renderPlatformsTable();

  // Atualiza dashboard se estiver visível
  if (state.currentPage === 'dashboard') renderDashboard();
}

function togglePlatformStatus(id) {
  const p = state.platforms.find(x => x.id === id);
  if (!p) return;
  if (p.status === 'inativa') {
    p.status = 'disponivel';
    showToast(`${p.name} reativada.`, 'success');
  } else {
    // Verifica se há reservas ativas
    const activeRes = state.reservations.find(r =>
      r.platformId === id && ['agendada', 'em_uso'].includes(r.status)
    );
    if (activeRes) {
      showToast('Há reservas ativas para esta plataforma. Cancele-as antes de desativar.', 'error');
      return;
    }
    p.status = 'inativa';
    showToast(`${p.name} desativada.`, 'warning');
  }
  saveState();
  renderPlatformsTable();
}

function openReservationsByPlatform(platformId) {
  // Navega para reservas com filtro da plataforma
  navigate('reservations');
  // Pequeno delay para garantir que a tabela renderizou
  setTimeout(() => {
    const plat = getPlatform(platformId);
    if (plat) {
      const searchEl = document.getElementById('reservationSearch');
      if (searchEl) { searchEl.value = plat.name; filterReservations(); }
    }
  }, 50);
}

// ============================================================
// RESERVAS
// ============================================================

function renderReservationsTable() {
  filterReservations();
}

function filterReservations() {
  const search = (document.getElementById('reservationSearch')?.value || '').toLowerCase();
  const status = document.getElementById('reservationStatusFilter')?.value || '';
  const date   = document.getElementById('reservationDateFilter')?.value || '';

  let list = state.reservations.filter(r => {
    // Filtra por perfil (usuário de setor vê só o próprio setor)
    if (!state.currentProfile.canViewAll && state.currentProfile.sector) {
      if (r.sector !== state.currentProfile.sector) return false;
    }

    const plat = getPlatform(r.platformId);
    const sec  = getSector(r.sector);
    const matchSearch = !search ||
      sec.name.toLowerCase().includes(search) ||
      r.responsible.toLowerCase().includes(search) ||
      (plat && plat.name.toLowerCase().includes(search));
    const matchStatus = !status || r.status === status;
    const matchDate   = !date   || r.date === date;
    return matchSearch && matchStatus && matchDate;
  }).sort((a, b) => b.date.localeCompare(a.date) || b.timeStart.localeCompare(a.timeStart));

  const tbody = document.getElementById('reservationsTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">Nenhuma reserva encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => {
    const plat = getPlatform(r.platformId);
    const sec  = getSector(r.sector);
    const canEdit   = state.currentProfile.canCancelAny || r.sector === state.currentProfile.sector;
    const canCancel = canEdit && !['concluida', 'cancelada'].includes(r.status);
    return `
      <tr>
        <td><strong style="color:var(--primary);font-size:0.78rem;">${r.id}</strong></td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            ${sectorDot(r.sector)}
            <strong>${sec.name}</strong>
          </div>
        </td>
        <td>${r.responsible}</td>
        <td>${plat ? plat.name : r.platformId}</td>
        <td>${formatDate(r.date)}</td>
        <td style="white-space:nowrap;">${r.timeStart} – ${r.timeEnd}</td>
        <td>${priorityBadge(r.priority)}</td>
        <td>${badge(r.status)}</td>
        <td>
          <div class="table-actions">
            <button class="btn-icon" title="Ver detalhes" onclick="openReservationDetail('${r.id}')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            ${canCancel ? `
            <button class="btn-icon danger" title="Cancelar reserva" onclick="cancelReservation('${r.id}')">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');
}

// ============================================================
// NOVA RESERVA (Modal Form)
// ============================================================

function openNewReservationModal(prefilledPlatformId = null) {
  state.editingReservationId = null;
  document.getElementById('reservationFormTitle').textContent  = 'Nova Reserva';
  document.getElementById('reservationSubmitBtn').textContent  = 'Criar Reserva';
  document.getElementById('reservationForm').reset();
  document.getElementById('conflictAlert').style.display = 'none';

  // Define data mínima como hoje
  document.getElementById('rf-date').min = todayStr();
  document.getElementById('rf-date').value = todayStr();

  // Popula setores
  const sectorSel = document.getElementById('rf-sector');
  sectorSel.innerHTML = '<option value="">Selecione o setor</option>' +
    SECTORS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  // Pré-seleciona setor do perfil atual
  if (state.currentProfile.sector) {
    sectorSel.value = state.currentProfile.sector;
    updateResponsibleOptions();
  }

  // Popula plataformas disponíveis
  populatePlatformSelect(prefilledPlatformId);

  openModal('reservationFormModal');
}

function openEditReservationModal(id) {
  const r = state.reservations.find(x => x.id === id);
  if (!r) return;

  if (['concluida', 'cancelada'].includes(r.status)) {
    showToast('Não é possível editar uma reserva concluída ou cancelada.', 'error');
    return;
  }

  state.editingReservationId = id;
  document.getElementById('reservationFormTitle').textContent = 'Editar Reserva';
  document.getElementById('reservationSubmitBtn').textContent = 'Salvar Alterações';
  document.getElementById('conflictAlert').style.display = 'none';

  document.getElementById('rf-date').min = todayStr();

  const sectorSel = document.getElementById('rf-sector');
  sectorSel.innerHTML = '<option value="">Selecione o setor</option>' +
    SECTORS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  sectorSel.value = r.sector;

  populatePlatformSelect(r.platformId);

  document.getElementById('rf-responsible').value = r.responsible;
  document.getElementById('rf-priority').value    = r.priority;
  document.getElementById('rf-date').value        = r.date;
  document.getElementById('rf-start').value       = r.timeStart;
  document.getElementById('rf-end').value         = r.timeEnd;
  document.getElementById('rf-motive').value      = r.motive;

  closeModal('reservationDetailModal');
  openModal('reservationFormModal');
}

function populatePlatformSelect(selectedId = null) {
  const sel = document.getElementById('rf-platform');
  // Mostra apenas plataformas não-inativas
  const avail = state.platforms.filter(p => p.status !== 'inativa');
  sel.innerHTML = '<option value="">Selecione a plataforma</option>' +
    avail.map(p => {
      const statusLabel = p.status === 'disponivel' ? '' : ` (${STATUS_LABELS[p.status]})`;
      return `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.name}${statusLabel}</option>`;
    }).join('');
}

function updateResponsibleOptions() {
  // Apenas preenche sugestão de responsável pelo setor
  const sector = document.getElementById('rf-sector').value;
  if (sector === state.currentProfile.sector && state.currentProfile.name !== 'Administrador') {
    document.getElementById('rf-responsible').value = state.currentProfile.name;
  }
}

// Verifica conflito de horário
function checkConflicts() {
  const platformId = document.getElementById('rf-platform').value;
  const date       = document.getElementById('rf-date').value;
  const start      = document.getElementById('rf-start').value;
  const end        = document.getElementById('rf-end').value;
  const alertEl    = document.getElementById('conflictAlert');
  const submitBtn  = document.getElementById('reservationSubmitBtn');

  if (!platformId || !date || !start || !end) {
    alertEl.style.display = 'none';
    submitBtn.disabled = false;
    return;
  }

  if (timeToMinutes(end) <= timeToMinutes(start)) {
    document.getElementById('conflictMsg').textContent = 'O horário final deve ser após o horário inicial.';
    alertEl.style.display = 'flex';
    submitBtn.disabled = true;
    return;
  }

  const conflict = state.reservations.find(r => {
    if (r.platformId !== platformId) return false;
    if (r.date !== date) return false;
    if (['cancelada', 'concluida'].includes(r.status)) return false;
    if (state.editingReservationId && r.id === state.editingReservationId) return false;

    const rStart = timeToMinutes(r.timeStart);
    const rEnd   = timeToMinutes(r.timeEnd);
    const nStart = timeToMinutes(start);
    const nEnd   = timeToMinutes(end);

    // Sobreposição: não há conflito somente se um termina antes do outro começar
    return !(nEnd <= rStart || nStart >= rEnd);
  });

  if (conflict) {
    const sec  = getSector(conflict.sector);
    document.getElementById('conflictMsg').textContent =
      `Conflito com reserva ${conflict.id} (${sec.name} · ${conflict.timeStart}–${conflict.timeEnd}).`;
    alertEl.style.display = 'flex';
    submitBtn.disabled = true;
  } else {
    alertEl.style.display = 'none';
    submitBtn.disabled = false;
  }
}

function submitReservation(e) {
  if (e && e.preventDefault) e.preventDefault();

  const sector      = document.getElementById('rf-sector').value;
  const responsible = document.getElementById('rf-responsible').value.trim();
  const platformId  = document.getElementById('rf-platform').value;
  const priority    = document.getElementById('rf-priority').value;
  const date        = document.getElementById('rf-date').value;
  const timeStart   = document.getElementById('rf-start').value;
  const timeEnd     = document.getElementById('rf-end').value;
  const motive      = document.getElementById('rf-motive').value.trim();

  if (!sector || !responsible || !platformId || !date || !timeStart || !timeEnd || !motive) {
    showToast('Preencha todos os campos obrigatórios.', 'error');
    return;
  }
  if (timeToMinutes(timeEnd) <= timeToMinutes(timeStart)) {
    showToast('O horário final deve ser após o horário inicial.', 'error');
    return;
  }

  // Re-checa conflito (garante mesmo se o usuário não disparou o evento)
  const conflict = state.reservations.find(r => {
    if (r.platformId !== platformId) return false;
    if (r.date !== date) return false;
    if (['cancelada', 'concluida'].includes(r.status)) return false;
    if (state.editingReservationId && r.id === state.editingReservationId) return false;
    const rS = timeToMinutes(r.timeStart), rE = timeToMinutes(r.timeEnd);
    const nS = timeToMinutes(timeStart),   nE = timeToMinutes(timeEnd);
    return !(nE <= rS || nS >= rE);
  });

  if (conflict) {
    showToast('Não é possível salvar: conflito de horário detectado.', 'error');
    return;
  }

  if (state.editingReservationId) {
    const idx = state.reservations.findIndex(r => r.id === state.editingReservationId);
    if (idx >= 0) {
      state.reservations[idx] = {
        ...state.reservations[idx],
        sector, responsible, platformId, priority, date, timeStart, timeEnd, motive,
      };
      showToast('Reserva atualizada com sucesso!', 'success');
    }
  } else {
    const newRes = {
      id: 'RES' + genId(''),
      sector, responsible, platformId, priority, date,
      timeStart, timeEnd, motive,
      status: 'agendada',
      createdAt: new Date().toISOString(),
    };
    state.reservations.push(newRes);
    showToast('Reserva criada com sucesso!', 'success');
  }

  // Atualiza status da plataforma
  syncPlatformStatuses();
  saveState();
  closeModal('reservationFormModal');

  // Re-renderiza a página atual
  const renderers = {
    dashboard:    renderDashboard,
    reservations: renderReservationsTable,
    calendar:     renderCalendar,
    history:      renderHistoryTable,
  };
  if (renderers[state.currentPage]) renderers[state.currentPage]();
}

// Sincroniza status das plataformas com base nas reservas ativas
function syncPlatformStatuses() {
  const today = todayStr();
  state.platforms.forEach(p => {
    if (p.status === 'inativa' || p.status === 'manutencao') return;
    const active = state.reservations.find(r =>
      r.platformId === p.id &&
      r.date === today &&
      ['agendada', 'em_uso'].includes(r.status)
    );
    p.status = active ? 'reservada' : 'disponivel';
  });
}

// ============================================================
// DETALHES DA RESERVA
// ============================================================

function openReservationDetail(id) {
  const r = state.reservations.find(x => x.id === id);
  if (!r) return;

  const plat = getPlatform(r.platformId);
  const sec  = getSector(r.sector);

  document.getElementById('reservationDetailTitle').textContent = `Reserva ${r.id}`;

  const canEdit   = state.currentProfile.canCancelAny || r.sector === state.currentProfile.sector;
  const canCancel = canEdit && !['concluida', 'cancelada'].includes(r.status);
  const canChangeStatus = state.currentProfile.canCancelAny || canEdit;

  document.getElementById('reservationDetailBody').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item">
        <div class="detail-label">ID da Reserva</div>
        <div class="detail-value" style="color:var(--primary);font-weight:700;">${r.id}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Status</div>
        <div class="detail-value">${badge(r.status)}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Setor</div>
        <div class="detail-value" style="display:flex;align-items:center;gap:6px;">
          ${sectorDot(r.sector, 10)}
          <strong>${sec.name}</strong>
        </div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Responsável</div>
        <div class="detail-value">${r.responsible}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Plataforma</div>
        <div class="detail-value">${plat ? `<strong>${plat.name}</strong> <span style="color:var(--text-muted);font-size:0.8rem;">(${plat.code})</span>` : r.platformId}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Localização</div>
        <div class="detail-value">${plat ? plat.location : '—'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Data</div>
        <div class="detail-value">${formatDateFull(r.date)}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Horário</div>
        <div class="detail-value">${r.timeStart} – ${r.timeEnd}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Prioridade</div>
        <div class="detail-value">${priorityBadge(r.priority)}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Criada em</div>
        <div class="detail-value">${formatDateTime(r.createdAt)}</div>
      </div>
      <div class="detail-item detail-full">
        <div class="detail-label">Motivo / Descrição</div>
        <div class="detail-motive">${r.motive}</div>
      </div>
      ${canChangeStatus && !['cancelada'].includes(r.status) ? `
      <div class="detail-item detail-full detail-status-change">
        <label>Alterar Status</label>
        <div class="status-btn-group">
          ${['agendada', 'em_uso', 'concluida'].map(s => `
            <button class="status-btn" 
              style="border-color:${getStatusColor(s)};color:${getStatusColor(s)};${r.status === s ? `background:${getStatusColor(s)};color:#fff;` : ''}"
              onclick="changeReservationStatus('${r.id}','${s}')" 
              ${r.status === s ? 'disabled' : ''}>
              ${STATUS_LABELS[s]}
            </button>`).join('')}
        </div>
      </div>` : ''}
    </div>
  `;

  const footer = document.getElementById('reservationDetailFooter');
  footer.innerHTML = `
    <button class="btn-ghost" onclick="closeModal('reservationDetailModal')">Fechar</button>
    ${canEdit && !['concluida', 'cancelada'].includes(r.status)
      ? `<button class="btn-outline" onclick="openEditReservationModal('${r.id}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Editar
        </button>` : ''}
    ${canCancel
      ? `<button class="btn-danger" onclick="cancelReservation('${r.id}',true)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Cancelar Reserva
        </button>` : ''}
  `;

  openModal('reservationDetailModal');
}

function getStatusColor(status) {
  const map = {
    agendada:  '#2563EB',
    em_uso:    '#D97706',
    concluida: '#16A34A',
    cancelada: '#DC2626',
  };
  return map[status] || '#6B7280';
}

function changeReservationStatus(id, newStatus) {
  const r = state.reservations.find(x => x.id === id);
  if (!r) return;
  r.status = newStatus;
  syncPlatformStatuses();
  saveState();
  showToast(`Status alterado para: ${STATUS_LABELS[newStatus]}`, 'success');
  closeModal('reservationDetailModal');

  const renderers = { dashboard: renderDashboard, reservations: renderReservationsTable, history: renderHistoryTable, calendar: renderCalendar };
  if (renderers[state.currentPage]) renderers[state.currentPage]();
}

function cancelReservation(id, fromDetail = false) {
  const r = state.reservations.find(x => x.id === id);
  if (!r) return;

  if (!confirm(`Confirma o cancelamento da reserva ${r.id}?`)) return;

  r.status = 'cancelada';
  syncPlatformStatuses();
  saveState();
  showToast(`Reserva ${r.id} cancelada.`, 'warning');

  if (fromDetail) closeModal('reservationDetailModal');
  const renderers = { dashboard: renderDashboard, reservations: renderReservationsTable, history: renderHistoryTable, calendar: renderCalendar };
  if (renderers[state.currentPage]) renderers[state.currentPage]();
}

// ============================================================
// CALENDÁRIO SEMANAL
// ============================================================

const HOURS = ['06','07','08','09','10','11','12','13','14','15','16','17','18','19','20'];
const DAY_NAMES = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

function getWeekDates(offsetWeeks = 0) {
  const now = new Date();
  const day = now.getDay(); // 0 = domingo
  const monday = new Date(now);
  monday.setDate(now.getDate() - day + (day === 0 ? -6 : 1) + offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function renderCalendar() {
  const days = getWeekDates(state.calendarWeekOffset);
  const todayDate = todayStr();

  // Label da semana
  const fmt = d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
  document.getElementById('calWeekLabel').textContent =
    `${fmt(days[0])} – ${fmt(days[6])}`;

  // Legenda de setores
  const legend = document.getElementById('calLegend');
  legend.innerHTML = SECTORS.map(s => `
    <div class="cal-legend-item">
      <div class="cal-legend-dot" style="background:${s.color}"></div>
      ${s.name}
    </div>`).join('');

  const grid = document.getElementById('calGrid');
  let html = '';

  // Cabeçalho: coluna vazia + 7 dias
  html += `<div class="cal-time-label" style="background:var(--surface-2);"></div>`;
  days.forEach((d, i) => {
    const dateStr = d.toISOString().slice(0, 10);
    const isToday = dateStr === todayDate;
    html += `
      <div class="cal-header-cell ${isToday ? 'today-col' : ''}">
        ${DAY_NAMES[d.getDay()]}
        <span class="cal-header-date ${isToday ? 'today-date' : ''}">${d.getDate()}</span>
      </div>`;
  });

  // Linhas por hora
  HOURS.forEach(h => {
    html += `<div class="cal-time-label">${h}:00</div>`;

    days.forEach(d => {
      const dateStr = d.toISOString().slice(0, 10);
      const isToday = dateStr === todayDate;

      // Reservas que iniciam nesta hora
      const eventsHere = state.reservations.filter(r => {
        if (['cancelada'].includes(r.status)) return false;
        if (r.date !== dateStr) return false;
        const rH = r.timeStart.slice(0, 2);
        return rH === h;
      });

      const eventsHtml = eventsHere.map(r => {
        const sec = getSector(r.sector);
        const plat = getPlatform(r.platformId);
        const bg = sec.color + '22';
        return `
          <div class="cal-event" 
               style="background:${bg};border-left:3px solid ${sec.color};color:${sec.color};"
               onclick="openReservationDetail('${r.id}')"
               title="${sec.name} · ${plat ? plat.name : r.platformId} · ${r.timeStart}–${r.timeEnd}">
            <div class="cal-event-platform">${plat ? plat.code : r.platformId}</div>
            <div class="cal-event-sector">${sec.name}</div>
            <div style="opacity:0.7;font-size:0.65rem;">${r.timeStart}–${r.timeEnd}</div>
          </div>`;
      }).join('');

      html += `<div class="cal-cell ${isToday ? 'today-col-cell' : ''}">${eventsHtml}</div>`;
    });
  });

  grid.innerHTML = html;
}

function changeWeek(dir) {
  state.calendarWeekOffset += dir;
  renderCalendar();
}

function goToToday() {
  state.calendarWeekOffset = 0;
  renderCalendar();
}

// ============================================================
// HISTÓRICO
// ============================================================

function renderHistoryTable() {
  // Popula filtros dinâmicos de setor e plataforma
  const sectorFilter   = document.getElementById('historySectorFilter');
  const platformFilter = document.getElementById('historyPlatformFilter');

  if (sectorFilter && sectorFilter.options.length === 1) {
    SECTORS.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      sectorFilter.appendChild(opt);
    });
  }

  if (platformFilter && platformFilter.options.length === 1) {
    state.platforms.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      platformFilter.appendChild(opt);
    });
  }

  filterHistory();
}

function filterHistory() {
  const search   = (document.getElementById('historySearch')?.value || '').toLowerCase();
  const sector   = document.getElementById('historySectorFilter')?.value || '';
  const platform = document.getElementById('historyPlatformFilter')?.value || '';
  const status   = document.getElementById('historyStatusFilter')?.value || '';
  const dateFrom = document.getElementById('historyDateFrom')?.value || '';
  const dateTo   = document.getElementById('historyDateTo')?.value || '';

  let list = state.reservations.filter(r => {
    // Filtra por perfil
    if (!state.currentProfile.canViewAll && state.currentProfile.sector) {
      if (r.sector !== state.currentProfile.sector) return false;
    }

    const plat = getPlatform(r.platformId);
    const sec  = getSector(r.sector);
    const matchSearch = !search ||
      sec.name.toLowerCase().includes(search) ||
      r.responsible.toLowerCase().includes(search) ||
      r.motive.toLowerCase().includes(search) ||
      (plat && plat.name.toLowerCase().includes(search)) ||
      r.id.toLowerCase().includes(search);
    const matchSector   = !sector   || r.sector === sector;
    const matchPlatform = !platform || r.platformId === platform;
    const matchStatus   = !status   || r.status === status;
    const matchFrom     = !dateFrom || r.date >= dateFrom;
    const matchTo       = !dateTo   || r.date <= dateTo;
    return matchSearch && matchSector && matchPlatform && matchStatus && matchFrom && matchTo;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);">Nenhum registro encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(r => {
    const plat = getPlatform(r.platformId);
    const sec  = getSector(r.sector);
    return `
      <tr>
        <td><strong style="color:var(--primary);font-size:0.78rem;">${r.id}</strong></td>
        <td style="font-size:0.8rem;">${formatDateTime(r.createdAt)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;">
            ${sectorDot(r.sector)}
            ${sec.name}
          </div>
        </td>
        <td>${r.responsible}</td>
        <td>${plat ? plat.name : r.platformId}</td>
        <td style="white-space:nowrap;font-size:0.8rem;">${formatDate(r.date)}<br>${r.timeStart}–${r.timeEnd}</td>
        <td style="max-width:200px;font-size:0.8rem;color:var(--text-secondary);" title="${r.motive}">${r.motive.length > 60 ? r.motive.slice(0, 60) + '…' : r.motive}</td>
        <td>${badge(r.status)}</td>
        <td>
          <button class="btn-icon" title="Ver detalhes" onclick="openReservationDetail('${r.id}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </td>
      </tr>`;
  }).join('');
}

// ============================================================
// EXPORTAR CSV
// ============================================================

function exportCSV() {
  const headers = ['ID', 'Criada em', 'Setor', 'Responsável', 'Plataforma', 'Data', 'Início', 'Fim', 'Prioridade', 'Status', 'Motivo'];

  const rows = state.reservations.map(r => {
    const plat = getPlatform(r.platformId);
    const sec  = getSector(r.sector);
    return [
      r.id,
      formatDateTime(r.createdAt),
      sec.name,
      r.responsible,
      plat ? plat.name : r.platformId,
      formatDate(r.date),
      r.timeStart,
      r.timeEnd,
      r.priority,
      STATUS_LABELS[r.status] || r.status,
      `"${r.motive.replace(/"/g, '""')}"`,
    ].join(';');
  });

  const csv = [headers.join(';'), ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `reservas_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exportação CSV iniciada!', 'success');
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================

function init() {
  // Carrega dados do localStorage (ou mocks iniciais)
  loadState();

  // Sincroniza status de plataformas com reservas
  syncPlatformStatuses();

  // Inicializa UI de perfil
  updateProfileUI();

  // Define data na topbar
  document.getElementById('topbarDate').textContent =
    new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });

  // Navega para o dashboard
  navigate('dashboard');

  // Atalho de teclado: ESC fecha modais
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    }
  });

  console.log('PlataformaRes iniciado. Plataformas:', state.platforms.length, '| Reservas:', state.reservations.length);
}

// Aguarda o DOM carregar
document.addEventListener('DOMContentLoaded', init);