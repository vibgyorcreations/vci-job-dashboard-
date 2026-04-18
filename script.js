'use strict';

// ========== CONFIGURATION ==========
const APP_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzbglRY49SnXCq9BrOdL4DtHXxivasmQRn7fiHjByxFwp2OtJg_ML0E-v3SAIN6qSx0ew/exec';

// ========== APP STATE ==========
let appData = {
  jobs: [],
  archive: [],
  materials: [],
  machines: [],
  categories: [],
  notifications: [],
  settings: { companyName:'FactoryFlow OS', companyLogo:'', driveFolderId:'', theme:'dark', accentColor:'#00f0ff' },
  pins: { admin:'1234', waiting:'1111', printing:'2222', assembly:'3333', dispatch:'4444' }
};

let currentRole = null;
let pendingRole  = null;
let pinBuffer    = '';
let currentView  = 'dashboard';
let refreshTimer = null;
let sessionTimer = null;
let sessionWarnTimer = null;
let printJobId   = null;
let clockTimer   = null;
let selectedMaterials = [];   // multi-material picker state
let invStockFilter = 'all';   // inventory tab filter: 'all' | 'instock' | 'low' | 'out'
const SESSION_TIMEOUT  = 15 * 60 * 1000; // 15 min inactivity → logout
const SESSION_WARN     = 12 * 60 * 1000; // warn at 12 min mark (3 min before timeout)

// ========== PERMISSIONS ==========
const ROLE_PERMISSIONS = {
  admin:    {
    canCreateJob:true, canEditJob:true, canDeleteJob:true, canDuplicateJob:true, canSplitJob:true,
    canMoveToPrinting:true, canMoveToAssembly:true, canMoveToDispatch:true, canArchive:true,
    canManageInventory:true, canManageMachines:true, canManageSettings:true,
    canViewDashboard:true, canViewArchive:true, canViewAnalytics:true, canViewInventory:true, canViewMachines:true,
    canStockIn:true, canStockOut:true, canStockAdjust:true, canAssignMachine:true
  },
  waiting:  { canCreateJob:true, canViewDashboard:true, canViewInventory:true, canStockOut:true },
  printing: { canMoveToPrinting:true, canMoveToAssembly:true, canViewDashboard:true, canViewInventory:true, canStockOut:true, canAssignMachine:true },
  assembly: { canMoveToAssembly:true, canMoveToDispatch:true, canViewDashboard:true, canViewInventory:true, canStockOut:true },
  dispatch: { canMoveToDispatch:true, canArchive:true, canViewDashboard:true, canViewArchive:true }
};
function can(perm){ return !!(currentRole && ROLE_PERMISSIONS[currentRole] && ROLE_PERMISSIONS[currentRole][perm]); }

// Columns each role can see on the Kanban board
const ROLE_COLUMNS = {
  admin:    ['waiting','printing','assembly','dispatch'],
  waiting:  ['waiting'],
  printing: ['printing'],
  assembly: ['assembly'],
  dispatch: ['dispatch']
};

// ========== CLOUD SYNC ==========
const Cloud = {
  async fetchData(){
    const resp = await fetch(APP_SCRIPT_URL);
    return await resp.json();
  },
  async pushData(action, payload){
    const resp = await fetch(APP_SCRIPT_URL, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain' },
      body: JSON.stringify({ action, ...payload })
    });
    return await resp.json();
  }
};

// ========== LOCAL STORAGE ==========
function saveLocal(){
  try { localStorage.setItem('ffos_appdata', JSON.stringify(appData)); } catch(e){}
}
function loadLocal(){
  try {
    const raw = localStorage.getItem('ffos_appdata');
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed.jobs)      appData.jobs      = parsed.jobs;
      if(parsed.archive)   appData.archive   = parsed.archive;
      if(parsed.materials) appData.materials = parsed.materials;
      if(parsed.machines && parsed.machines.length) appData.machines = parsed.machines;
      if(parsed.categories) appData.categories = parsed.categories;
      if(parsed.notifications) appData.notifications = parsed.notifications;
      if(parsed.settings)  Object.assign(appData.settings, parsed.settings);
      if(parsed.pins)      Object.assign(appData.pins, parsed.pins);
    }
  } catch(e){}
  if(!appData.machines || !appData.machines.length) appData.machines = defaultMachines();
  if(!appData.categories) appData.categories = [];
  if(!appData.notifications) appData.notifications = [];
}
function defaultMachines(){
  return [
    {id:'m1',name:'Press A',type:'Digital Press',capacity:500,totalSqft:0,jobCount:0},
    {id:'m2',name:'Press B',type:'Digital Press',capacity:500,totalSqft:0,jobCount:0},
    {id:'m3',name:'Wide Format 1',type:'Wide Format',capacity:800,totalSqft:0,jobCount:0},
    {id:'m4',name:'Flatbed UV',type:'Flatbed UV',capacity:300,totalSqft:0,jobCount:0}
  ];
}

// ========== JOB ID ==========
function genJobId(){
  const d = new Date();
  const dateStr = d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
  const todayKey = 'ffos_seq_' + dateStr;
  let seq = parseInt(localStorage.getItem(todayKey)||'0') + 1;
  localStorage.setItem(todayKey, seq);
  return 'JID-' + dateStr + '-' + String(seq).padStart(4,'0');
}

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  loadLocal();
  applyTheme(appData.settings.theme || 'dark');
  applyBranding();

  // Check existing session
  const sess = sessionStorage.getItem('ffos_session');
  if(sess){
    try{
      const s = JSON.parse(sess);
      currentRole = s.role;
      showApp();
    } catch(e){ showLogin(); }
  } else {
    showLogin();
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);
  document.addEventListener('click', e => {
    if(e.target.classList.contains('modal')) closeTopModal();
  });

  // Clock
  updateClock();
  clockTimer = setInterval(updateClock, 1000);

  // Default report dates
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  const rFrom = document.getElementById('reportDateFrom');
  const rTo   = document.getElementById('reportDateTo');
  if(rFrom) rFrom.value = weekAgo;
  if(rTo)   rTo.value   = today;
});

// ========== CLOCK ==========
function updateClock(){
  const t = new Date().toLocaleTimeString();
  const el = document.getElementById('systemClock');
  const el2 = document.getElementById('sessionClock');
  if(el) el.textContent = t;
  if(el2) el2.textContent = t;
}

// ========== LOGIN / AUTH ==========
function showLogin(){
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('appPage').classList.add('hidden');
  stopTimers();
  backToRoles();
}
function showApp(){
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('appPage').classList.remove('hidden');
  applyRoleUI();
  startTimers();
  loadData();
  updateFab();
  document.getElementById('sessionRole').textContent = currentRole || '';
  setRoleIcon();
}
function setRoleIcon(){
  const icons = {admin:'👑',waiting:'📋',printing:'🖨️',assembly:'🔧',dispatch:'📦'};
  const el = document.getElementById('sessionRoleIcon');
  if(el) el.textContent = icons[currentRole] || '👤';
}
function selectRole(role){
  pendingRole = role;
  pinBuffer = '';
  updatePinDots();
  const icons = {admin:'👑',waiting:'📋',printing:'🖨️',assembly:'🔧',dispatch:'📦'};
  const names = {admin:'Admin',waiting:'Waiting',printing:'Printing',assembly:'Assembly',dispatch:'Dispatch'};
  document.getElementById('pinRoleLabel').textContent = (icons[role]||'') + ' ' + (names[role]||role) + ' — Enter PIN';
  document.getElementById('roleSelect').classList.add('hidden');
  document.getElementById('pinEntry').classList.remove('hidden');
  document.getElementById('pinError').classList.add('hidden');
}
function backToRoles(){
  pendingRole = null; pinBuffer = '';
  document.getElementById('pinEntry').classList.add('hidden');
  document.getElementById('roleSelect').classList.remove('hidden');
  document.getElementById('pinError').classList.add('hidden');
  updatePinDots();
}
function pinDigit(d){
  if(pinBuffer.length >= 4) return;
  pinBuffer += d;
  updatePinDots();
  if(pinBuffer.length === 4) setTimeout(checkPin, 120);
}
function pinBack(){ pinBuffer = pinBuffer.slice(0,-1); updatePinDots(); }
function pinClear(){ pinBuffer = ''; updatePinDots(); }
function updatePinDots(){
  for(let i=0;i<4;i++){
    const dot = document.getElementById('dot'+i);
    if(dot) dot.classList.toggle('filled', i < pinBuffer.length);
  }
}
function checkPin(){
  const expected = appData.pins[pendingRole] || '0000';
  if(pinBuffer === expected){
    currentRole = pendingRole;
    sessionStorage.setItem('ffos_session', JSON.stringify({role:currentRole, ts: Date.now()}));
    showApp();
  } else {
    document.getElementById('pinError').classList.remove('hidden');
    pinBuffer = '';
    updatePinDots();
    setTimeout(() => document.getElementById('pinError').classList.add('hidden'), 2500);
  }
}
function handleLogout(){
  showToast('👋 Logged out','info');
  currentRole = null;
  sessionStorage.removeItem('ffos_session');
  showLogin();
}

// ========== SESSION TIMEOUT ==========
function startTimers(){
  clearTimers();
  refreshTimer = setInterval(loadData, 180000); // 3 min
  resetSessionTimeout();
  document.addEventListener('mousemove', resetSessionTimeout);
  document.addEventListener('keydown', resetSessionTimeout, true);
}
function stopTimers(){
  clearTimers();
  document.removeEventListener('mousemove', resetSessionTimeout);
  document.removeEventListener('keydown', resetSessionTimeout, true);
}
function clearTimers(){
  if(refreshTimer){ clearInterval(refreshTimer); refreshTimer=null; }
  if(sessionTimer){ clearTimeout(sessionTimer); sessionTimer=null; }
  if(sessionWarnTimer){ clearTimeout(sessionWarnTimer); sessionWarnTimer=null; }
}
function resetSessionTimeout(){
  if(sessionWarnTimer){ clearTimeout(sessionWarnTimer); }
  if(sessionTimer){ clearTimeout(sessionTimer); }
  sessionWarnTimer = setTimeout(() => showToast('⚠️ Session expiring in 3 min due to inactivity','warning'), SESSION_WARN);
  sessionTimer = setTimeout(() => { showToast('🔒 Session timed out','warning'); handleLogout(); }, SESSION_TIMEOUT);
}

