import {
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  FREQUENCY_OPTIONS,
  computeBudgetModel,
  computeMonthlyAmount,
} from './budget-engine.js';

const SUPABASE_URL = 'https://rpegjcnwtsjdbqrxxzrm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3QFbL-uHbTadq5eQpUdDiA_hTicgtOL';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'reste_supabase_auth',
  },
});

const state = {
  user: null,
  profile: null,
  household: null,
  members: [],
  items: [],
  spendLogs: [],
  snapshots: [],
  activeTab: 'overview',
  personalScope: 'partner_a',
  jointFilterCat: 'All',
  jointSearch: '',
  selectedMonth: null,
  authMode: 'login',
  darkMode: localStorage.getItem('reste_dark') === '1',
  online: navigator.onLine,
  channel: null,
  presenceNames: [],
  offlineQueue: [],
  flushing: false,
  selectedLogPot: '',
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(val, currencyOverride) {
  const cur = currencyOverride || state.household?.currency || '£';
  const num = Number(val || 0);
  const abs = Math.abs(num).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < -0.004 ? `-${cur}${abs}` : `${cur}${abs}`;
}

function fmtPct(ratio) {
  return `${(Number(ratio || 0) * 100).toFixed(1)}%`;
}

function fmtMonthLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || 'This Month';
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

let toastTimer = null;
function showToast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function setBanner(elId, msg, type = 'err') {
  const el = $(elId);
  if (!el) return;
  if (!msg) {
    el.className = 'hidden';
    el.textContent = '';
    return;
  }
  el.className = type === 'ok' ? 'ok-banner' : 'err-banner';
  el.textContent = msg;
}

function toAuthEmail(identifier) {
  const clean = String(identifier || '').trim().toLowerCase();
  if (!clean) return '';
  if (clean.includes('@')) return clean;
  const slug = clean.replace(/[^a-z0-9._-]/g, '');
  return slug ? `${slug}@users.reste.app` : '';
}

function queueStorageKey() {
  return state.user ? `reste_queue_${state.user.id}` : 'reste_queue_anon';
}

function loadOfflineQueue() {
  try {
    const raw = localStorage.getItem(queueStorageKey());
    state.offlineQueue = raw ? JSON.parse(raw) : [];
  } catch {
    state.offlineQueue = [];
  }
}

function saveOfflineQueue() {
  try {
    localStorage.setItem(queueStorageKey(), JSON.stringify(state.offlineQueue));
  } catch {
    // ignore quota errors
  }
}

function updateSyncBar() {
  const bar = $('sync-bar');
  const txt = $('sync-txt');
  const pill = $('presence-pill');
  if (!bar || !txt) return;

  if (!state.household) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  if (!state.online || state.offlineQueue.length > 0) {
    bar.className = 'sync-bar off';
    const q = state.offlineQueue.length;
    txt.textContent = !state.online
      ? `Offline — ${q ? `${q} change(s) queued to save` : 'viewing saved snapshot'}`
      : `Syncing ${q} queued change(s)…`;
  } else {
    bar.className = 'sync-bar';
    txt.textContent = 'Live · All changes saved permanently';
  }

  const others = state.presenceNames.filter(
    (n) => n && n !== (state.profile?.display_name || state.profile?.username)
  );
  if (others.length > 0) {
    pill.textContent = `${others.join(', ')} live`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

// ─── DARK MODE & SERVICE WORKER ───────────────────────────────────────────────
function applyDarkMode() {
  document.body.classList.toggle('dark', state.darkMode);
  const btn = $('dark-toggle');
  if (btn) btn.textContent = state.darkMode ? '☀️' : '🌙';
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ─── MODAL SYSTEM ─────────────────────────────────────────────────────────────
function openModal(title, htmlBuilder) {
  $('modal-title').textContent = title;
  const body = $('modal-body');
  body.innerHTML = '';
  htmlBuilder(body);
  $('modal-overlay').classList.add('open');
}

function closeModal() {
  $('modal-overlay').classList.remove('open');
}

// ─── DATA LOADING & REALTIME SYNC ─────────────────────────────────────────────
async function loadProfileAndHousehold() {
  const { data: sessData } = await sb.auth.getSession();
  const session = sessData?.session;

  if (!session?.user) {
    state.user = null;
    state.profile = null;
    state.household = null;
    teardownRealtime();
    showView('auth');
    return;
  }

  state.user = session.user;
  loadOfflineQueue();

  let { data: prof } = await sb
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!prof) {
    const meta = session.user.user_metadata || {};
    const uname = String(meta.username || session.user.email?.split('@')[0] || 'member')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    const { data: created } = await sb
      .from('profiles')
      .upsert({
        id: session.user.id,
        username: uname || `user_${session.user.id.slice(0, 6)}`,
        display_name: meta.display_name || uname || 'Member',
        email: meta.contact_email || '',
      })
      .select()
      .single();
    prof = created;
  }

  state.profile = prof;
  $('setup-user-name').textContent = prof?.display_name || prof?.username || 'friend';

  let householdId = prof?.active_household_id || null;
  if (!householdId) {
    const { data: memberships } = await sb
      .from('household_members')
      .select('household_id')
      .eq('user_id', session.user.id)
      .limit(1);
    if (memberships?.length) {
      householdId = memberships[0].household_id;
      await sb.from('profiles').update({ active_household_id: householdId }).eq('id', session.user.id);
    }
  }

  if (!householdId) {
    state.household = null;
    teardownRealtime();
    showView('household-setup');
    return;
  }

  await fetchHouseholdData(householdId);
  if (session?.access_token) {
    await sb.realtime.setAuth(session.access_token);
  }
  setupRealtime(householdId);
  await flushOfflineQueue();
  showView('app');
  renderAll();
}

async function fetchHouseholdData(householdId) {
  const [hhRes, memRes, itemsRes, logsRes, snapRes] = await Promise.all([
    sb.from('households').select('*').eq('id', householdId).single(),
    sb.from('household_members').select('*, profiles(id, username, display_name, avatar_color)').eq('household_id', householdId),
    sb.from('budget_items').select('*').eq('household_id', householdId).order('sort_order', { ascending: true }).order('created_at', { ascending: true }),
    sb.from('spend_logs').select('*').eq('household_id', householdId).order('spend_date', { ascending: false }).order('created_at', { ascending: false }),
    sb.from('monthly_snapshots').select('*').eq('household_id', householdId).order('month_key', { ascending: true }),
  ]);

  if (hhRes.error || !hhRes.data) {
    state.household = null;
    showView('household-setup');
    return;
  }

  state.household = hhRes.data;
  state.members = memRes.data || [];
  state.items = itemsRes.data || [];
  state.spendLogs = logsRes.data || [];
  state.snapshots = snapRes.data || [];

  if (!state.selectedMonth) {
    state.selectedMonth = state.household.active_month || currentYearMonth();
  }

  // Default personal tab to caller's partner slot
  const myMembership = state.members.find((m) => m.user_id === state.user?.id);
  if (myMembership && !state._personalPickedOnce) {
    state.personalScope = myMembership.partner_slot === 'b' ? 'partner_b' : 'partner_a';
    state._personalPickedOnce = true;
  }

  $('topbar-sub').textContent = `${state.household.name} · Code ${state.household.invite_code}`;
  updateSyncBar();
}

let refreshDebounce = null;
function scheduleRefresh(summaryText) {
  if (!state.household) return;
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(async () => {
    await fetchHouseholdData(state.household.id);
    renderAll();
    if (summaryText) showToast(summaryText);
  }, 120);
}

function teardownRealtime() {
  if (state.channel) {
    sb.removeChannel(state.channel);
    state.channel = null;
  }
  state.presenceNames = [];
  updateSyncBar();
}

function setupRealtime(householdId) {
  if (state.channel) sb.removeChannel(state.channel);
  const myName = state.profile?.display_name || state.profile?.username || 'Partner';

  const ch = sb.channel(`household:${householdId}`, {
    config: { presence: { key: state.user?.id || myName } },
  });

  ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'households', filter: `id=eq.${householdId}` },
    () => scheduleRefresh()
  )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'budget_items', filter: `household_id=eq.${householdId}` },
      () => scheduleRefresh()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'spend_logs', filter: `household_id=eq.${householdId}` },
      () => scheduleRefresh()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'monthly_snapshots', filter: `household_id=eq.${householdId}` },
      () => scheduleRefresh()
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'household_members', filter: `household_id=eq.${householdId}` },
      () => scheduleRefresh()
    )
    .on('broadcast', { event: 'sync_ping' }, ({ payload }) => {
      if (!payload || payload.senderId === state.user?.id) return;
      scheduleRefresh(payload.message || `${payload.actor || 'Partner'} updated the planner`);
    })
    .on('presence', { event: 'sync' }, () => {
      const pres = ch.presenceState();
      const names = [];
      Object.values(pres).forEach((entries) => {
        entries.forEach((e) => {
          if (e.name && !names.includes(e.name)) names.push(e.name);
        });
      });
      state.presenceNames = names;
      updateSyncBar();
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({ user_id: state.user?.id, name: myName });
      }
    });

  state.channel = ch;
}

async function broadcastChange(message) {
  if (!state.channel || !state.user) return;
  try {
    await state.channel.send({
      type: 'broadcast',
      event: 'sync_ping',
      payload: {
        senderId: state.user.id,
        actor: state.profile?.display_name || state.profile?.username || 'Partner',
        message,
      },
    });
  } catch {
    // ignore transient broadcast error
  }
}

