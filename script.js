/* ============================================================
   FactoryFlow OS — script.js
   All core logic preserved + new features added
   ============================================================ */

// ========== CONFIGURATION ==========
var API_URL = 'https://script.google.com/macros/s/AKfycbzbglRY49SnXCq9BrOdL4DtHXxivasmQRn7fiHjByxFwp2OtJg_ML0E-v3SAIN6qSx0ew/exec';

// ========== GLOBAL STATE ==========
var currentUser    = null;
var permissions    = null;
var settings       = null;
var allJobs        = { waiting: [], printing: [], assembly: [], dispatch: [] };
var refreshInterval = null;

// ============================================================
// TOAST NOTIFICATION SYSTEM
// ============================================================
var Toast = {
    icons: {
        success: '✅',
        error:   '❌',
        warning: '⚠️',
        info:    'ℹ️'
    },

    show: function(message, type, duration) {
        type     = type     || 'info';
        duration = duration || 3000;

        var container = document.getElementById('toast-container');
        if (!container) return;

        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;

        var msgEl = document.createElement('div');
        msgEl.className = 'toast-msg';
        msgEl.textContent = message;

        var body = document.createElement('div');
        body.className = 'toast-body';
        body.appendChild(msgEl);

        var iconEl = document.createElement('span');
        iconEl.className = 'toast-icon';
        iconEl.textContent = Toast.icons[type] || 'ℹ️';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', function() { Toast.remove(toast); });

        var progress = document.createElement('div');
        progress.className = 'toast-progress';
        progress.style.animationDuration = duration + 'ms';

        toast.appendChild(iconEl);
        toast.appendChild(body);
        toast.appendChild(closeBtn);
        toast.appendChild(progress);

        container.appendChild(toast);

        var timer = setTimeout(function() { Toast.remove(toast); }, duration);
        toast._timer = timer;

        return toast;
    },

    remove: function(el) {
        if (!el || el._removing) return;
        el._removing = true;
        clearTimeout(el._timer);
        el.classList.add('removing');
        setTimeout(function() { if (el.parentElement) el.parentElement.removeChild(el); }, 350);
    }
};

// Keep old showToast for compatibility
function showToast(message, type) {
    Toast.show(message, type);
}

// ============================================================
// SESSION TIMEOUT
// ============================================================
var Session = {
    timeout:   15 * 60 * 1000, // 15 minutes
    warningAt: 12 * 60 * 1000, // warn at 12 min
    timer:        null,
    warningTimer: null,

    reset: function() {
        clearTimeout(Session.timer);
        clearTimeout(Session.warningTimer);

        Session.warningTimer = setTimeout(function() {
            Toast.show('Session expiring in 3 minutes. Click anywhere to stay logged in.', 'warning', 10000);
        }, Session.warningAt);

        Session.timer = setTimeout(function() {
            handleLogout(true);
            Toast.show('Session expired. Please log in again.', 'error', 5000);
        }, Session.timeout);
    },

    init: function() {
        ['click', 'keydown', 'mousemove', 'scroll'].forEach(function(evt) {
            document.addEventListener(evt, function() {
                if (currentUser) Session.reset();
            }, { passive: true });
        });
    }
};

// ============================================================
// CSV EXPORT
// ============================================================
var Export = {
    toCSV: function(data, filename) {
        if (!data || !data.length) {
            Toast.show('No data to export', 'warning');
            return;
        }
        var keys = Object.keys(data[0]);
        var csv  = keys.join(',') + '\n';
        data.forEach(function(row) {
            csv += keys.map(function(k) {
                var val = (row[k] === undefined || row[k] === null) ? '' : String(row[k]);
                // Escape quotes and wrap if needed
                val = val.replace(/"/g, '""');
                if (val.search(/("|,|\n)/g) >= 0) val = '"' + val + '"';
                return val;
            }).join(',') + '\n';
        });

        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        Toast.show('Exported: ' + filename, 'success');
    },

    jobsCSV: function() {
        var all = allJobs.waiting.concat(allJobs.printing, allJobs.assembly, allJobs.dispatch);
        if (!all.length) { Toast.show('No jobs to export', 'warning'); return; }
        var rows = all.map(function(j) {
            return {
                id:        j.id        || '',
                name:      j.name      || '',
                client:    j.client    || '',
                status:    j.status    || '',
                priority:  j.priority  || '',
                size:      j.size      || '',
                quantity:  j.quantity  || '',
                materials: j.materials || '',
                notes:     j.notes     || ''
            };
        });
        Export.toCSV(rows, 'factoryflow-jobs-' + new Date().toISOString().split('T')[0] + '.csv');
    }
};

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
    showLoginPage();
    checkExistingSession();
    setDefaultDates();
    Session.init();

    // Enter key handlers
    var userInput = document.getElementById('loginUserId');
    var passInput = document.getElementById('loginPassword');
    if (userInput) {
        userInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') { if (passInput) passInput.focus(); }
        });
    }
    if (passInput) {
        passInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleLogin();
        });
    }

    // Close dropdowns when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.priority-wrapper')) {
            closeAllPriorityDropdowns();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        var tag = e.target ? e.target.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (!currentUser) return;

        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(function(m) {
                m.classList.remove('active');
            });
        }
    });
});