// ========== LOAD DATA ==========
async function loadData(){
  setSyncStatus('syncing');
  try {
    const data = await Cloud.fetchData();
    if(data.jobs || data.waiting || data.archive){
      // Merge cloud data
      if(Array.isArray(data.jobs)) appData.jobs = data.jobs;
      else {
        const lists = ['waiting','printing','assembly','dispatch'];
        appData.jobs = [];
        lists.forEach(s => { if(Array.isArray(data[s])) data[s].forEach(j => { j.status = j.status || s; appData.jobs.push(j); }); });
      }
      if(Array.isArray(data.archive)) appData.archive = data.archive;
      if(Array.isArray(data.materials)) appData.materials = data.materials;
      if(Array.isArray(data.machines) && data.machines.length) appData.machines = data.machines;
      if(Array.isArray(data.categories)) appData.categories = data.categories;
      if(data.settings) Object.assign(appData.settings, data.settings);
      if(data.pins) Object.assign(appData.pins, data.pins);
    }
    saveLocal();
    setSyncStatus('synced');
    document.getElementById('lastSyncTime').textContent = 'Synced ' + new Date().toLocaleTimeString();
  } catch(e){
    setSyncStatus('error');
    document.getElementById('lastSyncTime').textContent = 'Sync failed';
  }
  renderCurrentView();
  updateKPIs();
}
function setSyncStatus(s){
  const dot = document.getElementById('syncDot');
  if(!dot) return;
  dot.className = 'sync-dot ' + s;
}

// ========== RENDER VIEWS ==========
function renderCurrentView(){
  if(currentView === 'dashboard') renderDashboard();
  else if(currentView === 'archive') renderArchive();
  else if(currentView === 'analytics') renderAnalytics();
  else if(currentView === 'inventory') renderInventory();
  else if(currentView === 'machines') renderMachines();
}

function switchView(v){
  // Guard: prevent non-admin from navigating to views they don't have access to
  const viewPerms = { archive:'canViewArchive', analytics:'canViewAnalytics', inventory:'canViewInventory', machines:'canViewMachines' };
  if(viewPerms[v] && !can(viewPerms[v])){
    showToast('⛔ Access denied','error'); return;
  }
  currentView = v;
  document.querySelectorAll('.view').forEach(el => { el.classList.remove('active'); el.classList.add('hidden'); });
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const viewEl = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
  if(viewEl){ viewEl.classList.remove('hidden'); viewEl.classList.add('active'); }
  const navEl = document.querySelector('[data-view="'+v+'"]');
  if(navEl) navEl.classList.add('active');
  document.getElementById('headerTitle').textContent = {dashboard:'Dashboard',archive:'Archive',analytics:'Analytics',inventory:'Inventory',machines:'Machines'}[v] || v;
  renderCurrentView();
  // Close sidebar on mobile after nav
  if(window.innerWidth <= 768) document.getElementById('sidebar').classList.remove('mobile-open');
}

function toggleSidebar(){
  const sb = document.getElementById('sidebar');
  if(window.innerWidth <= 768) sb.classList.toggle('mobile-open');
  else sb.classList.toggle('collapsed');
}

function updateFab(){
  const fab = document.getElementById('fabBtn');
  if(fab) fab.style.display = can('canCreateJob') ? 'flex' : 'none';
}

function applyRoleUI(){
  // New Job button & FAB — waiting and admin only
  const nb = document.getElementById('newJobBtn');
  if(nb) nb.style.display = can('canCreateJob') ? '' : 'none';
  updateFab();

  // Settings button in header — admin only
  const settBtn = document.getElementById('headerSettingsBtn');
  if(settBtn) settBtn.style.display = can('canManageSettings') ? '' : 'none';

  // Sidebar nav items — hide views the role cannot access
  const navPerms = { archive:'canViewArchive', analytics:'canViewAnalytics', inventory:'canViewInventory', machines:'canViewMachines' };
  Object.entries(navPerms).forEach(([view, perm]) => {
    const navEl = document.querySelector('[data-view="'+view+'"]');
    if(navEl) navEl.style.display = can(perm) ? '' : 'none';
  });

  // Kanban columns — show only the column(s) this role owns
  const visibleCols = ROLE_COLUMNS[currentRole] || ['waiting'];
  ['waiting','printing','assembly','dispatch'].forEach(col => {
    const colName = col.charAt(0).toUpperCase() + col.slice(1);
    const el = document.getElementById('kanbanCol'+colName);
    if(el) el.style.display = visibleCols.includes(col) ? '' : 'none';
  });
  // Expand to full width when only one column is visible
  const kanban = document.getElementById('kanbanBoard');
  if(kanban){
    if(visibleCols.length === 1) kanban.classList.add('kanban-single');
    else kanban.classList.remove('kanban-single');
  }

  // KPI cards — non-admin roles see only their own stage KPI; hide irrelevant ones
  const kpiMap = { waiting:'kpiWaiting', printing:'kpiPrinting', assembly:'kpiAssembly', dispatch:'kpiDispatch' };
  if(currentRole !== 'admin'){
    // Hide every stage KPI except the one matching the role, and hide total/sqft/urgent
    ['kpiTotal','kpiWaiting','kpiPrinting','kpiAssembly','kpiDispatch','kpiSqft','kpiUrgent'].forEach(id => {
      const el = document.getElementById(id);
      if(!el) return;
      const kpiCard = el.closest('.kpi-card');
      if(!kpiCard) return;
      const ownKpi = kpiMap[currentRole];
      if(id === ownKpi) {
        kpiCard.style.display = '';
      } else {
        kpiCard.style.display = 'none';
      }
    });
  } else {
    // Admin sees all KPI cards
    document.querySelectorAll('.kpi-card').forEach(el => el.style.display = '');
  }

  // Inventory action buttons in header — admin only
  ['invAddMaterialBtn','invCategoriesBtn','invCsvBtn'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = can('canManageInventory') ? '' : 'none';
  });

  // Notification bell — admin only
  const notifWrap = document.getElementById('notifWrap');
  if(notifWrap) notifWrap.style.display = (currentRole === 'admin') ? '' : 'none';
  updateNotifBadge();
}

// ========== KPI ==========
function updateKPIs(){
  const jobs = appData.jobs;
  const w = jobs.filter(j => j.status==='waiting').length;
  const p = jobs.filter(j => j.status==='printing').length;
  const a = jobs.filter(j => j.status==='assembly').length;
  const d = jobs.filter(j => j.status==='dispatch').length;
  const totalSqft = jobs.reduce((s,j) => s+(parseFloat(j.sqft||j.size||0)||0),0);
  const urgent = jobs.filter(j => (j.priority||'').toLowerCase()==='high').length;
  setValue('kpiTotal', jobs.length);
  setValue('kpiWaiting', w);
  setValue('kpiPrinting', p);
  setValue('kpiAssembly', a);
  setValue('kpiDispatch', d);
  setValue('kpiSqft', totalSqft.toFixed(0));
  setValue('kpiUrgent', urgent);
}
function setValue(id, v){ const el=document.getElementById(id); if(el) el.textContent=v; }

// ========== FILTERS ==========
function applyFilters(){
  renderDashboard();
}
function getFilteredJobs(){
  const search = (document.getElementById('globalSearch')||{}).value||'';
  const q = search.toLowerCase().trim();
  const pf = (document.getElementById('filterPriority')||{}).value||'';
  const sf = (document.getElementById('filterStatus')||{}).value||'';
  return appData.jobs.filter(j => {
    const matStr = Array.isArray(j.materials) ? j.materials.join(' ') : (j.materials||j.material||'');
    const matchQ = !q || [j.id,j.name,j.client,matStr,j.notes].some(v => v&&v.toLowerCase().includes(q));
    const matchP = !pf || (j.priority||'').toLowerCase()===pf;
    const matchS = !sf || j.status===sf;
    return matchQ && matchP && matchS;
  });
}

// ========== DASHBOARD ==========
function renderDashboard(){
  const jobs = getFilteredJobs();
  const cols = {waiting:[],printing:[],assembly:[],dispatch:[]};
  jobs.forEach(j => { const s = j.status||'waiting'; if(cols[s]) cols[s].push(j); });
  // Pinned first
  Object.keys(cols).forEach(s => cols[s].sort((a,b) => (b.pinned?1:0)-(a.pinned?1:0)));

  setValue('colCountWaiting', cols.waiting.length);
  setValue('colCountPrinting', cols.printing.length);
  setValue('colCountAssembly', cols.assembly.length);
  setValue('colCountDispatch', cols.dispatch.length);

  renderJobList('listWaiting',  cols.waiting,  'waiting');
  renderJobList('listPrinting', cols.printing, 'printing');
  renderJobList('listAssembly', cols.assembly, 'assembly');
  renderJobList('listDispatch', cols.dispatch, 'dispatch');
}
function renderJobList(containerId, jobs, colStatus){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!jobs.length){
    const msgs = {waiting:'No jobs waiting — all clear! 🎉', printing:'No jobs in printing', assembly:'No jobs in assembly', dispatch:'No jobs ready to dispatch'};
    const icons = {waiting:'⏳',printing:'🖨️',assembly:'🔧',dispatch:'📦'};
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">'+icons[colStatus]+'</div><div class="empty-state-text">'+(msgs[colStatus]||'No jobs')+'</div></div>';
    return;
  }
  el.innerHTML = jobs.map(j => jobCardHTML(j, colStatus)).join('');
}

