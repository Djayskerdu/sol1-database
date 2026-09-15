// ╔═══════════════════════════════════════════════════════════╗
// ║  STEP 1 — PASTE YOUR GAS WEB APP URL BELOW               ║
// ╚═══════════════════════════════════════════════════════════╝
const GAS_URL = 'https://script.google.com/macros/s/AKfycby0pzMuQyA0Hp5xZ1eyMr6obJ5gRaOlOjD6I8pIK1XGvKDlydamCHUuKBC6oKJ0bkEhoQ/exec';

// ─── QR SECURITY TOKEN ───────────────────────────────────────
// Deliberately a different secret/prefix from the Lifeclass app so a
// Lifeclass QR code can never be scanned into the SOL 1 system or vice versa.
const QR_SECRET = 'SOL1-2026-DAVAOCHURCH-8X';
const QR_PREFIX = `SOL1_APP:${QR_SECRET}:`;

// ═══════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function apiGet(action, params = "", timeoutMs) {
  // Cache-bust: Google Apps Script Web App GET responses can be cached by
  // Google's edge servers, so a fresh timestamp param + no-store ensures
  // we always get the live sheet data instead of a stale cached copy.
  const cacheBust = `&_t=${Date.now()}`;
  const url = `${GAS_URL}?action=${action}${params}${cacheBust}`;
  const res = await fetchWithTimeout(url, { cache: 'no-store' }, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status} for action=${action}`);
  return await res.json();
}

async function apiPost(payload) {
  // text/plain avoids CORS preflight that Google Apps Script rejects
  const res = await fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ═══════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════
let APP = {
  students: [],
  faculty: [],
  lessons: [],
  payments: [],
  attendance: [],
  facultyAttendance: [],
  credits: [],
  qrScans: [],
  tableGuides: [],
  settings: {},
  currentScreen: 's-portal',
  selectedReason: 'Attendance',
  currentWeek: 1,
  totalFee: 500,
  devotionals: {},   // studentId -> Set of completed day numbers (1-63)
  activities: {},    // studentId -> Set of completed day numbers (1-63)
  makeupStatus: {}   // attendanceId -> { status, notes }
};

// ═══════════════════════════════════════════
// TABLE NAME HELPERS
// Returns the custom Table Name for a given table number.
// Falls back to "Table X" if no custom name is set.
// ═══════════════════════════════════════════
function getTableName(tableNo) {
  if (!tableNo && tableNo !== 0) return '—';
  const guide = APP.tableGuides.find(g => String(g['Table No']) === String(tableNo));
  return (guide && guide['Table Name'] && String(guide['Table Name']).trim())
    ? String(guide['Table Name']).trim()
    : null;
}

// Returns "Name | Table X" if a custom name exists, otherwise "Table X"
function getTableLabel(tableNo) {
  if (!tableNo && tableNo !== 0) return '—';
  const name = getTableName(tableNo);
  return name ? `${name} | Table ${tableNo}` : `Table ${tableNo}`;
}

// ═══════════════════════════════════════════
// ATTENDANCE TIME RULES
// 1:00 PM - 1:44 PM = Present
// 1:45 PM - 2:29 PM = Late
// 2:30 PM onwards   = Absent
// ═══════════════════════════════════════════
function getAttendanceStatusByTime() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const totalMin = h * 60 + m;
  const t_100 = 13 * 60 + 0;   // 1:00 PM
  const t_144 = 13 * 60 + 44;  // 1:44 PM
  const t_145 = 13 * 60 + 45;  // 1:45 PM
  const t_229 = 14 * 60 + 29;  // 2:29 PM
  const t_230 = 14 * 60 + 30;  // 2:30 PM

  if (totalMin >= t_100 && totalMin <= t_144) return 'Present';
  if (totalMin >= t_145 && totalMin <= t_229) return 'Late';
  if (totalMin >= t_230) return 'Absent';
  // Before 1:00 PM, treat as Present (early) 
  return 'Present';
}

function getAttendanceAlertMessage(status) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  if (status === 'Present') return `✅ PRESENT — Scanned at ${timeStr}\n(1:00 PM – 1:44 PM window)`;
  if (status === 'Late')    return `⏰ LATE — Scanned at ${timeStr}\n(1:45 PM – 2:29 PM window)\n⚠️ 3 unexcused tardiness = 1 Absent`;
  if (status === 'Absent')  return `❌ ABSENT — Scanned at ${timeStr}\n(After 2:30 PM)\n⚠️ 3 unexcused absences = Drop`;
  return '';
}

// ═══════════════════════════════════════════
// DEVOTIONAL HELPERS — stored locally
// ═══════════════════════════════════════════
const DEVOTIONAL_KEY_PREFIX = 'lc_devot_';
const ACTIVITY_KEY_PREFIX   = 'lc_activ_';
const TOTAL_DEVOTIONAL_DAYS = 63;

// ── Devotionals (synced to Google Sheets) ───────────────────
function loadDevotionalsFromSheet(sheetRows) {
  APP.students.forEach(s => { APP.devotionals[s['Student ID']] = new Set(); });
  (sheetRows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const day = Number(row['Day No']);
    // Guard against bad/duplicate data in the sheet (e.g. Day No > 63)
    // so a student's count can never exceed the actual 63-day program.
    if (sid && day >= 1 && day <= TOTAL_DEVOTIONAL_DAYS && (row['Completed'] === 'Yes' || row['Completed'] === true)) {
      if (!APP.devotionals[sid]) APP.devotionals[sid] = new Set();
      APP.devotionals[sid].add(day);
    }
  });
}

function loadActivitiesFromSheet(sheetRows) {
  APP.students.forEach(s => { APP.activities[s['Student ID']] = new Set(); });
  (sheetRows || []).forEach(row => {
    const sid = String(row['Student ID'] || '');
    const day = Number(row['Day No']);
    // Guard against bad/duplicate data in the sheet (e.g. Day No > 63)
    // so a student's count can never exceed the actual 63-day program.
    if (sid && day >= 1 && day <= TOTAL_DEVOTIONAL_DAYS && (row['Completed'] === 'Yes' || row['Completed'] === true)) {
      if (!APP.activities[sid]) APP.activities[sid] = new Set();
      APP.activities[sid].add(day);
    }
  });
}

// Fallback: load from localStorage (legacy / offline)
function loadDevotionalsLocal() {
  APP.students.forEach(s => {
    if (APP.devotionals[s['Student ID']] && APP.devotionals[s['Student ID']].size > 0) return;
    const key = DEVOTIONAL_KEY_PREFIX + s['Student ID'];
    try {
      const saved = localStorage.getItem(key);
      const days = saved ? JSON.parse(saved) : [];
      // Guard against stale on-device data with out-of-range days (same fix
      // as the sheet loader) — old cached values here shouldn't inflate counts.
      APP.devotionals[s['Student ID']] = new Set(days.filter(d => d >= 1 && d <= TOTAL_DEVOTIONAL_DAYS));
    } catch(e) { APP.devotionals[s['Student ID']] = new Set(); }
  });
}

function loadActivitiesLocal() {
  APP.students.forEach(s => {
    if (APP.activities[s['Student ID']] && APP.activities[s['Student ID']].size > 0) return;
    const key = ACTIVITY_KEY_PREFIX + s['Student ID'];
    try {
      const saved = localStorage.getItem(key);
      const days = saved ? JSON.parse(saved) : [];
      APP.activities[s['Student ID']] = new Set(days.filter(d => d >= 1 && d <= TOTAL_DEVOTIONAL_DAYS));
    } catch(e) { APP.activities[s['Student ID']] = new Set(); }
  });
}

async function saveDevotional(studentId, day, checked) {
  if (!APP.devotionals[studentId]) APP.devotionals[studentId] = new Set();
  if (checked) APP.devotionals[studentId].add(day);
  else APP.devotionals[studentId].delete(day);
  // local backup
  try { localStorage.setItem(DEVOTIONAL_KEY_PREFIX + studentId, JSON.stringify([...APP.devotionals[studentId]])); } catch(e) {}
  // sync to sheet
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  try {
    await apiPost({ action: 'toggleDevotional', studentId, studentName: student?.['Full Name'] || '', tableNo: student?.['Table No'] || '', dayNo: day, completed: checked, markedBy: APP.currentFaculty?.['Full Name'] || '' });
  } catch(e) { console.warn('Devotional sync failed:', e); }
}

async function saveActivity(studentId, day, checked) {
  if (!APP.activities[studentId]) APP.activities[studentId] = new Set();
  if (checked) APP.activities[studentId].add(day);
  else APP.activities[studentId].delete(day);
  try { localStorage.setItem(ACTIVITY_KEY_PREFIX + studentId, JSON.stringify([...APP.activities[studentId]])); } catch(e) {}
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  try {
    await apiPost({ action: 'toggleActivity', studentId, studentName: student?.['Full Name'] || '', tableNo: student?.['Table No'] || '', dayNo: day, completed: checked, markedBy: APP.currentFaculty?.['Full Name'] || '' });
  } catch(e) { console.warn('Activity sync failed:', e); }
}

function getDevotionalCount(studentId) {
  const size = APP.devotionals[studentId] ? APP.devotionals[studentId].size : 0;
  return Math.min(size, TOTAL_DEVOTIONAL_DAYS);
}
function getActivityCount(studentId) {
  const size = APP.activities[studentId] ? APP.activities[studentId].size : 0;
  return Math.min(size, TOTAL_DEVOTIONAL_DAYS);
}

// ── Makeup Status ────────────────────────────────────────────
function loadMakeupStatusFromSheet(rows) {
  APP.makeupStatus = {};
  (rows || []).forEach(row => {
    const attId = String(row['Attendance ID'] || '');
    if (attId) APP.makeupStatus[attId] = { status: row['Status'] || 'Pending', notes: row['Notes'] || '' };
  });
}

async function saveMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo, notes) {
  APP.makeupStatus[attendanceId] = { status, notes: notes || '' };
  try {
    await apiPost({ action: 'updateMakeupStatus', attendanceId, studentId, studentName, weekNo, tableNo, status, updatedBy: APP.currentFaculty?.['Full Name'] || 'Admin', notes: notes || '' });
  } catch(e) { console.warn('Makeup status sync failed:', e); }
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  loadAllData();
  initClock();
});

// ═══════════════════════════════════════════
// LOAD ALL DATA
// ═══════════════════════════════════════════
function safeData(settled) {
  if (settled.status === 'rejected') {
    console.warn('API call failed:', settled.reason);
    return [];
  }
  return settled.value?.data || [];
}

// ─── LOCAL CACHE OF THE LAST GOOD DATA BUNDLE ─────────────────────────
// Apps Script's own open-the-spreadsheet step is the slow part of every
// sync (often several seconds) and nothing on the frontend can speed
// that up. What we CAN fix is the blank/loading screen while it's
// happening: cache the last successful bundle and render it instantly
// on load, then swap in fresh data once the network call finishes.
const DATA_CACHE_KEY = 'sol1_data_cache_v1';

function loadCachedBundle() {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.bundle ? parsed : null;
  } catch (e) { return null; }
}

function saveCachedBundle(bundle) {
  try {
    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify({ bundle, savedAt: Date.now() }));
  } catch (e) {
    // Quota exceeded or storage unavailable (e.g. private browsing) —
    // caching is a nice-to-have, so fail silently rather than break sync.
    console.warn('Could not cache data locally:', e);
  }
}

// Pushes a data bundle into APP state and re-renders every screen that
// depends on it. Shared by the instant cached render and the live
// network update, so both paths behave identically.
function applyBundle(bundle) {
  APP.students          = bundle.students          || [];
  APP.faculty            = bundle.faculty            || [];
  APP.credits             = bundle.credits             || [];
  APP.payments            = bundle.payments            || [];
  APP.attendance          = bundle.studentAttendance   || [];
  APP.facultyAttendance   = bundle.facultyAttendance   || [];
  APP.lessons             = bundle.lessonWeeks         || [];
  APP.qrScans             = bundle.qrscans             || [];
  APP.tableGuides         = bundle.tableGuides         || [];

  const settingsData = bundle.settings || [];
  if (settingsData.length) {
    settingsData.forEach(row => { APP.settings[row['Setting']] = row['Value']; });
    APP.currentWeek = Number(APP.settings['Current Week'] || 1);
    APP.totalFee    = Number(APP.settings['Total Class Fee'] || 500);
  }

  loadDevotionalsFromSheet(bundle.devotionals || []);
  loadActivitiesFromSheet(bundle.activities || []);
  loadDevotionalsLocal();   // fill blanks from localStorage (offline fallback)
  loadActivitiesLocal();
  loadMakeupStatusFromSheet(bundle.makeupStatus || []);

  populateCreditStudentSelect();
  populatePayStudentSelect();
  populateWeekDropdowns();
  updateAdminHomeStats();
  updateFacultyHome();
  renderRecordStats();
  renderBalancesSummary();
  refreshCurrentScreen();
}

async function loadAllData() {
  // STEP 1 — render instantly from whatever we last synced successfully,
  // so the dashboard is usable right away instead of sitting blank while
  // Apps Script opens the spreadsheet in the background.
  const cached = loadCachedBundle();
  if (cached) {
    applyBundle(cached.bundle);
    updateSyncStatus(false, 'Showing saved data — syncing latest…', true);
  } else {
    updateSyncStatus(false);
  }

  // STEP 2 — fetch the live data and swap it in once it arrives.
  // Single batched call — the backend opens the spreadsheet ONCE and reads
  // every sheet in that one execution, instead of the old approach of 13
  // separate HTTP calls each re-opening the spreadsheet from scratch.
  // Falls back to the old per-sheet calls automatically if the deployed
  // backend doesn't have the "allData" action yet (e.g. not redeployed).
  let bundle;
  let usedFallback = false;
  let missingSheets = [];
  try {
    // Give this one generous room (30s) since it's a single request doing
    // real work server-side — a slow-but-working response is much better
    // than giving up early and triggering the 13-call fallback below,
    // which only adds MORE concurrent load on top of whatever already
    // made this one slow.
    let res;
    try {
      res = await apiGet('allData', '', 30000);
    } catch (firstErr) {
      // One quiet retry before falling back — covers the common case of
      // a momentary pile-up (several devices syncing at once) that's
      // already clearing up by the time we try again.
      res = await apiGet('allData', '', 30000);
    }
    if (!res || res.success === false || !res.data) throw new Error('allData not available');
    bundle = res.data;
    missingSheets = res.missingSheets || [];
  } catch (err) {
    usedFallback = true;
    const results = await Promise.allSettled([
      apiGet('students'), apiGet('faculty'), apiGet('credits'), apiGet('payments'),
      apiGet('studentAttendance'), apiGet('facultyAttendance'), apiGet('lessonWeeks'),
      apiGet('qrscans'), apiGet('tableGuides'), apiGet('settings'),
      apiGet('devotionals'), apiGet('activities'), apiGet('makeupStatus')
    ]);
    bundle = {
      students: safeData(results[0]), faculty: safeData(results[1]), credits: safeData(results[2]),
      payments: safeData(results[3]), studentAttendance: safeData(results[4]), facultyAttendance: safeData(results[5]),
      lessonWeeks: safeData(results[6]), qrscans: safeData(results[7]), tableGuides: safeData(results[8]),
      settings: safeData(results[9]), devotionals: safeData(results[10]), activities: safeData(results[11]),
      makeupStatus: safeData(results[12])
    };
    bundle._failCount = results.slice(0, 10).filter(r => r.status === 'rejected').length;
  }

  // If EVERY source failed and we already have cached data on screen,
  // leave the cached render in place instead of wiping it with empty
  // arrays — a dropped connection shouldn't blank out what's showing.
  const totalFailure = usedFallback && (bundle._failCount || 0) === 10;
  if (!(totalFailure && cached)) {
    applyBundle(bundle);
  }

  if (usedFallback) {
    const failCount = bundle._failCount || 0;
    if (failCount === 10) {
      updateSyncStatus(false, cached ? 'Offline — showing saved data' : 'Cannot reach server — check GAS_URL', !!cached);
      if (!cached) showConnectionError();
    } else if (failCount > 0) {
      updateSyncStatus(false, failCount + ' source(s) failed to load');
      saveCachedBundle(bundle);
    } else {
      updateSyncStatus(true);
      saveCachedBundle(bundle);
    }
  } else if (missingSheets.length) {
    // The request succeeded, but one or more tabs don't exist in the Sheet
    // (wrong/renamed tab, e.g. FACULTY_STAFF) — this is why login can say
    // "still connecting" even though the badge would otherwise say Synced.
    updateSyncStatus(false, 'Missing tab(s) in Sheet: ' + missingSheets.join(', '));
  } else if (APP.faculty.length === 0) {
    // Connected fine, FACULTY_STAFF tab exists, but it has no rows —
    // logins need at least one row in there (Username/Password columns).
    updateSyncStatus(false, 'Connected, but FACULTY_STAFF has no rows yet');
  } else {
    updateSyncStatus(true);
    saveCachedBundle(bundle);
  }
}

function showConnectionError() {
  const el = document.getElementById('sync-label-portal');
  if (el) {
    el.innerHTML = '⚠️ <strong>Not connected.</strong> Set GAS_URL in script1.js, then redeploy.';
    el.style.color = '#c0392b';
    el.style.fontSize = '12px';
  }
}

// ═══════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════
function showToast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
  }, duration);
}

// ═══════════════════════════════════════════
// REASON SELECTOR
// ═══════════════════════════════════════════
function selectReason(btn, reason) {
  const grid = btn.closest('.reason-grid');
  if (grid) grid.querySelectorAll('.reason-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  APP.selectedReason = reason;

  const creditOther = document.getElementById('credit-other-wrap');
  if (creditOther) creditOther.style.display = (reason === '__other__' && btn.closest('#s-add-credit')) ? '' : 'none';
  const modalOther = document.getElementById('modal-other-wrap');
  if (modalOther) modalOther.style.display = (reason === '__other__' && btn.closest('#modal-table-credit')) ? '' : 'none';
}

// ═══════════════════════════════════════════
// POPULATE SELECTS
// ═══════════════════════════════════════════
function populateCreditStudentSelect() {
  const sel = document.getElementById('credit-student-sel');
  if (!sel) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]}</option>`
  ).join('');
}