function setDefaultDates() {
    var today   = new Date().toISOString().split('T')[0];
    var weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    var fromEl  = document.getElementById('reportDateFrom');
    var toEl    = document.getElementById('reportDateTo');
    if (fromEl) fromEl.value = weekAgo;
    if (toEl)   toEl.value   = today;
}

// ============================================================
// PAGE CONTROL
// ============================================================
function showLoginPage() {
    var lp = document.getElementById('loginPage');
    var dp = document.getElementById('dashboardPage');
    if (lp) lp.style.display = 'flex';
    if (dp) dp.style.display = 'none';
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    clearTimeout(Session.timer);
    clearTimeout(Session.warningTimer);
}

function showDashboardPage() {
    var lp = document.getElementById('loginPage');
    var dp = document.getElementById('dashboardPage');
    if (lp) lp.style.display = 'none';
    if (dp) dp.style.display = 'block';
    applyBranding();
    applyPermissions();
    loadData();
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(loadData, 30000);
    Session.reset();
}

// ============================================================
// SESSION
// ============================================================
function checkExistingSession() {
    var savedUser = localStorage.getItem('jobCardUser');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            permissions = JSON.parse(localStorage.getItem('jobCardPermissions') || '{}');
            settings    = JSON.parse(localStorage.getItem('jobCardSettings') || '{}');
            if (currentUser && currentUser.email && currentUser.name) {
                showDashboardPage();
            } else {
                clearSession();
                showLoginPage();
            }
        } catch (e) {
            clearSession();
            showLoginPage();
        }
    } else {
        loadSettingsForLogin();
    }
}

function clearSession() {
    localStorage.removeItem('jobCardUser');
    localStorage.removeItem('jobCardPermissions');
    localStorage.removeItem('jobCardSettings');
    currentUser = null;
    permissions = null;
}

async function loadSettingsForLogin() {
    try {
        var response = await fetch(API_URL + '?action=getSettings');
        var data = await response.json();
        if (data.success && data.settings) {
            settings = data.settings;
            var nameEl = document.getElementById('loginCompanyName');
            var logoEl = document.getElementById('loginLogoContainer');
            if (settings.companyName && nameEl) nameEl.textContent = settings.companyName;
            if (settings.companyLogo && logoEl) {
                var img = document.createElement('img');
                img.src = settings.companyLogo;
                img.className = 'login-logo';
                img.alt = 'Company Logo';
                img.addEventListener('error', function() {
                    var ph = document.createElement('div');
                    ph.className = 'login-logo-placeholder';
                    ph.textContent = '🏢';
                    if (this.parentElement) { this.parentElement.innerHTML = ''; this.parentElement.appendChild(ph); }
                });
                logoEl.innerHTML = '';
                logoEl.appendChild(img);
            }
        }
    } catch (e) {
        console.log('Could not load settings');
    }
}

// ============================================================
// LOGIN
// ============================================================
async function handleLogin() {
    var emailEl   = document.getElementById('loginUserId');
    var passEl    = document.getElementById('loginPassword');
    var errorEl   = document.getElementById('loginError');
    var btn       = document.getElementById('loginBtn');

    var email    = emailEl  ? emailEl.value.trim() : '';
    var password = passEl   ? passEl.value          : '';

    if (!email || !password) {
        if (errorEl) { errorEl.textContent = 'Please enter email and password'; errorEl.style.display = 'block'; }
        return;
    }

    if (btn)     { btn.disabled = true; btn.textContent = 'Signing in...'; }
    if (errorEl)   errorEl.style.display = 'none';

    try {
        var response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ action: 'login', email: email, password: password })
        });
        var result = await response.json();

        if (result.success) {
            currentUser = result.user;
            permissions = result.permissions || {};
            settings    = result.settings    || {};

            localStorage.setItem('jobCardUser',        JSON.stringify(currentUser));
            localStorage.setItem('jobCardPermissions', JSON.stringify(permissions));
            localStorage.setItem('jobCardSettings',    JSON.stringify(settings));

            Toast.show('Welcome, ' + currentUser.name + '!', 'success');
            showDashboardPage();
        } else {
            if (errorEl) { errorEl.textContent = result.message || 'Login failed'; errorEl.style.display = 'block'; }
        }
    } catch (error) {
        console.error('Login error:', error);
        if (errorEl) { errorEl.textContent = 'Connection error. Please try again.'; errorEl.style.display = 'block'; }
    }

    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
}