function jobCardHTML(job, colStatus){
  const id = escHtml(job.id||'');
  const name = escHtml(job.name||'-');
  const client = escHtml(job.client||'-');
  // Support both array and string forms of materials
  const matArr = Array.isArray(job.materials) ? job.materials : (job.materials||job.material||'').split(',').map(s=>s.trim()).filter(Boolean);
  const matDisplay = matArr.length
    ? matArr.map(m => `<span class="mat-tag" style="font-size:11px;padding:2px 8px 2px 10px">${escHtml(m)}</span>`).join('')
    : '<span style="color:var(--text-muted)">—</span>';
  const qty = escHtml(String(job.qty||job.quantity||'-'));
  const sqft = escHtml(String(job.sqft||job.size||'-'));
  const finish = escHtml(job.finish||job.finishing||'');
  const notes = escHtml(job.notes||'');
  const fileUrl = job.fileUrl||job.files||'';
  const priority = (job.priority||'medium').toLowerCase();
  const approvalBy = escHtml(job.approvalBy||'');
  const dueDate = job.dueDate ? '<span style="font-size:10px;color:var(--warning)">📅 '+escHtml(job.dueDate)+'</span>' : '';
  const pClass = 'badge badge-'+priority;
  const pLabel = {high:'🔴 HIGH',medium:'🟡 MED',low:'🟢 LOW'}[priority]||priority.toUpperCase();
  const pinnedBadge = job.pinned ? '<span class="badge badge-pinned">📌 PINNED</span>' : '';
  const reworkBadge = job.rework ? '<span class="badge badge-rework">🔄 REWORK</span>' : '';
  const cardClass = 'job-card' + (job.pinned?' pinned':'') + (job.rework?' rework':'');
  const jid = job.id||'';

  // Action buttons based on status & permissions
  let mainBtn = '';
  if(colStatus==='waiting' && can('canMoveToPrinting'))
    mainBtn = '<button class="job-act-btn btn-move-next" onclick="approveJob(\''+jid+'\')"><span class="jab-icon">✅</span><span class="jab-label">Approve</span></button>';
  else if(colStatus==='printing' && can('canMoveToAssembly'))
    mainBtn = '<button class="job-act-btn btn-move-next" onclick="moveJob(\''+jid+'\',\'assembly\')"><span class="jab-icon">🔧</span><span class="jab-label">Assembly</span></button>';
  else if(colStatus==='assembly' && can('canMoveToDispatch'))
    mainBtn = '<button class="job-act-btn btn-move-next" onclick="moveJob(\''+jid+'\',\'dispatch\')"><span class="jab-icon">📦</span><span class="jab-label">Dispatch</span></button>';
  else if(colStatus==='dispatch' && can('canArchive'))
    mainBtn = '<button class="job-act-btn btn-archive" onclick="openDispatchModal(\''+jid+'\')"><span class="jab-icon">📦</span><span class="jab-label">Archive</span></button>';

  // Machine assignment — only in printing column
  const assignMachineBtn = (colStatus==='printing' && can('canAssignMachine'))
    ? '<button class="job-act-btn btn-assign-machine" onclick="openMachineAssignModal(\''+jid+'\')"><span class="jab-icon">🔩</span><span class="jab-label">Machine</span></button>'
    : '';

  const editBtn  = can('canEditJob')      ? '<button class="job-act-btn btn-edit-card" onclick="editJob(\''+jid+'\')" title="Edit"><span class="jab-icon">✏️</span><span class="jab-label">Edit</span></button>' : '';
  const dupBtn   = can('canDuplicateJob') ? '<button class="job-act-btn btn-dup" onclick="duplicateJob(\''+jid+'\')" title="Duplicate"><span class="jab-icon">⎘</span><span class="jab-label">Copy</span></button>' : '';
  const splitBtn = can('canSplitJob')     ? '<button class="job-act-btn btn-split-c" onclick="openSplit(\''+jid+'\')" title="Split"><span class="jab-icon">✂️</span><span class="jab-label">Split</span></button>' : '';
  const pinBtn   = '<button class="job-act-btn btn-pin-c" onclick="togglePin(\''+jid+'\')" title="Pin/Unpin"><span class="jab-icon">📌</span><span class="jab-label">Pin</span></button>';
  const rwBtn    = '<button class="job-act-btn btn-rework-c" onclick="toggleRework(\''+jid+'\')" title="Toggle Rework"><span class="jab-icon">🔄</span><span class="jab-label">Rework</span></button>';
  const tlBtn    = '<button class="job-act-btn btn-timeline" onclick="openTimeline(\''+jid+'\')" title="Timeline"><span class="jab-icon">📜</span><span class="jab-label">Log</span></button>';
  const delBtn   = can('canDeleteJob') ? '<button class="job-act-btn btn-del" onclick="deleteJob(\''+jid+'\')" title="Delete"><span class="jab-icon">🗑️</span><span class="jab-label">Delete</span></button>' : '';

  return `<div class="${cardClass}" id="card-${id}">
    <div class="job-card-top">
      <span class="job-id-badge">${id}</span>
      <div class="job-card-badges"><span class="${pClass}">${pLabel}</span>${pinnedBadge}${reworkBadge}${dueDate}</div>
    </div>
    <div class="job-field"><strong>Client:</strong> ${client}</div>
    <div class="job-field"><strong>Job:</strong> ${name}</div>
    <div class="job-field"><strong>Qty:</strong> ${qty}&nbsp;&nbsp;<strong>Sq.Ft:</strong> ${sqft}</div>
    <div class="job-field"><strong>Material:</strong> <span style="display:inline-flex;flex-wrap:wrap;gap:4px;vertical-align:middle">${matDisplay}</span>${finish?' &nbsp;|&nbsp; <strong>Finish:</strong> '+finish:''}</div>
    ${approvalBy ? '<div class="job-field"><strong>Approval:</strong> '+approvalBy+'</div>' : ''}
    ${fileUrl ? '<div class="job-field job-file-row"><button class="btn-view-file" onclick="openJobFile(\''+jid+'\')"><span class="jab-icon">📁</span><span class="jab-label">View File</span></button></div>' : ''}
    <div class="job-notes-wrap">
      <div class="notes-header">
        <span class="notes-label">📝 Notes</span>
        <button class="btn-notes-edit" onclick="editNotes('${jid}')"><span class="jab-icon">✏️</span><span class="jab-label">Edit Notes</span></button>
      </div>
      <div class="notes-text" onclick="editNotes('${jid}')" id="ntext-${jid}">${notes||'Click to add notes…'}</div>
      <textarea class="notes-edit-input" id="ninput-${jid}" onblur="cancelNotes('${jid}')">${notes}</textarea>
      <div class="notes-btns" id="nbtns-${jid}">
        <button class="btn-icon" onmousedown="saveNotes('${jid}')">💾 Save</button>
        <button class="btn-icon" onmousedown="cancelNotes('${jid}')">✕ Cancel</button>
      </div>
    </div>
    <div class="job-card-actions">
      <div class="jca-primary">${mainBtn}${assignMachineBtn}</div>
      <div class="jca-utils">${editBtn}${dupBtn}${splitBtn}${pinBtn}${rwBtn}${tlBtn}${delBtn}</div>
    </div>
  </div>`;
}

function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ========== MULTI-MATERIAL PICKER ==========
function renderMaterialTags(){
  const container = document.getElementById('selectedMaterialTags');
  if(!container) return;
  if(!selectedMaterials.length){ container.innerHTML=''; return; }
  container.innerHTML = selectedMaterials.map((m,i) =>
    `<span class="mat-tag">${escHtml(m)}<button type="button" onclick="removeMaterial(${i})" tabindex="-1">×</button></span>`
  ).join('');
}
function removeMaterial(idx){
  selectedMaterials.splice(idx,1);
  renderMaterialTags();
}
function addMaterialToJob(name){
  const n = name.trim();
  if(!n) return;
  if(!selectedMaterials.includes(n)) selectedMaterials.push(n);
  renderMaterialTags();
  const inp = document.getElementById('matPickerSearch');
  if(inp) inp.value='';
  hideMatDropdown();
}
function filterMatPicker(){
  const q = (document.getElementById('matPickerSearch').value||'').toLowerCase().trim();
  const dropdown = document.getElementById('matPickerDropdown');
  if(!dropdown) return;
  const matches = appData.materials.filter(m =>
    !q || (m.name||'').toLowerCase().includes(q) || (m.category||'').toLowerCase().includes(q)
  );
  if(!matches.length && !q){ hideMatDropdown(); return; }
  dropdown.classList.remove('hidden');
  const items = matches.map(m => {
    const isOut = (m.stock||0) === 0;
    const isLow = !isOut && (m.stock||0) <= (m.lowAt||5);
    const cls   = isOut ? 'stock-out' : isLow ? 'stock-low' : '';
    const stockLabel = isOut ? '🔴 Out of stock' : isLow ? `⚠️ ${m.stock} ${m.unit||''}` : `✅ ${m.stock} ${m.unit||''}`;
    return `<div class="mat-picker-option ${cls}" onclick="addMaterialToJob('${escHtml(m.name)}')">
      <span class="mat-opt-name">${escHtml(m.name)}${m.category?'<span style="color:var(--text-muted);font-size:11px"> · '+escHtml(m.category)+'</span>':''}</span>
      <span class="mat-opt-stock">${stockLabel}</span>
    </div>`;
  });
  // Add "use custom" option if query doesn't exactly match an existing material
  if(q && !appData.materials.some(m=>(m.name||'').toLowerCase()===q)){
    items.push(`<div class="mat-picker-option" onclick="addMaterialToJob('${escHtml(document.getElementById('matPickerSearch').value.trim())}')">
      <span class="mat-opt-name">✚ Add "<strong>${escHtml(document.getElementById('matPickerSearch').value.trim())}</strong>" as custom</span>
    </div>`);
  }
  if(!items.length){
    dropdown.innerHTML='<div class="mat-picker-empty">No materials found — type to add a custom one.</div>';
  } else {
    dropdown.innerHTML = items.join('');
  }
}
function showMatDropdown(){
  filterMatPicker();
}
function hideMatDropdown(){
  const dropdown = document.getElementById('matPickerDropdown');
  if(dropdown) dropdown.classList.add('hidden');
}
function matPickerKeydown(e){
  if(e.key==='Enter'){
    e.preventDefault();
    const val = (document.getElementById('matPickerSearch').value||'').trim();
    if(val) addMaterialToJob(val);
  } else if(e.key==='Escape'){
    hideMatDropdown();
  }
}
// Close mat dropdown when clicking outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('matPickerWrap');
  if(wrap && !wrap.contains(e.target)) hideMatDropdown();
});

// ========== NOTIFICATIONS ==========
function addNotification(message, jobId){
  if(!appData.notifications) appData.notifications = [];
  appData.notifications.unshift({
    id: 'n-'+Date.now(),
    message,
    jobId: jobId||'',
    timestamp: new Date().toISOString(),
    read: false
  });
  // Keep last 50 notifications
  if(appData.notifications.length > 50) appData.notifications.length = 50;
  saveLocal();
  updateNotifBadge();
}
function updateNotifBadge(){
  const badge = document.getElementById('notifBadge');
  if(!badge) return;
  const unread = (appData.notifications||[]).filter(n => !n.read).length;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.classList.toggle('hidden', unread === 0);
}
function toggleNotifications(){
  const panel = document.getElementById('notifPanel');
  if(!panel) return;
  if(panel.classList.contains('hidden')){
    renderNotifications();
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}
function renderNotifications(){
  const list = document.getElementById('notifList');
  if(!list) return;
  const notifs = appData.notifications || [];
  if(!notifs.length){
    list.innerHTML='<div class="notif-empty">No notifications yet</div>';
    return;
  }
  list.innerHTML = notifs.map(n => {
    const timeAgo = formatTimeAgo(n.timestamp);
    return `<div class="notif-item ${n.read?'read':'unread'}">
      <div class="notif-icon">🆕</div>
      <div class="notif-body">
        <div class="notif-msg">${escHtml(n.message)}</div>
        <div class="notif-time">${timeAgo}</div>
      </div>
    </div>`;
  }).join('');
}
function markAllNotificationsRead(){
  (appData.notifications||[]).forEach(n => { n.read = true; });
  saveLocal();
  updateNotifBadge();
  renderNotifications();
}
function formatTimeAgo(ts){
  if(!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff/60000);
  if(mins < 1)  return 'Just now';
  if(mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  if(hrs < 24)  return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
}
// Close notifications panel when clicking outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('notifWrap');
  const panel = document.getElementById('notifPanel');
  if(wrap && panel && !wrap.contains(e.target)) panel.classList.add('hidden');
});