// ─── PERSISTENT CLOUD MUTATIONS + OFFLINE QUEUE ───────────────────────────────
async function runMutation(op, toastMsg) {
  const actorName = state.profile?.display_name || state.profile?.username || '';
  const executeOp = async (entry) => {
    if (entry.table === 'budget_items') {
      if (entry.action === 'insert') {
        const { error } = await sb.from('budget_items').insert({ ...entry.payload, updated_by_name: actorName });
        if (error) throw error;
      } else if (entry.action === 'update') {
        const { error } = await sb.from('budget_items').update({ ...entry.payload, updated_by_name: actorName }).eq('id', entry.id);
        if (error) throw error;
      } else if (entry.action === 'delete') {
        const { error } = await sb.from('budget_items').delete().eq('id', entry.id);
        if (error) throw error;
      }
    } else if (entry.table === 'spend_logs') {
      if (entry.action === 'insert') {
        const { error } = await sb.from('spend_logs').insert({ ...entry.payload, created_by_name: actorName });
        if (error) throw error;
      } else if (entry.action === 'update') {
        const { error } = await sb.from('spend_logs').update(entry.payload).eq('id', entry.id);
        if (error) throw error;
      } else if (entry.action === 'delete') {
        const { error } = await sb.from('spend_logs').delete().eq('id', entry.id);
        if (error) throw error;
      }
    } else if (entry.table === 'households') {
      const { error } = await sb.from('households').update({ ...entry.payload, updated_by_name: actorName }).eq('id', entry.id);
      if (error) throw error;
    } else if (entry.table === 'monthly_snapshots') {
      const { error } = await sb
        .from('monthly_snapshots')
        .upsert(entry.payload, { onConflict: 'household_id,month_key' });
      if (error) throw error;
    }
  };

  if (!navigator.onLine) {
    state.offlineQueue.push(op);
    saveOfflineQueue();
    updateSyncBar();
    showToast('Saved offline — will sync automatically');
    return;
  }

  try {
    await executeOp(op);
    await fetchHouseholdData(state.household.id);
    renderAll();
    if (toastMsg) {
      showToast(toastMsg);
      broadcastChange(`${actorName || 'Partner'}: ${toastMsg}`);
    } else {
      broadcastChange(`${actorName || 'Partner'} updated the budget`);
    }
  } catch (err) {
    if (!navigator.onLine || String(err?.message || '').toLowerCase().includes('fetch')) {
      state.offlineQueue.push(op);
      saveOfflineQueue();
      updateSyncBar();
      showToast('Connection lost — change queued safely');
    } else {
      showToast(`Save error: ${err?.message || 'Please retry'}`);
    }
  }
}

async function flushOfflineQueue() {
  if (state.flushing || !navigator.onLine || !state.offlineQueue.length || !state.household) return;
  state.flushing = true;
  updateSyncBar();
  const remaining = [];
  for (const op of state.offlineQueue) {
    try {
      await runMutationDirect(op);
    } catch {
      remaining.push(op);
    }
  }
  state.offlineQueue = remaining;
  saveOfflineQueue();
  state.flushing = false;
  if (remaining.length === 0) {
    await fetchHouseholdData(state.household.id);
    renderAll();
    showToast('Offline changes synced to cloud');
  }
  updateSyncBar();
}

async function runMutationDirect(entry) {
  if (entry.table === 'budget_items') {
    if (entry.action === 'insert') return sb.from('budget_items').insert(entry.payload).throwOnError();
    if (entry.action === 'update') return sb.from('budget_items').update(entry.payload).eq('id', entry.id).throwOnError();
    if (entry.action === 'delete') return sb.from('budget_items').delete().eq('id', entry.id).throwOnError();
  } else if (entry.table === 'spend_logs') {
    if (entry.action === 'insert') return sb.from('spend_logs').insert(entry.payload).throwOnError();
    if (entry.action === 'update') return sb.from('spend_logs').update(entry.payload).eq('id', entry.id).throwOnError();
    if (entry.action === 'delete') return sb.from('spend_logs').delete().eq('id', entry.id).throwOnError();
  } else if (entry.table === 'households') {
    return sb.from('households').update(entry.payload).eq('id', entry.id).throwOnError();
  } else if (entry.table === 'monthly_snapshots') {
    return sb.from('monthly_snapshots').upsert(entry.payload, { onConflict: 'household_id,month_key' }).throwOnError();
  }
}

// ─── JSON BACKUP IMPORT ───────────────────────────────────────────────────────
async function importJSONBackup(file) {
  const raw = await file.text();
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Invalid Reste backup JSON file.');
  }
  const h = state.household;
  const actorName = state.profile?.display_name || state.profile?.username || '';
  if (!confirm(`Import ${parsed.items.length} budget item(s) into "${h.name}"? This replaces current items in this household.`)) {
    return;
  }

  await sb.from('budget_items').delete().eq('household_id', h.id).throwOnError();
  await sb.from('spend_logs').delete().eq('household_id', h.id).throwOnError();
  await sb.from('monthly_snapshots').delete().eq('household_id', h.id).throwOnError();

  if (parsed.household && typeof parsed.household === 'object') {
    const src = parsed.household;
    await sb
      .from('households')
      .update({
        currency: src.currency || h.currency,
        active_month: src.active_month || h.active_month,
        partner_a_name: src.partner_a_name || h.partner_a_name,
        partner_b_name: src.partner_b_name || h.partner_b_name,
        split_mode: src.split_mode || h.split_mode,
        partner_a_split: Number(src.partner_a_split ?? h.partner_a_split),
        partner_a_joint_transfer: Number(src.partner_a_joint_transfer ?? 0),
        partner_b_joint_transfer: Number(src.partner_b_joint_transfer ?? 0),
        partner_a_joint_optional: Number(src.partner_a_joint_optional ?? 0),
        partner_b_joint_optional: Number(src.partner_b_joint_optional ?? 0),
        expense_categories: Array.isArray(src.expense_categories) ? src.expense_categories : h.expense_categories,
        income_categories: Array.isArray(src.income_categories) ? src.income_categories : h.income_categories,
        updated_by_name: actorName,
      })
      .eq('id', h.id)
      .throwOnError();
  }

  const itemsPayload = parsed.items.map((it) => ({
    household_id: h.id,
    scope: it.scope,
    section: it.section,
    name: it.name,
    category: it.category || 'Others/Irregular',
    amount: Number(it.amount || 0),
    partner_a_amount: Number(it.partner_a_amount || 0),
    partner_b_amount: Number(it.partner_b_amount || 0),
    actual_amount: it.actual_amount !== null && it.actual_amount !== undefined ? Number(it.actual_amount) : null,
    raw_cost: it.raw_cost !== null && it.raw_cost !== undefined ? Number(it.raw_cost) : null,
    frequency: it.frequency || 'monthly',
    custom_split_a: it.custom_split_a !== null && it.custom_split_a !== undefined ? Number(it.custom_split_a) : null,
    paid_by: it.paid_by || '',
    is_paid: Boolean(it.is_paid),
    notes: it.notes || '',
    sort_order: Number(it.sort_order || 0),
    updated_by_name: actorName,
  }));

  const { data: insertedItems } = await sb.from('budget_items').insert(itemsPayload).select().throwOnError();
  const potByName = {};
  (insertedItems || [])
    .filter((i) => i.scope === 'joint' && i.section === 'budgeted_expense')
    .forEach((p) => {
      potByName[p.name] = p.id;
    });

  if (Array.isArray(parsed.spend_logs) && parsed.spend_logs.length) {
    const logsPayload = parsed.spend_logs.map((l) => ({
      household_id: h.id,
      budget_item_id: potByName[l.pot_name] || null,
      pot_name: l.pot_name,
      month_key: l.month_key,
      spend_date: l.spend_date,
      amount: Number(l.amount || 0),
      paid_by: l.paid_by || 'joint',
      note: l.note || '',
      created_by_name: actorName,
    }));
    await sb.from('spend_logs').insert(logsPayload).throwOnError();
  }

  if (Array.isArray(parsed.snapshots) && parsed.snapshots.length) {
    const snapsPayload = parsed.snapshots.map((s) => ({
      household_id: h.id,
      month_key: s.month_key,
      label: s.label || s.month_key,
      pot_totals: s.pot_totals || {},
      summary_json: s.summary_json || {},
    }));
    await sb.from('monthly_snapshots').upsert(snapsPayload, { onConflict: 'household_id,month_key' }).throwOnError();
  }

  await fetchHouseholdData(h.id);
  renderAll();
  broadcastChange(`${actorName || 'Partner'} imported a backup`);
  showToast('Backup restored permanently');
}