function handleLogout(silent) {
    if (!silent && !confirm('Are you sure you want to logout?')) return;
    clearSession();

    var userInput = document.getElementById('loginUserId');
    var passInput = document.getElementById('loginPassword');
    var errInput  = document.getElementById('loginError');
    if (userInput) userInput.value = '';
    if (passInput) passInput.value = '';
    if (errInput)  errInput.style.display = 'none';

    showLoginPage();
    if (!silent) Toast.show('Logged out successfully', 'info');
}

// ============================================================
// BRANDING
// ============================================================
function applyBranding() {
    if (!settings) return;

    var titleEl  = document.getElementById('dashboardTitle');
    var footerEl = document.getElementById('footerCompanyName');
    var headerEl = document.getElementById('headerLogoContainer');
    var nameEl   = document.getElementById('userName');
    var roleEl   = document.getElementById('userRole');

    if (settings.companyName) {
        if (titleEl)  titleEl.textContent  = settings.companyName + ' Dashboard';
        if (footerEl) footerEl.textContent = settings.companyName;
        document.title = settings.companyName + ' - Dashboard';
    }

    if (settings.companyLogo && headerEl) {
        var img = document.createElement('img');
        img.src = settings.companyLogo;
        img.className = 'header-logo';
        img.alt = 'Company Logo';
        img.addEventListener('error', function() {
            var ph = document.createElement('div');
            ph.className = 'header-logo-placeholder';
            ph.textContent = '🏢';
            if (this.parentElement) { this.parentElement.innerHTML = ''; this.parentElement.appendChild(ph); }
        });
        headerEl.innerHTML = '';
        headerEl.appendChild(img);
    }

    if (currentUser) {
        if (nameEl) nameEl.textContent = currentUser.name || 'User';
        if (roleEl) roleEl.textContent = currentUser.role || 'User';
    }
}

// ============================================================
// PERMISSIONS
// ============================================================
function applyPermissions() {
    if (!permissions) return;
    var usersBtn    = document.getElementById('usersBtn');
    var settingsBtn = document.getElementById('settingsBtn');
    var reportBtn   = document.getElementById('reportBtn');
    if (usersBtn)    usersBtn.style.display    = permissions.canManageUsers    ? 'inline-block' : 'none';
    if (settingsBtn) settingsBtn.style.display = permissions.canEditSettings   ? 'inline-block' : 'none';
    if (reportBtn)   reportBtn.style.display   = permissions.canViewReports !== false ? 'inline-block' : 'none';
}

// ============================================================
// LOAD DATA
// ============================================================
async function loadData() {
    var refreshBtn  = document.getElementById('refreshBtn');
    var loadingEl   = document.getElementById('loading');
    var contentEl   = document.getElementById('content');
    var errorEl     = document.getElementById('error');

    try {
        if (refreshBtn) refreshBtn.disabled = true;
        if (loadingEl)  loadingEl.style.display  = 'block';
        if (contentEl)  contentEl.style.display  = 'none';
        if (errorEl)    errorEl.style.display     = 'none';

        var response = await fetch(API_URL);
        var data     = await response.json();

        if (data.error) throw new Error(data.error);

        allJobs = {
            waiting:  data.waiting  || [],
            printing: data.printing || [],
            assembly: data.assembly || [],
            dispatch: data.dispatch || []
        };

        if (data.settings) {
            settings = data.settings;
            localStorage.setItem('jobCardSettings', JSON.stringify(settings));
        }

        renderDashboard(allJobs);
        updateStats(allJobs);
        updateTime();

        if (loadingEl) loadingEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'grid';
        if (refreshBtn) refreshBtn.disabled = false;

    } catch (error) {
        console.error('Error:', error);
        if (loadingEl)  loadingEl.style.display  = 'none';
        if (contentEl)  contentEl.style.display  = 'none';
        if (errorEl)    { errorEl.style.display = 'block'; errorEl.textContent = '❌ Error: ' + error.message; }
        if (refreshBtn) refreshBtn.disabled = false;
    }
}

function updateStats(jobs) {
    var w = document.getElementById('statWaiting');
    var p = document.getElementById('statPrinting');
    var a = document.getElementById('statAssembly');
    var d = document.getElementById('statDispatch');
    if (w) w.textContent = jobs.waiting.length;
    if (p) p.textContent = jobs.printing.length;
    if (a) a.textContent = jobs.assembly.length;
    if (d) d.textContent = jobs.dispatch.length;
}

function updateTime() {
    var el = document.getElementById('lastUpdate');
    if (el) el.textContent = new Date().toLocaleTimeString();
}