// ========== NOTES ==========
function editNotes(jid){
  const input = document.getElementById('ninput-'+jid);
  const text  = document.getElementById('ntext-'+jid);
  const btns  = document.getElementById('nbtns-'+jid);
  if(!input) return;
  text.style.display='none';
  input.style.display='block';
  btns.style.display='flex';
  input.focus();
}
function cancelNotes(jid){
  const input = document.getElementById('ninput-'+jid);
  const text  = document.getElementById('ntext-'+jid);
  const btns  = document.getElementById('nbtns-'+jid);
  if(!input) return;
  text.style.display='';
  input.style.display='none';
  btns.style.display='none';
}
async function saveNotes(jid){
  const input = document.getElementById('ninput-'+jid);
  if(!input) return;
  const notes = input.value;
  const job = appData.jobs.find(j => j.id===jid);
  if(job){ job.notes = notes; addActivity(job,'Notes updated',currentRole); saveLocal(); }
  cancelNotes(jid);
  try{
    await Cloud.pushData('saveNotes',{jobId:jid, notes});
    showToast('✅ Notes saved','success');
  } catch(e){ showToast('Notes saved locally','info'); }
  renderDashboard();
}

// ========== VIEW FILE ==========
function openJobFile(jid){
  const job = appData.jobs.find(j => j.id === jid);
  const url = job && (job.fileUrl || job.files || '');
  if(!url){ showToast('No file attached to this job','info'); return; }
  // Only open http/https URLs to prevent javascript: or data: URI abuse
  try {
    const parsed = new URL(url);
    if(parsed.protocol !== 'https:' && parsed.protocol !== 'http:'){
      showToast('Invalid file URL','error'); return;
    }
  } catch(e){ showToast('Invalid file URL','error'); return; }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ========== FILE UPLOAD TO GOOGLE DRIVE ==========
function handleFileSelect(input){
  const file = input.files[0];
  const display = document.getElementById('fileNameDisplay');
  const status  = document.getElementById('uploadStatus');
  if(display) display.textContent = file ? file.name : 'No file selected';
  if(status){ status.textContent = ''; status.className = 'upload-status'; }
}

async function uploadFileToDrive(file){
  const folderId = (appData.settings.driveFolderId||'').trim();
  if(!folderId){
    showToast('⚠️ No Drive Folder ID set — go to Settings → Drive to configure it.','warning', 6000);
    return null;
  }
  const statusEl = document.getElementById('uploadStatus');
  if(statusEl){ statusEl.textContent = '⏳ Uploading to Drive…'; statusEl.className = 'upload-status uploading'; }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = async function(e){
      const base64 = e.target.result.split(',')[1];
      try{
        const resp = await Cloud.pushData('uploadFile', {
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          content:  base64,
          folderId
        });
        if(resp && resp.url){
          if(statusEl){ statusEl.textContent = '✅ Uploaded successfully!'; statusEl.className = 'upload-status uploaded'; }
          resolve(resp.url);
        } else {
          const msg = (resp && resp.error) ? resp.error : 'Apps Script did not return a URL';
          if(statusEl){ statusEl.textContent = '❌ ' + msg; statusEl.className = 'upload-status error'; }
          showToast('❌ Drive upload failed: ' + msg,'error');
          resolve(null);
        }
      } catch(err){
        if(statusEl){ statusEl.textContent = '❌ Network error during upload'; statusEl.className = 'upload-status error'; }
        showToast('❌ Upload error: ' + err.message,'error');
        resolve(null);
      }
    };
    reader.readAsDataURL(file);
  });
}


function openJobModal(job){
  document.getElementById('jobModalTitle').textContent = job ? '✏️ Edit Job' : '✚ New Job';
  document.getElementById('jobEditId').value = job ? job.id : '';
  document.getElementById('jobClient').value = job ? (job.client||'') : '';
  document.getElementById('jobName').value   = job ? (job.name||'') : '';
  document.getElementById('jobQty').value    = job ? (job.qty||job.quantity||'') : '';
  document.getElementById('jobSqft').value   = job ? (job.sqft||job.size||'') : '';
  document.getElementById('jobFinish').value    = job ? (job.finish||job.finishing||'') : '';
  document.getElementById('jobPriority').value  = job ? (job.priority||'medium') : 'medium';
  document.getElementById('jobDueDate').value   = job ? (job.dueDate||'') : '';
  document.getElementById('jobApprovalBy').value= job ? (job.approvalBy||'') : '';
  document.getElementById('jobFileUrl').value   = job ? (job.fileUrl||job.files||'') : '';
  // Reset file upload widget
  const fi = document.getElementById('jobFileInput');
  if(fi) fi.value = '';
  const fnd = document.getElementById('fileNameDisplay');
  if(fnd) fnd.textContent = (job && (job.fileUrl||job.files)) ? '(existing file — replace by choosing a new one)' : 'No file selected';
  const us = document.getElementById('uploadStatus');
  if(us){ us.textContent = ''; us.className = 'upload-status'; }
  document.getElementById('jobNotes').value     = job ? (job.notes||'') : '';
  // Initialise multi-material picker
  selectedMaterials = [];
  if(job){
    const mats = job.materials;
    if(Array.isArray(mats) && mats.length) selectedMaterials = [...mats];
    else if(typeof mats === 'string' && mats) selectedMaterials = mats.split(',').map(s=>s.trim()).filter(Boolean);
    else if(job.material) selectedMaterials = job.material.split(',').map(s=>s.trim()).filter(Boolean);
  }
  renderMaterialTags();
  hideMatDropdown();
  openModal('jobModal');
}
function editJob(jid){
  const job = appData.jobs.find(j => j.id===jid);
  if(job) openJobModal(job);
}
async function saveJob(){
  const editId = document.getElementById('jobEditId').value;
  const client = document.getElementById('jobClient').value.trim();
  const name   = document.getElementById('jobName').value.trim();
  if(!client || !name){ showToast('❌ Client and Job Name are required','error'); return; }

  // Handle file upload first (if a local file was chosen)
  const fileInput = document.getElementById('jobFileInput');
  if(fileInput && fileInput.files[0]){
    const uploadedUrl = await uploadFileToDrive(fileInput.files[0]);
    if(uploadedUrl){
      document.getElementById('jobFileUrl').value = uploadedUrl;
    }
    // If upload failed the user can still save with the existing / manual URL
  }

  const isEdit = !!editId;
  let job;
  if(isEdit){
    job = appData.jobs.find(j => j.id===editId);
    if(!job){ showToast('❌ Job not found','error'); return; }
  } else {
    job = { id:genJobId(), status:'waiting', pinned:false, rework:false, machines:[], activity:[], dispatchFinal:null, createdAt:new Date().toISOString(), createdBy:currentRole };
    appData.jobs.push(job);
  }
  job.client     = client;
  job.name       = name;
  job.qty        = parseInt(document.getElementById('jobQty').value)||0;
  job.sqft       = parseFloat(document.getElementById('jobSqft').value)||0;
  // Multi-material: store array; also keep legacy string fields for backward compat
  job.materials  = selectedMaterials.length ? [...selectedMaterials] : [];
  job.material   = selectedMaterials.join(', ');
  job.finish     = document.getElementById('jobFinish').value.trim();
  job.finishing  = job.finish;
  job.priority   = document.getElementById('jobPriority').value;
  job.dueDate    = document.getElementById('jobDueDate').value;
  job.approvalBy = document.getElementById('jobApprovalBy').value.trim();
  job.fileUrl    = document.getElementById('jobFileUrl').value.trim();
  job.files      = job.fileUrl;
  job.notes      = document.getElementById('jobNotes').value;
  addActivity(job, isEdit?'Job edited':'Job created', currentRole);
  saveLocal();
  closeModal('jobModal');
  showToast(isEdit ? '✅ Job updated' : '✅ Job created: '+job.id, 'success');
  if(!isEdit) addNotification('🆕 New job created: '+job.id+' — '+job.name+' (by '+currentRole+')', job.id);
  try{
    await Cloud.pushData(isEdit?'updateJob':'createJob', job);
  } catch(e){}
  renderDashboard();
  updateKPIs();
}

async function deleteJob(jid){
  if(!confirm('Delete job '+jid+'? This cannot be undone.')) return;
  appData.jobs = appData.jobs.filter(j => j.id!==jid);
  saveLocal();
  showToast('🗑️ Job deleted','warning');
  try{ await Cloud.pushData('deleteJob',{jobId:jid}); } catch(e){}
  renderDashboard();
  updateKPIs();
}

async function moveJob(jid, toStatus){
  const job = appData.jobs.find(j => j.id===jid);
  if(!job){ showToast('❌ Job not found','error'); return; }
  const from = job.status;
  job.status = toStatus;
  addActivity(job, `Moved from ${from} → ${toStatus}`, currentRole);
  saveLocal();
  showToast('✅ Moved to '+toStatus,'success');
  try{ await Cloud.pushData('moveJob',{jobId:jid, status:toStatus}); } catch(e){}
  renderDashboard();
  updateKPIs();
}

// ========== APPROVE JOB (waiting → printing, no machine modal) ==========
async function approveJob(jid){
  if(!can('canMoveToPrinting')){ showToast('❌ Not authorized','error'); return; }
  await moveJob(jid, 'printing');
}