// ─── VIEW SWITCHING ───────────────────────────────────────────────────────────
function showView(view) {
  ['view-loading', 'view-auth', 'view-household-setup'].forEach((id) => $(id).classList.add('hidden'));
  ['panel-overview', 'panel-joint', 'panel-spend', 'panel-personal', 'panel-household'].forEach((id) =>
    $(id).classList.remove('active')
  );

  const isApp = view === 'app';
  $('bottom-nav').classList.toggle('hidden', !isApp);
  $('quick-spend-top').classList.toggle('hidden', !isApp);
  $('account-top-btn').classList.toggle('hidden', !isApp);
  $('sync-bar').classList.toggle('hidden', !isApp);

  if (view === 'loading') $('view-loading').classList.remove('hidden');
  else if (view === 'auth') {
    $('topbar-sub').textContent = 'Household Budget Planner';
    $('view-auth').classList.remove('hidden');
  } else if (view === 'household-setup') {
    $('topbar-sub').textContent = 'Set up your household';
    $('view-household-setup').classList.remove('hidden');
  } else if (isApp) {
    setActiveTab(state.activeTab);
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  const panel = $(`panel-${tab}`);
  const navBtn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (panel) panel.classList.add('active');
  if (navBtn) navBtn.classList.add('active');
  $('main-content').scrollTop = 0;
  renderAll();
}

// ─── RENDERING ────────────────────────────────────────────────────────────────
function getExpenseCategories() {
  const custom = state.household?.expense_categories;
  return Array.isArray(custom) && custom.length ? custom : DEFAULT_EXPENSE_CATEGORIES;
}

function getIncomeCategories() {
  const custom = state.household?.income_categories;
  return Array.isArray(custom) && custom.length ? custom : DEFAULT_INCOME_CATEGORIES;
}

function renderAll() {
  if (!state.household) return;
  const activeMonth = state.selectedMonth || state.household.active_month || currentYearMonth();
  const model = computeBudgetModel(state.household, state.items, state.spendLogs, activeMonth);

  if (state.activeTab === 'overview') renderOverview(model, activeMonth);
  else if (state.activeTab === 'joint') renderJoint(model);
  else if (state.activeTab === 'spend') renderSpend(model, activeMonth);
  else if (state.activeTab === 'personal') renderPersonal(model);
  else if (state.activeTab === 'household') renderHouseholdTab(model);
}

function renderOverview(m, activeMonth) {
  const h = state.household;
  const pA = h.partner_a_name || 'Partner A';
  const pB = h.partner_b_name || 'Partner B';
  const totalOutNeg = -Math.abs(m.totalHouseholdExpenditure);

  const potHtml = m.potTrackers.length
    ? m.potTrackers
        .map((p) => {
          const barCls = p.over ? 'over' : p.pct >= 80 ? 'warn' : '';
          const remTxt =
            p.remaining >= 0
              ? `${fmtMoney(p.remaining)} left`
              : `<span class="over-txt">${fmtMoney(Math.abs(p.remaining))} over</span>`;
          return `
          <div class="pot-row" data-log-pot="${esc(p.name)}" style="cursor:pointer;">
            <div class="pot-top">
              <span class="pot-name">${esc(p.name)}</span>
              <span class="pot-nums num">${fmtMoney(p.actual)} / ${fmtMoney(p.budget)}</span>
            </div>
            <div class="bar-track"><div class="bar-fill ${barCls}" style="width:${p.pct.toFixed(1)}%"></div></div>
            <div class="pot-foot">
              <span>${esc(p.category)}</span>
              <span>${remTxt}</span>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty-note">No budgeted pots yet. Add one in the Joint tab.</div>';

  const maxCat = m.categoriesSorted[0]?.total || 1;
  const catHtml = m.categoriesSorted.length
    ? m.categoriesSorted
        .map((c) => {
          const w = Math.min(100, (c.total / maxCat) * 100);
          return `
          <div style="margin-bottom:9px;">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
              <span>${esc(c.name)}</span>
              <span class="num" style="font-weight:600;">${fmtMoney(c.total)}</span>
            </div>
            <div class="bar-track" style="height:6px;"><div class="bar-fill" style="width:${w.toFixed(1)}%"></div></div>
          </div>`;
        })
        .join('')
    : '<div class="empty-note">Add joint expenses to see category totals.</div>';

  $('panel-overview').innerHTML = `
    <div class="hero-card">
      <div class="hero-top">
        <div>
          <div class="hero-kicker">Monthly Household Reste</div>
          <div class="hero-amount ${m.totalHouseholdDisposable < 0 ? 'neg' : ''}">${fmtMoney(m.totalHouseholdDisposable)}</div>
        </div>
        <button class="btn btn-sm" id="ov-log-spend-btn" style="background:rgba(255,255,255,0.14);border-color:rgba(255,255,255,0.22);color:#faf7f0;">+ Log Spend</button>
      </div>
      <div class="hero-meta-row">
        <span>Income <strong class="num">${fmtMoney(m.totalHouseholdIncome)}</strong></span>
        <span>Expenses <strong class="num">${fmtMoney(totalOutNeg)}</strong></span>
      </div>
      <div class="hero-pills">
        <button class="hero-pill" data-jump-tab="joint" type="button">
          <span class="hero-pill-lbl">Joint Reste</span>
          <span class="hero-pill-val">${fmtMoney(m.jointDisposable)}</span>
        </button>
        <button class="hero-pill" data-jump-personal="partner_a" type="button">
          <span class="hero-pill-lbl">${esc(pA)}'s Reste</span>
          <span class="hero-pill-val">${fmtMoney(m.partnerA.disposable)}</span>
        </button>
        <button class="hero-pill" data-jump-personal="partner_b" type="button">
          <span class="hero-pill-lbl">${esc(pB)}'s Reste</span>
          <span class="hero-pill-val">${fmtMoney(m.partnerB.disposable)}</span>
        </button>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Budgeted Pots · ${esc(fmtMonthLabel(activeMonth))}</div>
          <div class="sec-sub">Tap any pot to log a receipt</div>
        </div>
        <button class="btn btn-sm" id="ov-open-spend-btn" type="button">All Spend →</button>
      </div>
      ${potHtml}
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Cost Split &amp; Joint Transfers</div>
          <div class="sec-sub">Suggested by income: ${fmtPct(m.split.suggestedA)} / ${fmtPct(m.split.suggestedB)}</div>
        </div>
        <button class="btn btn-sm" id="ov-edit-split-btn" type="button">Edit Split</button>
      </div>
      <div class="split-bar">
        <div class="split-bar-a" style="width:${(m.split.activeA * 100).toFixed(1)}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;font-weight:600;">
        <span>${esc(pA)}: ${fmtPct(m.split.activeA)} (${fmtMoney(m.jointBillsA)} bills)</span>
        <span>${esc(pB)}: ${fmtPct(m.split.activeB)} (${fmtMoney(m.jointBillsB)} bills)</span>
      </div>
      <div class="kv-grid">
        <div class="kv-box">
          <div class="kv-lbl">${esc(pA)} Joint Transfer</div>
          <div class="kv-val">${fmtMoney(m.transferA)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">${esc(pB)} Joint Transfer</div>
          <div class="kv-val">${fmtMoney(m.transferB)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Direct Income</div>
          <div class="kv-val">${fmtMoney(m.jointDirectIncome)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Outgoings</div>
          <div class="kv-val">${fmtMoney(m.jointExpenseSubtotal)}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Joint Spend by Category</div>
          <div class="sec-sub">Monthly committed total: ${fmtMoney(m.jointExpenseSubtotal)}</div>
        </div>
      </div>
      ${catHtml}
    </div>
  `;

  $('ov-log-spend-btn')?.addEventListener('click', () => openSpendModal());
  $('ov-open-spend-btn')?.addEventListener('click', () => setActiveTab('spend'));
  $('ov-edit-split-btn')?.addEventListener('click', () => openSplitTransfersModal(m));
  $('panel-overview').querySelectorAll('[data-jump-tab]').forEach((b) =>
    b.addEventListener('click', () => setActiveTab(b.dataset.jumpTab))
  );
  $('panel-overview').querySelectorAll('[data-jump-personal]').forEach((b) =>
    b.addEventListener('click', () => {
      state.personalScope = b.dataset.jumpPersonal;
      setActiveTab('personal');
    })
  );
  $('panel-overview').querySelectorAll('[data-log-pot]').forEach((row) =>
    row.addEventListener('click', () => openSpendModal(null, row.dataset.logPot))
  );
}

function renderJoint(m) {
  const h = state.household;
  const pA = h.partner_a_name || 'Partner A';
  const pB = h.partner_b_name || 'Partner B';

  const usedCats = new Set(['All']);
  [...m.regularExpenses, ...m.budgetedExpenses, ...m.prepayments].forEach((i) => {
    if (i.category) usedCats.add(i.category);
  });

  const q = state.jointSearch.trim().toLowerCase();
  const matchesFilter = (item) => {
    if (state.jointFilterCat !== 'All' && item.category !== state.jointFilterCat) return false;
    if (q && !item.name.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) return false;
    return true;
  };

  const renderJointRows = (list, isPrepayment = false) => {
    const filtered = list.filter(matchesFilter);
    if (!filtered.length) return '<div class="empty-note">No items match this filter.</div>';
    return filtered
      .map((item) => {
        const monthly = isPrepayment
          ? computeMonthlyAmount(item.raw_cost ?? item.amount, item.frequency)
          : Number(item.amount || 0);
        const sA =
          item.custom_split_a !== null && item.custom_split_a !== undefined && item.custom_split_a !== ''
            ? Number(item.custom_split_a)
            : m.split.activeA;
        const shareA = monthly * sA;
        const shareB = monthly * (1 - sA);
        const freqLbl = isPrepayment
          ? FREQUENCY_OPTIONS.find((f) => f.value === item.frequency)?.label || item.frequency
          : '';
        return `
        <div class="item-row" data-edit-item="${item.id}">
          <div class="item-chk ${item.is_paid ? 'on' : ''}" data-toggle-paid="${item.id}" title="Mark paid">✓</div>
          <div class="item-main">
            <div class="item-name">
              <span>${esc(item.name)}</span>
              <span class="badge">${esc(item.category)}</span>
              ${isPrepayment ? `<span class="badge gold">${fmtMoney(item.raw_cost ?? item.amount)} · ${esc(freqLbl)}</span>` : ''}
            </div>
            <div class="item-sub">
              <span>${esc(pA)}: ${fmtMoney(shareA)}</span>
              <span>${esc(pB)}: ${fmtMoney(shareB)}</span>
              ${item.paid_by ? `<span>Paid by ${esc(item.paid_by)}</span>` : ''}
            </div>
          </div>
          <div class="item-right">
            <div class="item-amt">${fmtMoney(monthly)}</div>
            <div class="item-split">${isPrepayment ? '/ month' : fmtPct(sA)}</div>
          </div>
        </div>`;
      })
      .join('');
  };

  const incomeHtml = m.incomeItems.length
    ? m.incomeItems
        .map((item) => {
          const rowTotal = Number(item.amount || 0) + Number(item.partner_a_amount || 0) + Number(item.partner_b_amount || 0);
          return `
          <div class="item-row" data-edit-item="${item.id}">
            <div class="item-main">
              <div class="item-name">
                <span>${esc(item.name)}</span>
                <span class="badge emerald">${esc(item.category)}</span>
              </div>
              <div class="item-sub">
                ${Number(item.amount) ? `<span>Joint: ${fmtMoney(item.amount)}</span>` : ''}
                ${Number(item.partner_a_amount) ? `<span>${esc(pA)}: ${fmtMoney(item.partner_a_amount)}</span>` : ''}
                ${Number(item.partner_b_amount) ? `<span>${esc(pB)}: ${fmtMoney(item.partner_b_amount)}</span>` : ''}
              </div>
            </div>
            <div class="item-right">
              <div class="item-amt credit">${fmtMoney(rowTotal)}</div>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty-note">No income rows added yet.</div>';

  const debtTrackerHtml = m.jointDebtItems.length
    ? m.jointDebtItems
        .map(
          (d) => `
        <div class="item-row" data-edit-item="${d.id}">
          <div class="item-main">
            <div class="item-name">${esc(d.name)}</div>
            <div class="item-sub">Expected ${fmtMoney(d.amount)} · Actual ${fmtMoney(d.actual_amount || 0)}</div>
          </div>
          <div class="item-right">
            <div class="item-amt">${fmtMoney(d.actual_amount ?? d.amount)}</div>
          </div>
        </div>`
        )
        .join('')
    : '';

  $('panel-joint').innerHTML = `
    <div class="fg" style="margin-bottom:10px;">
      <input class="fi" id="joint-search-input" type="search" placeholder="Search bills, income, pots…" value="${esc(state.jointSearch)}" />
    </div>
    <div class="chip-strip">
      ${[...usedCats]
        .map((c) => `<button class="chip ${state.jointFilterCat === c ? 'on' : ''}" data-cat-chip="${esc(c)}" type="button">${esc(c)}</button>`)
        .join('')}
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Household Income</div>
          <div class="sec-sub">Joint + ${esc(pA)} + ${esc(pB)}</div>
        </div>
        <button class="btn btn-primary btn-sm" data-add-section="joint|income" type="button">+ Add Income</button>
      </div>
      <div class="item-list">${incomeHtml}</div>
      <div class="sec-total-bar">
        <span>Total Monthly Income</span>
        <span class="num">${fmtMoney(m.totalHouseholdIncome)}</span>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Regular Joint Expenses</div>
          <div class="sec-sub">${m.regularExpenses.length} recurring items</div>
        </div>
        <button class="btn btn-primary btn-sm" data-add-section="joint|regular_expense" type="button">+ Add Bill</button>
      </div>
      <div class="item-list">${renderJointRows(m.regularExpenses)}</div>
      <div class="sec-total-bar">
        <span>Regular Subtotal</span>
        <span class="num">${fmtMoney(m.regularTotal)}</span>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Budgeted Expense Pots</div>
          <div class="sec-sub">Monthly spending allowances</div>
        </div>
        <button class="btn btn-primary btn-sm" data-add-section="joint|budgeted_expense" type="button">+ Add Pot</button>
      </div>
      <div class="item-list">${renderJointRows(m.budgetedExpenses)}</div>
      <div class="sec-total-bar">
        <span>Pots Subtotal</span>
        <span class="num">${fmtMoney(m.budgetedTotal)}</span>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Prepayment Expenses</div>
          <div class="sec-sub">Auto-converted to monthly equivalent</div>
        </div>
        <button class="btn btn-primary btn-sm" data-add-section="joint|prepayment" type="button">+ Add Prepayment</button>
      </div>
      <div class="item-list">${renderJointRows(m.prepayments, true)}</div>
      <div class="sec-total-bar">
        <span>Monthly Equivalent Subtotal</span>
        <span class="num">${fmtMoney(m.prepaymentTotal)}</span>
      </div>
    </div>

    ${
      debtTrackerHtml
        ? `<div class="card">
            <div class="sec-hdr">
              <div>
                <div class="sec-title">Joint Debt Repayment</div>
                <div class="sec-sub">Expected vs Actual paid</div>
              </div>
            </div>
            <div class="item-list">${debtTrackerHtml}</div>
            <div class="sec-total-bar">
              <span>Expected ${fmtMoney(m.jointDebtExpected)}</span>
              <span class="num">Actual ${fmtMoney(m.jointDebtActual)}</span>
            </div>
          </div>`
        : ''
    }

    <div class="card" style="background:var(--emerald-p);border-color:var(--emerald);">
      <div style="display:flex;justify-content:space-between;align-items:center;font-weight:700;">
        <span>Total Joint Expenditure</span>
        <span class="num">${fmtMoney(m.jointExpenseSubtotal)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--ink2);margin-top:6px;">
        <span>${esc(pA)}'s share (${fmtPct(m.split.activeA)}): <strong class="num">${fmtMoney(m.jointBillsA)}</strong></span>
        <span>${esc(pB)}'s share (${fmtPct(m.split.activeB)}): <strong class="num">${fmtMoney(m.jointBillsB)}</strong></span>
      </div>
    </div>
  `;

  $('joint-search-input')?.addEventListener('input', (e) => {
    state.jointSearch = e.target.value;
    renderJoint(m);
    const inp = $('joint-search-input');
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  });
  $('panel-joint').querySelectorAll('[data-cat-chip]').forEach((b) =>
    b.addEventListener('click', () => {
      state.jointFilterCat = b.dataset.catChip;
      renderJoint(m);
    })
  );
  bindItemActions('panel-joint');
}

function renderSpend(m, activeMonth) {
  const pots = m.budgetedExpenses;
  if (!state.selectedLogPot && pots.length) state.selectedLogPot = pots[0].name;

  const monthsSet = new Set([activeMonth, currentYearMonth(), state.household.active_month].filter(Boolean));
  state.spendLogs.forEach((l) => monthsSet.add(l.month_key));
  const months = [...monthsSet].sort().reverse();

  const totalSpentMonth = m.monthLogs.reduce((s, l) => s + Number(l.amount || 0), 0);
  const totalBudgetMonth = pots.reduce((s, p) => s + Number(p.amount || 0), 0);

  // Build 6-month history columns from snapshots + active month
  const historyRows = [...state.snapshots];
  if (!historyRows.some((s) => s.month_key === activeMonth) && m.monthLogs.length) {
    const liveTotals = {};
    m.potTrackers.forEach((p) => {
      liveTotals[p.name] = Number(p.actual.toFixed(2));
    });
    historyRows.push({
      month_key: activeMonth,
      label: fmtMonthLabel(activeMonth) + ' (Live)',
      pot_totals: liveTotals,
    });
  }

  const potNames = pots.map((p) => p.name);
  const histHeaders = potNames.map((n) => `<th class="num">${esc(n)}</th>`).join('');
  const histTotals = {};
  potNames.forEach((n) => (histTotals[n] = 0));

  const histBody = historyRows
    .map((row) => {
      const cells = potNames
        .map((n) => {
          const v = Number(row.pot_totals?.[n] || 0);
          histTotals[n] += v;
          return `<td class="num">${fmtMoney(v)}</td>`;
        })
        .join('');
      return `<tr><td>${esc(row.label || fmtMonthLabel(row.month_key))}</td>${cells}</tr>`;
    })
    .join('');

  const avgCount = Math.max(1, historyRows.length);
  const totalCells = potNames.map((n) => `<td class="num"><strong>${fmtMoney(histTotals[n])}</strong></td>`).join('');
  const avgCells = potNames.map((n) => `<td class="num">${fmtMoney(histTotals[n] / avgCount)}</td>`).join('');

  $('panel-spend').innerHTML = `
    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Month: ${esc(fmtMonthLabel(activeMonth))}</div>
          <div class="sec-sub">Logged <strong class="num">${fmtMoney(totalSpentMonth)}</strong> of <strong class="num">${fmtMoney(totalBudgetMonth)}</strong></div>
        </div>
        <input class="fi" id="spend-month-picker" type="month" value="${esc(activeMonth)}" style="width:auto;padding:6px 10px;font-size:13px;" />
      </div>
      <div class="chip-strip" style="margin-bottom:0;padding-bottom:2px;">
        ${months
          .map(
            (mk) =>
              `<button class="chip ${mk === activeMonth ? 'on' : ''}" data-pick-month="${esc(mk)}" type="button">${esc(fmtMonthLabel(mk))}</button>`
          )
          .join('')}
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div class="sec-title">Quick Log Receipt</div>
      </div>
      <form id="inline-spend-form">
        <div class="chip-strip" style="margin-bottom:10px;">
          ${pots.length
            ? pots
                .map(
                  (p) =>
                    `<button class="chip ${state.selectedLogPot === p.name ? 'on' : ''}" data-select-pot="${esc(p.name)}" type="button">${esc(p.name)}</button>`
                )
                .join('')
            : '<span class="sec-sub">Add a budgeted pot in Joint first</span>'}
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="inline-spend-amt">Amount (${esc(state.household.currency)})</label>
            <input class="fi num" id="inline-spend-amt" type="number" step="0.01" placeholder="0.00" required />
          </div>
          <div class="fg">
            <label class="fl" for="inline-spend-date">Date</label>
            <input class="fi" id="inline-spend-date" type="date" value="${todayISO()}" required />
          </div>
        </div>
        <div class="fg">
          <label class="fl" for="inline-spend-note">Note (optional)</label>
          <input class="fi" id="inline-spend-note" type="text" placeholder="e.g. Sainsbury's weekly shop" />
        </div>
        <button class="btn btn-primary btn-full" type="submit" ${pots.length ? '' : 'disabled'}>Save Spend</button>
      </form>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div class="sec-title">Pot Balances</div>
      </div>
      ${m.potTrackers
        .map((p) => {
          const barCls = p.over ? 'over' : p.pct >= 80 ? 'warn' : '';
          return `
          <div class="pot-row">
            <div class="pot-top">
              <span class="pot-name">${esc(p.name)}</span>
              <span class="pot-nums num">${fmtMoney(p.actual)} / ${fmtMoney(p.budget)}</span>
            </div>
            <div class="bar-track"><div class="bar-fill ${barCls}" style="width:${p.pct.toFixed(1)}%"></div></div>
            <div class="pot-foot">
              <span>${p.pct.toFixed(0)}% used</span>
              <span>${p.remaining >= 0 ? `${fmtMoney(p.remaining)} left` : `<span class="over-txt">${fmtMoney(Math.abs(p.remaining))} over</span>`}</span>
            </div>
          </div>`;
        })
        .join('') || '<div class="empty-note">No pots configured.</div>'}
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Receipts (${m.monthLogs.length})</div>
          <div class="sec-sub">Tap any receipt to edit or remove</div>
        </div>
      </div>
      <div class="item-list">
        ${m.monthLogs.length
          ? m.monthLogs
              .map(
                (l) => `
              <div class="item-row" data-edit-log="${l.id}">
                <div class="item-main">
                  <div class="item-name">
                    <span>${esc(l.pot_name)}</span>
                    <span class="badge">${esc(l.spend_date)}</span>
                  </div>
                  <div class="item-sub">
                    ${l.note ? `<span>${esc(l.note)}</span>` : '<span>Receipt</span>'}
                    ${l.created_by_name ? `<span>· ${esc(l.created_by_name)}</span>` : ''}
                  </div>
                </div>
                <div class="item-right">
                  <div class="item-amt">${fmtMoney(l.amount)}</div>
                </div>
              </div>`
              )
              .join('')
          : '<div class="empty-note">No receipts logged in this month yet.</div>'}
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Monthly History &amp; Averages</div>
          <div class="sec-sub">Tracks monthly pot totals across saved months</div>
        </div>
        <button class="btn btn-sm" id="save-snapshot-btn" type="button">Save Month Snapshot</button>
      </div>
      <div class="tbl-wrap">
        <table class="data-tbl">
          <thead>
            <tr><th>Period</th>${histHeaders}</tr>
          </thead>
          <tbody>
            ${histBody || '<tr><td colspan="4" class="empty-note">No monthly snapshots yet.</td></tr>'}
            ${
              historyRows.length
                ? `<tr><td><strong>Total</strong></td>${totalCells}</tr>
                   <tr><td><strong>Average</strong></td>${avgCells}</tr>`
                : ''
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  $('spend-month-picker')?.addEventListener('change', (e) => {
    if (e.target.value) {
      state.selectedMonth = e.target.value;
      renderAll();
    }
  });
  $('panel-spend').querySelectorAll('[data-pick-month]').forEach((b) =>
    b.addEventListener('click', () => {
      state.selectedMonth = b.dataset.pickMonth;
      renderAll();
    })
  );
  $('panel-spend').querySelectorAll('[data-select-pot]').forEach((b) =>
    b.addEventListener('click', () => {
      state.selectedLogPot = b.dataset.selectPot;
      renderSpend(m, activeMonth);
    })
  );
  $('inline-spend-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amt = Number($('inline-spend-amt').value);
    const spendDate = $('inline-spend-date').value || todayISO();
    const note = $('inline-spend-note').value.trim();
    const potName = state.selectedLogPot || pots[0]?.name;
    if (!potName || Number.isNaN(amt)) return;
    const potObj = pots.find((p) => p.name === potName);
    const monthKey = spendDate.slice(0, 7);
    state.selectedMonth = monthKey;
    await runMutation(
      {
        table: 'spend_logs',
        action: 'insert',
        payload: {
          household_id: state.household.id,
          budget_item_id: potObj?.id || null,
          pot_name: potName,
          month_key: monthKey,
          spend_date: spendDate,
          amount: amt,
          paid_by: 'joint',
          note,
        },
      },
      `Logged ${fmtMoney(amt)} to ${potName}`
    );
  });

  $('panel-spend').querySelectorAll('[data-edit-log]').forEach((row) =>
    row.addEventListener('click', () => {
      const log = state.spendLogs.find((l) => l.id === row.dataset.editLog);
      if (log) openSpendModal(log);
    })
  );

  $('save-snapshot-btn')?.addEventListener('click', async () => {
    const potTotals = {};
    m.potTrackers.forEach((p) => {
      potTotals[p.name] = Number(p.actual.toFixed(2));
    });
    await runMutation(
      {
        table: 'monthly_snapshots',
        action: 'upsert',
        payload: {
          household_id: state.household.id,
          month_key: activeMonth,
          label: fmtMonthLabel(activeMonth),
          pot_totals: potTotals,
          summary_json: {
            total_income: m.totalHouseholdIncome,
            total_expenditure: m.totalHouseholdExpenditure,
            household_reste: m.totalHouseholdDisposable,
          },
        },
      },
      `Saved ${fmtMonthLabel(activeMonth)} snapshot`
    );
  });
}

function renderPersonal(m) {
  const h = state.household;
  const pAName = h.partner_a_name || 'Partner A';
  const pBName = h.partner_b_name || 'Partner B';
  const scope = state.personalScope;
  const isA = scope === 'partner_a';
  const partnerName = isA ? pAName : pBName;
  const p = isA ? m.partnerA : m.partnerB;

  const renderSection = (title, sub, sectionKey, items, showActual = false) => {
    const subtotal = items.reduce((s, i) => s + Number(i.amount || 0), 0);
    const actualSum = items.reduce((s, i) => s + Number(i.actual_amount || 0), 0);
    return `
    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">${esc(title)}</div>
          <div class="sec-sub">${esc(sub)}</div>
        </div>
        <button class="btn btn-primary btn-sm" data-add-section="${scope}|${sectionKey}" type="button">+ Add</button>
      </div>
      <div class="item-list">
        ${
          items.length
            ? items
                .map((item) => {
                  const amt = Number(item.amount || 0);
                  const isCredit = amt < 0;
                  return `
                  <div class="item-row" data-edit-item="${item.id}">
                    <div class="item-chk ${item.is_paid ? 'on' : ''}" data-toggle-paid="${item.id}" title="Toggle done">✓</div>
                    <div class="item-main">
                      <div class="item-name">
                        <span>${esc(item.name)}</span>
                        <span class="badge">${esc(item.category)}</span>
                        ${item.is_paid ? '<span class="badge emerald">Finished</span>' : ''}
                      </div>
                      ${
                        showActual
                          ? `<div class="item-sub">Expected ${fmtMoney(amt)} · Actual ${fmtMoney(item.actual_amount || 0)}</div>`
                          : item.notes
                          ? `<div class="item-sub">${esc(item.notes)}</div>`
                          : ''
                      }
                    </div>
                    <div class="item-right">
                      <div class="item-amt ${isCredit ? 'credit' : ''}">${fmtMoney(amt)}</div>
                    </div>
                  </div>`;
                })
                .join('')
            : '<div class="empty-note">Nothing added yet.</div>'
        }
      </div>
      <div class="sec-total-bar">
        <span>Subtotal${showActual ? ` (Actual ${fmtMoney(actualSum)})` : ''}</span>
        <span class="num">${fmtMoney(subtotal)}</span>
      </div>
    </div>`;
  };

  $('panel-personal').innerHTML = `
    <div class="seg-tabs">
      <button class="seg-tab ${isA ? 'on' : ''}" data-switch-personal="partner_a" type="button">
        ${esc(pAName)} · <span class="num">${fmtMoney(m.partnerA.disposable)}</span>
      </button>
      <button class="seg-tab ${!isA ? 'on' : ''}" data-switch-personal="partner_b" type="button">
        ${esc(pBName)} · <span class="num">${fmtMoney(m.partnerB.disposable)}</span>
      </button>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">${esc(partnerName)}'s Monthly Reste</div>
          <div class="sec-sub">Personal disposable after joint transfer &amp; personal items</div>
        </div>
        <button class="btn btn-sm" id="personal-edit-transfers-btn" type="button">Edit Transfer</button>
      </div>
      <div style="font-size:28px;font-weight:700;margin:4px 0 10px;" class="num">${fmtMoney(p.disposable)}</div>
      <div class="kv-grid">
        <div class="kv-box">
          <div class="kv-lbl">${esc(partnerName)}'s Income</div>
          <div class="kv-val">${fmtMoney(p.income)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Total Expenses</div>
          <div class="kv-val">${fmtMoney(p.totalExpenditure)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Account Transfer</div>
          <div class="kv-val">${fmtMoney(p.transfer)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Bills Share</div>
          <div class="kv-val">${fmtMoney(p.billsShare)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Extra</div>
          <div class="kv-val">${fmtMoney(p.jointExtra)}</div>
        </div>
        <div class="kv-box">
          <div class="kv-lbl">Joint Optional</div>
          <div class="kv-val">${fmtMoney(p.jointOptional)}</div>
        </div>
      </div>
    </div>

    ${renderSection('Debt Repayment', 'Personal credit cards & loans', 'debt', p.debts, true)}
    ${renderSection('Personal Bills', 'Direct debits, phone & subscriptions', 'personal_bill', p.bills, false)}
    ${renderSection('Savings & Investments', 'Monthly transfers & pots', 'savings', p.savings, false)}
    ${renderSection('Personal Budgeted Items', 'One-off items, reimbursements (use -amount for credits)', 'personal_budgeted', p.budgeted, true)}
  `;

  $('panel-personal').querySelectorAll('[data-switch-personal]').forEach((b) =>
    b.addEventListener('click', () => {
      state.personalScope = b.dataset.switchPersonal;
      renderPersonal(m);
    })
  );
  $('personal-edit-transfers-btn')?.addEventListener('click', () => openSplitTransfersModal(m));
  bindItemActions('panel-personal');
}

function renderHouseholdTab(m) {
  const h = state.household;
  const myMem = state.members.find((mem) => mem.user_id === state.user?.id);

  const membersHtml = state.members
    .map((mem) => {
      const prof = mem.profiles || {};
      const slotName = mem.partner_slot === 'b' ? h.partner_b_name : h.partner_a_name;
      const isMe = mem.user_id === state.user?.id;
      return `
      <div class="item-row" style="cursor:default;">
        <div class="item-main">
          <div class="item-name">
            <span>${esc(prof.display_name || prof.username || 'Member')}</span>
            ${isMe ? '<span class="badge emerald">You</span>' : ''}
            <span class="badge gold">${esc(slotName)}</span>
          </div>
          <div class="item-sub">@${esc(prof.username || 'member')} · ${esc(mem.role)}</div>
        </div>
      </div>`;
    })
    .join('');

  $('panel-household').innerHTML = `
    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Share Code</div>
          <div class="sec-sub">Share this code with your partner so you both edit the exact same live budget</div>
        </div>
      </div>
      <div class="code-box">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#a9c7be;">Household Invite Code</div>
        <div class="code-value" id="hh-invite-code">${esc(h.invite_code)}</div>
        <div style="font-size:11.5px;color:#cde0da;">${h.joins_locked ? 'Joins locked · Existing members stay synced' : 'Permanent cloud storage · Real-time sync active'}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" style="flex:1;" id="copy-code-btn" type="button">Copy Code</button>
        <button class="btn" style="flex:1;" id="share-code-btn" type="button">Share Invite</button>
        <button class="btn btn-sm" id="regen-code-btn" type="button">New Code</button>
      </div>
      <button class="btn btn-full btn-sm ${h.joins_locked ? 'btn-gold' : ''}" id="toggle-lock-joins-btn" type="button" style="margin-top:8px;">
        ${h.joins_locked ? '🔒 Joins Locked (tap to allow new member)' : '🔓 Joins Open (tap to lock new member joins)'}
      </button>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Household &amp; Partners</div>
          <div class="sec-sub">Connected accounts (${state.members.length})</div>
        </div>
        <button class="btn btn-sm" id="edit-hh-settings-btn" type="button">Edit Settings</button>
      </div>
      <div class="item-list">${membersHtml}</div>
      ${
        myMem
          ? `<div style="margin-top:12px;display:flex;gap:8px;align-items:center;justify-content:space-between;">
              <span style="font-size:12.5px;color:var(--ink2);">Your default personal view:</span>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm ${myMem.partner_slot === 'a' ? 'btn-primary' : ''}" data-set-slot="a" type="button">${esc(h.partner_a_name)}</button>
                <button class="btn btn-sm ${myMem.partner_slot === 'b' ? 'btn-primary' : ''}" data-set-slot="b" type="button">${esc(h.partner_b_name)}</button>
              </div>
            </div>`
          : ''
      }
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Install Reste on Phone</div>
          <div class="sec-sub">Shows the Reste name &amp; emerald-gold logo on iOS &amp; Android</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--ink2);line-height:1.55;">
        <p style="margin-bottom:8px;"><strong>iPhone / iPad (Safari):</strong> Tap the <strong>Share</strong> icon, scroll down, and tap <strong>Add to Home Screen</strong>. It will install as <strong>Reste</strong>.</p>
        <p><strong>Android (Chrome):</strong> Tap the <strong>⋮ Menu</strong> (or the install prompt) and choose <strong>Add to Home screen / Install app</strong>.</p>
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Categories &amp; Backups</div>
          <div class="sec-sub">Future-proof custom categories &amp; full exports</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-full" id="manage-cats-btn" type="button">Manage Expense &amp; Income Categories</button>
        <div class="frow">
          <button class="btn" id="export-json-btn" type="button">Export JSON Backup</button>
          <button class="btn" id="export-csv-btn" type="button">Export CSV Sheet</button>
        </div>
        <button class="btn btn-full" id="import-json-btn" type="button">Import JSON Backup</button>
        <input type="file" id="import-json-file" accept=".json,application/json" class="hidden" />
      </div>
    </div>

    <div class="card">
      <div class="sec-hdr">
        <div>
          <div class="sec-title">Account &amp; Security</div>
          <div class="sec-sub">Signed in as @${esc(state.profile?.username || '')}</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <button class="btn btn-full" id="join-other-hh-btn" type="button">Join Another Household with Code</button>
        <button class="btn btn-full" id="change-pw-btn" type="button">Change Password</button>
        <button class="btn btn-danger btn-full" id="signout-btn" type="button">Sign Out</button>
      </div>
    </div>
  `;

  $('copy-code-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(h.invite_code);
      showToast(`Copied ${h.invite_code}`);
    } catch {
      showToast(`Code: ${h.invite_code}`);
    }
  });

  $('share-code-btn')?.addEventListener('click', async () => {
    const shareText = `Join our Reste household budget! Open Reste, create your account, and enter share code: ${h.invite_code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Reste Household Invite', text: shareText, url: window.location.href });
        return;
      } catch {
        // user cancelled or unavailable
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      showToast('Invite message copied');
    } catch {
      showToast(`Share code: ${h.invite_code}`);
    }
  });

  $('regen-code-btn')?.addEventListener('click', async () => {
    if (!confirm('Generate a new share code? The old code will stop working for new joins.')) return;
    const { data, error } = await sb.rpc('regenerate_invite_code_rpc', { p_household_id: h.id });
    if (error) return showToast(error.message);
    await fetchHouseholdData(h.id);
    renderAll();
    showToast(`New code: ${data}`);
  });

  $('panel-household').querySelectorAll('[data-set-slot]').forEach((b) =>
    b.addEventListener('click', async () => {
      const slot = b.dataset.setSlot;
      const { error } = await sb
        .from('household_members')
        .update({ partner_slot: slot })
        .eq('household_id', h.id)
        .eq('user_id', state.user.id);
      if (error) return showToast(error.message);
      state.personalScope = slot === 'b' ? 'partner_b' : 'partner_a';
      await fetchHouseholdData(h.id);
      renderAll();
      showToast('Partner slot updated');
    })
  );

  $('edit-hh-settings-btn')?.addEventListener('click', () => openHouseholdSettingsModal());
  $('toggle-lock-joins-btn')?.addEventListener('click', async () => {
    const nextLocked = !h.joins_locked;
    await runMutation(
      { table: 'households', action: 'update', id: h.id, payload: { joins_locked: nextLocked } },
      nextLocked ? 'New member joins locked' : 'New member joins unlocked'
    );
  });
  $('manage-cats-btn')?.addEventListener('click', () => openCategoriesModal());
  $('export-json-btn')?.addEventListener('click', () => exportJSON(m));
  $('export-csv-btn')?.addEventListener('click', () => exportCSV(m));
  $('import-json-btn')?.addEventListener('click', () => $('import-json-file')?.click());
  $('import-json-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await importJSONBackup(file);
    } catch (err) {
      showToast(err?.message || 'Could not import backup');
    }
  });
  $('join-other-hh-btn')?.addEventListener('click', () => openJoinOtherModal());
  $('change-pw-btn')?.addEventListener('click', () => openChangePasswordModal());
  $('signout-btn')?.addEventListener('click', async () => {
    teardownRealtime();
    await sb.auth.signOut();
    state._personalPickedOnce = false;
    state.selectedMonth = null;
    await loadProfileAndHousehold();
  });
}

// ─── ITEM ACTIONS & MODALS ────────────────────────────────────────────────────
function bindItemActions(containerId) {
  const root = $(containerId);
  if (!root) return;

  root.querySelectorAll('[data-add-section]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [scope, section] = btn.dataset.addSection.split('|');
      openItemModal({ scope, section });
    })
  );

  root.querySelectorAll('[data-toggle-paid]').forEach((chk) =>
    chk.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = chk.dataset.togglePaid;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;
      const nextPaid = !item.is_paid;
      await runMutation(
        { table: 'budget_items', action: 'update', id, payload: { is_paid: nextPaid } },
        `${item.name} marked ${nextPaid ? 'paid' : 'unpaid'}`
      );
    })
  );

  root.querySelectorAll('[data-edit-item]').forEach((row) =>
    row.addEventListener('click', () => {
      const item = state.items.find((i) => i.id === row.dataset.editItem);
      if (item) openItemModal(item);
    })
  );
}

function openItemModal(itemOrTemplate) {
  const isNew = !itemOrTemplate.id;
  const scope = itemOrTemplate.scope || 'joint';
  const section = itemOrTemplate.section || 'regular_expense';
  const h = state.household;
  const pA = h.partner_a_name || 'Partner A';
  const pB = h.partner_b_name || 'Partner B';
  const isIncome = section === 'income';
  const isPrep = section === 'prepayment';
  const hasActual = ['debt', 'personal_budgeted', 'regular_expense'].includes(section);
  const cats = isIncome ? getIncomeCategories() : getExpenseCategories();

  const titles = {
    income: 'Income Item',
    regular_expense: 'Regular Joint Bill',
    budgeted_expense: 'Budgeted Expense Pot',
    prepayment: 'Prepayment Expense',
    debt: 'Debt Repayment',
    personal_bill: 'Personal Bill',
    savings: 'Savings & Investment',
    personal_budgeted: 'Personal Budgeted Item',
  };

  openModal(`${isNew ? 'Add' : 'Edit'} ${titles[section] || 'Item'}`, (body) => {
    const curCat = itemOrTemplate.category || (isIncome ? 'Main Income' : cats[0] || 'Others/Irregular');
    const allCats = cats.includes(curCat) ? cats : [curCat, ...cats];

    body.innerHTML = `
      <form id="item-modal-form">
        <div class="fg">
          <label class="fl" for="im-name">Name</label>
          <input class="fi" id="im-name" type="text" value="${esc(itemOrTemplate.name || '')}" required placeholder="e.g. Mortgage, Groceries, Phone" />
        </div>
        <div class="fg">
          <label class="fl" for="im-cat">Category</label>
          <select class="fi" id="im-cat">
            ${allCats.map((c) => `<option value="${esc(c)}" ${c === curCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
        ${
          isIncome
            ? `<div class="fg">
                <label class="fl" for="im-amt">Joint Amount (${esc(h.currency)})</label>
                <input class="fi num" id="im-amt" type="number" step="0.01" value="${Number(itemOrTemplate.amount || 0)}" />
              </div>
              <div class="frow">
                <div class="fg">
                  <label class="fl" for="im-pa">${esc(pA)} Amount</label>
                  <input class="fi num" id="im-pa" type="number" step="0.01" value="${Number(itemOrTemplate.partner_a_amount || 0)}" />
                </div>
                <div class="fg">
                  <label class="fl" for="im-pb">${esc(pB)} Amount</label>
                  <input class="fi num" id="im-pb" type="number" step="0.01" value="${Number(itemOrTemplate.partner_b_amount || 0)}" />
                </div>
              </div>`
            : isPrep
            ? `<div class="frow">
                <div class="fg">
                  <label class="fl" for="im-raw">Bill Cost (${esc(h.currency)})</label>
                  <input class="fi num" id="im-raw" type="number" step="0.01" value="${Number(itemOrTemplate.raw_cost ?? itemOrTemplate.amount ?? 0)}" required />
                </div>
                <div class="fg">
                  <label class="fl" for="im-freq">Payment Period</label>
                  <select class="fi" id="im-freq">
                    ${FREQUENCY_OPTIONS.map(
                      (f) => `<option value="${f.value}" ${(itemOrTemplate.frequency || 'quarterly') === f.value ? 'selected' : ''}>${f.label}</option>`
                    ).join('')}
                  </select>
                </div>
              </div>
              <div class="sec-sub" id="im-prep-preview" style="margin-bottom:12px;"></div>`
            : `<div class="frow">
                <div class="fg">
                  <label class="fl" for="im-amt">Amount (${esc(h.currency)})</label>
                  <input class="fi num" id="im-amt" type="number" step="0.01" value="${Number(itemOrTemplate.amount || 0)}" required />
                </div>
                ${
                  hasActual
                    ? `<div class="fg">
                        <label class="fl" for="im-actual">Actual Paid (optional)</label>
                        <input class="fi num" id="im-actual" type="number" step="0.01" value="${itemOrTemplate.actual_amount ?? ''}" placeholder="0.00" />
                      </div>`
                    : `<div class="fg">
                        <label class="fl" for="im-paidby">Paid By (optional)</label>
                        <input class="fi" id="im-paidby" type="text" value="${esc(itemOrTemplate.paid_by || '')}" placeholder="e.g. Joint" />
                      </div>`
                }
              </div>`
        }
        ${
          scope === 'joint' && !isIncome
            ? `<div class="fg">
                <label class="fl" for="im-split">Custom ${esc(pA)} Split % (leave blank for household default)</label>
                <input class="fi num" id="im-split" type="number" min="0" max="100" step="0.1" value="${
                  itemOrTemplate.custom_split_a !== null && itemOrTemplate.custom_split_a !== undefined
                    ? (Number(itemOrTemplate.custom_split_a) * 100).toFixed(1)
                    : ''
                }" placeholder="Default" />
              </div>`
            : ''
        }
        <div class="fg">
          <label class="fl" for="im-notes">Notes (optional)</label>
          <input class="fi" id="im-notes" type="text" value="${esc(itemOrTemplate.notes || '')}" placeholder="Reference or due date" />
        </div>
        ${
          !isIncome
            ? `<div class="fg">
                <label class="toggle-row">
                  <span style="font-size:13.5px;font-weight:500;">Marked as Paid / Finished</span>
                  <input id="im-paid" type="checkbox" ${itemOrTemplate.is_paid ? 'checked' : ''} />
                </label>
              </div>`
            : ''
        }
        <div class="sheet-actions">
          ${!isNew ? '<button class="btn btn-danger" id="im-delete-btn" type="button" style="margin-right:auto;">Delete</button>' : ''}
          <button class="btn" id="im-cancel-btn" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">${isNew ? 'Add Item' : 'Save Changes'}</button>
        </div>
      </form>
    `;

    const updatePrepPreview = () => {
      const prev = $('im-prep-preview');
      if (!prev) return;
      const monthly = computeMonthlyAmount($('im-raw').value, $('im-freq').value);
      prev.textContent = `Monthly equivalent: ${fmtMoney(monthly)} / month`;
    };
    if (isPrep) {
      updatePrepPreview();
      $('im-raw').addEventListener('input', updatePrepPreview);
      $('im-freq').addEventListener('change', updatePrepPreview);
    }

    $('im-cancel-btn').addEventListener('click', closeModal);
    $('im-delete-btn')?.addEventListener('click', async () => {
      if (!confirm(`Delete "${itemOrTemplate.name}"?`)) return;
      closeModal();
      await runMutation(
        { table: 'budget_items', action: 'delete', id: itemOrTemplate.id },
        `Deleted ${itemOrTemplate.name}`
      );
    });

    $('item-modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('im-name').value.trim();
      if (!name) return;
      const category = $('im-cat').value;
      const notes = $('im-notes').value.trim();
      const isPaid = $('im-paid') ? $('im-paid').checked : false;
      const customSplitRaw = $('im-split')?.value?.trim();
      const custom_split_a =
        customSplitRaw !== undefined && customSplitRaw !== '' ? Math.min(1, Math.max(0, Number(customSplitRaw) / 100)) : null;

      let payload = {
        household_id: h.id,
        scope,
        section,
        name,
        category,
        notes,
        is_paid: isPaid,
        custom_split_a,
      };

      if (isIncome) {
        payload.amount = Number($('im-amt').value || 0);
        payload.partner_a_amount = Number($('im-pa').value || 0);
        payload.partner_b_amount = Number($('im-pb').value || 0);
      } else if (isPrep) {
        const raw = Number($('im-raw').value || 0);
        const freq = $('im-freq').value;
        payload.raw_cost = raw;
        payload.frequency = freq;
        payload.amount = Number(computeMonthlyAmount(raw, freq).toFixed(2));
      } else {
        payload.amount = Number($('im-amt').value || 0);
        if ($('im-actual')) {
          const act = $('im-actual').value.trim();
          payload.actual_amount = act === '' ? null : Number(act);
        }
        if ($('im-paidby')) {
          payload.paid_by = $('im-paidby').value.trim();
        }
      }

      closeModal();
      if (isNew) {
        payload.sort_order = state.items.filter((i) => i.scope === scope && i.section === section).length + 1;
        await runMutation({ table: 'budget_items', action: 'insert', payload }, `Added ${name}`);
      } else {
        await runMutation({ table: 'budget_items', action: 'update', id: itemOrTemplate.id, payload }, `Updated ${name}`);
      }
    });
  });
}

function openSpendModal(existingLog = null, presetPot = null) {
  const pots = state.items.filter((i) => i.scope === 'joint' && i.section === 'budgeted_expense');
  if (!pots.length && !existingLog) {
    showToast('Create a budgeted pot in Joint first');
    return;
  }
  const isNew = !existingLog;
  const activePot = existingLog?.pot_name || presetPot || state.selectedLogPot || pots[0]?.name || '';

  openModal(isNew ? 'Log Spend' : 'Edit Receipt', (body) => {
    body.innerHTML = `
      <form id="spend-modal-form">
        <div class="fg">
          <label class="fl" for="sm-pot">Budgeted Pot</label>
          <select class="fi" id="sm-pot">
            ${pots.map((p) => `<option value="${esc(p.name)}" ${p.name === activePot ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="sm-amt">Amount (${esc(state.household.currency)})</label>
            <input class="fi num" id="sm-amt" type="number" step="0.01" value="${existingLog ? Number(existingLog.amount) : ''}" placeholder="0.00" required />
          </div>
          <div class="fg">
            <label class="fl" for="sm-date">Date</label>
            <input class="fi" id="sm-date" type="date" value="${existingLog?.spend_date || todayISO()}" required />
          </div>
        </div>
        <div class="fg">
          <label class="fl" for="sm-note">Note (optional)</label>
          <input class="fi" id="sm-note" type="text" value="${esc(existingLog?.note || '')}" placeholder="e.g. Tesco, Shell" />
        </div>
        <div class="sheet-actions">
          ${!isNew ? '<button class="btn btn-danger" id="sm-del" type="button" style="margin-right:auto;">Delete</button>' : ''}
          <button class="btn" id="sm-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">${isNew ? 'Save Spend' : 'Update'}</button>
        </div>
      </form>
    `;

    $('sm-cancel').addEventListener('click', closeModal);
    $('sm-del')?.addEventListener('click', async () => {
      if (!confirm('Delete this spend entry?')) return;
      closeModal();
      await runMutation(
        { table: 'spend_logs', action: 'delete', id: existingLog.id },
        `Removed ${fmtMoney(existingLog.amount)} from ${existingLog.pot_name}`
      );
    });

    $('spend-modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const potName = $('sm-pot').value;
      const amt = Number($('sm-amt').value);
      const spendDate = $('sm-date').value || todayISO();
      const note = $('sm-note').value.trim();
      const potObj = pots.find((p) => p.name === potName);
      const monthKey = spendDate.slice(0, 7);
      state.selectedMonth = monthKey;
      state.selectedLogPot = potName;
      closeModal();

      const payload = {
        household_id: state.household.id,
        budget_item_id: potObj?.id || null,
        pot_name: potName,
        month_key: monthKey,
        spend_date: spendDate,
        amount: amt,
        paid_by: 'joint',
        note,
      };
      if (isNew) {
        await runMutation({ table: 'spend_logs', action: 'insert', payload }, `Logged ${fmtMoney(amt)} to ${potName}`);
      } else {
        await runMutation({ table: 'spend_logs', action: 'update', id: existingLog.id, payload }, `Updated ${potName} receipt`);
      }
    });
  });
}

function openSplitTransfersModal(m) {
  const h = state.household;
  const pA = h.partner_a_name || 'Partner A';
  const pB = h.partner_b_name || 'Partner B';

  openModal('Cost Split & Joint Transfers', (body) => {
    body.innerHTML = `
      <form id="split-modal-form">
        <div class="fg">
          <label class="fl" for="sp-mode">Split Method</label>
          <select class="fi" id="sp-mode">
            <option value="custom" ${h.split_mode === 'custom' ? 'selected' : ''}>Custom Percentage (${fmtPct(h.partner_a_split)} / ${fmtPct(1 - h.partner_a_split)})</option>
            <option value="suggested" ${h.split_mode === 'suggested' ? 'selected' : ''}>Suggested by Income (${fmtPct(m.split.suggestedA)} / ${fmtPct(m.split.suggestedB)})</option>
            <option value="equal" ${h.split_mode === 'equal' ? 'selected' : ''}>50 / 50 Equal Split</option>
          </select>
        </div>
        <div class="fg" id="sp-custom-wrap">
          <label class="fl" for="sp-pct-a">${esc(pA)}'s Split Percentage (%)</label>
          <input class="fi num" id="sp-pct-a" type="number" min="0" max="100" step="0.5" value="${(Number(h.partner_a_split || 0.5) * 100).toFixed(1)}" />
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="sp-tr-a">${esc(pA)} Joint Transfer</label>
            <input class="fi num" id="sp-tr-a" type="number" step="0.01" value="${Number(h.partner_a_joint_transfer || 0)}" />
          </div>
          <div class="fg">
            <label class="fl" for="sp-tr-b">${esc(pB)} Joint Transfer</label>
            <input class="fi num" id="sp-tr-b" type="number" step="0.01" value="${Number(h.partner_b_joint_transfer || 0)}" />
          </div>
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="sp-opt-a">${esc(pA)} Joint Optional</label>
            <input class="fi num" id="sp-opt-a" type="number" step="0.01" value="${Number(h.partner_a_joint_optional || 0)}" />
          </div>
          <div class="fg">
            <label class="fl" for="sp-opt-b">${esc(pB)} Joint Optional</label>
            <input class="fi num" id="sp-opt-b" type="number" step="0.01" value="${Number(h.partner_b_joint_optional || 0)}" />
          </div>
        </div>
        <div class="sheet-actions">
          <button class="btn" id="sp-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Save Split</button>
        </div>
      </form>
    `;

    const toggleCustom = () => {
      $('sp-custom-wrap').classList.toggle('hidden', $('sp-mode').value !== 'custom');
    };
    toggleCustom();
    $('sp-mode').addEventListener('change', toggleCustom);
    $('sp-cancel').addEventListener('click', closeModal);

    $('split-modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = $('sp-mode').value;
      const pctA = Math.min(1, Math.max(0, Number($('sp-pct-a').value || 50) / 100));
      closeModal();
      await runMutation(
        {
          table: 'households',
          action: 'update',
          id: h.id,
          payload: {
            split_mode: mode,
            partner_a_split: pctA,
            partner_a_joint_transfer: Number($('sp-tr-a').value || 0),
            partner_b_joint_transfer: Number($('sp-tr-b').value || 0),
            partner_a_joint_optional: Number($('sp-opt-a').value || 0),
            partner_b_joint_optional: Number($('sp-opt-b').value || 0),
          },
        },
        'Updated cost split & transfers'
      );
    });
  });
}

function openHouseholdSettingsModal() {
  const h = state.household;
  openModal('Household Settings', (body) => {
    body.innerHTML = `
      <form id="hh-settings-form">
        <div class="fg">
          <label class="fl" for="hs-name">Household Name</label>
          <input class="fi" id="hs-name" type="text" value="${esc(h.name)}" required />
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="hs-pa">Partner 1 Name</label>
            <input class="fi" id="hs-pa" type="text" value="${esc(h.partner_a_name)}" required />
          </div>
          <div class="fg">
            <label class="fl" for="hs-pb">Partner 2 Name</label>
            <input class="fi" id="hs-pb" type="text" value="${esc(h.partner_b_name)}" required />
          </div>
        </div>
        <div class="frow">
          <div class="fg">
            <label class="fl" for="hs-cur">Currency Symbol</label>
            <input class="fi" id="hs-cur" type="text" maxlength="4" value="${esc(h.currency || '£')}" required />
          </div>
          <div class="fg">
            <label class="fl" for="hs-month">Default Active Month</label>
            <input class="fi" id="hs-month" type="month" value="${esc(h.active_month || currentYearMonth())}" />
          </div>
        </div>
        <div class="sheet-actions">
          <button class="btn" id="hs-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Save Settings</button>
        </div>
      </form>
    `;
    $('hs-cancel').addEventListener('click', closeModal);
    $('hh-settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nextMonth = $('hs-month').value || h.active_month;
      state.selectedMonth = nextMonth;
      closeModal();
      await runMutation(
        {
          table: 'households',
          action: 'update',
          id: h.id,
          payload: {
            name: $('hs-name').value.trim() || h.name,
            partner_a_name: $('hs-pa').value.trim() || 'Partner A',
            partner_b_name: $('hs-pb').value.trim() || 'Partner B',
            currency: $('hs-cur').value.trim() || '£',
            active_month: nextMonth,
          },
        },
        'Household settings updated'
      );
    });
  });
}

function openCategoriesModal() {
  let expCats = [...getExpenseCategories()];
  let incCats = [...getIncomeCategories()];

  const renderBody = (body) => {
    body.innerHTML = `
      <div class="fg">
        <div class="fl">Expense Categories (${expCats.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${expCats
            .map(
              (c, idx) =>
                `<span class="badge" style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;">${esc(c)} <button type="button" data-rm-exp="${idx}" style="border:none;background:none;cursor:pointer;font-weight:700;color:var(--red);">×</button></span>`
            )
            .join('')}
        </div>
        <div style="display:flex;gap:6px;">
          <input class="fi" id="new-exp-cat" type="text" placeholder="Add expense category…" />
          <button class="btn btn-primary btn-sm" id="add-exp-cat-btn" type="button">Add</button>
        </div>
      </div>
      <div class="fg">
        <div class="fl">Income Categories (${incCats.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          ${incCats
            .map(
              (c, idx) =>
                `<span class="badge emerald" style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;">${esc(c)} <button type="button" data-rm-inc="${idx}" style="border:none;background:none;cursor:pointer;font-weight:700;color:var(--red);">×</button></span>`
            )
            .join('')}
        </div>
        <div style="display:flex;gap:6px;">
          <input class="fi" id="new-inc-cat" type="text" placeholder="Add income category…" />
          <button class="btn btn-primary btn-sm" id="add-inc-cat-btn" type="button">Add</button>
        </div>
      </div>
      <div class="sheet-actions">
        <button class="btn" id="cat-close" type="button">Close</button>
        <button class="btn btn-primary" id="cat-save" type="button">Save Categories</button>
      </div>
    `;

    body.querySelectorAll('[data-rm-exp]').forEach((b) =>
      b.addEventListener('click', () => {
        expCats.splice(Number(b.dataset.rmExp), 1);
        renderBody(body);
      })
    );
    body.querySelectorAll('[data-rm-inc]').forEach((b) =>
      b.addEventListener('click', () => {
        incCats.splice(Number(b.dataset.rmInc), 1);
        renderBody(body);
      })
    );
    $('add-exp-cat-btn').addEventListener('click', () => {
      const val = $('new-exp-cat').value.trim();
      if (val && !expCats.includes(val)) {
        expCats.push(val);
        expCats.sort();
        renderBody(body);
      }
    });
    $('add-inc-cat-btn').addEventListener('click', () => {
      const val = $('new-inc-cat').value.trim();
      if (val && !incCats.includes(val)) {
        incCats.push(val);
        incCats.sort();
        renderBody(body);
      }
    });
    $('cat-close').addEventListener('click', closeModal);
    $('cat-save').addEventListener('click', async () => {
      closeModal();
      await runMutation(
        {
          table: 'households',
          action: 'update',
          id: state.household.id,
          payload: { expense_categories: expCats, income_categories: incCats },
        },
        'Categories updated'
      );
    });
  };

  openModal('Manage Categories', renderBody);
}

function openJoinOtherModal() {
  openModal('Join Household with Code', (body) => {
    body.innerHTML = `
      <form id="join-other-form">
        <div class="fg">
          <label class="fl" for="jo-code">Household Share Code</label>
          <input class="fi mono" id="jo-code" type="text" maxlength="16" style="text-transform:uppercase;letter-spacing:0.18em;font-weight:700;" required />
        </div>
        <div class="sheet-actions">
          <button class="btn" id="jo-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Join Household</button>
        </div>
      </form>
    `;
    $('jo-cancel').addEventListener('click', closeModal);
    $('join-other-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('jo-code').value.trim();
      const { data, error } = await sb.rpc('join_household_rpc', { p_invite_code: code });
      if (error) return showToast(error.message);
      closeModal();
      state.selectedMonth = data.active_month || currentYearMonth();
      state._personalPickedOnce = false;
      await loadProfileAndHousehold();
      showToast(`Joined ${data.name}`);
    });
  });
}

function openChangePasswordModal() {
  openModal('Change Password', (body) => {
    body.innerHTML = `
      <form id="cpw-form">
        <div class="fg">
          <label class="fl" for="cpw-cur">Current Password</label>
          <input class="fi" id="cpw-cur" type="password" required />
        </div>
        <div class="fg">
          <label class="fl" for="cpw-new">New Password</label>
          <input class="fi" id="cpw-new" type="password" minlength="6" required />
        </div>
        <div class="sheet-actions">
          <button class="btn" id="cpw-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" type="submit">Update Password</button>
        </div>
      </form>
    `;
    $('cpw-cancel').addEventListener('click', closeModal);
    $('cpw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const curr = $('cpw-cur').value;
      const next = $('cpw-new').value;
      const { error: reauthErr } = await sb.auth.signInWithPassword({
        email: state.user.email,
        password: curr,
      });
      if (reauthErr) return showToast('Current password is incorrect');
      const { error } = await sb.auth.updateUser({ password: next });
      if (error) return showToast(error.message);
      closeModal();
      showToast('Password updated');
    });
  });
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportJSON(model) {
  const payload = {
    exported_at: new Date().toISOString(),
    household: state.household,
    items: state.items,
    spend_logs: state.spendLogs,
    snapshots: state.snapshots,
    summary: {
      total_income: model.totalHouseholdIncome,
      total_expenditure: model.totalHouseholdExpenditure,
      household_reste: model.totalHouseholdDisposable,
      joint_reste: model.jointDisposable,
    },
  };
  downloadFile(`reste-${state.household.invite_code}.json`, JSON.stringify(payload, null, 2), 'application/json');
  showToast('JSON backup downloaded');
}

function exportCSV(model) {
  const rows = [['Scope', 'Section', 'Name', 'Category', 'Amount', 'Partner A', 'Partner B', 'Raw Cost', 'Frequency', 'Actual', 'Paid']];
  state.items.forEach((i) => {
    rows.push([
      i.scope,
      i.section,
      `"${String(i.name || '').replace(/"/g, '""')}"`,
      `"${String(i.category || '').replace(/"/g, '""')}"`,
      i.amount,
      i.partner_a_amount,
      i.partner_b_amount,
      i.raw_cost ?? '',
      i.frequency || 'monthly',
      i.actual_amount ?? '',
      i.is_paid ? 'Yes' : 'No',
    ]);
  });
  rows.push([]);
  rows.push(['Summary', 'Total Income', model.totalHouseholdIncome.toFixed(2)]);
  rows.push(['Summary', 'Total Expenses', (-model.totalHouseholdExpenditure).toFixed(2)]);
  rows.push(['Summary', 'Household Reste', model.totalHouseholdDisposable.toFixed(2)]);
  downloadFile(`reste-${state.household.invite_code}.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv');
  showToast('CSV exported');
}

// ─── EVENT WIRING & BOOTSTRAP ─────────────────────────────────────────────────
function bindGlobalEvents() {
  $('dark-toggle').addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    localStorage.setItem('reste_dark', state.darkMode ? '1' : '0');
    applyDarkMode();
  });

  $('quick-spend-top').addEventListener('click', () => openSpendModal());
  $('account-top-btn').addEventListener('click', () => setActiveTab('household'));

  document.querySelectorAll('.nav-item').forEach((btn) =>
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab))
  );

  $('modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('modal-overlay')) closeModal();
  });

  // Auth mode tabs
  const setAuthMode = (mode) => {
    state.authMode = mode;
    const isSignup = mode === 'signup';
    $('auth-tab-login').classList.toggle('on', !isSignup);
    $('auth-tab-signup').classList.toggle('on', isSignup);
    $('signup-name-group').classList.toggle('hidden', !isSignup);
    $('signup-confirm-group').classList.toggle('hidden', !isSignup);
    $('auth-submit-btn').textContent = isSignup ? 'Create account' : 'Sign in';
    $('auth-password').setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
    setBanner('auth-msg', '');
  };
  $('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  $('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('auth-msg', '');
    const btn = $('auth-submit-btn');
    const ident = $('auth-ident').value.trim();
    const password = $('auth-password').value;
    const email = toAuthEmail(ident);
    if (!email) return setBanner('auth-msg', 'Please enter a valid username or email.');

    btn.disabled = true;
    try {
      if (state.authMode === 'signup') {
        const confirmPw = $('auth-password-confirm').value;
        if (password !== confirmPw) {
          throw new Error('Passwords do not match.');
        }
        const displayName = $('auth-display-name').value.trim() || ident.split('@')[0];
        const username = ident.includes('@') ? ident.split('@')[0] : ident;
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: {
              username,
              display_name: displayName,
              contact_email: ident.includes('@') ? ident : '',
            },
          },
        });
        if (error) throw error;
        if (!data?.session) {
          const { error: signInErr } = await sb.auth.signInWithPassword({ email, password });
          if (signInErr) throw signInErr;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw new Error('Invalid username/email or password.');
      }
      await loadProfileAndHousehold();
    } catch (err) {
      setBanner('auth-msg', err?.message || 'Authentication failed.');
    } finally {
      btn.disabled = false;
    }
  });

  $('create-household-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('setup-msg', '');
    const btn = $('create-hh-btn');
    btn.disabled = true;
    try {
      const { data: hh, error } = await sb.rpc('create_household_rpc', {
        p_name: $('create-hh-name').value.trim() || 'Our Household',
        p_partner_a_name: $('create-pa-name').value.trim() || 'Partner 1',
        p_partner_b_name: $('create-pb-name').value.trim() || 'Partner 2',
        p_currency: '£',
        p_active_month: currentYearMonth(),
        p_expense_categories: DEFAULT_EXPENSE_CATEGORIES,
        p_income_categories: DEFAULT_INCOME_CATEGORIES,
      });
      if (error) throw error;

      state.selectedMonth = hh.active_month || currentYearMonth();
      await loadProfileAndHousehold();
      showToast(`Household ready! Share code: ${hh.invite_code}`);
    } catch (err) {
      setBanner('setup-msg', err?.message || 'Could not create household.');
    } finally {
      btn.disabled = false;
    }
  });

  $('join-household-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setBanner('setup-msg', '');
    const btn = $('join-hh-btn');
    btn.disabled = true;
    try {
      const code = $('join-code-input').value.trim();
      const { data: hh, error } = await sb.rpc('join_household_rpc', { p_invite_code: code });
      if (error) throw error;
      state.selectedMonth = hh.active_month || currentYearMonth();
      await loadProfileAndHousehold();
      showToast(`Joined ${hh.name}`);
    } catch (err) {
      setBanner('setup-msg', err?.message || 'Could not join household.');
    } finally {
      btn.disabled = false;
    }
  });

  $('setup-signout-btn').addEventListener('click', async () => {
    await sb.auth.signOut();
    await loadProfileAndHousehold();
  });

  window.addEventListener('online', () => {
    state.online = true;
    updateSyncBar();
    flushOfflineQueue();
    if (state.household) scheduleRefresh();
  });

  window.addEventListener('offline', () => {
    state.online = false;
    updateSyncBar();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.household && navigator.onLine) {
      scheduleRefresh();
    }
  });
}

applyDarkMode();
registerSW();
bindGlobalEvents();
loadProfileAndHousehold();