// ═══════════════════════════════════════════
// REFRESH CURRENT SCREEN
// ═══════════════════════════════════════════
function refreshCurrentScreen() {
  const id = APP.currentScreen;
  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-f-devotional')  renderFDevotional();
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-a-devotional')  renderADevotionalTables();
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
  if (id === 's-a-led-control') openLedControl();
}

// ═══════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════
const LOGIN_SCREEN_IDS = ['s-portal', 's-faculty-login', 's-admin-login', 's-record-login', 's-gs-host-login', 's-gs-buzzer-login'];

function go(id) {
  const main = document.getElementById('desktop-main');
  (main ? main.querySelectorAll('.screen') : document.querySelectorAll('.screen'))
    .forEach(s => { s.classList.remove('active'); s.classList.remove('screen-animated'); });
  const el = document.getElementById(id);
  if (el) { el.classList.add('screen-animated'); el.classList.add('active'); }
  APP.currentScreen = id;

  const refreshBtn = document.getElementById('global-refresh-btn');
  if (refreshBtn) refreshBtn.classList.toggle('is-hidden', LOGIN_SCREEN_IDS.includes(id));

  if (id === 's-faculty-home')  updateFacultyHome();
  if (id === 's-f-lessons')     renderWeeks('f');
  if (id === 's-f-students')    renderFStudents();
  if (id === 's-f-payment')     renderFPayment();
  if (id === 's-f-credits')     renderFCredits();
  if (id === 's-f-devotional')  renderFDevotional();
  if (id === 's-admin-home')    updateAdminHomeStats();
  if (id === 's-a-student-att') renderAStudentAtt();
  if (id === 's-a-faculty-att') renderAFacultyAtt();
  if (id === 's-a-makeup')      renderMakeup();
  if (id === 's-a-dropped')     renderDroppedStudents();
  if (id === 's-a-tables')      renderATables();
  if (id === 's-a-leaderboard') switchLeaderboardTab('students');
  if (id === 's-a-devotional')  renderADevotionalTables();
  if (id === 's-record-home')   renderRecordStats();
  if (id === 's-r-qr')          { switchQRTab('scan'); }
  if (id === 's-r-attendance')  switchAttTab('students');
  if (id === 's-r-payment')     populatePayStudentSelect();
  if (id === 's-r-balances')    { renderBalances(); renderBalancesSummary(); }
  if (id === 's-add-credit')   populateCreditStudentSelect();
  if (id === 's-a-led-control') openLedControl();
}