// ========== MACHINE ASSIGNMENT (only in printing column) ==========
function openMachineAssignModal(jid){
  if(!can('canAssignMachine')){ showToast('❌ Not authorized','error'); return; }
  printJobId = jid;
  const job = appData.jobs.find(j => j.id===jid);
  if(!job) return;
  const titleEl = document.getElementById('printConfirmTitle');
  const btnEl   = document.getElementById('printConfirmBtn');
  if(titleEl) titleEl.textContent = '🔩 Assign Machine';
  if(btnEl)   btnEl.textContent   = '✓ Assign';
  document.getElementById('printConfirmDesc').textContent = `Job: ${job.id} — ${job.name||''} | Sq.Ft: ${job.sqft||job.size||0}`;
  const mc = document.getElementById('machineCheckboxes');
  const alreadyAssigned = job.machines || [];
  mc.innerHTML = appData.machines.map(m => {
    const prev = alreadyAssigned.find(x => x.machineId===m.id);
    return `
    <div class="machine-check-row">
      <input type="checkbox" id="mchk-${m.id}" value="${m.id}" ${prev?'checked':''}>
      <label class="machine-check-label" for="mchk-${m.id}">${escHtml(m.name)} (${escHtml(m.type)}) — Cap: ${m.capacity} sq.ft/day</label>
      <input type="number" class="machine-sqft-input" id="msqft-${m.id}" placeholder="sq.ft" min="0" step="0.01" value="${prev?prev.sqft:''}">
    </div>`;
  }).join('');
  openModal('printConfirmModal');
}
async function confirmPrint(){
  if(!printJobId) return;
  const job = appData.jobs.find(j => j.id===printJobId);
  if(!job) return;
  const selectedMachines = [];
  appData.machines.forEach(m => {
    const chk = document.getElementById('mchk-'+m.id);
    if(chk && chk.checked){
      const sqft = parseFloat((document.getElementById('msqft-'+m.id)||{}).value)||0;
      selectedMachines.push({machineId:m.id, sqft});
      m.totalSqft = (m.totalSqft||0) + sqft;
      m.jobCount  = (m.jobCount||0) + 1;
    }
  });
  job.machines = selectedMachines;
  addActivity(job, 'Machines assigned' + (selectedMachines.length ? ' (' + selectedMachines.map(x=>x.machineId).join(',') + ')' : ''), currentRole);
  saveLocal();
  closeModal('printConfirmModal');
  showToast('✅ Machines assigned','success');
  try{ await Cloud.pushData('updateJobField',{jobId:printJobId, field:'machines', value:selectedMachines}); } catch(e){}
  // Sync updated machine stats (totalSqft, jobCount) back to cloud
  for(const sel of selectedMachines){
    const m = appData.machines.find(x => x.id===sel.machineId);
    if(m){ try{ await Cloud.pushData('updateMachine', m); } catch(e){} }
  }
  printJobId = null;
  renderDashboard();
  updateKPIs();
}

// ========== DISPATCH / ARCHIVE ==========
function openDispatchModal(jid){
  if(!can('canArchive')){ showToast('❌ Not authorized','error'); return; }
  document.getElementById('dispatchJobId').value = jid;
  document.getElementById('dispatchCourier').value = '';
  document.getElementById('dispatchTracking').value = '';
  document.getElementById('dispatchNotes').value = '';
  openModal('dispatchModal');
}
async function confirmArchive(){
  const jid = document.getElementById('dispatchJobId').value;
  const courier  = document.getElementById('dispatchCourier').value.trim();
  const tracking = document.getElementById('dispatchTracking').value.trim();
  const notes    = document.getElementById('dispatchNotes').value.trim();
  const job = appData.jobs.find(j => j.id===jid);
  if(!job){ showToast('❌ Job not found','error'); return; }
  job.dispatchFinal = { courier, tracking, notes, timestamp: new Date().toISOString() };
  job.archivedAt = new Date().toISOString();
  addActivity(job,'Archived / dispatched',currentRole);
  appData.archive.push(job);
  appData.jobs = appData.jobs.filter(j => j.id!==jid);
  saveLocal();
  closeModal('dispatchModal');
  showToast('✅ Job archived','success');
  try{ await Cloud.pushData('archiveJob',{jobId:jid, dispatchFinal:job.dispatchFinal}); } catch(e){}
  renderDashboard();
  updateKPIs();
}

// ========== DUPLICATE ==========
async function duplicateJob(jid){
  const src = appData.jobs.find(j => j.id===jid);
  if(!src){ showToast('❌ Not found','error'); return; }
  const clone = JSON.parse(JSON.stringify(src));
  clone.id = genJobId();
  clone.status = 'waiting';
  clone.pinned = false;
  clone.activity = [];
  clone.createdAt = new Date().toISOString();
  clone.createdBy = currentRole;
  addActivity(clone,'Duplicated from '+jid,currentRole);
  appData.jobs.push(clone);
  saveLocal();
  showToast('⎘ Duplicated as '+clone.id,'success');
  try{ await Cloud.pushData('createJob',clone); } catch(e){}
  renderDashboard();
  updateKPIs();
}

// ========== SPLIT ==========
function openSplit(jid){
  const job = appData.jobs.find(j => j.id===jid);
  if(!job) return;
  document.getElementById('splitJobId').value = jid;
  document.getElementById('split1Qty').value  = Math.floor((job.qty||0)/2)||1;
  document.getElementById('split2Qty').value  = Math.ceil((job.qty||0)/2)||1;
  document.getElementById('split1Sqft').value = ((job.sqft||0)/2).toFixed(2);
  document.getElementById('split2Sqft').value = ((job.sqft||0)/2).toFixed(2);
  openModal('splitModal');
}
async function confirmSplit(){
  const jid = document.getElementById('splitJobId').value;
  const src = appData.jobs.find(j => j.id===jid);
  if(!src) return;
  const q1 = parseInt(document.getElementById('split1Qty').value)||1;
  const q2 = parseInt(document.getElementById('split2Qty').value)||1;
  const s1 = parseFloat(document.getElementById('split1Sqft').value)||0;
  const s2 = parseFloat(document.getElementById('split2Sqft').value)||0;
  const jobA = JSON.parse(JSON.stringify(src)); jobA.id=genJobId(); jobA.qty=q1; jobA.sqft=s1; jobA.activity=[]; addActivity(jobA,'Split from '+jid,currentRole);
  const jobB = JSON.parse(JSON.stringify(src)); jobB.id=genJobId(); jobB.qty=q2; jobB.sqft=s2; jobB.activity=[]; addActivity(jobB,'Split from '+jid,currentRole);
  appData.jobs = appData.jobs.filter(j => j.id!==jid);
  appData.jobs.push(jobA, jobB);
  saveLocal();
  closeModal('splitModal');
  showToast('✂️ Split into '+jobA.id+' & '+jobB.id,'success');
  try{ await Cloud.pushData('deleteJob',{jobId:jid}); await Cloud.pushData('createJob',jobA); await Cloud.pushData('createJob',jobB); } catch(e){}
  renderDashboard();
  updateKPIs();
}

// ========== PIN / REWORK ==========
async function togglePin(jid){
  const job = appData.jobs.find(j => j.id===jid);
  if(!job) return;
  job.pinned = !job.pinned;
  addActivity(job, job.pinned?'Pinned':'Unpinned', currentRole);
  saveLocal();
  showToast(job.pinned?'📌 Pinned':'Unpinned','info');
  try{ await Cloud.pushData('updateJobField',{jobId:jid,field:'pinned',value:job.pinned}); } catch(e){}
  renderDashboard();
}
async function toggleRework(jid){
  const job = appData.jobs.find(j => j.id===jid);
  if(!job) return;
  job.rework = !job.rework;
  addActivity(job, job.rework?'Flagged for rework':'Rework flag removed', currentRole);
  saveLocal();
  showToast(job.rework?'🔄 Marked as rework':'Rework flag removed','info');
  try{ await Cloud.pushData('updateJobField',{jobId:jid,field:'rework',value:job.rework}); } catch(e){}
  renderDashboard();
}

// ========== ACTIVITY ==========
function addActivity(job, action, by){
  if(!job.activity) job.activity=[];
  job.activity.push({ action, by:by||'system', timestamp:new Date().toISOString() });
}
function openTimeline(jid){
  const job = appData.jobs.find(j => j.id===jid) || appData.archive.find(j => j.id===jid);
  if(!job){ showToast('❌ Job not found','error'); return; }
  const acts = job.activity||[];
  const icons = { 'Job created':'🟢','Job edited':'✏️','Sent to printing':'🖨️','Moved':'🔀','Archived':'📦','Pinned':'📌','Rework':'🔄','Notes':'📝' };
  const html = acts.length ? [...acts].reverse().map(a => {
    const icon = Object.keys(icons).find(k => a.action.includes(k)) ? icons[Object.keys(icons).find(k => a.action.includes(k))] : '●';
    return `<div class="tl-item"><div class="tl-dot">${icon}</div><div class="tl-body"><div class="tl-action">${escHtml(a.action)}</div><div class="tl-meta">By ${escHtml(a.by||'system')} · ${new Date(a.timestamp).toLocaleString()}</div></div></div>`;
  }).join('') : '<div style="color:var(--text-muted);padding:20px;text-align:center">No activity yet</div>';
  document.getElementById('timelineContent').innerHTML = '<div style="font-weight:700;margin-bottom:16px;color:var(--primary)">'+escHtml(job.id)+'</div>'+html;
  openModal('timelineModal');
}

// ========== ARCHIVE VIEW ==========
function renderArchive(){
  const q = ((document.getElementById('archiveSearch')||{}).value||'').toLowerCase();
  const from = (document.getElementById('reportDateFrom')||{}).value||'';
  const to   = (document.getElementById('reportDateTo')||{}).value||'';
  let jobs = appData.archive;
  if(q) jobs = jobs.filter(j => [j.id,j.client,j.name].some(v => v&&v.toLowerCase().includes(q)));
  if(from) jobs = jobs.filter(j => (j.archivedAt||j.createdAt||'')>=from);
  if(to)   jobs = jobs.filter(j => (j.archivedAt||j.createdAt||'')<=to+'T23:59:59');
  const tbody = document.getElementById('archiveBody');
  if(!tbody) return;
  if(!jobs.length){ tbody.innerHTML='<tr><td colspan="10" class="no-data">No archived jobs</td></tr>'; return; }
  tbody.innerHTML = jobs.map(j => {
    const df = j.dispatchFinal||{};
    return `<tr>
      <td><span class="job-id-badge">${escHtml(j.id)}</span></td>
      <td>${escHtml(j.client||'-')}</td>
      <td>${escHtml(j.name||'-')}</td>
      <td>${escHtml(String(j.qty||j.quantity||'-'))}</td>
      <td>${escHtml(String(j.sqft||j.size||'-'))}</td>
      <td>${escHtml(Array.isArray(j.materials)?j.materials.join(', '):(j.material||j.materials||'-'))}</td>
      <td><span class="badge badge-${(j.priority||'medium').toLowerCase()}">${(j.priority||'-').toUpperCase()}</span></td>
      <td>${escHtml(df.courier||'-')}</td>
      <td>${escHtml(df.tracking||'-')}</td>
      <td>${j.archivedAt ? new Date(j.archivedAt).toLocaleDateString() : '-'}</td>
    </tr>`;
  }).join('');
}