// ============================================================
// SEARCH & FILTER
// ============================================================
function searchJobs() {
    var searchEl   = document.getElementById('searchInput');
    var statusEl   = document.getElementById('filterStatus');
    var priorityEl = document.getElementById('filterPriority');

    var searchTerm     = searchEl   ? searchEl.value.toLowerCase().trim()   : '';
    var statusFilter   = statusEl   ? statusEl.value                         : '';
    var priorityFilter = priorityEl ? priorityEl.value                       : '';

    if (!searchTerm && !statusFilter && !priorityFilter) {
        renderDashboard(allJobs);
        return;
    }

    var filteredJobs = {
        waiting:  filterArray(allJobs.waiting,  searchTerm, priorityFilter),
        printing: filterArray(allJobs.printing, searchTerm, priorityFilter),
        assembly: filterArray(allJobs.assembly, searchTerm, priorityFilter),
        dispatch: filterArray(allJobs.dispatch, searchTerm, priorityFilter)
    };

    if (statusFilter) {
        if (statusFilter !== 'waiting')  filteredJobs.waiting  = [];
        if (statusFilter !== 'printing') filteredJobs.printing = [];
        if (statusFilter !== 'assembly') filteredJobs.assembly = [];
        if (statusFilter !== 'dispatch') filteredJobs.dispatch = [];
    }

    renderDashboard(filteredJobs);
    var total = filteredJobs.waiting.length + filteredJobs.printing.length +
                filteredJobs.assembly.length + filteredJobs.dispatch.length;
    Toast.show('Found ' + total + ' job(s)', 'info');
}

function filterArray(jobs, searchTerm, priorityFilter) {
    return jobs.filter(function(job) {
        var matchSearch = !searchTerm ||
            (job.id        || '').toLowerCase().includes(searchTerm) ||
            (job.name      || '').toLowerCase().includes(searchTerm) ||
            (job.client    || '').toLowerCase().includes(searchTerm) ||
            (job.materials || '').toLowerCase().includes(searchTerm);
        var matchPriority = !priorityFilter || (job.priority || '').toLowerCase() === priorityFilter;
        return matchSearch && matchPriority;
    });
}

function clearSearch() {
    var s = document.getElementById('searchInput');
    var f = document.getElementById('filterStatus');
    var p = document.getElementById('filterPriority');
    if (s) s.value = '';
    if (f) f.value = '';
    if (p) p.value = '';
    renderDashboard(allJobs);
    Toast.show('Filters cleared', 'info');
}