// Manually re-syncs all data from the sheet and re-renders whatever screen
// is currently open — no page reload, so the person stays logged in.
async function refreshApp() {
  const btn = document.getElementById('global-refresh-btn');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  try {
    await loadAllData();
    showToast('✅ Data refreshed');
  } catch (err) {
    showToast('❌ Refresh failed — check connection');
    console.error('refreshApp error:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// ═══════════════════════════════════════════
// WEEK LESSONS
// ═══════════════════════════════════════════
function renderWeeks(prefix) {
  const grid = document.getElementById(`week-grid-${prefix}`);
  if (!grid) return;
  if (!APP.lessons.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No lessons found.</p>';
    return;
  }
  grid.innerHTML = APP.lessons.map(l => `
    <div class="week-card" style="cursor:pointer;border:1.5px solid var(--border);border-radius:12px;padding:14px;background:#fff;transition:box-shadow 0.15s" onclick="showLessonDetail(${l['Week No']},'${prefix}')" onmouseover="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.10)'" onmouseout="this.style.boxShadow='none'">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:2px">WEEK ${l["Week No"]}</div>
      <strong style="font-size:14px;color:var(--text1)">${l["Lesson Title"] || ""}</strong>
      <div style="margin-top:6px;font-size:11px;color:var(--text3)">${l["Status"] || ""}</div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Turns the raw multi-line "Lesson Content" cell text (exactly as typed/arranged
// in Google Sheets, with blank-line paragraph breaks and "1. ITEM — description"
// style numbered points) into properly structured, styled HTML.
function formatLessonContent(raw) {
  if (!raw || !String(raw).trim()) {
    return '<span style="color:var(--text3)">No content added yet.</span>';
  }

  const text = String(raw).replace(/\r\n/g, '\n').trim();
  const blocks = text.split(/\n\s*\n/); // paragraphs = blank-line separated chunks
  let html = '';

  blocks.forEach(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;

    const isNumberedList = lines.length > 1 && lines.every(l => /^\d+\.\s*/.test(l));

    if (isNumberedList) {
      html += '<div class="lc-list">';
      lines.forEach(line => {
        const m = line.match(/^(\d+)\.\s*(.+)$/);
        const num = m[1];
        const rest = m[2];
        const dashMatch = rest.match(/^(.*?)\s*[—–-]\s*(.+)$/);
        const label = dashMatch ? dashMatch[1].trim() : rest.trim();
        const desc  = dashMatch ? dashMatch[2].trim() : '';
        html += `<div class="lc-list-item">
          <span class="lc-num">${num}.</span>
          <span class="lc-item-body"><strong>${escapeHtml(label)}</strong>${desc ? ' — ' + escapeHtml(desc) : ''}</span>
        </div>`;
      });
      html += '</div>';
      return;
    }

    if (lines.length === 1) {
      const letters = lines[0].replace(/[^A-Za-z]/g, '');
      const isHeading = letters.length > 3 && letters === letters.toUpperCase();
      if (isHeading) {
        html += `<div class="lc-heading">${escapeHtml(lines[0])}</div>`;
        return;
      }
    }

    html += `<p class="lc-para">${lines.map(escapeHtml).join('<br>')}</p>`;
  });

  return html || `<p class="lc-para">${escapeHtml(text)}</p>`;
}

function showLessonDetail(weekNo, prefix) {
  const lesson = APP.lessons.find(l => String(l["Week No"]) === String(weekNo));
  if (!lesson) return;

  const titleEl = document.getElementById('lesson-detail-title');
  const bodyEl  = document.getElementById('lesson-detail-body');

  if (titleEl) titleEl.textContent = `Week ${lesson["Week No"]}`;
  if (bodyEl) bodyEl.innerHTML = `
    <div class="card" style="margin-bottom:12px;background:linear-gradient(135deg,var(--navy),var(--navy-light));padding:18px">
      <div style="font-size:11px;color:rgba(255,255,255,0.65);font-weight:600;margin-bottom:4px">LESSON TITLE</div>
      <div style="font-size:18px;font-weight:700;color:#fff;font-family:var(--font-head)">${lesson["Lesson Title"] || "—"}</div>
    </div>
    <div class="card" style="margin-bottom:12px;padding:18px">
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:8px">LESSON CONTENT</div>
      <div class="lc-content">${formatLessonContent(lesson["Lesson Content"])}</div>
    </div>
    <div style="display:flex;gap:10px">
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">DATE RELEASED</div>
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${lesson["Date Released"] ? new Date(lesson["Date Released"]).toLocaleDateString() : "—"}</div>
      </div>
      <div class="card" style="flex:1;padding:14px;text-align:center">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">STATUS</div>
        <div style="font-size:13px;font-weight:600;color:${lesson["Status"] === "Released" ? "var(--green)" : "var(--text3)"}">${lesson["Status"] || "—"}</div>
      </div>
    </div>
  `;

  APP._lessonDetailPrefix = prefix;
  go('s-f-lesson-detail');
}

// ═══════════════════════════════════════════
// FACULTY — ATTENDANCE LIST (renamed from Students)
// ═══════════════════════════════════════════
function renderFStudents() {
  const list = document.getElementById('f-students-list');
  if (!list) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const week = document.getElementById('f-week-filter')?.value || APP.currentWeek;
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    list.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }

  const statusColors = {
    present: { bg: '#e8f5ee', color: '#e64980', label: 'Present' },
    late:    { bg: '#fff5e0', color: '#c9960c', label: 'Late'    },
    absent:  { bg: '#fdecea', color: '#e53935', label: 'Absent'  },
    none:    { bg: '#eceef1', color: '#6b7280', label: 'Not yet recorded' },
  };

  // Tally tardiness and absences for warning
  list.innerHTML = filtered.map(s => {
    const att = APP.attendance.find(a =>
      String(a["Student ID"]) === String(s["Student ID"]) &&
      String(a["Week No"]) === String(week)
    );

    // IMPORTANT: no attendance row at all (never scanned, not marked absent)
    // must NOT be displayed as "Absent" — that's a real, distinct status
    // someone explicitly recorded. Missing data just means nothing has
    // happened yet for this student/week.
    let key;
    if (!att) {
      key = "none";
    } else {
      const rawStatus = (att["Attendance Status"] || att["Status"] || "present").toLowerCase();
      key = rawStatus.includes("late") ? "late" : rawStatus.includes("absent") ? "absent" : "present";
    }
    const { bg, color, label } = statusColors[key];

    // Count totals for warnings
    const allAtt = APP.attendance.filter(a => String(a["Student ID"]) === String(s["Student ID"]));
    const totalLate = allAtt.filter(a => (a["Attendance Status"]||a["Status"]||"").toLowerCase().includes("late")).length;
    const totalAbsent = allAtt.filter(a => (a["Attendance Status"]||a["Status"]||"").toLowerCase().includes("absent")).length;
    const warningHtml = totalAbsent >= 2 ? `<div style="font-size:10px;color:#e53935;margin-top:2px">⚠️ ${totalAbsent} absences${totalAbsent >= 3 ? ' — DROP RISK' : ''}</div>` :
                        totalLate >= 2 ? `<div style="font-size:10px;color:#c9960c;margin-top:2px">⏰ ${totalLate} tardiness${totalLate >= 3 ? ' = 1 Absent' : ''}</div>` : '';

    return `
      <div class="row" style="align-items:center">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>${getTableLabel(s["Table No"])} · Week ${week}</small>
          ${warningHtml}
        </div>
        <div style="background:${bg};color:${color};font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;white-space:nowrap">${label}</div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// FACULTY — DEVOTIONAL & ACTIVITIES (Student List)
// ═══════════════════════════════════════════
let devotActCurrentStudent = null;

function renderFDevotional() {
  const el = document.getElementById('f-devotional-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const devotDone = getDevotionalCount(s["Student ID"]);
    const devotPct  = Math.round((devotDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    const activDone = getActivityCount(s["Student ID"]);
    const activPct  = Math.round((activDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    return `
      <button class="row" style="align-items:center;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:12px 0;border-bottom:1px solid #f0f0f0" onclick="openDevotActDetail('${s["Student ID"]}')">
        <div style="flex:1">
          <div style="font-weight:600;font-size:14px">${s["Full Name"]}</div>
          <div style="display:flex;gap:12px;margin-top:4px">
            <div style="flex:1">
              <div style="font-size:10px;color:#e64980;font-weight:600;margin-bottom:2px">📖 Devotionals ${devotDone}/${TOTAL_DEVOTIONAL_DAYS}</div>
              <div style="height:4px;background:#e0e0e0;border-radius:4px;overflow:hidden">
                <div style="height:100%;width:${devotPct}%;background:${devotPct >= 80 ? '#e64980' : devotPct >= 50 ? '#c9960c' : '#e53935'};border-radius:4px;transition:width 0.3s"></div>
              </div>
            </div>
            <div style="flex:1">
              <div style="font-size:10px;color:#ae3ec9;font-weight:600;margin-bottom:2px">⚡ Activities ${activDone}/${TOTAL_DEVOTIONAL_DAYS}</div>
              <div style="height:4px;background:#e0e0e0;border-radius:4px;overflow:hidden">
                <div style="height:100%;width:${activPct}%;background:${activPct >= 80 ? '#ae3ec9' : activPct >= 50 ? '#c9960c' : '#e53935'};border-radius:4px;transition:width 0.3s"></div>
              </div>
            </div>
          </div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="2" style="width:16px;height:16px;margin-left:10px;flex-shrink:0"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('');
}

function openDevotActDetail(studentId) {
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) return;
  devotActCurrentStudent = studentId;
  devotActActiveTab = 'devot'; // always start on Devotionals tab
  const el = document.getElementById('f-devot-detail-name');
  if (el) el.textContent = student["Full Name"];
  renderDevotActChecklist(studentId);
  go('s-f-devot-detail');
}

// Tab state for devotional detail screen
let devotActActiveTab = 'devot'; // 'devot' or 'activ'

function switchDevotTab(tab) {
  devotActActiveTab = tab;
  const devotTab = document.getElementById('devot-tab-btn');
  const activTab = document.getElementById('activ-tab-btn');
  const devotPanel = document.getElementById('devot-tab-panel');
  const activPanel = document.getElementById('activ-tab-panel');
  if (!devotTab || !activTab || !devotPanel || !activPanel) return;

  if (tab === 'devot') {
    devotTab.style.background = '#e64980';
    devotTab.style.color = '#fff';
    devotTab.style.borderColor = '#e64980';
    activTab.style.background = '#fff';
    activTab.style.color = '#ae3ec9';
    activTab.style.borderColor = '#e8e8e8';
    devotPanel.style.display = '';
    activPanel.style.display = 'none';
  } else {
    activTab.style.background = '#ae3ec9';
    activTab.style.color = '#fff';
    activTab.style.borderColor = '#ae3ec9';
    devotTab.style.background = '#fff';
    devotTab.style.color = '#e64980';
    devotTab.style.borderColor = '#e8e8e8';
    devotPanel.style.display = 'none';
    activPanel.style.display = '';
  }
}

// Render BOTH devotional + activity checklists separately (tab-based)
function renderDevotActChecklist(studentId) {
  const el = document.getElementById('f-devot-checklist');
  if (!el) return;
  const devotDone = APP.devotionals[studentId] || new Set();
  const activDone = APP.activities[studentId] || new Set();
  const devotCount = devotDone.size;
  const activCount = activDone.size;

  const counter = document.getElementById('f-devot-counter');
  if (counter) counter.textContent = `📖 ${devotCount} · ⚡ ${activCount} / ${TOTAL_DEVOTIONAL_DAYS}`;

  let devotHtml = '';
  let activHtml = '';
  const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  for (let day = 1; day <= TOTAL_DEVOTIONAL_DAYS; day++) {
    const week = Math.ceil(day / 7);
    const dayName = dayNames[(day - 1) % 7];
    const dChecked = devotDone.has(day);
    const aChecked = activDone.has(day);

    devotHtml += `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:${dChecked ? '#e8f5ee' : '#fafafa'};margin-bottom:6px;cursor:pointer;border:1.5px solid ${dChecked ? '#e64980' : '#e8e8e8'};transition:all 0.2s">
        <input type="checkbox" ${dChecked ? 'checked' : ''} onchange="toggleDevot('${studentId}', ${day}, this.checked)" style="width:18px;height:18px;accent-color:#e64980;cursor:pointer">
        <div style="flex:1">
          <span style="font-weight:600;font-size:13px">Day ${day}</span>
          <span style="color:var(--text3);font-size:11px;margin-left:8px">Wk ${week} · ${dayName}</span>
        </div>
        ${dChecked ? '<span data-tick="1" style="color:#e64980;font-size:13px;font-weight:700">✓</span>' : ''}
      </label>`;

    activHtml += `
      <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:${aChecked ? '#f8e8fb' : '#fafafa'};margin-bottom:6px;cursor:pointer;border:1.5px solid ${aChecked ? '#ae3ec9' : '#e8e8e8'};transition:all 0.2s">
        <input type="checkbox" ${aChecked ? 'checked' : ''} onchange="toggleActiv('${studentId}', ${day}, this.checked)" style="width:18px;height:18px;accent-color:#ae3ec9;cursor:pointer">
        <div style="flex:1">
          <span style="font-weight:600;font-size:13px">Day ${day}</span>
          <span style="color:var(--text3);font-size:11px;margin-left:8px">Wk ${week} · ${dayName}</span>
        </div>
        ${aChecked ? '<span data-tick="1" style="color:#ae3ec9;font-size:13px;font-weight:700">✓</span>' : ''}
      </label>`;
  }

  const devotIsActive = devotActActiveTab === 'devot';

  el.innerHTML = `
    <!-- TAB SWITCHER -->
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button id="devot-tab-btn" onclick="switchDevotTab('devot')"
        style="flex:1;padding:10px 0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid ${devotIsActive ? '#e64980' : '#e8e8e8'};background:${devotIsActive ? '#e64980' : '#fff'};color:${devotIsActive ? '#fff' : '#e64980'};transition:all 0.2s">
        📖 Devotionals<br><span style="font-size:11px;opacity:0.85">${devotCount}/${TOTAL_DEVOTIONAL_DAYS} done</span>
      </button>
      <button id="activ-tab-btn" onclick="switchDevotTab('activ')"
        style="flex:1;padding:10px 0;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;border:1.5px solid ${!devotIsActive ? '#ae3ec9' : '#e8e8e8'};background:${!devotIsActive ? '#ae3ec9' : '#fff'};color:${!devotIsActive ? '#fff' : '#ae3ec9'};transition:all 0.2s">
        ⚡ Activities<br><span style="font-size:11px;opacity:0.85">${activCount}/${TOTAL_DEVOTIONAL_DAYS} done</span>
      </button>
    </div>

    <!-- DEVOTIONALS PANEL -->
    <div id="devot-tab-panel" style="display:${devotIsActive ? '' : 'none'}">
      <div style="height:6px;background:#e0e0e0;border-radius:6px;margin-bottom:10px;overflow:hidden">
        <div style="height:100%;width:${Math.round(devotCount/TOTAL_DEVOTIONAL_DAYS*100)}%;background:#e64980;border-radius:6px;transition:width 0.3s"></div>
      </div>
      <div id="devot-day-list">${devotHtml}</div>
    </div>

    <!-- ACTIVITIES PANEL -->
    <div id="activ-tab-panel" style="display:${!devotIsActive ? '' : 'none'}">
      <div style="height:6px;background:#e0e0e0;border-radius:6px;margin-bottom:10px;overflow:hidden">
        <div style="height:100%;width:${Math.round(activCount/TOTAL_DEVOTIONAL_DAYS*100)}%;background:#ae3ec9;border-radius:6px;transition:width 0.3s"></div>
      </div>
      <div id="activ-day-list">${activHtml}</div>
    </div>`;
}

function toggleDevot(studentId, day, checked) {
  saveDevotional(studentId, day, checked);
  const devotDone = APP.devotionals[studentId] || new Set();
  const activDone = APP.activities[studentId] || new Set();
  const counter = document.getElementById('f-devot-counter');
  if (counter) counter.textContent = `📖 ${devotDone.size} · ⚡ ${activDone.size} / ${TOTAL_DEVOTIONAL_DAYS}`;
  const devotTabBtn = document.getElementById('devot-tab-btn');
  if (devotTabBtn) devotTabBtn.innerHTML = `📖 Devotionals<br><span style="font-size:11px;opacity:0.85">${devotDone.size}/${TOTAL_DEVOTIONAL_DAYS} done</span>`;
  const labels = document.querySelectorAll('#devot-day-list label');
  labels.forEach((lbl, idx) => {
    const d = idx + 1;
    const ok = (APP.devotionals[studentId] || new Set()).has(d);
    lbl.style.background = ok ? '#e8f5ee' : '#fafafa';
    lbl.style.borderColor = ok ? '#e64980' : '#e8e8e8';
    const tick = lbl.querySelector('[data-tick]');
    if (ok && !tick) { const s = document.createElement('span'); s.dataset.tick='1'; s.style.cssText='color:#e64980;font-size:13px;font-weight:700'; s.textContent='✓'; lbl.appendChild(s); }
    else if (!ok && tick) tick.remove();
  });
  const bar = document.querySelector('#devot-tab-panel > div > div');
  if (bar) bar.style.width = Math.round(devotDone.size/TOTAL_DEVOTIONAL_DAYS*100) + '%';
  renderFDevotional();
}

function toggleActiv(studentId, day, checked) {
  saveActivity(studentId, day, checked);
  const devotDone = APP.devotionals[studentId] || new Set();
  const activDone = APP.activities[studentId] || new Set();
  const counter = document.getElementById('f-devot-counter');
  if (counter) counter.textContent = `📖 ${devotDone.size} · ⚡ ${activDone.size} / ${TOTAL_DEVOTIONAL_DAYS}`;
  // Update tab button count
  const activTabBtn = document.getElementById('activ-tab-btn');
  if (activTabBtn) activTabBtn.innerHTML = `⚡ Activities<br><span style="font-size:11px;opacity:0.85">${activDone.size}/${TOTAL_DEVOTIONAL_DAYS} done</span>`;
  // Update checkbox labels inline
  const labels = document.querySelectorAll('#activ-day-list label');
  labels.forEach((lbl, idx) => {
    const d = idx + 1;
    const ok = (APP.activities[studentId] || new Set()).has(d);
    lbl.style.background = ok ? '#f8e8fb' : '#fafafa';
    lbl.style.borderColor = ok ? '#ae3ec9' : '#e8e8e8';
    const tick = lbl.querySelector('[data-tick]');
    if (ok && !tick) { const s = document.createElement('span'); s.dataset.tick='1'; s.style.cssText='color:#ae3ec9;font-size:13px;font-weight:700'; s.textContent='✓'; lbl.appendChild(s); }
    else if (!ok && tick) tick.remove();
  });
  // Update progress bar
  const bar = document.querySelector('#activ-tab-panel > div > div');
  if (bar) bar.style.width = Math.round(activDone.size/TOTAL_DEVOTIONAL_DAYS*100) + '%';
  renderFDevotional();
}

// ═══════════════════════════════════════════
// ADMIN — DEVOTIONAL & ACTIVITIES RECORDS VIEW
// ═══════════════════════════════════════════
function renderADevotionalTables() {
  const el = document.getElementById('a-devot-tables');
  if (!el) return;
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))].filter(Boolean).sort();
  el.innerHTML = tableNos.map(tno => {
    const students = APP.students.filter(s => String(s["Table No"]) === tno && (s["Status"]||"Active").toLowerCase() !== "dropped");
    const totalS = students.length;
    const totalDevot = students.reduce((sum, s) => sum + getDevotionalCount(s["Student ID"]), 0);
    const totalActiv = students.reduce((sum, s) => sum + getActivityCount(s["Student ID"]), 0);
    const maxPossible = totalS * TOTAL_DEVOTIONAL_DAYS;
    const devotPct = maxPossible > 0 ? Math.round((totalDevot / maxPossible) * 100) : 0;
    const activPct = maxPossible > 0 ? Math.round((totalActiv / maxPossible) * 100) : 0;
    return `
      <button class="menu-item" onclick="openADevotTable('${tno}')" style="margin-bottom:8px">
        <div class="mi-icon" style="background:#e8f5ee"><svg viewBox="0 0 24 24" stroke="#e64980" fill="none"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg></div>
        <div class="mi-text">
          <div class="mi-title">${getTableLabel(tno)} — ${totalS} students</div>
          <div class="mi-sub">📖 ${devotPct}% devotionals · ⚡ ${activPct}% activities</div>
        </div>
        <svg class="mi-arr" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </button>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No tables found.</p>';
}

function openADevotTable(tableNo) {
  const el = document.getElementById('a-devot-table-title');
  if (el) el.textContent = `${getTableLabel(tableNo)} — Devotionals & Activities`;
  renderADevotTableStudents(tableNo);
  go('s-a-devot-table');
}

function renderADevotTableStudents(tableNo) {
  const el = document.getElementById('a-devot-table-list');
  if (!el) return;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"]||"Active").toLowerCase() !== "dropped"
  ).sort((a, b) => (getDevotionalCount(b["Student ID"]) + getActivityCount(b["Student ID"])) - (getDevotionalCount(a["Student ID"]) + getActivityCount(a["Student ID"])));

  el.innerHTML = students.map((s, i) => {
    const devotDone = getDevotionalCount(s["Student ID"]);
    const activDone = getActivityCount(s["Student ID"]);
    const devotPct  = Math.round((devotDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    const activPct  = Math.round((activDone / TOTAL_DEVOTIONAL_DAYS) * 100);
    return `
      <div class="row" style="align-items:flex-start;padding:12px 0;flex-direction:column">
        <div style="display:flex;align-items:center;width:100%;margin-bottom:8px">
          <div style="width:26px;height:26px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:#666;flex-shrink:0;margin-right:10px">#${i+1}</div>
          <div style="font-weight:600;font-size:14px">${s["Full Name"]}</div>
        </div>
        <div style="display:flex;gap:12px;width:100%;padding-left:36px">
          <div style="flex:1">
            <div style="font-size:10px;color:#e64980;font-weight:600;margin-bottom:3px">📖 Devotionals ${devotDone}/${TOTAL_DEVOTIONAL_DAYS} (${devotPct}%)</div>
            <div style="height:5px;background:#e0e0e0;border-radius:5px;overflow:hidden">
              <div style="height:100%;width:${devotPct}%;background:#e64980;border-radius:5px"></div>
            </div>
          </div>
          <div style="flex:1">
            <div style="font-size:10px;color:#ae3ec9;font-weight:600;margin-bottom:3px">⚡ Activities ${activDone}/${TOTAL_DEVOTIONAL_DAYS} (${activPct}%)</div>
            <div style="height:5px;background:#e0e0e0;border-radius:5px;overflow:hidden">
              <div style="height:100%;width:${activPct}%;background:#ae3ec9;border-radius:5px"></div>
            </div>
          </div>
        </div>
      </div>`;
  }).join('') || '<p style="padding:16px;color:var(--gray)">No students found.</p>';
}

// ═══════════════════════════════════════════
function getStudentCredits(studentId) {
  return APP.credits
    .filter(c => String(c["Student ID"]) === String(studentId))
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
}

// ═══════════════════════════════════════════
// PAYMENT CALCULATION
// ═══════════════════════════════════════════
function getStudentPayment(studentId) {
  const payments = APP.payments.filter(p => String(p["Student ID"]) === String(studentId));
  if (!payments.length) return { paid: 0, balance: APP.totalFee, status: "Unpaid" };
  const paid = payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const balance = APP.totalFee - paid;
  return { paid, balance, status: balance <= 0 ? "Paid" : "Partial" };
}

// ═══════════════════════════════════════════
// FACULTY — PAYMENT LIST
// ═══════════════════════════════════════════
function renderFPayment() {
  const el = document.getElementById('f-payment-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  if (!filtered.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No students found.</p>';
    return;
  }
  el.innerHTML = filtered.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>₱${pay.paid.toLocaleString()} paid · ₱${pay.balance.toLocaleString()} balance</small>
        </div>
        <div>${pay.status}</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// FACULTY — CREDITS LEADERBOARD
// ═══════════════════════════════════════════
function renderFCredits() {
  const el = document.getElementById('f-credits-list');
  if (!el) return;
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const filtered = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const sorted = [...filtered].sort(
    (a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"])
  );
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>#${i + 1} ${s["Full Name"]}</strong><br><small>${getTableLabel(s["Table No"])}</small></div>
      <div>${getStudentCredits(s["Student ID"])} SOL</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No credits yet.</p>';
}

// ═══════════════════════════════════════════
// ADD CREDIT (Faculty)
// ═══════════════════════════════════════════
async function doAddCredit() {
  const sel = document.getElementById('credit-student-sel');
  const studentId = sel ? sel.value : null;
  const amountEl = document.getElementById('credit-amount');
  const amount = parseInt(amountEl ? amountEl.value : 0);

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Please select a student'); return; }
  if (!amount || amount < 1) { showToast('⚠️ Enter a valid credit amount'); return; }

  const rawReason = APP.selectedReason || 'Attendance';
  const reason = rawReason === '__other__'
    ? (document.getElementById('credit-other-text')?.value?.trim() || 'Other')
    : rawReason;

  try {
    const btn = document.querySelector('#s-add-credit .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action: "addCredit",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      tableNo: student["Table No"],
      weekNo: APP.currentWeek,
      reason,
      creditsAdded: amount,
      addedBy: APP.currentFaculty?.["Full Name"] || "Faculty"
    });

    showToast(`✅ ${amount} SOL added to ${student["Full Name"]}`);
    if (amountEl) amountEl.value = 5;
    await loadAllData();
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to save'));
    console.error('doAddCredit error:', err);
  } finally {
    const btn = document.querySelector('#s-add-credit .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Credits'; }
  }
}

// Builds the Present / Late / Absent summary bar shown at the top of an
// attendance list. `roster` is the total enrolled count for that group
// (students or faculty); anyone in the roster without a Present/Late record
// for the week counts as Absent.
function buildAttendanceSummary(weekAtt, rosterTotal) {
  const norm = a => (a["Attendance Status"] || a["Status"] || "present").toLowerCase();
  const present = weekAtt.filter(a => norm(a) === "present").length;
  const late    = weekAtt.filter(a => norm(a).includes("late")).length;
  const explicitAbsent = weekAtt.filter(a => norm(a).includes("absent")).length;
  const unaccounted = Math.max(rosterTotal - present - late - explicitAbsent, 0);
  const absent = explicitAbsent + unaccounted;

  return `
    <div class="att-summary-bar">
      <div class="att-summary-item att-summary-present">
        <div class="att-summary-num">${present}</div>
        <div class="att-summary-lbl">Present</div>
      </div>
      <div class="att-summary-item att-summary-late">
        <div class="att-summary-num">${late}</div>
        <div class="att-summary-lbl">Late</div>
      </div>
      <div class="att-summary-item att-summary-absent">
        <div class="att-summary-num">${absent}</div>
        <div class="att-summary-lbl">Absent</div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════
// ADMIN — STUDENT ATTENDANCE
// ═══════════════════════════════════════════
function renderAStudentAtt() {
  const el = document.getElementById('a-att-list');
  const week = document.getElementById('a-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.students.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No attendance records for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>${getTableLabel(a["Table No"] || "—")} · ${a["LG Leader"] || ""}</small>      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// ADMIN — TABLES VIEW
// ═══════════════════════════════════════════
function renderATables() {
  const grid = document.getElementById('a-table-grid');
  const week = document.getElementById('a-table-week')?.value || APP.currentWeek;
  if (!grid) return;

  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const tableMap = {};
  APP.students.forEach(s => {
    const t = String(s["Table No"]);
    if (!tableMap[t]) tableMap[t] = { students: [], present: 0 };
    tableMap[t].students.push(s);
  });
  weekAtt.forEach(a => {
    const t = String(a["Table No"]);
    if (tableMap[t]) tableMap[t].present++;
  });

  const tables = Object.keys(tableMap).sort((a, b) => Number(a) - Number(b));
  if (!tables.length) {
    grid.innerHTML = '<p style="padding:16px;color:var(--gray)">No table data found.</p>';
    return;
  }
  grid.innerHTML = tables.map(t => {
    const totalLC = getTableCredits(t);
    return `
      <div class="card" style="padding:14px;cursor:pointer" onclick="showTableDetail('${t}')">
        <div style="font-family:var(--font-head);font-size:18px;font-weight:700">${getTableLabel(t)}</div>
        <div style="font-size:12px;color:var(--gray);margin-top:4px">${totalLC} SOL Credits</div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — TABLE DETAIL
// ═══════════════════════════════════════════
function showTableDetail(tableNo) {
  go('s-a-table-detail');
  // Store current table so refresh works
  APP._currentTableDetail = tableNo;
  const title       = document.getElementById('a-td-title');
  const stats       = document.getElementById('a-td-stats');
  const presentStat = document.getElementById('a-td-present-stat');
  const list        = document.getElementById('a-td-list');
  if (title) title.textContent = getTableLabel(tableNo);

  // Only active (non-dropped) students
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const presentThisWeek = APP.attendance.filter(a =>
    String(a["Table No"]) === String(tableNo) && String(a["Week No"]) === String(APP.currentWeek)
  );
  // Table-level credits only (not individual student sum)
  const tableCredits = getTableCredits(tableNo);

  if (presentStat) presentStat.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;background:linear-gradient(135deg,var(--green),var(--green-light));border-radius:12px;padding:14px 18px;margin-bottom:12px">
      <div style="font-size:28px;font-family:var(--font-head);font-weight:700;color:#fff">${presentThisWeek.length}<span style="font-size:14px;font-weight:500;opacity:0.7">/${students.length}</span></div>
      <div style="color:rgba(255,255,255,0.85);font-size:13px;font-weight:600">Present — Week ${APP.currentWeek}</div>
    </div>
  `;

  if (stats) stats.innerHTML = `
    <div class="stat-card"><div class="stat-val">${students.length}</div><div class="stat-label">Students</div></div>
    <div class="stat-card"><div class="stat-val">${tableCredits}</div><div class="stat-label">Table SOL Credits</div></div>
  `;

  const sorted = [...students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  if (list) list.innerHTML = sorted.map(s => `
    <div class="row">
      <div><strong>${s["Full Name"]}</strong></div>
      <div>${getStudentCredits(s["Student ID"])} SOL</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students in this table.</p>';
}

async function confirmDropStudentFromTable(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    renderDroppedStudents();
    updateAdminHomeStats();
    populateCreditStudentSelect();
    // Refresh table detail in place
    showTableDetail(APP._currentTableDetail);
  } catch (err) {
    console.error('confirmDropStudentFromTable error:', err);
    showToast('❌ Failed to update status');
  }
}

// Get total SOL credits for a whole table — table-level only (studentId is blank)
function getTableCredits(tableNo) {
  return APP.credits
    .filter(c => String(c["Table No"]) === String(tableNo) && (!c["Student ID"] || String(c["Student ID"]).startsWith('TABLE-')))
    .reduce((sum, c) => sum + Number(c["Credits Added"] || 0), 0);
}

// Get total SOL credits for a table summing all student credits in that table
function getTableTotalStudentCredits(tableNo) {
  const students = APP.students.filter(s => String(s["Table No"]) === String(tableNo));
  return students.reduce((sum, s) => sum + getStudentCredits(s["Student ID"]), 0);
}

// ═══════════════════════════════════════════
// ADMIN — LEADERBOARD
// ═══════════════════════════════════════════
function switchLeaderboardTab(tab) {
  const studentList = document.getElementById('a-leaderboard-list');
  const tableList   = document.getElementById('a-table-leaderboard-list');
  const sBtn        = document.getElementById('lb-tab-students');
  const tBtn        = document.getElementById('lb-tab-tables');
  if (tab === 'students') {
    studentList.style.display = ''; tableList.style.display = 'none';
    sBtn.style.background = '#c9960c'; sBtn.style.color = '#fff';
    tBtn.style.background = '#fff';   tBtn.style.color = '#c9960c';
    renderLeaderboard();
  } else {
    studentList.style.display = 'none'; tableList.style.display = '';
    tBtn.style.background = '#c9960c'; tBtn.style.color = '#fff';
    sBtn.style.background = '#fff';    sBtn.style.color = '#c9960c';
    renderTableLeaderboard();
  }
}

function renderLeaderboard() {
  const el = document.getElementById('a-leaderboard-list');
  if (!el) return;
  const sorted = [...APP.students].sort((a, b) => getStudentCredits(b["Student ID"]) - getStudentCredits(a["Student ID"]));
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((s, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} ${s["Full Name"]}</strong><br><small>${getTableLabel(s["Table No"])}</small></div>
      <div>${getStudentCredits(s["Student ID"])} SOL</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No students yet.</p>';
}

function renderTableLeaderboard() {
  const el = document.getElementById('a-table-leaderboard-list');
  if (!el) return;
  const tableSet = new Set(APP.students.map(s => String(s["Table No"])));
  const tableMap = {};
  tableSet.forEach(t => {
    tableMap[t] = {
      total: getTableCredits(t),
      count: APP.students.filter(s => String(s["Table No"]) === t).length
    };
  });
  const sorted = Object.keys(tableMap).sort((a, b) => tableMap[b].total - tableMap[a].total);
  const medals = ['🥇','🥈','🥉'];
  el.innerHTML = sorted.map((t, i) => `
    <div class="row">
      <div><strong>${medals[i] || `#${i + 1}`} ${getTableLabel(t)}</strong><br><small>${tableMap[t].count} students</small></div>
      <div>${tableMap[t].total} SOL</div>
    </div>
  `).join('') || '<p style="padding:16px;color:var(--gray)">No data yet.</p>';
}

// ═══════════════════════════════════════════
// ADMIN — DROPPED STUDENTS
// ═══════════════════════════════════════════
function renderDroppedStudents() {
  const el = document.getElementById('a-dropped-list');
  if (!el) return;
  const dropped = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  );
  if (!dropped.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No dropped students found.</p>';
    return;
  }

  // Group by table
  const byTable = {};
  dropped.forEach(s => {
    const t = String(s["Table No"] || "—");
    if (!byTable[t]) byTable[t] = [];
    byTable[t].push(s);
  });

  const tables = Object.keys(byTable).sort((a, b) => Number(a) - Number(b));
  el.innerHTML = tables.map(t => `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);letter-spacing:0.05em;padding:10px 16px 4px">TABLE ${t}</div>
      ${byTable[t].map(s => {
        // Count absences for this student
        const absenceCount = APP.attendance.filter(a =>
          String(a['Student ID']) === String(s['Student ID']) &&
          (a['Attendance Status'] || a['Status'] || '').toLowerCase().includes('absent')
        ).length;
        return `
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:#fff">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--text1)">${s["Full Name"]}</div>
              <div style="font-size:12px;color:var(--text3)">${s["LG Leader"] || "—"} · ${getTableLabel(t)}</div>
              <div style="font-size:11px;color:#e53935;margin-top:2px;font-weight:600">🚫 DROPPED — ${absenceCount} absence${absenceCount !== 1 ? 's' : ''}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="handleDropDecision('${s["Student ID"]}','${s["Full Name"].replace(/'/g,"\\'")}','drop')"
              style="flex:1;padding:8px;border-radius:8px;border:1.5px solid #e53935;background:#fdecea;color:#e53935;font-size:12px;font-weight:700;cursor:pointer">
              🗑 Drop (no excuse)
            </button>
            <button onclick="handleDropDecision('${s["Student ID"]}','${s["Full Name"].replace(/'/g,"\\'")}','continue')"
              style="flex:1;padding:8px;border-radius:8px;border:1.5px solid #27ae60;background:#e8f5ee;color:#27ae60;font-size:12px;font-weight:700;cursor:pointer">
              ✅ Continue (valid excuse)
            </button>
          </div>
        </div>
      `}).join('')}
    </div>
  `).join('');
}

async function handleDropDecision(studentId, studentName, decision) {
  const student = APP.students.find(s => String(s['Student ID']) === String(studentId));
  if (!student) return;

  if (decision === 'drop') {
    if (!confirm(`Confirm DROP for ${studentName}?\n\nNo valid excuse — this student will remain dropped and their QR code will stay disabled.`)) return;
    // Already dropped — just confirm and keep as-is (status stays "Dropped")
    showToast(`🗑 ${studentName} confirmed Dropped`);
    renderDroppedStudents();

  } else if (decision === 'continue') {
    const excuse = prompt(`Allow ${studentName} to CONTINUE?\n\nEnter the valid excuse / reason (required):`);
    if (excuse === null) return; // cancelled
    if (!excuse.trim()) { showToast('⚠️ Excuse is required to reinstate.'); return; }
    try {
      await apiPost({
        action: 'updateStudentStatus',
        studentId: student['Student ID'],
        studentName: student['Full Name'],
        status: 'Active',
        notes: excuse.trim()
      });
      student['Status'] = 'Active';
      showToast(`✅ ${studentName} reinstated — QR re-enabled`);
      renderDroppedStudents();
      updateAdminHomeStats();
      populateCreditStudentSelect();
    } catch (err) {
      console.error('handleDropDecision error:', err);
      showToast('❌ Failed to update status');
    }
  }
}

function openDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (!modal) return;
  // Reset to table picker step
  document.getElementById('drop-step-table').style.display = '';
  document.getElementById('drop-step-students').style.display = 'none';
  // Build table buttons
  const tableSet = [...new Set(
    APP.students
      .filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped")
      .map(s => String(s["Table No"]))
  )].sort((a, b) => Number(a) - Number(b));
  const tableGrid = document.getElementById('drop-table-grid');
  if (tableGrid) {
    tableGrid.innerHTML = tableSet.map(t => `
      <button onclick="selectDropTable('${t}')" style="padding:14px;border-radius:10px;border:1.5px solid var(--border);background:#fff;font-size:15px;font-weight:700;cursor:pointer;color:var(--text1)">${getTableLabel(t)}</button>
    `).join('');
  }
  modal.style.display = 'flex';
}

function selectDropTable(tableNo) {
  document.getElementById('drop-step-table').style.display = 'none';
  document.getElementById('drop-step-students').style.display = '';
  document.getElementById('drop-step-table-label').textContent = `${getTableLabel(tableNo)} — Select Student`;
  const students = APP.students.filter(s =>
    String(s["Table No"]) === String(tableNo) &&
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const list = document.getElementById('drop-student-list');
  if (!list) return;
  if (!students.length) {
    list.innerHTML = '<p style="padding:12px;color:var(--gray);text-align:center">No active students in this table.</p>';
    return;
  }
  list.innerHTML = students.map(s => `
    <div onclick="confirmDropStudent('${s["Student ID"]}', '${s["Full Name"].replace(/'/g, "\\'")}')"
      style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer">
      <div style="font-size:14px;font-weight:600;color:var(--text1)">${s["Full Name"]}</div>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red,#e53935)" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

async function confirmDropStudent(studentId, studentName) {
  if (!confirm(`Drop ${studentName}? This will remove them from active student lists.`)) return;
  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Student not found'); return; }
  try {
    await apiPost({
      action: "updateStudentStatus",
      studentId: student["Student ID"],
      studentName: student["Full Name"],
      status: "Dropped"
    });
    student["Status"] = "Dropped";
    showToast(`✅ ${student["Full Name"]} marked as Dropped`);
    closeDropStudentModal();
    renderDroppedStudents();
    updateAdminHomeStats();
  } catch (err) {
    console.error('confirmDropStudent error:', err);
    showToast('❌ Failed to update status');
  }
}

function closeDropStudentModal() {
  const modal = document.getElementById('modal-drop-student');
  if (modal) modal.style.display = 'none';
}


// ═══════════════════════════════════════════
// QR SCANNER
// ═══════════════════════════════════════════
let html5QrScanner = null;
let qrScanCooldown = false;

// ═══════════════════════════════════════════
// QR TAB SWITCHER (Scan QR / QR Generator)
// ═══════════════════════════════════════════
function switchQRTab(tab) {
  const panels = { scan: document.getElementById('qr-panel-scan'), gen: document.getElementById('qr-panel-gen') };
  const btns   = { scan: document.getElementById('qr-tab-scan'),   gen: document.getElementById('qr-tab-gen') };
  const statusBar = document.getElementById('qr-status-bar');
  const resultEl  = document.getElementById('qr-result');

  Object.keys(panels).forEach(key => {
    if (panels[key]) panels[key].style.display = (key === tab) ? '' : 'none';
    if (btns[key]) {
      btns[key].style.background = (key === tab) ? 'var(--purple)' : '#fff';
      btns[key].style.color      = (key === tab) ? '#fff'          : 'var(--purple)';
    }
  });

  // Stop the camera if we're leaving the scan tab
  if (tab !== 'scan' && html5QrScanner) stopQRCamera();

  if (tab === 'gen') {
    if (statusBar) statusBar.style.display = 'none';
    if (resultEl)  resultEl.innerHTML = '';
    renderQRGenList();
  } else {
    setScanStatus('idle', '');
    if (resultEl) resultEl.innerHTML = '';
  }
}

// ═══════════════════════════════════════════
// QR SCANNER — with live status indicator
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
// SOUND FEEDBACK (beeps for scan/tap results)
// ═══════════════════════════════════════════
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { return null; }
  }
  if (audioCtx.state === 'suspended') { audioCtx.resume().catch(()=>{}); }
  return audioCtx;
}
function playTone(freq, durationMs, delay = 0, type = 'sine', vol = 0.22) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationMs / 1000);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durationMs / 1000 + 0.03);
}
function playScanSound(kind) {
  // kind: 'success' | 'warn' | 'error'
  if (kind === 'success') { playTone(880, 100, 0); playTone(1320, 140, 0.09); }
  else if (kind === 'warn') { playTone(660, 90, 0); playTone(660, 90, 0.14); }
  else if (kind === 'error') { playTone(220, 220, 0, 'square', 0.16); }
}

function setScanStatus(state, msg) {
  // state: 'idle' | 'scanning' | 'success' | 'error'
  if (state === 'success') playScanSound('success');
  else if (state === 'error') playScanSound('error');
  else if (state === 'scanning' && /\bLate\b/.test(msg || '')) playScanSound('warn');
  const bar = document.getElementById('qr-status-bar');
  if (!bar) return;
  const colors = { idle:'#6b7280', scanning:'#ae3ec9', success:'#e64980', error:'#e53935' };
  const icons  = { idle:'📷', scanning:'🔍', success:'✅', error:'⚠️' };
  bar.style.display = msg ? '' : 'none';
  bar.style.background = colors[state] || colors.idle;
  bar.innerHTML = `<span style="font-size:15px">${icons[state]||''}</span> <span>${msg}</span>`;
}

function startQRCamera() {
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  if (placeholder) placeholder.style.display = 'none';
  if (startBtn)    startBtn.style.display = 'none';
  if (stopBtn)     stopBtn.style.display  = '';
  if (html5QrScanner) { try { html5QrScanner.stop(); } catch(e){} html5QrScanner = null; }

  setScanStatus('scanning', 'Camera starting… hold your QR up to the screen');

  html5QrScanner = new Html5Qrcode('qr-reader');
  html5QrScanner.start(
    // FRONT camera (not rear) — mount this phone screen-facing-out at the
    // entrance. No qrbox passed = scans the ENTIRE frame, not just a centered
    // square, so the QR doesn't need to be perfectly centered — just fully
    // visible somewhere in view. That's the most room we can give people
    // before the code gets cropped and becomes unreadable.
    { facingMode: 'environment  ' },
    { fps: 20, aspectRatio: 1.0, disableFlip: true },
    onQRCodeScanned,
    (errorMsg) => {
      // Called every frame when no QR found — only update if not in cooldown
      if (!qrScanCooldown) setScanStatus('scanning', 'Ready — bring QR up to the screen');
    }
  ).then(() => {
    setScanStatus('scanning', 'Ready — bring QR up to the screen');
  }).catch(err => {
    setScanStatus('error', 'Camera error: ' + err);
    showToast('Camera error: ' + err);
    if (placeholder) placeholder.style.display = '';
    if (startBtn)    startBtn.style.display = '';
    if (stopBtn)     stopBtn.style.display  = 'none';
  });
}

function stopQRCamera() {
  if (html5QrScanner) { html5QrScanner.stop().catch(()=>{}); html5QrScanner = null; }
  const placeholder = document.getElementById('qr-reader-placeholder');
  const startBtn    = document.getElementById('qr-start-btn');
  const stopBtn     = document.getElementById('qr-stop-btn');
  const reader      = document.getElementById('qr-reader');
  if (placeholder) placeholder.style.display = '';
  if (startBtn)    startBtn.style.display = '';
  if (stopBtn)     stopBtn.style.display  = 'none';
  if (reader)      reader.innerHTML = '';
  setScanStatus('idle', '');
}

// ─── "Tap feel" feedback: a short beep + phone vibration on every read ───
// Runs on ANY decoded QR (valid or not) so the person feels an immediate
// physical response the instant their phone is close enough to scan.
function playTapFeedback(success) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = success ? 880 : 300;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.12 : 0.25));
    setTimeout(() => ctx.close(), 400);
  } catch (e) { /* audio not available — no big deal */ }
  if (navigator.vibrate) navigator.vibrate(success ? 60 : [40, 60, 40]);
}

async function onQRCodeScanned(decodedText) {
  if (qrScanCooldown) return;
  qrScanCooldown = true;

  // Flash green on the currently-visible scanner/tap box
  const scanBox = Array.from(document.querySelectorAll('.qr-scan-box')).find(el => el.offsetParent !== null);
  if (scanBox) {
    scanBox.style.outline = '4px solid #4ade80';
    setTimeout(() => { scanBox.style.outline = ''; }, 600);
  }

  if (!decodedText.startsWith(QR_PREFIX)) {
    playTapFeedback(false);
    setScanStatus('error', 'Invalid QR — only SOL 1 QR codes accepted');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fff3cd;padding:14px 16px;border-radius:12px;border-left:4px solid #e8a020;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">⚠️</span>
        <div><strong>Invalid QR Code</strong><br><span style="font-size:12px;color:#666">Only SOL 1 QR codes are accepted. Try the QR Generator tab to create one.</span></div>
      </div>`;
    showToast('⚠️ Not a SOL 1 QR code');
    setTimeout(() => {
      qrScanCooldown = false;
      setScanStatus('scanning', 'Ready — bring QR up to the screen');
    }, 1500);
    return;
  }

  const personId = decodedText.slice(QR_PREFIX.length);
  const student  = APP.students.find(s => String(s['Student ID']) === String(personId));
  if (student) { playTapFeedback(true); await scanQR(student['Student ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — next person, please'); }, 1200); return; }
  const faculty  = APP.faculty.find(f => String(f['Faculty ID']) === String(personId));
  if (faculty)  { playTapFeedback(true); await scanFacultyQR(faculty['Faculty ID']); setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — next person, please'); }, 1200); return; }

  playTapFeedback(false);
  setScanStatus('error', 'QR not recognised — ID: ' + personId);
  showToast('QR not recognised: ' + personId);
  setTimeout(() => { qrScanCooldown = false; setScanStatus('scanning','Ready — bring QR up to the screen'); }, 1500);
}

async function scanQR(id) {
  const student = APP.students.find(s => String(s['Student ID']) === String(id));
  if (!student) return;

  // ── Block dropped students ──────────────────────────────────────────────
  const studentStatus = (student['Status'] || 'Active').toLowerCase();
  if (studentStatus === 'dropped') {
    setScanStatus('error', student['Full Name'] + ' — DROPPED (QR disabled)');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #e53935;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:28px">🚫</span>
        <div>
          <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
          <div style="font-size:12px;color:#e53935;margin-top:2px">This student has been <strong>DROPPED</strong>.</div>
          <div style="font-size:11px;color:#888;margin-top:4px">Contact the director or consultant to reinstate.</div>
        </div>
      </div>`;
    showToast('🚫 ' + student['Full Name'] + ' — Dropped, QR disabled');
    return;
  }

  // ── Check if already scanned this week ────────────────────────────────
  const alreadyScanned = APP.attendance.find(a =>
    String(a['Student ID']) === String(id) &&
    String(a['Week No']) === String(APP.currentWeek)
  );
  if (alreadyScanned) {
    const prevStatus = alreadyScanned['Attendance Status'] || alreadyScanned['Status'] || 'Present';
    setScanStatus('error', student['Full Name'] + ' already recorded as ' + prevStatus + ' this week');
    const resultEl = document.getElementById('qr-result');
    if (resultEl) resultEl.innerHTML = `
      <div style="background:#fff3cd;padding:14px 16px;border-radius:12px;border-left:4px solid #e8a020;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
        <span style="font-size:20px">⚠️</span>
        <div><strong>${student['Full Name']}</strong><br><span style="font-size:12px;color:#666">Already recorded as <strong>${prevStatus}</strong> for Week ${APP.currentWeek}.</span></div>
      </div>`;
    showToast('⚠️ Already scanned — ' + student['Full Name']);
    return;
  }

  const status = getAttendanceStatusByTime();
  setScanStatus('scanning', 'Saving attendance for ' + student['Full Name'] + '…');

  await apiPost({
    action:'addQRScan', qrCode:String(student['Student ID']),
    personType:'student', personId:student['Student ID'],
    name:student['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addAttendance', studentId:student['Student ID'],
    studentName:student['Full Name'], age:student['Age']||'',
    gender:student['Gender']||'', lgLeader:student['LG Leader']||'',
    networkLeader:student['Network Leader']||'', tableNo:student['Table No'],
    weekNo:APP.currentWeek, status:status, remarks:''
  });

  // ── Check absence count AFTER recording this scan ─────────────────────
  if (status === 'Absent') {
    // Count absences including the one just recorded (reload first for accuracy)
    await loadAllData();
    const totalAbsences = APP.attendance.filter(a =>
      String(a['Student ID']) === String(id) &&
      (a['Attendance Status'] || a['Status'] || '').toLowerCase().includes('absent')
    ).length;

    if (totalAbsences >= 3) {
      // Auto-drop: update status to Dropped
      await apiPost({
        action: 'updateStudentStatus',
        studentId: student['Student ID'],
        studentName: student['Full Name'],
        status: 'Dropped'
      });
      // Update local state immediately
      student['Status'] = 'Dropped';
      setScanStatus('error', student['Full Name'] + ' — AUTO-DROPPED (3 absences)');
      const resultEl = document.getElementById('qr-result');
      if (resultEl) resultEl.innerHTML = `
        <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #b71c1c;margin-top:8px;display:flex;gap:10px;align-items:flex-start">
          <span style="font-size:28px">🚫</span>
          <div>
            <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
            <div style="font-size:13px;color:#e53935;margin-top:2px"><strong>AUTO-DROPPED</strong> — 3rd unexcused absence reached.</div>
            <div style="font-size:11px;color:#888;margin-top:4px">Director or consultant must review in admin portal.</div>
          </div>
        </div>`;
      showToast('🚫 ' + student['Full Name'] + ' AUTO-DROPPED — 3 absences');
      updateAdminHomeStats();
      return;
    }

    // Show warning if 2 absences (next = drop)
    if (totalAbsences === 2) {
      const resultEl = document.getElementById('qr-result');
      if (resultEl) resultEl.innerHTML = `
        <div style="background:#fdecea;padding:14px 16px;border-radius:12px;border-left:4px solid #e53935;margin-top:8px;display:flex;gap:10px;align-items:center">
          <span style="font-size:28px">❌</span>
          <div>
            <div style="font-weight:700;font-size:15px;color:#b71c1c">${student['Full Name']}</div>
            <div style="font-size:12px;color:#e53935">Marked <strong>Absent</strong> — Week ${APP.currentWeek} · ${getTableLabel(student['Table No'])}</div>
            <div style="font-size:12px;color:#b71c1c;font-weight:700;margin-top:4px">⚠️ WARNING: 2 absences — 1 more = AUTO-DROP</div>
          </div>
        </div>`;
      showToast('❌ ' + student['Full Name'] + ' — Absent (2nd, 1 more = Drop)');
      setTimeout(() => alert(`⚠️ WARNING\n\n${student['Full Name']} now has 2 absences.\nOne more unexcused absence will automatically DROP this student.`), 300);
      updateAdminHomeStats();
      return;
    }
  }

  // ── Normal result display ──────────────────────────────────────────────
  const alertMsg = getAttendanceAlertMessage(status);
  const statusColors = { Present: { bg:'#e8f5ee', border:'#e64980', icon:'✅' }, Late: { bg:'#fff5e0', border:'#c9960c', icon:'⏰' }, Absent: { bg:'#fdecea', border:'#e53935', icon:'❌' } };
  const sc = statusColors[status] || statusColors['Present'];

  setScanStatus(status === 'Present' ? 'success' : (status === 'Late' ? 'scanning' : 'error'), student['Full Name'] + ' — ' + status + ' ✓');
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:${sc.bg};padding:14px 16px;border-radius:12px;border-left:4px solid ${sc.border};margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">${sc.icon}</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:#1a3a2a">${student['Full Name']}</div>
        <div style="font-size:12px;color:${sc.border}">Marked <strong>${status}</strong> — Week ${APP.currentWeek} · ${getTableLabel(student['Table No'])}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${new Date().toLocaleTimeString()}</div>
        ${status === 'Late' ? '<div style="font-size:11px;color:#c9960c;margin-top:3px">⚠️ 3 unexcused late = 1 Absent</div>' : ''}
        ${status === 'Absent' ? '<div style="font-size:11px;color:#e53935;margin-top:3px">⚠️ 3 unexcused absences = Drop</div>' : ''}
      </div>
    </div>`;

  // Show alert popup for Late/Absent
  if (status === 'Late' || status === 'Absent') {
    setTimeout(() => alert(alertMsg), 300);
  }

  showToast((status === 'Present' ? '✅' : status === 'Late' ? '⏰' : '❌') + ' ' + student['Full Name'] + ' — ' + status);
  await loadAllData();
}

async function scanFacultyQR(id) {
  const faculty = APP.faculty.find(f => String(f['Faculty ID']) === String(id));
  if (!faculty) return;
  setScanStatus('scanning', 'Saving attendance for ' + faculty['Full Name'] + '…');

  await apiPost({
    action:'addQRScan', qrCode:String(faculty['Faculty ID']),
    personType:'faculty', personId:faculty['Faculty ID'],
    name:faculty['Full Name'], weekNo:APP.currentWeek, scanType:'attendance'
  });
  await apiPost({
    action:'addFacultyAttendance', facultyId:faculty['Faculty ID'],
    facultyName:faculty['Full Name'], role:faculty['Role']||'',
    weekNo:APP.currentWeek, status:'Present'
  });

  setScanStatus('success', faculty['Full Name'] + ' (' + (faculty['Role']||'') + ') marked PRESENT ✓');
  const resultEl = document.getElementById('qr-result');
  if (resultEl) resultEl.innerHTML = `
    <div style="background:#e8f5ee;padding:14px 16px;border-radius:12px;border-left:4px solid #e64980;margin-top:8px;display:flex;gap:10px;align-items:center">
      <span style="font-size:28px">✅</span>
      <div>
        <div style="font-weight:700;font-size:15px;color:#1a3a2a">${faculty['Full Name']}</div>
        <div style="font-size:12px;color:#e64980"><strong>${faculty['Role']||'Faculty'}</strong> marked PRESENT — Week ${APP.currentWeek}</div>
        <div style="font-size:11px;color:#666;margin-top:2px">${new Date().toLocaleTimeString()}</div>
      </div>
    </div>`;
  showToast('✅ ' + faculty['Full Name'] + ' — Present');
}

// ═══════════════════════════════════════════
// MARK UNSCANNED STUDENTS AS ABSENT
// ═══════════════════════════════════════════
async function markUnscannedAbsent() {
  const week = APP.currentWeek;

  // Students
  const activeStudents = APP.students.filter(s => (s['Status'] || 'Active').toLowerCase() !== 'dropped');
  const scannedStudentIds = new Set(
    APP.attendance
      .filter(a => String(a['Week No']) === String(week))
      .map(a => String(a['Student ID']))
  );
  const unscannedStudents = activeStudents.filter(s => !scannedStudentIds.has(String(s['Student ID'])));

  // Faculty & Staff
  const scannedFacultyIds = new Set(
    APP.facultyAttendance
      .filter(a => String(a['Week No']) === String(week))
      .map(a => String(a['Faculty ID'] || a['FacultyID']))
  );
  const unscannedFaculty = APP.faculty.filter(f => !scannedFacultyIds.has(String(f['Faculty ID'])));

  if (!unscannedStudents.length && !unscannedFaculty.length) {
    showToast('✅ Everyone already has attendance for Week ' + week);
    return;
  }

  const listLines = [
    ...unscannedStudents.map(s => '• ' + s['Full Name'] + ' (Student)'),
    ...unscannedFaculty.map(f => '• ' + f['Full Name'] + ' (Faculty/Staff)')
  ].join('\n');
  const confirmed = confirm(
    `Mark ${unscannedStudents.length} student(s) and ${unscannedFaculty.length} faculty/staff as ABSENT for Week ${week}?\n\n${listLines}`
  );
  if (!confirmed) return;

  const btn = document.getElementById('mark-absent-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  let studentCount = 0;
  for (const student of unscannedStudents) {
    try {
      await apiPost({
        action:'addAttendance', studentId:student['Student ID'],
        studentName:student['Full Name'], age:student['Age']||'',
        gender:student['Gender']||'', lgLeader:student['LG Leader']||'',
        networkLeader:student['Network Leader']||'', tableNo:student['Table No'],
        weekNo:week, status:'Absent', remarks:'Auto-marked (unscanned)'
      });
      studentCount++;
    } catch(e) { console.error('Failed to mark student absent:', student['Full Name'], e); }
  }

  let facultyCount = 0;
  for (const faculty of unscannedFaculty) {
    try {
      await apiPost({
        action:'addFacultyAttendance', facultyId:faculty['Faculty ID'],
        facultyName:faculty['Full Name'], role:faculty['Role']||'',
        weekNo:week, status:'Absent'
      });
      facultyCount++;
    } catch(e) { console.error('Failed to mark faculty absent:', faculty['Full Name'], e); }
  }

  showToast(`✅ ${studentCount} student(s) & ${facultyCount} faculty/staff marked Absent for Week ${week}`);
  if (btn) { btn.disabled = false; btn.textContent = '📋 Mark Unscanned as Absent'; }
  await loadAllData();
}


let qrGenCurrentId      = null;
let qrGenCurrentName    = null;
let qrGenCurrentPayload = null;

function renderQRGenList() {
  const type   = document.getElementById('qrgen-type')?.value || 'student';
  const search = (document.getElementById('qrgen-search')?.value || '').toLowerCase();
  const list   = document.getElementById('qrgen-list');
  if (!list) return;

  const items = type === 'student'
    ? APP.students.filter(s => (s['Status']||'').toLowerCase() !== 'dropped' && (!search || s['Full Name'].toLowerCase().includes(search) || String(s['Student ID']).includes(search)))
    : APP.faculty.filter(f  => !search || f['Full Name'].toLowerCase().includes(search) || String(f['Faculty ID']).includes(search));

  if (!items.length) {
    list.innerHTML = '<p style="color:var(--text3);font-size:13px;text-align:center;padding:20px">No results found.</p>';
    return;
  }

  list.innerHTML = items.map(item => {
    const id   = type === 'student' ? item['Student ID'] : item['Faculty ID'];
    const name = item['Full Name'];
    const sub  = type === 'student' ? `ID: ${id} · ${getTableLabel(item['Table No'])}` : `ID: ${id} · ${item['Role']}`;
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    return `<div onclick="openQRModal('${String(id).replace(/'/g,"\'")}','${name.replace(/'/g,"\'")}','${sub.replace(/'/g,"\'")}',this)"
      style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#f8f8f8;border-radius:10px;cursor:pointer;border:1.5px solid transparent;transition:border-color 0.15s"
      onmouseover="this.style.borderColor='var(--purple)'" onmouseout="this.style.borderColor='transparent'">
      <div style="width:38px;height:38px;background:var(--purple);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0">${initials}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text1)">${name}</div>
        <div style="font-size:11px;color:var(--text3)">${sub}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--purple)" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
    </div>`;
  }).join('');
}

function openQRModal(id, name, sub) {
  qrGenCurrentId   = id;
  qrGenCurrentName = name;
  const modal = document.getElementById('qrgen-modal');
  modal.style.display = 'flex';
  document.getElementById('qrgen-modal-name').textContent = name;
  document.getElementById('qrgen-modal-id').textContent   = sub;

  // Show loading state
  const canvas = document.getElementById('qrgen-canvas');
  const qrWrap = document.getElementById('qrgen-img-wrap');

  // Use qrcode library — render into a fresh temp div then grab the img/canvas
  const tempDiv = document.createElement('div');
  tempDiv.style.position = 'absolute';
  tempDiv.style.visibility = 'hidden';
  document.body.appendChild(tempDiv);

  const qrPayload = QR_PREFIX + String(id);
  qrGenCurrentPayload = qrPayload;

  // Clear previous
  if (qrWrap) qrWrap.innerHTML = '<div style="color:#999;font-size:13px;padding:20px">Generating…</div>';

  new QRCode(tempDiv, {
    text: qrPayload,
    width: 160, height: 160,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  setTimeout(() => {
    // QRCode lib renders either canvas or img depending on browser
    const generatedCanvas = tempDiv.querySelector('canvas');
    const generatedImg    = tempDiv.querySelector('img');

    if (qrWrap) {
      if (generatedCanvas) {
        // Copy to our display canvas
        canvas.width  = generatedCanvas.width;
        canvas.height = generatedCanvas.height;
        canvas.getContext('2d').drawImage(generatedCanvas, 0, 0);
        canvas.style.display = '';
        qrWrap.innerHTML = '';
        qrWrap.appendChild(canvas);
      } else if (generatedImg) {
        // Some browsers generate an img — use it directly
        const img = document.createElement('img');
        img.src = generatedImg.src;
        img.style.cssText = 'width:160px;height:160px;border-radius:8px;display:block';
        img.onload = () => {
          // Also copy to canvas for download
          canvas.width = 160; canvas.height = 160;
          canvas.getContext('2d').drawImage(img, 0, 0, 160, 160);
        };
        qrWrap.innerHTML = '';
        qrWrap.appendChild(img);
      } else {
        qrWrap.innerHTML = '<div style="color:#e53935;font-size:13px;padding:20px">Failed to generate QR. Refresh and try again.</div>';
      }
    }

    document.body.removeChild(tempDiv);

    // Show payload for debugging
    const payloadEl = document.getElementById('qrgen-payload');
    if (payloadEl) payloadEl.textContent = 'Payload: ' + qrPayload;
  }, 200);
}

function closeQRModal() {
  document.getElementById('qrgen-modal').style.display = 'none';
}

function downloadQRCode() {
  const canvas = document.getElementById('qrgen-canvas');
  const link   = document.createElement('a');
  link.download = `SOL1_QR_${qrGenCurrentId}_${(qrGenCurrentName||'').replace(/\s+/g,'_')}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// Stop camera when navigating away
(function() {
  const _origGo = go;
  go = function(id) {
    if (id !== 's-r-qr' && html5QrScanner) stopQRCamera();
    _origGo(id);
  };
})();

// ═══════════════════════════════════════════
// ADMIN — TABLE ADD CREDIT MODAL
// ═══════════════════════════════════════════
function openTableAddCredit() {
  const modal = document.getElementById('modal-table-credit');
  if (!modal) return;
  const tableNo    = APP._currentTableDetail;
  const modalTitle = document.getElementById('modal-table-credit-title');
  if (modalTitle) modalTitle.textContent = `Add SOL Credits — ${getTableLabel(tableNo)}`;
  modal.style.display = 'flex';
  document.querySelectorAll('#modal-table-credit .reason-btn').forEach((b, i) => {
    b.classList.toggle('selected', i === 0);
  });
  APP.selectedReason = 'Attendance';
  const otherWrap = document.getElementById('modal-other-wrap');
  if (otherWrap) otherWrap.style.display = 'none';
  const otherText = document.getElementById('modal-other-text');
  if (otherText) otherText.value = '';
  const amountEl = document.getElementById('modal-credit-amount');
  if (amountEl) amountEl.value = 5;
}

function closeTableCreditModal() {
  const modal = document.getElementById('modal-table-credit');
  if (modal) modal.style.display = 'none';
}

async function doTableAddCredit() {
  const tableNo = APP._currentTableDetail;
  const amount  = Number(document.getElementById('modal-credit-amount')?.value || 5);
  const rawReason = APP.selectedReason || 'Attendance';
  const reason  = rawReason === '__other__'
    ? (document.getElementById('modal-other-text')?.value?.trim() || 'Other')
    : rawReason;

  if (!tableNo) { showToast('⚠️ Table not found'); return; }
  if (!amount || amount < 1) { showToast('⚠️ Enter a valid credit amount'); return; }

  try {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      'addCredit',
      studentId:   '',
      studentName: `${getTableLabel(tableNo)} (Group)`,
      tableNo:     tableNo,
      weekNo:      APP.currentWeek,
      reason,
      creditsAdded: amount,
      addedBy:     APP.currentFaculty?.["Full Name"] || 'Admin'
    });

    closeTableCreditModal();
    await loadAllData();
    showToast(`✅ ${amount} SOL added to ${getTableLabel(tableNo)}`);
    showTableDetail(tableNo);
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to save'));
    console.error('doTableAddCredit error:', err);
  } finally {
    const btn = document.getElementById('modal-add-credit-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Add Credits to Table'; }
  }
}

// ═══════════════════════════════════════════
// RECORD — ATTENDANCE TAB SWITCH
// ═══════════════════════════════════════════
function switchAttTab(tab) {
  const sPanel = document.getElementById('att-panel-students');
  const fPanel = document.getElementById('att-panel-faculty');
  const sBtn   = document.getElementById('att-tab-students');
  const fBtn   = document.getElementById('att-tab-faculty');
  if (tab === 'students') {
    sPanel.style.display = ''; fPanel.style.display = 'none';
    sBtn.style.background = 'var(--purple)'; sBtn.style.color = '#fff';
    fBtn.style.background = '#fff';          fBtn.style.color = 'var(--purple)';
    renderRAttendance();
  } else {
    sPanel.style.display = 'none'; fPanel.style.display = '';
    fBtn.style.background = 'var(--purple)'; fBtn.style.color = '#fff';
    sBtn.style.background = '#fff';          sBtn.style.color = 'var(--purple)';
    renderRFacultyAtt();
  }
}

function renderRFacultyAtt() {
  const el   = document.getElementById('r-fac-att-list');
  const week = document.getElementById('r-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.faculty.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

function renderRAttendance() {
  const el   = document.getElementById('r-att-list');
  const week = document.getElementById('r-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.attendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.students.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => `
    <div class="row">
      <div>
        <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
        <small>${formatDate(a["Scan Time"] || a["ScanTime"])}</small>
      </div>
      <div>${a["Attendance Status"] || a["Status"] || "Present"}</div>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════
// BALANCES
// ═══════════════════════════════════════════
function renderBalances() {
  const el = document.getElementById('r-bal-list');
  if (!el) return;
  if (!APP.students.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No student records.</p>';
    return;
  }
  const sorted = [...APP.students].sort((a, b) => {
    const pa = getStudentPayment(a["Student ID"]);
    const pb = getStudentPayment(b["Student ID"]);
    return pb.balance - pa.balance;
  });
  el.innerHTML = sorted.map(s => {
    const pay = getStudentPayment(s["Student ID"]);
    return `
      <div class="row">
        <div>
          <strong>${s["Full Name"]}</strong><br>
          <small>${getTableLabel(s["Table No"])} · ₱${pay.paid.toLocaleString()} paid</small>
        </div>
        <div style="color:${pay.balance > 0 ? 'var(--red,#e53935)' : 'var(--green)'}">
          ₱${pay.balance.toLocaleString()}
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// PRINT
// ═══════════════════════════════════════════
function printAttendance() {
  // Get the currently selected week from the attendance week filter
  const weekEl = document.getElementById('a-att-week');
  const selectedWeek = weekEl ? weekEl.value : APP.currentWeek;
  const lessonInfo = APP.lessons.find(l => String(l['Week No']) === String(selectedWeek));
  const lessonLabel = lessonInfo
    ? `Lesson ${lessonInfo['Week No']}${lessonInfo['Lesson Title'] ? ' — ' + lessonInfo['Lesson Title'] : ''}`
    : `Lesson ${selectedWeek}`;

  // Filter attendance to only the selected lesson
  const filtered = APP.attendance.filter(a => String(a['Week No']) === String(selectedWeek));

  if (!filtered.length) {
    alert('No attendance records found for ' + lessonLabel);
    return;
  }

  const data = filtered.map(a => `
    <tr>
      <td>${formatDate(a["Scan Time"] || a["ScanTime"])}</td>
      <td>${a["Student Name"] || a["StudentName"] || ""}</td>
      <td>${a["Age"]            || ""}</td>
      <td>${a["Gender"]         || ""}</td>
      <td>${a["Attendance Status"] || a["Status"] || "Present"}</td>
      <td>${a["LG Leader"]      || ""}</td>
      <td>${a["Network Leader"] || ""}</td>
    </tr>
  `).join("");
  const win = window.open("", "", "width=900,height=700");
  win.document.write(`
    <html><head><title>Student Attendance — ${lessonLabel}</title>
    <style>
      @page { size: A4 portrait; margin: 20mm; }
      body { font-family: Arial, sans-serif; }
      h2 { text-align: center; margin-bottom: 4px; }
      h3 { text-align: center; margin-top: 0; margin-bottom: 20px; color: #555; font-weight: 400; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { border: 1px solid #000; padding: 6px; text-align: left; }
      th { background: #f2f2f2; }
    </style></head>
    <body>
      <h2>STUDENT ATTENDANCE REPORT — ${APP.settings["Batch Name"] || "SOL 1"}</h2>
      <h3>${lessonLabel}</h3>
      <table>
        <thead><tr><th>Scan Time</th><th>Name</th><th>Age</th><th>Gender</th><th>Status</th><th>LG Leader</th><th>Network Leader</th></tr></thead>
        <tbody>${data}</tbody>
      </table>
      <script>window.print();<\/script>
    </body></html>
  `);
  win.document.close();
}

// ═══════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════
function formatDate(val) {
  if (!val) return "—";
  try { return new Date(val).toLocaleString(); } catch { return String(val); }
}

function initClock() {
  setInterval(() => {
    const el = document.getElementById('qr-live-clock');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }, 1000);
}

function updateSyncStatus(ok, msg, isInfo) {
  const el  = document.getElementById('sync-label-portal');
  const dot = document.getElementById('sync-dot-portal');
  if (!el) return;
  if (ok) {
    el.textContent = 'Online · Synced';
    if (dot) { dot.style.background = '#27ae60'; dot.style.boxShadow = '0 0 0 3px rgba(39,174,96,0.25)'; }
  } else if (msg && isInfo) {
    // Neutral progress message (e.g. "showing saved data, syncing…") —
    // not an error, so no warning icon/color.
    el.textContent = msg;
    if (dot) { dot.style.background = '#5b8def'; dot.style.boxShadow = '0 0 0 3px rgba(91,141,239,0.25)'; }
  } else if (msg) {
    el.textContent = '⚠️ ' + msg;
    if (dot) { dot.style.background = '#e67e22'; dot.style.boxShadow = '0 0 0 3px rgba(230,126,34,0.25)'; }
  } else {
    el.textContent = 'Syncing…';
    if (dot) { dot.style.background = ''; dot.style.boxShadow = ''; }
  }
}

// ═══════════════════════════════════════════
// WEEK DROPDOWNS
// ═══════════════════════════════════════════
function populateWeekDropdowns() {
  const weekOptions = APP.lessons.map(l =>
    `<option value="${l["Week No"]}"${Number(l["Week No"]) === APP.currentWeek ? ' selected' : ''}>Lesson ${l["Week No"]}${l["Lesson Title"] ? ' – ' + l["Lesson Title"] : ''}</option>`
  ).join('');

  const fWeek = document.getElementById('f-week-filter');
  if (fWeek && weekOptions) fWeek.innerHTML = weekOptions;

  ['a-att-week', 'a-table-week', 'a-fac-att-week'].forEach(id => {
    const el = document.getElementById(id);
    if (el && weekOptions) el.innerHTML = weekOptions;
  });

  const rAtt    = document.getElementById('r-att-week');
  if (rAtt    && weekOptions) rAtt.innerHTML    = weekOptions;
  const rFacAtt = document.getElementById('r-fac-att-week');
  if (rFacAtt && weekOptions) rFacAtt.innerHTML = weekOptions;

  const mkp = document.getElementById('makeup-week');
  if (mkp && APP.lessons.length) {
    mkp.innerHTML = `<option value="0">All Weeks</option>` +
      APP.lessons.map(l => `<option value="${l["Week No"]}">Week ${l["Week No"]} absences</option>`).join('');
  }
}

// ═══════════════════════════════════════════
// ADMIN HOME STATS
// ═══════════════════════════════════════════
function updateAdminHomeStats() {
  const totalStudentsEl = document.getElementById('a-total-students');
  const totalFacultyEl  = document.getElementById('a-total-faculty');
  const totalPaidEl     = document.getElementById('a-total-paid');
  const totalDroppedEl  = document.getElementById('a-total-dropped');

  const activeStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() !== "dropped"
  );
  const droppedStudents = APP.students.filter(s =>
    (s["Status"] || "Active").toLowerCase() === "dropped"
  );

  if (totalStudentsEl) totalStudentsEl.textContent = activeStudents.length;
  if (totalFacultyEl)  totalFacultyEl.textContent  = APP.faculty.length;
  if (totalDroppedEl)  totalDroppedEl.textContent  = droppedStudents.length;
  if (totalPaidEl) {
    const total = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
    totalPaidEl.textContent = `₱${total.toLocaleString()}`;
  }

  const pendingMakeupCount = APP.attendance
    .filter(a => {
      const isAbsent = (a["Attendance Status"] || a["Status"] || "").toLowerCase() === "absent";
      if (!isAbsent) return false;
      const attId = a["Attendance ID"] || a["id"] || "";
      const mkStatus = (APP.makeupStatus[attId]?.status || "Pending").toLowerCase();
      return mkStatus === "pending";
    }).length;
  const badge = document.getElementById('a-makeup-badge');
  if (badge) {
    if (pendingMakeupCount > 0) { badge.textContent = `${pendingMakeupCount} pending`; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  // Dropped students badge
  const droppedCount = APP.students.filter(s =>
    (s["Status"] || "").toLowerCase() === "dropped"
  ).length;
  const droppedBadge = document.getElementById('a-dropped-badge');
  if (droppedBadge) {
    if (droppedCount > 0) { droppedBadge.textContent = `${droppedCount}`; droppedBadge.style.display = ''; }
    else { droppedBadge.style.display = 'none'; }
  }
}

// ═══════════════════════════════════════════
// FACULTY HOME
// ═══════════════════════════════════════════
function updateFacultyHome() {
  const nameEl = document.getElementById('f-home-name');
  const roleEl = document.getElementById('f-home-role');
  const f = APP.currentFaculty || APP.faculty[0];
  if (!f) return;
  if (nameEl) nameEl.textContent = f["Full Name"] || "—";
  if (roleEl) roleEl.textContent = `${f["Role"] || ""}${f["Table Assigned"] ? ' · Table ' + f["Table Assigned"] : ''}`;

  const tableNo = f["Table Assigned"] || "";
  ['f-students-topbar','f-payment-topbar','f-credits-topbar'].forEach(id => {
    const el = document.getElementById(id);
    if (el && tableNo) {
      const labels = { 'f-students-topbar': 'Attendance', 'f-payment-topbar': 'Payment', 'f-credits-topbar': 'SOL Credits' };
      el.textContent = `${getTableLabel(tableNo)} — ${labels[id]}`;
    }
  });
}

// ═══════════════════════════════════════════
// ADMIN — FACULTY ATTENDANCE
// ═══════════════════════════════════════════
function renderAFacultyAtt() {
  const el   = document.getElementById('a-fac-att-list');
  const week = document.getElementById('a-fac-att-week')?.value || APP.currentWeek;
  if (!el) return;
  const weekAtt = APP.facultyAttendance.filter(a => String(a["Week No"]) === String(week));
  const summaryHtml = buildAttendanceSummary(weekAtt, APP.faculty.length);

  if (!weekAtt.length) {
    el.innerHTML = summaryHtml + `<p style="padding:16px;color:var(--gray)">No faculty attendance for Week ${week}.</p>`;
    return;
  }
  el.innerHTML = summaryHtml + weekAtt.map(a => {
    const name     = a["Faculty Name"] || a["FacultyName"] || "—";
    const initials = name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const role     = a["Role"]   || "—";
    const status   = a["Status"] || "Present";
    const time     = formatDate(a["Scan Time"] || a["ScanTime"]);
    const badgeCls = status.toLowerCase() === 'late' ? 'ba' : 'bg';
    return `
      <div class="att-row">
        <div class="av">${initials}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600">${name}</div>
          <div style="font-size:11px;color:var(--text3)">${role}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:1px">Scanned ${time}</div>
        </div>
        <span class="badge ${badgeCls}">${status}</span>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════
// ADMIN — MAKEUP LESSONS
// ═══════════════════════════════════════════
function renderMakeup() {
  const el   = document.getElementById('makeup-list');
  const week = document.getElementById('makeup-week')?.value || "0";
  if (!el) return;
  let absences = APP.attendance.filter(a =>
    (a["Attendance Status"] || a["Status"] || "").toLowerCase() === "absent"
  );
  if (week !== "0") absences = absences.filter(a => String(a["Week No"]) === String(week));
  if (!absences.length) {
    el.innerHTML = '<p style="padding:16px;color:var(--gray)">No absences found.</p>';
    return;
  }

  const statusColors = {
    'Pending':   { bg: '#fdecea', color: '#e53935' },
    'Scheduled': { bg: '#fff5e0', color: '#c9960c' },
    'Done':      { bg: '#e8f5ee', color: '#e64980' }
  };

  el.innerHTML = absences.map(a => {
    const attId = String(a["Attendance ID"] || '');
    const mkStatus = (APP.makeupStatus[attId]?.status) || 'Pending';
    const { bg, color } = statusColors[mkStatus] || statusColors['Pending'];
    return `
      <div class="row" style="align-items:center;flex-wrap:wrap;gap:6px;padding:12px 0">
        <div style="flex:1;min-width:120px">
          <strong>${a["Student Name"] || a["StudentName"] || "—"}</strong><br>
          <small style="color:var(--text3)">Week ${a["Week No"]} · ${getTableLabel(a["Table No"] || "—")}</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <div style="background:${bg};color:${color};font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;white-space:nowrap">${mkStatus}</div>
          <select onchange="doUpdateMakeupStatus('${attId}', this.value, '${a["Student ID"] || ""}', '${(a["Student Name"]||"").replace(/'/g,"\\'")}', ${a["Week No"] || 0}, '${a["Table No"] || ""}')"
            style="font-size:11px;padding:4px 8px;border:1.5px solid ${color};border-radius:8px;background:#fff;color:${color};font-weight:600;cursor:pointer">
            <option value="Pending"   ${mkStatus === 'Pending'   ? 'selected' : ''}>Pending</option>
            <option value="Scheduled" ${mkStatus === 'Scheduled' ? 'selected' : ''}>Scheduled</option>
            <option value="Done"      ${mkStatus === 'Done'      ? 'selected' : ''}>Done</option>
          </select>
        </div>
      </div>`;
  }).join('');
}

async function doUpdateMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo) {
  if (!attendanceId) { showToast('⚠️ Cannot update — no attendance ID.'); return; }
  showToast('⏳ Updating makeup status...');
  await saveMakeupStatus(attendanceId, status, studentId, studentName, weekNo, tableNo, '');
  renderMakeup();
  showToast(`✅ Makeup status set to ${status}`);
}



// ═══════════════════════════════════════════
// RECORD HOME STATS
// ═══════════════════════════════════════════
function renderRecordStats() {
  const el = document.getElementById('r-stats');
  if (!el) return;
  const activeStudents = APP.students.filter(s => (s["Status"] || "Active").toLowerCase() !== "dropped");
  const totalPaid = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  const totalPaymentsAmount = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const totalUnpaid = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Unpaid").length;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-val">${activeStudents.length}</div><div class="stat-label">Total Students</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${totalPaid}</div><div class="stat-label">Fully Paid</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#ae3ec9">₱${totalPaymentsAmount.toLocaleString()}</div><div class="stat-label">Total Collected</div></div>
    <div class="stat-card"><div class="stat-val" style="color:${totalUnpaid > 0 ? '#e53935' : 'var(--green)'}">${totalUnpaid}</div><div class="stat-label">Unpaid</div></div>
  `;
}

// ═══════════════════════════════════════════
// RECORD — PAYMENT
// ═══════════════════════════════════════════
function populatePayStudentSelect() {
  const sel = document.getElementById('pay-student-sel');
  if (!sel) return;
  sel.innerHTML = APP.students.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (${getTableLabel(s["Table No"])})</option>`
  ).join('');
}

function filterPayStudents() {
  const query = document.getElementById('pay-search')?.value?.toLowerCase() || '';
  const sel   = document.getElementById('pay-student-sel');
  if (!sel) return;
  const filtered = APP.students.filter(s =>
    s["Full Name"].toLowerCase().includes(query) || String(s["Student ID"]).includes(query)
  );
  sel.innerHTML = filtered.map(s =>
    `<option value="${s["Student ID"]}">${s["Full Name"]} (${getTableLabel(s["Table No"])})</option>`
  ).join('');
}

async function doAddPayment() {
  const studentId = document.getElementById('pay-student-sel')?.value;
  const amount    = parseFloat(document.getElementById('pay-amount')?.value || 0);
  const type      = document.getElementById('pay-type')?.value || 'Full';
  const notes     = document.getElementById('pay-notes')?.value || '';

  const student = APP.students.find(s => String(s["Student ID"]) === String(studentId));
  if (!student) { showToast('⚠️ Please select a student.'); return; }
  if (!amount || amount <= 0) { showToast('⚠️ Enter a valid amount.'); return; }

  const pay     = getStudentPayment(student["Student ID"]);
  const balance = Math.max(0, pay.balance - amount);
  const status  = balance <= 0 ? "Paid" : "Partial";

  try {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    await apiPost({
      action:      "addPayment",
      studentId:   student["Student ID"],
      studentName: student["Full Name"],
      tableNo:     student["Table No"],
      amountPaid:  amount,
      balance:     balance,
      status:      `${status} — ${type}${notes ? ' · ' + notes : ''}`
    });

    showToast(`✅ Payment recorded for ${student["Full Name"]}`);
    document.getElementById('pay-amount').value = '';
    document.getElementById('pay-notes').value  = '';
    await loadAllData();
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to record payment'));
    console.error('doAddPayment error:', err);
  } finally {
    const btn = document.querySelector('#s-r-payment .btn-primary');
    if (btn) { btn.disabled = false; btn.textContent = 'Record Payment'; }
  }
}

// ═══════════════════════════════════════════
// BALANCES SUMMARY
// ═══════════════════════════════════════════
function renderBalancesSummary() {
  const feeEl = document.getElementById('r-total-fee');
  if (feeEl) feeEl.textContent = `₱${APP.totalFee.toLocaleString()}.00`;

  const summaryEl = document.getElementById('r-bal-summary');
  if (!summaryEl) return;

  const activeStudents = APP.students.filter(s => (s["Status"]||"Active").toLowerCase() !== "dropped");
  const paid    = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Paid").length;
  const partial = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Partial").length;
  const unpaid  = activeStudents.filter(s => getStudentPayment(s["Student ID"]).status === "Unpaid").length;
  const totalCollected = APP.payments.reduce((sum, p) => sum + Number(p["Amount Paid"] || 0), 0);
  const totalExpected  = activeStudents.length * APP.totalFee;

  summaryEl.innerHTML = `
    <div class="stat-card"><div class="stat-val" style="color:var(--green)">${paid}</div><div class="stat-label">Fully Paid</div></div>
    <div class="stat-card"><div class="stat-val" style="color:#e8a020">${partial}</div><div class="stat-label">Partial</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--red,#e53935)">${unpaid}</div><div class="stat-label">Unpaid</div></div>
    <div class="stat-card" style="grid-column:1/-1;background:linear-gradient(135deg,#f3e8ff,#ede0f8)">
      <div class="stat-val" style="color:#ae3ec9">₱${totalCollected.toLocaleString()}</div>
      <div class="stat-label">Total Collected of ₱${totalExpected.toLocaleString()} expected</div>
    </div>
  `;
}

// ═══════════════════════════════════════════
// LOGIN SYSTEM
// ═══════════════════════════════════════════
const ADMIN_ROLES  = ['director', 'consultant'];
const RECORD_ROLES = ['record', 'recorder'];

// Returns ALL role types that apply to this person (a person can be e.g.
// "Consultant/Facilitator/Record" and have admin + faculty + record access).
// Falls back to ['faculty'] if nothing matches.
function getRoleTypes(role) {
  const r = (role || '').toLowerCase().trim();
  const types = [];
  if (ADMIN_ROLES.some(a  => r.includes(a))) types.push('admin');
  if (RECORD_ROLES.some(a => r.includes(a))) types.push('record');
  // "Facilitator" (or anyone not matched above) gets faculty/facilitator access
  if (r.includes('facilitator') || types.length === 0) types.push('faculty');
  return types;
}

// Kept for any other call sites — returns the single highest-priority role
// (admin > record > faculty). Prefer getRoleTypes().includes(x) for login gating.
function getRoleType(role) {
  const types = getRoleTypes(role);
  if (types.includes('admin'))  return 'admin';
  if (types.includes('record')) return 'record';
  return 'faculty';
}

function findFacultyByCredentials(username, password) {
  return APP.faculty.find(f =>
    String(f["Username"] || '').trim().toLowerCase() === username.trim().toLowerCase() &&
    String(f["Password"] || '').trim() === password.trim()
  ) || null;
}

function isDataEmpty() { return APP.faculty.length === 0; }

function showLoginError(errId, message) {
  const el = document.getElementById(errId);
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
}

function hideLoginError(errId) {
  const el = document.getElementById(errId);
  if (el) el.style.display = 'none';
}

function setLoginLoading(btnEl, loading) {
  if (!btnEl) return;
  btnEl.disabled    = loading;
  btnEl.textContent = loading ? 'Signing in…' : 'Sign in';
}

function doFacultyLogin() {
  const username = document.getElementById('f-login-user')?.value || '';
  const password = document.getElementById('f-login-pass')?.value || '';
  const btn      = document.querySelector('#s-faculty-login .btn-primary');
  hideLoginError('f-login-err');
  if (!username || !password) { showLoginError('f-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('f-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('f-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('f-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('faculty')) {
      const suggestion = roleTypes.includes('admin') ? 'Admin' : (roleTypes.includes('record') ? 'Record' : 'the correct');
      showLoginError('f-login-err', `Your account does not have Facilitator access. Use the ${suggestion} portal to sign in.`);
      setLoginLoading(btn, false);
      return;
    }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('f-login-user', 'f-login-pass');
    populateCreditStudentSelect();
    updateFacultyHome();
    go('s-faculty-home');
  }, 120);
}

function doAdminLogin() {
  const username = document.getElementById('a-login-user')?.value || '';
  const password = document.getElementById('a-login-pass')?.value || '';
  const btn      = document.querySelector('#s-admin-login .btn-primary');
  hideLoginError('a-login-err');
  if (!username || !password) { showLoginError('a-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('a-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('a-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('a-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('admin')) { showLoginError('a-login-err', 'Your account does not have Admin access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('a-login-user', 'a-login-pass');
    updateAdminHomeStats();
    go('s-admin-home');
  }, 120);
}

function doRecordLogin() {
  const username = document.getElementById('r-login-user')?.value || '';
  const password = document.getElementById('r-login-pass')?.value || '';
  const btn      = document.querySelector('#s-record-login .btn-primary');
  hideLoginError('r-login-err');
  if (!username || !password) { showLoginError('r-login-err', 'Please enter your username and password.'); return; }
  if (isDataEmpty()) { showLoginError('r-login-err', 'Still connecting to server. Please wait a moment and try again.'); return; }
  setLoginLoading(btn, true);
  setTimeout(() => {
    const person = findFacultyByCredentials(username, password);
    if (!person) { showLoginError('r-login-err', 'Incorrect username or password.'); setLoginLoading(btn, false); document.getElementById('r-login-pass').value = ''; return; }
    const roleTypes = getRoleTypes(person["Role"]);
    if (!roleTypes.includes('record')) { showLoginError('r-login-err', 'Your account does not have Record access.'); setLoginLoading(btn, false); return; }
    APP.currentFaculty = person;
    setLoginLoading(btn, false);
    clearLoginFields('r-login-user', 'r-login-pass');
    renderRecordStats();
    go('s-record-home');
  }, 120);
}

function logout() {
  stopLedPolling();
  const ledOverlay = document.getElementById('s-f-led');
  if (ledOverlay) ledOverlay.classList.remove('active');
  APP.currentFaculty = null;
  go('s-portal');
}

// ═══════════════════════════════════════════
// FACULTY — LIVE LED SCOREBOARD
// Shows the facilitator's table SOL points as a scrolling
// LED-style marquee, meant to be displayed on the phone that
// sits inside the SOL1 DIY cardboard laptop. Polls the sheet
// on its own short interval (independent of loadAllData) so it
// keeps updating live whenever an admin adds points to the
// table from the Admin > Tables screen.
// ═══════════════════════════════════════════
let LED_POLL_INTERVAL = null;
let LED_LAST_TOTAL    = null;

// Client-side fallback used before the first successful ledConfig fetch —
// mirrors LED_CONFIG_DEFAULTS on the Apps Script side.
const LED_CONFIG_DEFAULTS_CLIENT = {
  showName: true, showPoints: true, showRank: false, flashOnIncrease: true,
  theme: 'yellow', customMessage: '', messageMode: 'append', targetTable: ''
};

// Swaps in the yellow/green/red/blue/white glow — shared by the faculty
// board and the admin live preview.
function applyLedTheme(screenEl, theme) {
  if (!screenEl) return;
  ['led-theme-yellow', 'led-theme-green', 'led-theme-red', 'led-theme-blue', 'led-theme-white']
    .forEach(c => screenEl.classList.remove(c));
  screenEl.classList.add(`led-theme-${theme || 'yellow'}`);
}

// "🥇 1ST PLACE" etc, based on the same table-credit totals the Admin
// Table Leaderboard uses.
function getLedRankText(tableNo) {
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))].filter(Boolean);
  const ranked = tableNos
    .map(t => ({ t, total: getTableCredits(t) }))
    .sort((a, b) => b.total - a.total);
  const idx = ranked.findIndex(x => x.t === String(tableNo));
  if (idx === -1) return '';
  const medals = ['🥇 1ST PLACE', '🥈 2ND PLACE', '🥉 3RD PLACE'];
  return medals[idx] || `#${idx + 1} PLACE`;
}

// Builds the scrolling text for one table given the current admin-pushed
// config. Shared by the faculty LED board and the Admin control preview.
function buildLedText(tableNo, config) {
  const total = getTableCredits(tableNo);
  const parts = [];
  if (config.showName)   parts.push(getTableLabel(tableNo).toUpperCase());
  if (config.showPoints) parts.push(`${total} SOL POINTS`);
  if (config.showRank) {
    const rank = getLedRankText(tableNo);
    if (rank) parts.push(rank);
  }
  let base = parts.length ? parts.join('    ') : getTableLabel(tableNo).toUpperCase();

  const msg = (config.customMessage || '').trim();
  const targetsThisTable = !config.targetTable || String(config.targetTable) === String(tableNo);
  if (msg && targetsThisTable) {
    base = (config.messageMode === 'replace') ? msg : `${base}    ${msg}`;
  }
  return { text: base, total };
}

async function openLedBoard() {
  LED_LAST_TOTAL = null; // force a clean first render, no flash
  const overlay = document.getElementById('s-f-led');
  if (overlay) overlay.classList.add('active');
  initLedOrientationPref();
  renderLedBanner(); // immediate render with whatever's cached
  await refreshLedCredits(); // then pull the live totals + admin config
  startLedPolling();
  // Best-effort — most mobile browsers only allow fullscreen from a real
  // user tap, so this quietly no-ops if the browser refuses it here.
  const el = document.getElementById('led-screen');
  if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function closeLedBoard() {
  stopLedPolling();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const overlay = document.getElementById('s-f-led');
  if (overlay) overlay.classList.remove('active');
}

// Remembers whether the phone is mounted "flipped" in the cardboard
// laptop, so the forced-landscape rotation goes the right way next time.
function initLedOrientationPref() {
  const overlay = document.getElementById('s-f-led');
  if (!overlay) return;
  let flipped = false;
  try { flipped = localStorage.getItem('sol1_led_flip') === '1'; } catch (e) {}
  overlay.classList.toggle('led-flip', flipped);
}

function toggleLedFlip() {
  const overlay = document.getElementById('s-f-led');
  if (!overlay) return;
  const flipped = overlay.classList.toggle('led-flip');
  try { localStorage.setItem('sol1_led_flip', flipped ? '1' : '0'); } catch (e) {}
}

function toggleLedFullscreen() {
  const el = document.getElementById('led-screen');
  if (!el) return;
  if (!document.fullscreenElement) {
    (el.requestFullscreen ? el.requestFullscreen() : Promise.reject()).catch(() => {
      showToast('⚠️ Fullscreen not supported on this device');
    });
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

function startLedPolling() {
  stopLedPolling();
  // 6s keeps the board feeling "live" without hammering Apps Script —
  // this only re-fetches the CREDITS sheet, not the full data bundle.
  // A small random jitter on each tick keeps multiple LED boards from
  // landing on the exact same instant every cycle (which is what shows
  // up as several simultaneous doGet calls in the Executions log).
  const scheduleNext = () => {
    LED_POLL_INTERVAL = setTimeout(async () => {
      await refreshLedCredits();
      scheduleNext();
    }, 6000 + Math.floor(Math.random() * 2000));
  };
  scheduleNext();
}

function stopLedPolling() {
  if (LED_POLL_INTERVAL) { clearTimeout(LED_POLL_INTERVAL); LED_POLL_INTERVAL = null; }
}

async function refreshLedCredits() {
  try {
    const [credRes, cfgRes] = await Promise.all([apiGet('credits'), apiGet('ledConfig')]);
    if (credRes && credRes.success) APP.credits = credRes.data || [];
    if (cfgRes && cfgRes.success && cfgRes.config) APP.ledConfig = cfgRes.config;
    renderLedBanner();
  } catch (err) {
    console.error('refreshLedCredits error:', err);
  }
}

function renderLedBanner() {
  const tableNo = APP.currentFaculty?.["Table Assigned"] || "";
  const config  = APP.ledConfig || LED_CONFIG_DEFAULTS_CLIENT;
  const { text, total } = buildLedText(tableNo, config);

  const labelEl = document.getElementById('led-team-label');
  if (labelEl) labelEl.textContent = getTableLabel(tableNo).toUpperCase();

  const screen = document.getElementById('led-screen');
  applyLedTheme(screen, config.theme);

  const chunk1 = document.getElementById('led-chunk-1');
  if (!chunk1) return;

  // Static display now — only re-render and pop when the text actually
  // changed, so a same-content poll (every 6s) doesn't re-trigger it.
  if (chunk1.textContent !== text) {
    chunk1.textContent = text;
    chunk1.classList.remove('led-text-in');
    void chunk1.offsetWidth; // force reflow so the animation restarts cleanly
    chunk1.classList.add('led-text-in');
  }

  const increased = LED_LAST_TOTAL !== null && total > LED_LAST_TOTAL && config.flashOnIncrease !== false;
  if (increased) {
    const gained = total - LED_LAST_TOTAL;
    if (screen) {
      screen.classList.add('led-flash');
      setTimeout(() => screen.classList.remove('led-flash'), 1700);
    }
    // Show the actual points gained directly on the board itself — a
    // toast alone isn't reliable here since this screen is rotated into
    // forced landscape and the toast isn't part of that rotated layout.
    const gainBadge = document.getElementById('led-gain-badge');
    if (gainBadge) {
      gainBadge.textContent = `+${gained} SOL`;
      gainBadge.classList.remove('led-gain-pop');
      void gainBadge.offsetWidth; // force reflow so the animation restarts cleanly
      gainBadge.classList.add('led-gain-pop');
    }
    if (navigator.vibrate) navigator.vibrate([70, 60, 70]);
    showToast(`🎉 +${gained} SOL for ${getTableLabel(tableNo).toUpperCase()}!`);
  }
  LED_LAST_TOTAL = total;
}

// ═══════════════════════════════════════════
// ADMIN — LED BOARD CONTROL
// Pushes one shared config (Script Properties on the GAS side) that
// every faculty phone's LED board polls every ~6s, so the admin
// controls what shows on ALL boards (or just one table) from here.
// ═══════════════════════════════════════════
let LED_ADMIN_THEME    = 'yellow';
let LED_ADMIN_MSG_MODE = 'append';

function populateLedTargetSelect(selected) {
  const sel = document.getElementById('led-cfg-target');
  if (!sel) return;
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))]
    .filter(Boolean).sort((a, b) => Number(a) - Number(b));
  sel.innerHTML = '<option value="">All Tables</option>' +
    tableNos.map(t => `<option value="${t}">${getTableLabel(t)}</option>`).join('');
  sel.value = selected || '';
}

function selectLedTheme(theme) {
  LED_ADMIN_THEME = theme;
  document.querySelectorAll('.led-theme-swatch').forEach(btn => {
    btn.style.borderColor = (btn.dataset.theme === theme) ? btn.style.color : '#333';
  });
  updateLedPreview();
}

function setLedMessageMode(mode) {
  LED_ADMIN_MSG_MODE = mode;
  const appendBtn  = document.getElementById('led-mode-append');
  const replaceBtn = document.getElementById('led-mode-replace');
  if (!appendBtn || !replaceBtn) return;
  if (mode === 'replace') {
    replaceBtn.style.background = '#c9960c'; replaceBtn.style.color = '#fff';
    appendBtn.style.background  = '#fff';    appendBtn.style.color  = '#c9960c';
  } else {
    appendBtn.style.background  = '#c9960c'; appendBtn.style.color  = '#fff';
    replaceBtn.style.background = '#fff';    replaceBtn.style.color = '#c9960c';
  }
  updateLedPreview();
}

function getLedConfigFromUI() {
  return {
    showName:        document.getElementById('led-cfg-showName')?.checked ?? true,
    showPoints:      document.getElementById('led-cfg-showPoints')?.checked ?? true,
    showRank:        document.getElementById('led-cfg-showRank')?.checked ?? false,
    flashOnIncrease: document.getElementById('led-cfg-flash')?.checked ?? true,
    theme:           LED_ADMIN_THEME,
    customMessage:   document.getElementById('led-cfg-message')?.value || '',
    messageMode:     LED_ADMIN_MSG_MODE,
    targetTable:     document.getElementById('led-cfg-target')?.value || ''
  };
}

function updateLedPreview() {
  const config = getLedConfigFromUI();
  const tableNos = [...new Set(APP.students.map(s => String(s["Table No"])))]
    .filter(Boolean).sort((a, b) => Number(a) - Number(b));
  const previewTable = config.targetTable || tableNos[0] || '';

  const chunk1 = document.getElementById('led-preview-chunk-1');
  if (!chunk1) return;

  const text = previewTable ? buildLedText(previewTable, config).text : 'ADD A TABLE TO SEE A PREVIEW';
  applyLedTheme(document.getElementById('led-preview-screen'), config.theme);

  if (chunk1.textContent !== text) {
    chunk1.textContent = text;
    chunk1.classList.remove('led-text-in');
    void chunk1.offsetWidth;
    chunk1.classList.add('led-text-in');
  }
}

async function openLedControl() {
  populateLedTargetSelect('');
  selectLedTheme('yellow');
  setLedMessageMode('append');
  updateLedPreview();
  try {
    const res = await apiGet('ledConfig');
    if (res && res.success && res.config) {
      const cfg = res.config;
      const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
      setChecked('led-cfg-showName',   cfg.showName);
      setChecked('led-cfg-showPoints', cfg.showPoints);
      setChecked('led-cfg-showRank',   cfg.showRank);
      setChecked('led-cfg-flash',      cfg.flashOnIncrease);
      const msgEl = document.getElementById('led-cfg-message');
      if (msgEl) msgEl.value = cfg.customMessage || '';
      populateLedTargetSelect(cfg.targetTable || '');
      selectLedTheme(cfg.theme || 'yellow');
      setLedMessageMode(cfg.messageMode || 'append');
    }
  } catch (err) {
    console.error('openLedControl error:', err);
  }
  updateLedPreview();
}

async function doSaveLedConfig() {
  const config = getLedConfigFromUI();
  const btn = document.querySelector('#s-a-led-control .btn-primary');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Pushing…'; }
    await apiPost({ action: 'setLedConfig', ...config });
    showToast('📡 LED display settings pushed to every board');
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to push settings'));
    console.error('doSaveLedConfig error:', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📡 Push to All LED Boards'; }
  }
}

async function doClearLedMessage() {
  try {
    await apiPost({ action: 'clearLedMessage' });
    const msgEl = document.getElementById('led-cfg-message');
    if (msgEl) msgEl.value = '';
    populateLedTargetSelect('');
    updateLedPreview();
    showToast('✅ LED message cleared from every board');
  } catch (err) {
    showToast('❌ ' + (err.message || 'Failed to clear message'));
    console.error('doClearLedMessage error:', err);
  }
}

function clearLoginFields(...ids) {
  ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}