function exportArchiveCSV(){
  const headers = ['Job ID','Client','Job Name','Qty','Sq.Ft','Material','Priority','Courier','Tracking','Completed'];
  const rows = appData.archive.map(j => {
    const df = j.dispatchFinal||{};
    return [j.id,j.client,j.name,j.qty||j.quantity,j.sqft||j.size,j.material||j.materials,j.priority,df.courier||'',df.tracking||'',j.archivedAt?new Date(j.archivedAt).toLocaleDateString():''];
  });
  downloadCSV('archive-export.csv', headers, rows);
}
function printArchive(){
  const t = document.querySelector('#viewArchive .table-wrap');
  if(!t) return;
  const w = window.open('','_blank');
  w.document.write('<html><head><title>Archive</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #ddd;text-align:left}th{background:#f5f5f5}</style></head><body><h2>Archive Report — '+new Date().toLocaleString()+'</h2>'+t.innerHTML+'</body></html>');
  w.document.close(); w.print();
}

// ========== ANALYTICS ==========
function renderAnalytics(){
  const jobs = appData.jobs;
  const archived = appData.archive;
  // Status chart
  const statuses = [{label:'Waiting',val:jobs.filter(j=>j.status==='waiting').length,color:'var(--col-waiting)'},
    {label:'Printing',val:jobs.filter(j=>j.status==='printing').length,color:'var(--col-printing)'},
    {label:'Assembly',val:jobs.filter(j=>j.status==='assembly').length,color:'var(--col-assembly)'},
    {label:'Dispatch',val:jobs.filter(j=>j.status==='dispatch').length,color:'var(--col-dispatch)'}];
  const maxS = Math.max(1,...statuses.map(s=>s.val));
  const sc = document.getElementById('statusChart');
  if(sc) sc.innerHTML = statuses.map(s =>
    `<div class="bar-row"><div class="bar-label">${s.label}</div><div class="bar-track"><div class="bar-fill" style="width:${(s.val/maxS*100).toFixed(0)}%;background:${s.color}"><span class="bar-val">${s.val}</span></div></div></div>`
  ).join('');
  // Priority chart
  const pris = [{label:'High',val:jobs.filter(j=>(j.priority||'').toLowerCase()==='high').length,color:'var(--danger)'},
    {label:'Medium',val:jobs.filter(j=>(j.priority||'').toLowerCase()==='medium').length,color:'var(--warning)'},
    {label:'Low',val:jobs.filter(j=>(j.priority||'').toLowerCase()==='low').length,color:'var(--success)'}];
  const maxP = Math.max(1,...pris.map(p=>p.val));
  const pc = document.getElementById('priorityChart');
  if(pc) pc.innerHTML = pris.map(p =>
    `<div class="bar-row"><div class="bar-label">${p.label}</div><div class="bar-track"><div class="bar-fill" style="width:${(p.val/maxP*100).toFixed(0)}%;background:${p.color}"><span class="bar-val">${p.val}</span></div></div></div>`
  ).join('');
  // Heatmap (last 14 days of archive)
  const hm = document.getElementById('throughputHeatmap');
  if(hm){
    const days = [];
    for(let i=13;i>=0;i--){
      const d = new Date(Date.now()-i*86400000);
      const ds = d.toISOString().split('T')[0];
      const count = archived.filter(j => (j.archivedAt||'').startsWith(ds)).length;
      days.push({ds, day:d.toLocaleDateString('en',{weekday:'short'}), count});
    }
    const maxC = Math.max(1,...days.map(d=>d.count));
    hm.innerHTML = days.map(d => {
      const alpha = d.count ? 0.2+0.8*(d.count/maxC) : 0.05;
      const bg = d.count ? `rgba(0,240,255,${alpha.toFixed(2)})` : 'rgba(255,255,255,0.04)';
      return `<div class="heat-cell" style="background:${bg}" title="${d.ds}: ${d.count} jobs"><div class="heat-day">${d.count}</div><div>${d.day}</div></div>`;
    }).join('');
  }
  // Stats
  const ts = document.getElementById('throughputStats');
  if(ts){
    const total = archived.length;
    const avgPerDay = total ? (total/30).toFixed(1) : 0;
    const totalSqft = archived.reduce((s,j)=>s+(parseFloat(j.sqft||j.size||0)||0),0);
    ts.innerHTML = [
      {label:'Total Archived', val:total},
      {label:'Avg Jobs/Day (30d)', val:avgPerDay},
      {label:'Total Sq.Ft Produced', val:totalSqft.toFixed(0)},
      {label:'Active Jobs', val:appData.jobs.length},
      {label:'Total Materials', val:appData.materials.length},
      {label:'Total Machines', val:appData.machines.length}
    ].map(r => `<div class="stat-row"><div class="stat-row-label">${r.label}</div><div class="stat-row-val">${r.val}</div></div>`).join('');
  }
}

// ========== INVENTORY ==========
function renderInventory(){
  refreshCategoryDatalist();
  const alerts = document.getElementById('lowStockAlerts');
  const low = appData.materials.filter(m => (m.stock||0) > 0 && (m.stock||0) <= (m.lowAt||5));
  if(alerts) alerts.innerHTML = low.map(m => `<div class="low-alert">&#9888;&#65039; ${escHtml(m.name)}: ${m.stock} ${escHtml(m.unit||'')} remaining</div>`).join('');

  // Search filter
  const q = ((document.getElementById('invSearch')||{}).value||'').toLowerCase().trim();

  // Apply stock-status tab filter
  let materials = appData.materials.filter(m => {
    const matchQ = !q || (m.name||'').toLowerCase().includes(q) || (m.category||'').toLowerCase().includes(q);
    if(!matchQ) return false;
    if(invStockFilter === 'out')     return (m.stock||0) === 0;
    if(invStockFilter === 'low')     return (m.stock||0) > 0 && (m.stock||0) <= (m.lowAt||5);
    if(invStockFilter === 'instock') return (m.stock||0) > (m.lowAt||5);
    return true; // 'all'
  });

  const tbody = document.getElementById('inventoryBody');
  if(!tbody) return;

  // Cost column — admin only
  const showCost = can('canManageInventory');
  const costHeader = document.getElementById('invCostHeader');
  if(costHeader) costHeader.style.display = showCost ? '' : 'none';
  const oosCostHdr = document.getElementById('oosCostHeader');
  if(oosCostHdr) oosCostHdr.style.display = showCost ? '' : 'none';

  const colSpan = showCost ? 8 : 7;

  // Out-of-stock spotlight section (shown when filter = 'out' or 'all')
  const oosSection = document.getElementById('outOfStockSection');
  const oosBody    = document.getElementById('outOfStockBody');
  const mainTable  = document.getElementById('mainInvTable');
  const outMats    = appData.materials.filter(m => (m.stock||0) === 0 && (!q || (m.name||'').toLowerCase().includes(q) || (m.category||'').toLowerCase().includes(q)));

  if(invStockFilter === 'out'){
    // Show only OOS section, hide normal table
    if(oosSection) oosSection.classList.remove('hidden');
    if(mainTable)  mainTable.classList.add('hidden');
    if(oosBody){
      if(!outMats.length){
        oosBody.innerHTML = `<tr><td colspan="6" class="no-data">No out-of-stock materials 🎉</td></tr>`;
      } else {
        oosBody.innerHTML = outMats.map(m => renderOosRow(m, showCost)).join('');
      }
    }
    return;
  }

  // For 'all' tab: show OOS spotlight if any exist, then main table without OOS rows
  if(invStockFilter === 'all' && outMats.length){
    if(oosSection) oosSection.classList.remove('hidden');
    if(oosBody) oosBody.innerHTML = outMats.map(m => renderOosRow(m, showCost)).join('');
    // Exclude OOS from main table in 'all' mode
    materials = materials.filter(m => (m.stock||0) > 0);
  } else {
    if(oosSection) oosSection.classList.add('hidden');
  }

  if(mainTable) mainTable.classList.remove('hidden');
  if(!materials.length){ tbody.innerHTML=`<tr><td colspan="${colSpan}" class="no-data">No materials found</td></tr>`; return; }
  tbody.innerHTML = materials.map(m => renderInvRow(m, showCost)).join('');
}

function renderOosRow(m, showCost){
  const editBtn    = can('canManageInventory') ? `<button class="btn-icon" title="Edit" onclick="openMaterialModal('${escHtml(m.id)}')">&#9999;&#65039;</button>` : '';
  const stockInBtn = can('canStockIn') ? `<button class="btn-icon" onclick="openStockModal('${escHtml(m.id)}','in')">+In</button>` : '';
  const deleteBtn  = can('canManageInventory') ? `<button class="btn-icon" onclick="deleteMaterial('${escHtml(m.id)}')" style="color:var(--danger)">&#128465;&#65039;</button>` : '';
  const costCell   = showCost ? `<td style="color:var(--success);font-weight:700">&#8377;${(m.cost||0).toFixed(2)}</td>` : '';
  return `<tr style="background:rgba(255,23,68,0.07)">
    <td><strong style="color:var(--danger)">${escHtml(m.name)}</strong></td>
    <td>${escHtml(m.category||'-')}</td>
    <td>${escHtml(m.unit||'-')}</td>
    <td>${m.lowAt||5}</td>
    ${costCell}
    <td>${editBtn}${stockInBtn}${deleteBtn}</td>
  </tr>`;
}

function renderInvRow(m, showCost){
  const isLow = (m.stock||0) > 0 && (m.stock||0) <= (m.lowAt||5);
  const badge = isLow ? '<span class="badge badge-high" style="margin-left:4px">LOW</span>' : '<span class="badge badge-low">OK</span>';
  const editBtn    = can('canManageInventory') ? `<button class="btn-icon" title="Edit" onclick="openMaterialModal('${escHtml(m.id)}')">&#9999;&#65039;</button>` : '';
  const stockInBtn  = can('canStockIn')  ? `<button class="btn-icon" onclick="openStockModal('${escHtml(m.id)}','in')">+In</button>` : '';
  const stockOutBtn = can('canStockOut') ? `<button class="btn-icon" onclick="openStockModal('${escHtml(m.id)}','out')" style="margin:0 4px">-Out</button>` : '';
  const adjustBtn   = can('canStockAdjust') ? `<button class="btn-icon" onclick="openStockModal('${escHtml(m.id)}','adjust')">&#177;Adj</button>` : '';
  const deleteBtn   = can('canManageInventory') ? `<button class="btn-icon" onclick="deleteMaterial('${escHtml(m.id)}')" title="Delete" style="color:var(--danger)">&#128465;&#65039;</button>` : '';
  const anyAction = editBtn || stockInBtn || stockOutBtn || adjustBtn || deleteBtn;
  const costCell = showCost ? `<td style="color:var(--success);font-weight:700">&#8377;${(m.cost||0).toFixed(2)}</td>` : '';
  return `<tr>
    <td><strong>${escHtml(m.name)}</strong></td>
    <td>${escHtml(m.category||'-')}</td>
    <td style="font-weight:700;color:${isLow?'var(--warning)':'var(--success)'}">${m.stock||0}</td>
    <td>${escHtml(m.unit||'-')}</td>
    <td>${m.lowAt||5}</td>
    <td>${badge}</td>
    ${costCell}
    <td>${anyAction || '<span style="color:var(--text-muted);font-size:12px">View only</span>'}</td>
  </tr>`;
}