// ============================================================
// RENDER DASHBOARD
// ============================================================
function renderDashboard(data) {
    var waiting  = data.waiting  || [];
    var printing = data.printing || [];
    var assembly = data.assembly || [];
    var dispatch = data.dispatch || [];

    var setCount = function(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setCount('waitCount',     waiting.length);
    setCount('printingCount', printing.length);
    setCount('assemblyCount', assembly.length);
    setCount('dispatchCount', dispatch.length);
    setCount('totalCount', waiting.length + printing.length + assembly.length + dispatch.length);

    var canMove   = !permissions || permissions.canMoveJobs !== false;
    var canDelete = permissions && permissions.canDeleteJobs === true;
    var isAdmin   = currentUser && (currentUser.role === 'Admin' || currentUser.role === 'Manager');

    var emptyHTML = function(msg) {
        return '<div class="empty-state"><i class="fas fa-inbox"></i><p>' + msg + '</p></div>';
    };

    var wEl = document.getElementById('waiting');
    var pEl = document.getElementById('printing');
    var aEl = document.getElementById('assembly');
    var dEl = document.getElementById('dispatch');

    if (wEl) wEl.innerHTML = waiting.length
        ? waiting.map(function(j) { return jobTemplate(j, 'Approve', 'approveJob', canMove, canDelete, isAdmin); }).join('')
        : emptyHTML('No jobs waiting');

    if (pEl) pEl.innerHTML = printing.length
        ? printing.map(function(j) { return jobTemplate(j, 'Send to Assembly', 'sendToAssembly', canMove, canDelete, isAdmin); }).join('')
        : emptyHTML('No jobs printing');

    if (aEl) aEl.innerHTML = assembly.length
        ? assembly.map(function(j) { return jobTemplate(j, 'Send to Dispatch', 'sendToReady', canMove, canDelete, isAdmin); }).join('')
        : emptyHTML('No jobs in assembly');

    if (dEl) dEl.innerHTML = dispatch.length
        ? dispatch.map(function(j) { return jobTemplate(j, 'Archive', 'archiveJob', canMove, canDelete, isAdmin); }).join('')
        : emptyHTML('No jobs ready');
}

function getPriorityClass(priority) {
    if (!priority) return '';
    var p = priority.toLowerCase();
    if (p === 'high')   return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    if (p === 'low')    return 'priority-low';
    return '';
}

function jobTemplate(job, buttonText, buttonAction, canMove, canDelete, isAdmin) {
    var id = job.id || '';

    var deleteBtn = canDelete
        ? '<button class="job-delete-btn" onclick="deleteJob(\'' + id + '\')" title="Delete" aria-label="Delete job">✕</button>'
        : '';

    var actionBtn = canMove
        ? '<button class="action-btn btn-move" onclick="' + buttonAction + '(\'' + id + '\')">' + buttonText + '</button>'
        : '<button class="action-btn btn-move" disabled>' + buttonText + '</button>';

    var dupBtn = isAdmin
        ? '<button class="action-btn btn-duplicate" onclick="duplicateJob(\'' + id + '\')" title="Duplicate" aria-label="Duplicate job">⧉</button>'
        : '';

    var notesText    = (job.notes || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
    var priorityText = job.priority || 'Priority';
    var priorityClass = getPriorityClass(job.priority);
    var urgentClass   = (job.priority || '').toLowerCase() === 'high' ? ' priority-urgent' : '';

    // Timeline entries
    var timelineHTML = '';
    if (Array.isArray(job.timeline) && job.timeline.length) {
        timelineHTML = job.timeline.slice(-5).reverse().map(function(t) {
            var date = t.ts ? new Date(t.ts).toLocaleString() : '';
            return '<div class="timeline-item">' +
                '<div class="timeline-dot"></div>' +
                '<div class="timeline-content">' +
                    '<div class="tl-action">' + escHTML(t.action || '') + ': ' + escHTML(t.detail || '') + '</div>' +
                    '<div class="tl-meta">' + escHTML(t.by || '') + (date ? ' · ' + date : '') + '</div>' +
                '</div></div>';
        }).join('');
    } else {
        timelineHTML = '<div class="timeline-item"><div class="timeline-dot"></div><div class="timeline-content"><div class="tl-meta">No activity recorded</div></div></div>';
    }

    return '<div class="job' + urgentClass + '">' +
        deleteBtn +
        '<div class="job-header">' +
            '<div class="job-id">' + escHTML(id) + '</div>' +
            '<div class="priority-wrapper">' +
                '<button class="priority-btn ' + priorityClass + '" onclick="togglePriorityDropdown(event, \'' + id + '\')">' +
                    escHTML(priorityText) + ' ▾' +
                '</button>' +
                '<div class="priority-dropdown" id="priority-dropdown-' + id + '">' +
                    '<button class="priority-option high"   onclick="setPriority(\'' + id + '\', \'High\')">🔴 High</button>' +
                    '<button class="priority-option medium" onclick="setPriority(\'' + id + '\', \'Medium\')">🟡 Medium</button>' +
                    '<button class="priority-option low"    onclick="setPriority(\'' + id + '\', \'Low\')">🟢 Low</button>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div class="job-detail"><b>Job:</b> '       + escHTML(job.name      || '-') + '</div>' +
        '<div class="job-detail"><b>Client:</b> '    + escHTML(job.client    || '-') + '</div>' +
        '<div class="job-detail"><b>Size:</b> '      + escHTML(job.size      || '-') + '</div>' +
        '<div class="job-detail"><b>Qty:</b> '       + escHTML(String(job.quantity || '-')) + '</div>' +
        '<div class="job-detail"><b>Materials:</b> ' + escHTML(job.materials || '-') + '</div>' +
        (job.approvalBy ? '<span class="approval-badge">👤 ' + escHTML(job.approvalBy) + '</span>' : '') +
        (job.finishing  ? '<span class="finishing-badge">✨ ' + escHTML(job.finishing)  + '</span>' : '') +
        (job.files      ? '<a href="' + job.files + '" target="_blank" rel="noopener" class="btn-preview">📄 View File</a>' : '') +
        '<div class="notes-section" id="notes-' + id + '">' +
            '<div class="notes-label">Notes</div>' +
            '<div class="notes-display" onclick="editNotes(\'' + id + '\', \'' + notesText + '\')">' +
                (job.notes ? escHTML(job.notes) : 'Click to add notes') +
            '</div>' +
            '<textarea class="notes-input" id="notes-input-' + id + '" placeholder="Add notes..."></textarea>' +
            '<div class="notes-actions" id="notes-actions-' + id + '">' +
                '<button class="notes-btn notes-btn-save"   onclick="saveNotes(\'' + id + '\')">Save</button>' +
                '<button class="notes-btn notes-btn-cancel" onclick="cancelNotes(\'' + id + '\')">Cancel</button>' +
            '</div>' +
            '<button class="notes-edit-btn" id="notes-edit-btn-' + id + '" onclick="editNotes(\'' + id + '\', \'' + notesText + '\')">✏️ Edit Notes</button>' +
        '</div>' +
        '<button class="timeline-toggle-btn" onclick="toggleTimeline(\'' + id + '\')">⏱ Activity</button>' +
        '<div class="timeline-section" id="timeline-' + id + '">' + timelineHTML + '</div>' +
        '<div class="job-actions">' +
            actionBtn + dupBtn +
        '</div>' +
    '</div>';
}

function escHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================
// TIMELINE
// ============================================================
function toggleTimeline(jobId) {
    var section = document.getElementById('timeline-' + jobId);
    if (section) section.classList.toggle('open');
}

// ============================================================
// PRIORITY FUNCTIONS
// ============================================================
function togglePriorityDropdown(event, jobId) {
    event.stopPropagation();
    closeAllPriorityDropdowns();
    var dropdown = document.getElementById('priority-dropdown-' + jobId);
    if (dropdown) dropdown.classList.toggle('show');
}

function closeAllPriorityDropdowns() {
    document.querySelectorAll('.priority-dropdown').forEach(function(d) {
        d.classList.remove('show');
    });
}

async function setPriority(jobId, priority) {
    closeAllPriorityDropdowns();
    try {
        Toast.show('Setting priority...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'setPriority', jobId: jobId, priority: priority })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('Priority set to ' + priority, 'success');
            loadData();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// NOTES FUNCTIONS
// ============================================================
function editNotes(jobId, currentNotes) {
    var container = document.getElementById('notes-' + jobId);
    if (!container) return;
    container.querySelector('.notes-display').style.display   = 'none';
    container.querySelector('.notes-edit-btn').style.display  = 'none';
    container.querySelector('.notes-input').style.display     = 'block';
    container.querySelector('.notes-actions').style.display   = 'flex';
    container.querySelector('.notes-input').value             = currentNotes || '';
    container.querySelector('.notes-input').focus();
}

function cancelNotes(jobId) {
    var container = document.getElementById('notes-' + jobId);
    if (!container) return;
    container.querySelector('.notes-display').style.display  = 'block';
    container.querySelector('.notes-edit-btn').style.display = 'block';
    container.querySelector('.notes-input').style.display    = 'none';
    container.querySelector('.notes-actions').style.display  = 'none';
}

async function saveNotes(jobId) {
    var input = document.getElementById('notes-input-' + jobId);
    var notes = input ? input.value : '';
    try {
        Toast.show('Saving notes...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'saveNotes', jobId: jobId, notes: notes })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('Notes saved!', 'success');
            loadData();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// JOB ACTIONS
// ============================================================
async function approveJob(jobId) {
    await doJobAction('approve', jobId, 'Approving...', 'Job approved!');
}

async function sendToAssembly(jobId) {
    await doJobAction('sendToAssembly', jobId, 'Sending to assembly...', 'Sent to assembly!');
}

async function sendToReady(jobId) {
    await doJobAction('sendToReady', jobId, 'Sending to dispatch...', 'Sent to dispatch!');
}

async function archiveJob(jobId) {
    if (!confirm('Archive this job?')) return;
    await doJobAction('archiveJob', jobId, 'Archiving...', 'Job archived!');
}

async function deleteJob(jobId) {
    if (!confirm('DELETE this job?\n\nThis cannot be undone!')) return;
    await doJobAction('deleteJob', jobId, 'Deleting...', 'Job deleted!');
}

async function doJobAction(action, jobId, loadingMsg, successMsg) {
    try {
        Toast.show(loadingMsg, 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: action, jobId: jobId })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show(successMsg, 'success');
            loadData();
        } else {
            Toast.show(result.message || 'Action failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// JOB DUPLICATION
// ============================================================
async function duplicateJob(jobId) {
    // Find job in all columns
    var original = null;
    var allArr = allJobs.waiting.concat(allJobs.printing, allJobs.assembly, allJobs.dispatch);
    for (var i = 0; i < allArr.length; i++) {
        if (allArr[i].id === jobId) { original = allArr[i]; break; }
    }
    if (!original) { Toast.show('Job not found', 'error'); return; }

    try {
        Toast.show('Duplicating job...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({
                action:   'duplicateJob',
                jobId:    jobId,
                name:     original.name     || '',
                client:   original.client   || '',
                size:     original.size     || '',
                quantity: original.quantity || '',
                materials:original.materials|| '',
                priority: original.priority || ''
            })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('Job duplicated!', 'success');
            loadData();
        } else {
            // If backend doesn't support, do client-side feedback
            Toast.show('Duplicate: ' + (result.message || 'Not supported by backend'), 'warning');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// MODALS
// ============================================================
function openModal(modalId) {
    var el = document.getElementById(modalId);
    if (el) el.classList.add('active');
}

function closeModal(modalId) {
    var el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
}

// Close modal on outside click
document.addEventListener('click', function(e) {
    if (e.target.classList && e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal.active').forEach(function(m) {
            m.classList.remove('active');
        });
    }
});

// ============================================================
// DISPATCH DETAILS MODAL
// ============================================================
var _pendingDispatchJobId = null;

function openDispatchModal(jobId) {
    _pendingDispatchJobId = jobId;
    var el = document.getElementById('dispatchModal');
    if (el) el.classList.add('active');
}

async function confirmDispatch() {
    var jobId    = _pendingDispatchJobId;
    var courier  = document.getElementById('dispatchCourier')  ? document.getElementById('dispatchCourier').value  : '';
    var tracking = document.getElementById('dispatchTracking') ? document.getElementById('dispatchTracking').value : '';
    var notes    = document.getElementById('dispatchNotes')    ? document.getElementById('dispatchNotes').value    : '';
    var eta      = document.getElementById('dispatchETA')      ? document.getElementById('dispatchETA').value      : '';

    closeModal('dispatchModal');
    _pendingDispatchJobId = null;

    if (!jobId) return;

    try {
        Toast.show('Archiving with dispatch details...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({
                action:   'archiveJob',
                jobId:    jobId,
                dispatch: { courier: courier, tracking: tracking, notes: notes, eta: eta }
            })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('Job archived with dispatch info!', 'success');
            loadData();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// REPORTS
// ============================================================
async function generateReport() {
    var typeEl = document.getElementById('reportType');
    var fromEl = document.getElementById('reportDateFrom');
    var toEl   = document.getElementById('reportDateTo');

    var reportType = typeEl ? typeEl.value : 'daily';
    var dateFrom   = fromEl ? fromEl.value : '';
    var dateTo     = toEl   ? toEl.value   : '';

    Toast.show('Generating report...', 'info');

    try {
        var url      = API_URL + '?action=report&type=' + reportType + '&dateFrom=' + dateFrom + '&dateTo=' + dateTo;
        var response = await fetch(url);
        var data     = await response.json();

        if (data.success && data.report) {
            renderReport(data.report);
            Toast.show('Report generated!', 'success');
        } else {
            Toast.show('Failed to generate report', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

function renderReport(report) {
    var s = report.summary;
    var html = '<div class="report-summary">' +
        '<div class="report-stat"><div class="report-stat-value">' + s.totalJobs + '</div><div class="report-stat-label">Total</div></div>' +
        '<div class="report-stat"><div class="report-stat-value">' + s.waiting   + '</div><div class="report-stat-label">Waiting</div></div>' +
        '<div class="report-stat"><div class="report-stat-value">' + s.printing  + '</div><div class="report-stat-label">Printing</div></div>' +
        '<div class="report-stat"><div class="report-stat-value">' + s.assembly  + '</div><div class="report-stat-label">Assembly</div></div>' +
        '<div class="report-stat"><div class="report-stat-value">' + s.dispatch  + '</div><div class="report-stat-label">Dispatch</div></div>' +
        '<div class="report-stat"><div class="report-stat-value">' + s.urgentJobs+ '</div><div class="report-stat-label">Urgent</div></div>' +
        '</div>';

    if (report.jobs && report.jobs.length > 0) {
        html += '<table class="report-table"><thead><tr>' +
            '<th>Job ID</th><th>Name</th><th>Client</th><th>Status</th><th>Priority</th>' +
            '</tr></thead><tbody>';
        report.jobs.forEach(function(job) {
            html += '<tr>' +
                '<td>' + escHTML(job.id || '-')       + '</td>' +
                '<td>' + escHTML(job.name || '-')     + '</td>' +
                '<td>' + escHTML(job.client || '-')   + '</td>' +
                '<td>' + escHTML(job.status || '-')   + '</td>' +
                '<td>' + escHTML(job.priority || '-') + '</td>' +
                '</tr>';
        });
        html += '</tbody></table>';
    } else {
        html += '<div class="empty-state"><i class="fas fa-inbox"></i><p>No jobs found for this period</p></div>';
    }

    html += '<div style="margin-top:15px;display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button class="toolbar-btn btn-report" onclick="printReport()">🖨️ Print</button>' +
        '<button class="toolbar-btn btn-search" onclick="Export.jobsCSV()">⬇ Export CSV</button>' +
        '</div>';

    var resEl = document.getElementById('reportResults');
    if (resEl) resEl.innerHTML = html;
}

function printReport() {
    var resEl = document.getElementById('reportResults');
    var content = resEl ? resEl.innerHTML : '';
    var win = window.open('', '_blank');
    win.document.write('<html><head><title>Report</title>');
    win.document.write('<style>body{font-family:Arial,sans-serif;padding:20px;color:#111}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #ddd;text-align:left}th{background:#f5f5f5}.report-summary{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:20px}.report-stat{background:#f8f8f8;padding:15px 25px;border-radius:8px;text-align:center}.report-stat-value{font-size:24px;font-weight:bold}.report-stat-label{font-size:12px;color:#666}</style>');
    win.document.write('</head><body>');
    win.document.write('<h1>Job Report</h1>');
    win.document.write('<p>Generated: ' + new Date().toLocaleString() + '</p>');
    win.document.write(content);
    win.document.write('</body></html>');
    win.document.close();
    win.print();
}

// ============================================================
// USER MANAGEMENT
// ============================================================
async function loadUsers() {
    try {
        var response = await fetch(API_URL + '?action=getUsers');
        var data     = await response.json();
        if (data.success && data.users) renderUsersTable(data.users);
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function renderUsersTable(users) {
    var html = '';
    users.forEach(function(user) {
        var statusColor = user.status === 'Active' ? 'color:var(--neon-lime)' : 'color:var(--neon-red)';
        html += '<tr>' +
            '<td>' + escHTML(String(user.id))    + '</td>' +
            '<td>' + escHTML(user.name)           + '</td>' +
            '<td>' + escHTML(user.email)          + '</td>' +
            '<td>' + escHTML(user.role)           + '</td>' +
            '<td style="' + statusColor + ';font-weight:700">' + escHTML(user.status) + '</td>' +
            '<td>' +
                '<button class="toolbar-btn btn-clear" style="padding:5px 10px;font-size:10px;margin-right:5px" onclick="toggleUserStatus(\'' + user.id + '\', \'' + user.status + '\')">Toggle</button>' +
                '<button class="toolbar-btn" style="padding:5px 10px;font-size:10px;background:rgba(255,0,85,0.2);border:1px solid rgba(255,0,85,0.3);color:var(--neon-red)" onclick="deleteUser(\'' + user.id + '\')">Delete</button>' +
            '</td></tr>';
    });
    var tbEl = document.getElementById('usersTableBody');
    if (tbEl) tbEl.innerHTML = html || '<tr><td colspan="6" style="text-align:center;color:var(--text-secondary)">No users</td></tr>';
}

async function addUser() {
    var nameEl  = document.getElementById('newUserName');
    var emailEl = document.getElementById('newUserEmail');
    var passEl  = document.getElementById('newUserPassword');
    var roleEl  = document.getElementById('newUserRole');

    var name     = nameEl  ? nameEl.value.trim()  : '';
    var email    = emailEl ? emailEl.value.trim()  : '';
    var password = passEl  ? passEl.value          : '';
    var role     = roleEl  ? roleEl.value          : 'Viewer';

    if (!name || !email || !password) {
        Toast.show('Please fill all fields', 'error');
        return;
    }

    try {
        Toast.show('Adding user...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'addUser', name, email, password, role })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('User added!', 'success');
            var formEl = document.getElementById('addUserForm');
            if (formEl) formEl.style.display = 'none';
            if (nameEl)  nameEl.value  = '';
            if (emailEl) emailEl.value = '';
            if (passEl)  passEl.value  = '';
            loadUsers();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

async function toggleUserStatus(userId, currentStatus) {
    var newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
    try {
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'updateUser', userId, status: newStatus })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('Status updated!', 'success');
            loadUsers();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

async function deleteUser(userId) {
    if (!confirm('Delete this user?')) return;
    try {
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify({ action: 'deleteUser', userId })
        });
        var result = await response.json();
        if (result.success) {
            Toast.show('User deleted!', 'success');
            loadUsers();
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsForm() {
    if (!settings) return;
    var fields = {
        settingCompanyName:    settings.companyName    || '',
        settingCompanyLogo:    settings.companyLogo    || '',
        settingPrimaryColor:   settings.primaryColor   || '#00f0ff',
        settingSecondaryColor: settings.secondaryColor || '#8b5cf6',
        settingPhone:          settings.phone          || '',
        settingEmail:          settings.email          || '',
        settingAddress:        settings.address        || '',
        settingGSTNumber:      settings.gstNumber      || ''
    };
    Object.keys(fields).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = fields[id];
    });
}

async function saveSettings() {
    var get = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var newSettings = {
        action:          'saveSettings',
        companyName:     get('settingCompanyName'),
        companyLogo:     get('settingCompanyLogo'),
        primaryColor:    get('settingPrimaryColor'),
        secondaryColor:  get('settingSecondaryColor'),
        phone:           get('settingPhone'),
        email:           get('settingEmail'),
        address:         get('settingAddress'),
        gstNumber:       get('settingGSTNumber')
    };

    try {
        Toast.show('Saving settings...', 'info');
        var response = await fetch(API_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain' },
            body:    JSON.stringify(newSettings)
        });
        var result = await response.json();
        if (result.success) {
            settings = newSettings;
            localStorage.setItem('jobCardSettings', JSON.stringify(settings));
            applyBranding();
            Toast.show('Settings saved!', 'success');
            closeModal('settingsModal');
        } else {
            Toast.show(result.message || 'Failed', 'error');
        }
    } catch (error) {
        Toast.show('Error: ' + error.message, 'error');
    }
}