function setInvFilter(filter){
  invStockFilter = filter;
  ['all','instock','low','out'].forEach(f => {
    const btn = document.getElementById('invTab'+f.charAt(0).toUpperCase()+f.slice(1));
    if(btn) btn.classList.toggle('active', f===filter);
  });
  renderInventory();
}

// Open Add or Edit material modal
function openMaterialModal(mid){
  refreshCategoryDatalist();
  const isEdit = !!mid;
  const m = isEdit ? appData.materials.find(x => x.id === mid) : null;
  const titleEl = document.getElementById('addMaterialTitle');
  const saveBtn = document.getElementById('matSaveBtn');
  if(titleEl) titleEl.textContent = isEdit ? '✏️ Edit Material' : '✚ Add Material';
  if(saveBtn) saveBtn.textContent = isEdit ? '💾 Save Changes' : '✚ Add';
  document.getElementById('matEditId').value = mid || '';
  document.getElementById('matName').value     = m ? m.name     : '';
  document.getElementById('matCategory').value = m ? (m.category||'') : '';
  document.getElementById('matStock').value    = m ? (m.stock||0) : '';
  document.getElementById('matUnit').value     = m ? (m.unit||'') : '';
  document.getElementById('matLowAt').value    = m ? (m.lowAt||5) : '';
  document.getElementById('matCost').value     = m ? (m.cost||0)  : '';
  openModal('addMaterialModal');
}

async function saveMaterial(){
  const name = document.getElementById('matName').value.trim();
  if(!name){ showToast('❌ Material name is required','error'); return; }
  const editId = document.getElementById('matEditId').value;
  const fields = {
    name,
    category: document.getElementById('matCategory').value.trim(),
    stock:    parseFloat(document.getElementById('matStock').value)||0,
    unit:     document.getElementById('matUnit').value.trim(),
    lowAt:    parseFloat(document.getElementById('matLowAt').value)||5,
    cost:     parseFloat(document.getElementById('matCost').value)||0
  };
  let mat;
  if(editId){
    mat = appData.materials.find(m => m.id === editId);
    if(mat){ Object.assign(mat, fields); }
  } else {
    const materialId = 'mat-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2, 11));
    mat = { id: materialId, ...fields, history:[] };
    appData.materials.push(mat);
  }
  // Auto-add new category to the list if not already present
  if(fields.category && !appData.categories.includes(fields.category)){
    appData.categories.push(fields.category);
  }
  saveLocal();
  closeModal('addMaterialModal');
  showToast(editId ? '✅ Material updated' : '✅ Material added', 'success');
  try{ await Cloud.pushData(editId ? 'updateMaterial' : 'createMaterial', mat); } catch(e){}
  renderInventory();
}

async function deleteMaterial(mid){
  if(!confirm('Delete this material?')) return;
  appData.materials = appData.materials.filter(m => m.id!==mid);
  saveLocal();
  showToast('🗑️ Deleted','warning');
  try{ await Cloud.pushData('deleteMaterial',{materialId:mid}); } catch(e){}
  renderInventory();
}
function openStockModal(mid, action){
  const mat = appData.materials.find(m => m.id===mid);
  if(!mat) return;
  document.getElementById('stockMatId').value = mid;
  document.getElementById('stockActionType').value = action;
  document.getElementById('stockQty').value = '';
  document.getElementById('stockNote').value = '';
  const titles = {in:'📥 Stock In',out:'📤 Stock Out',adjust:'🔧 Adjust Stock'};
  document.getElementById('stockModalTitle').textContent = titles[action]||'Stock Adjustment';
  document.getElementById('stockDesc').textContent = `Material: ${mat.name} | Current: ${mat.stock||0} ${mat.unit||''}`;
  openModal('stockModal');
}
async function confirmStockAdjust(){
  const mid = document.getElementById('stockMatId').value;
  const action = document.getElementById('stockActionType').value;
  const qty = parseFloat(document.getElementById('stockQty').value)||0;
  const note = document.getElementById('stockNote').value.trim();
  if(!qty || qty<=0){ showToast('❌ Enter valid quantity','error'); return; }
  const mat = appData.materials.find(m => m.id===mid);
  if(!mat) return;
  const before = mat.stock||0;
  if(action==='in')     mat.stock = before + qty;
  else if(action==='out') mat.stock = Math.max(0, before - qty);
  else mat.stock = qty;
  if(!mat.history) mat.history=[];
  mat.history.push({action, qty, before, after:mat.stock, note, ts:new Date().toISOString()});
  saveLocal();
  closeModal('stockModal');
  showToast('✅ Stock updated','success');
  try{ await Cloud.pushData('updateMaterial', mat); } catch(e){}
  renderInventory();
}
function exportInventoryCSV(){
  const headers = ['Material','Category','Stock','Unit','Low Alert At','Cost'];
  const rows = appData.materials.map(m => [m.name,m.category||'',m.stock||0,m.unit||'',m.lowAt||5,m.cost||0]);
  downloadCSV('inventory-export.csv', headers, rows);
}

// ========== CATEGORY MANAGER ==========
function refreshCategoryDatalist(){
  const dl = document.getElementById('categoriesList');
  if(dl) dl.innerHTML = appData.categories.map(c => `<option value="${escHtml(c)}">`).join('');
}

function openManageCategoriesModal(){
  renderCategoriesManager();
  openModal('categoriesModal');
}

function renderCategoriesManager(){
  const list = document.getElementById('categoriesList2');
  if(!list) return;
  if(!appData.categories.length){
    list.innerHTML = '<div class="cat-empty">No categories yet — add one above.</div>';
    return;
  }
  list.innerHTML = appData.categories.map((c, idx) => `
    <div class="cat-row" id="cat-row-${idx}">
      <span class="cat-name" id="cat-name-${idx}">${escHtml(c)}</span>
      <input type="text" class="form-input cat-edit-input hidden" id="cat-edit-${idx}" value="${escHtml(c)}">
      <div class="cat-row-actions">
        <button class="btn-icon cat-edit-btn" title="Rename" onclick="startEditCategory(${idx})">✏️</button>
        <button class="btn-icon cat-save-btn hidden" title="Save" onclick="commitEditCategory(${idx})">✅</button>
        <button class="btn-icon cat-cancel-btn hidden" title="Cancel" onclick="cancelEditCategory(${idx})">✕</button>
        <button class="btn-icon" title="Delete" style="color:var(--danger)" onclick="deleteCategory(${idx})">🗑️</button>
      </div>
    </div>`).join('');
}

async function saveCategory(){
  const input = document.getElementById('newCatName');
  const name = input ? input.value.trim() : '';
  if(!name){ showToast('❌ Category name required','error'); return; }
  if(appData.categories.includes(name)){ showToast('⚠️ Category already exists','warning'); return; }
  appData.categories.push(name);
  saveLocal();
  if(input) input.value = '';
  renderCategoriesManager();
  refreshCategoryDatalist();
  showToast('✅ Category added','success');
  try{ await Cloud.pushData('saveCategories',{categories:appData.categories}); } catch(e){}
}

function startEditCategory(idx){
  const nameEl  = document.getElementById(`cat-name-${idx}`);
  const inputEl = document.getElementById(`cat-edit-${idx}`);
  const editBtn = document.querySelector(`#cat-row-${idx} .cat-edit-btn`);
  const saveBtn = document.querySelector(`#cat-row-${idx} .cat-save-btn`);
  const cancelBtn = document.querySelector(`#cat-row-${idx} .cat-cancel-btn`);
  if(!nameEl || !inputEl) return;
  nameEl.classList.add('hidden');
  inputEl.classList.remove('hidden');
  inputEl.focus();
  if(editBtn) editBtn.classList.add('hidden');
  if(saveBtn) saveBtn.classList.remove('hidden');
  if(cancelBtn) cancelBtn.classList.remove('hidden');
}

function cancelEditCategory(idx){
  const nameEl  = document.getElementById(`cat-name-${idx}`);
  const inputEl = document.getElementById(`cat-edit-${idx}`);
  const editBtn = document.querySelector(`#cat-row-${idx} .cat-edit-btn`);
  const saveBtn = document.querySelector(`#cat-row-${idx} .cat-save-btn`);
  const cancelBtn = document.querySelector(`#cat-row-${idx} .cat-cancel-btn`);
  if(nameEl) nameEl.classList.remove('hidden');
  if(inputEl){ inputEl.classList.add('hidden'); inputEl.value = appData.categories[idx] || ''; }
  if(editBtn) editBtn.classList.remove('hidden');
  if(saveBtn) saveBtn.classList.add('hidden');
  if(cancelBtn) cancelBtn.classList.add('hidden');
}

async function commitEditCategory(idx){
  const inputEl = document.getElementById(`cat-edit-${idx}`);
  const newName = inputEl ? inputEl.value.trim() : '';
  if(!newName){ showToast('❌ Name cannot be empty','error'); return; }
  if(appData.categories.indexOf(newName) !== -1 && appData.categories.indexOf(newName) !== idx){
    showToast('⚠️ Category already exists','warning'); return;
  }
  const oldName = appData.categories[idx];
  appData.categories[idx] = newName;
  // Update materials that use the old category name
  appData.materials.forEach(m => { if(m.category === oldName) m.category = newName; });
  saveLocal();
  renderCategoriesManager();
  refreshCategoryDatalist();
  showToast('✅ Category renamed','success');
  try{ await Cloud.pushData('saveCategories',{categories:appData.categories}); } catch(e){}
}

async function deleteCategory(idx){
  const name = appData.categories[idx];
  if(!confirm(`Delete category "${name}"? Materials using it won't be deleted.`)) return;
  appData.categories.splice(idx, 1);
  saveLocal();
  renderCategoriesManager();
  refreshCategoryDatalist();
  showToast('🗑️ Category deleted','warning');
  try{ await Cloud.pushData('saveCategories',{categories:appData.categories}); } catch(e){}
}

// ========== MACHINES ==========
function renderMachines(){
  const grid = document.getElementById('machinesGrid');
  if(!grid) return;
  if(!appData.machines.length){ grid.innerHTML='<div style="color:var(--text-muted);padding:40px;text-align:center">No machines added yet. Click ✚ Add Machine to get started.</div>'; return; }
  grid.innerHTML = appData.machines.map(m => {
    const pct = m.capacity ? Math.min(100,(m.totalSqft||0)/m.capacity*100) : 0;
    const statusMap = {
      maintenance: { color: 'var(--warning)', label: '🔧 Maintenance' },
      offline:     { color: 'var(--danger)',  label: '⛔ Offline' }
    };
    const statusInfo = statusMap[m.status] || { color: 'var(--success)', label: '✅ Active' };
    const statusColor = statusInfo.color;
    const statusLabel = statusInfo.label;
    return `<div class="machine-card">
      <div class="machine-name">${escHtml(m.name)}</div>
      <div class="machine-type">${escHtml(m.type||'')}</div>
      <div class="machine-stat"><span class="machine-stat-label">Status</span><span class="machine-stat-val" style="color:${statusColor}">${statusLabel}</span></div>
      <div class="machine-stat"><span class="machine-stat-label">Capacity</span><span class="machine-stat-val">${m.capacity||0} sq.ft/day</span></div>
      <div class="machine-stat"><span class="machine-stat-label">Total Jobs</span><span class="machine-stat-val">${m.jobCount||0}</span></div>
      <div class="machine-stat"><span class="machine-stat-label">Total Sq.Ft</span><span class="machine-stat-val">${(m.totalSqft||0).toFixed(0)}</span></div>
      ${m.notes ? `<div class="machine-notes">${escHtml(m.notes)}</div>` : ''}
      <div class="machine-capacity-bar" title="${pct.toFixed(0)}% utilisation"><div class="machine-capacity-fill" style="width:${pct.toFixed(0)}%"></div></div>
      <div class="machine-actions">
        <button class="btn-secondary" style="flex:1;padding:6px 10px;font-size:12px" onclick="openEditMachine('${escHtml(m.id)}')">✏️ Edit</button>
        <button class="btn-icon" onclick="deleteMachine('${escHtml(m.id)}')" style="color:var(--danger)" title="Delete machine">🗑️</button>
      </div>
    </div>`;
  }).join('');
}
function openAddMachineModal(){
  document.getElementById('addMachineTitle').textContent = '✚ Add Machine';
  document.getElementById('machineEditId').value = '';
  document.getElementById('machineName').value = '';
  document.getElementById('machineType').value = '';
  document.getElementById('machineCapacity').value = '';
  document.getElementById('machineStatus').value = 'active';
  document.getElementById('machineNotes').value = '';
  openModal('addMachineModal');
}
function openEditMachine(mid){
  const m = appData.machines.find(x => x.id===mid);
  if(!m) return;
  document.getElementById('addMachineTitle').textContent = '✏️ Edit Machine — ' + m.name;
  document.getElementById('machineEditId').value = m.id;
  document.getElementById('machineName').value = m.name;
  document.getElementById('machineType').value = m.type||'';
  document.getElementById('machineCapacity').value = m.capacity||0;
  document.getElementById('machineStatus').value = m.status||'active';
  document.getElementById('machineNotes').value = m.notes||'';
  openModal('addMachineModal');
}
async function saveMachine(){
  const editId = document.getElementById('machineEditId').value;
  const name = document.getElementById('machineName').value.trim();
  if(!name){ showToast('❌ Machine name is required','error'); return; }
  const fields = {
    name,
    type:     document.getElementById('machineType').value.trim(),
    capacity: parseFloat(document.getElementById('machineCapacity').value) || 0,
    status:   document.getElementById('machineStatus').value || 'active',
    notes:    document.getElementById('machineNotes').value.trim()
  };
  let machine;
  if(editId){
    machine = appData.machines.find(x => x.id===editId);
    if(machine){ Object.assign(machine, fields); }
  } else {
    const newMachineId = 'mach-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2, 11));
    machine = { id: newMachineId, ...fields, totalSqft: 0, jobCount: 0 };
    appData.machines.push(machine);
  }
  saveLocal();
  closeModal('addMachineModal');
  showToast(editId ? '✅ Machine updated' : '✅ Machine added', 'success');
  try{ await Cloud.pushData(editId ? 'updateMachine' : 'createMachine', machine); } catch(e){}
  renderMachines();
}
async function deleteMachine(mid){
  if(!confirm('Delete this machine?')) return;
  appData.machines = appData.machines.filter(m => m.id!==mid);
  saveLocal();
  showToast('🗑️ Machine deleted','warning');
  try{ await Cloud.pushData('deleteMachine',{machineId:mid}); } catch(e){}
  renderMachines();
}

// ========== SETTINGS ==========
function loadSettingsForm(){
  document.getElementById('settingCompanyName').value   = appData.settings.companyName||'';
  document.getElementById('settingCompanyLogo').value   = appData.settings.companyLogo||'';
  document.getElementById('settingAccentColor').value   = appData.settings.accentColor||'#00f0ff';
  document.getElementById('settingDriveFolderId').value = appData.settings.driveFolderId||'';
  document.getElementById('pinAdmin').value    = appData.pins.admin||'';
  document.getElementById('pinWaiting').value  = appData.pins.waiting||'';
  document.getElementById('pinPrinting').value = appData.pins.printing||'';
  document.getElementById('pinAssembly').value = appData.pins.assembly||'';
  document.getElementById('pinDispatch').value = appData.pins.dispatch||'';
}
async function saveSettings(){
  appData.settings.companyName   = document.getElementById('settingCompanyName').value.trim();
  appData.settings.companyLogo   = document.getElementById('settingCompanyLogo').value.trim();
  appData.settings.accentColor   = document.getElementById('settingAccentColor').value;
  appData.settings.driveFolderId = document.getElementById('settingDriveFolderId').value.trim();
  appData.pins.admin    = document.getElementById('pinAdmin').value||appData.pins.admin;
  appData.pins.waiting  = document.getElementById('pinWaiting').value||appData.pins.waiting;
  appData.pins.printing = document.getElementById('pinPrinting').value||appData.pins.printing;
  appData.pins.assembly = document.getElementById('pinAssembly').value||appData.pins.assembly;
  appData.pins.dispatch = document.getElementById('pinDispatch').value||appData.pins.dispatch;
  saveLocal();
  applyBranding();
  // Persist accent color
  document.documentElement.style.setProperty('--primary', appData.settings.accentColor);
  closeModal('settingsModal');
  showToast('✅ Settings saved','success');
  try{ await Cloud.pushData('saveSettings',{settings:appData.settings}); } catch(e){}
  try{ await Cloud.pushData('savePins',{pins:appData.pins}); } catch(e){}
}
function switchSettingsTab(tab){
  document.querySelectorAll('.settings-tab').forEach((t,i) => {
    const tabs = ['company','pins','theme','drive'];
    t.classList.toggle('active', tabs[i]===tab);
  });
  ['company','pins','theme','drive'].forEach(t => {
    const el = document.getElementById('settingsTab'+t.charAt(0).toUpperCase()+t.slice(1));
    if(el) el.classList.toggle('hidden', t!==tab);
  });
}

// ========== BRANDING ==========
function applyBranding(){
  const name = appData.settings.companyName || 'FactoryFlow OS';
  document.title = name;
  const cnEls = ['loginCompanyName','sidebarName'];
  cnEls.forEach(id => { const el=document.getElementById(id); if(el) el.textContent=name; });
  const logo = appData.settings.companyLogo;
  if(logo){
    ['loginLogo','sidebarLogo'].forEach(id => {
      const el = document.getElementById(id);
      if(!el) return;
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:12px';
      img.addEventListener('error', () => { el.textContent = '🏭'; });
      img.src = logo;
      el.textContent = '';
      el.appendChild(img);
    });
  }
  if(appData.settings.accentColor) document.documentElement.style.setProperty('--primary', appData.settings.accentColor);
}

// ========== THEME ==========
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  appData.settings.theme = theme;
  const btn = document.getElementById('themeBtn');
  if(btn) btn.textContent = theme==='dark' ? '🌙' : '☀️';
}
function toggleTheme(){
  const cur = appData.settings.theme||'dark';
  applyTheme(cur==='dark'?'light':'dark');
  saveLocal();
}

// ========== MODALS ==========
function openModal(id){ const el=document.getElementById(id); if(el){ el.classList.add('active'); el.style.display='flex'; } }
function closeModal(id){ const el=document.getElementById(id); if(el){ el.classList.remove('active'); el.style.display='none'; } }
function closeTopModal(){ document.querySelectorAll('.modal.active').forEach(m => { m.classList.remove('active'); m.style.display='none'; }); }

// ========== KEYBOARD SHORTCUTS ==========
function handleKeyboard(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT') return;
  if(e.key==='Escape'){ closeTopModal(); return; }
  if(e.ctrlKey||e.metaKey){
    if(e.key==='n'||e.key==='N'){ e.preventDefault(); if(can('canCreateJob')) openJobModal(); return; }
    if(e.key==='f'||e.key==='F'){ e.preventDefault(); const gs=document.getElementById('globalSearch'); if(gs) gs.focus(); return; }
  }
  const views = ['','dashboard','archive','analytics','inventory','machines'];
  if(e.key>='1'&&e.key<='5' && !e.ctrlKey && !e.metaKey){ const v=views[parseInt(e.key)]; if(v) switchView(v); }
}

// ========== TOAST ==========
function showToast(msg, type='info', duration=4000){
  const container = document.getElementById('toastContainer');
  if(!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-'+type;
  toast.innerHTML = `
    <div class="toast-inner">
      <span class="toast-icon">${{success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'}[type]||'ℹ️'}</span>
      <div class="toast-body"><div class="toast-msg">${escHtml(msg)}</div></div>
      <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 0 0 8px" onclick="this.closest('.toast').remove()">✕</button>
    </div>
    <div class="toast-progress"><div class="toast-bar" style="width:100%"></div></div>`;
  container.appendChild(toast);
  // Animate progress bar
  const bar = toast.querySelector('.toast-bar');
  bar.style.transition = `width ${duration}ms linear`;
  requestAnimationFrame(() => { requestAnimationFrame(() => { bar.style.width='0%'; }); });
  const timer = setTimeout(() => {
    toast.classList.add('toast-dismiss');
    setTimeout(() => toast.remove(), 310);
  }, duration);
  toast.querySelector('button').addEventListener('click', () => { clearTimeout(timer); });
}

// ========== CSV EXPORT ==========
function downloadCSV(filename, headers, rows){
  const esc = v => '"'+String(v||'').replace(/"/g,'""')+'"';
  const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
