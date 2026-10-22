'use strict';

/**
 * משימות שלי — renderer (UI).
 *
 * The renderer owns the in-memory document (state) and re-renders it after each
 * change. Every mutation calls markDirty(), which debounces a save to the main
 * process (~200 ms) so the data file on disk is always up to date.
 */

const bridge = window.api;

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const VIEW_DEFS = [
  { id: 'all', label: 'כל המשימות', icon: '▤' },
  { id: 'today', label: 'היום', icon: '☀' },
  { id: 'week', label: 'שבוע קרוב', icon: '▦' },
  { id: 'done', label: 'הושלמו', icon: '✓' },
];

const SORT_OPTIONS = [
  { id: 'manual', label: 'סידור: ידני' },
  { id: 'due', label: 'סידור: תאריך יעד' },
  { id: 'priority', label: 'סידור: עדיפות' },
  { id: 'created', label: 'סידור: חדש ביותר' },
  { id: 'alpha', label: 'סידור: אלף־בית' },
];

const PRIORITIES = {
  high: { label: 'גבוהה', short: 'גבוהה' },
  normal: { label: 'רגילה', short: 'רגילה' },
  low: { label: 'נמוכה', short: 'נמוכה' },
};
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

const GROUP_COLORS = ['#7c9cff', '#3ddc97', '#ffb454', '#ff6b6b', '#c792ea', '#4dd0e1', '#f78fb3', '#a3e635'];

const SAVE_DEBOUNCE_MS = 200;
const STATUS_HEARTBEAT_MS = 30_000;

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let state = null;
let info = null;

const ui = {
  expanded: new Set(),
  search: '',
  quickGroupId: null,
  dirty: false,
  saveTimer: null,
  saveChain: Promise.resolve(),
  lastSavedAt: null,
  popup: null,
  confirmResolve: null,
  toastTimer: null,
};

let dragTaskId = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const uid = () => (window.crypto && crypto.randomUUID
  ? crypto.randomUUID()
  : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const pad2 = (n) => String(n).padStart(2, '0');

function localISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
function todayISO() {
  return localISO(new Date());
}
function isoAddDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localISO(d);
}
function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(fromISO, toISO) {
  return Math.round((isoToDate(toISO) - isoToDate(fromISO)) / 86_400_000);
}
function formatDate(iso) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
}
function formatTimestamp(ts) {
  const d = new Date(ts);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}
function formatClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function findTask(taskId) {
  return state.tasks.find((task) => task.id === taskId) || null;
}
function findGroup(groupId) {
  return state.groups.find((group) => group.id === groupId) || null;
}

function describeDue(due, isDone) {
  if (!due) return null;
  const today = todayISO();
  const diff = daysBetween(today, due);
  if (isDone) return { text: formatDate(due), cls: '' };
  if (diff === 0) return { text: 'היום', cls: 'today' };
  if (diff === 1) return { text: 'מחר', cls: '' };
  if (diff === -1) return { text: 'אתמול', cls: 'overdue' };
  if (diff < 0) return { text: `באיחור ${Math.abs(diff)} ימים`, cls: 'overdue' };
  if (diff <= 7) return { text: `בעוד ${diff} ימים`, cls: '' };
  return { text: formatDate(due), cls: '' };
}

function priorityLabel(priority) {
  return (PRIORITIES[priority] || PRIORITIES.normal).label;
}

/* ------------------------------------------------------------------ */
/* Selection / filtering                                               */
/* ------------------------------------------------------------------ */

function activeSelection() {
  const settings = state.settings;
  const selection = settings && settings.selection;
  if (selection && selection.kind === 'group' && findGroup(selection.id)) return selection;
  if (selection && selection.kind === 'view' && VIEW_DEFS.some((view) => view.id === selection.id)) return selection;
  return { kind: 'view', id: 'all' };
}

function setSelection(selection) {
  state.settings.selection = selection;
  if (selection.kind === 'group') {
    state.settings.lastGroupId = selection.id;
    ui.quickGroupId = selection.id;
  }
  markDirty();
  render();
  const list = $('#task-list');
  if (list) list.scrollTop = 0;
}

function tasksForSelection(selection = activeSelection()) {
  const today = todayISO();
  if (selection.kind === 'group') {
    return state.tasks.filter((task) => task.groupId === selection.id);
  }
  switch (selection.id) {
    case 'today':
      return state.tasks.filter((task) => !task.done && task.due && task.due <= today);
    case 'week': {
      const end = isoAddDays(7);
      return state.tasks.filter((task) => !task.done && task.due && task.due <= end);
    }
    case 'done':
      return state.tasks.filter((task) => task.done);
    default:
      return state.tasks.slice();
  }
}

function matchesSearch(task, query) {
  if (!query) return true;
  const haystack = `${task.title} ${task.notes} ${task.subtasks.map((st) => st.title).join(' ')}`.toLowerCase();
  return haystack.includes(query);
}

function sortComparator(sort) {
  const indexOf = new Map(state.tasks.map((task, index) => [task.id, index]));
  switch (sort) {
    case 'due':
      return (a, b) => {
        if (a.due && b.due) return a.due.localeCompare(b.due) || (indexOf.get(a.id) - indexOf.get(b.id));
        if (a.due) return -1;
        if (b.due) return 1;
        return indexOf.get(a.id) - indexOf.get(b.id);
      };
    case 'priority':
      return (a, b) => (PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]) || (indexOf.get(a.id) - indexOf.get(b.id));
    case 'created':
      return (a, b) => b.createdAt - a.createdAt;
    case 'alpha':
      return (a, b) => a.title.localeCompare(b.title, 'he');
    default:
      return (a, b) => indexOf.get(a.id) - indexOf.get(b.id);
  }
}

function visibleTasks() {
  const selection = activeSelection();
  let list = tasksForSelection(selection);
  const query = ui.search.trim().toLowerCase();
  if (query) list = list.filter((task) => matchesSearch(task, query));

  const compare = sortComparator(state.settings.sort);
  const open = list.filter((task) => !task.done);
  const done = list.filter((task) => task.done);
  open.sort(compare);
  done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  if (selection.kind === 'view' && selection.id === 'done') return done;
  if (selection.kind === 'view' && (selection.id === 'today' || selection.id === 'week')) return open;
  return open.concat(done);
}

function scopeCounts(selection = activeSelection()) {
  const today = todayISO();
  const list = tasksForSelection(selection);
  let open = 0;
  let done = 0;
  let overdue = 0;
  for (const task of list) {
    if (task.done) { done += 1; continue; }
    open += 1;
    if (task.due && task.due < today) overdue += 1;
  }
  return { open, done, overdue, total: list.length };
}

function viewBadges() {
  const today = todayISO();
  const weekEnd = isoAddDays(7);
  const badges = { all: 0, today: 0, week: 0, done: 0 };
  let overdue = 0;
  for (const task of state.tasks) {
    if (task.done) { badges.done += 1; continue; }
    badges.all += 1;
    if (task.due) {
      if (task.due <= today) badges.today += 1;
      if (task.due <= weekEnd) badges.week += 1;
      if (task.due < today) overdue += 1;
    }
  }
  return { badges, overdue };
}

/* ------------------------------------------------------------------ */
/* Save pipeline                                                       */
/* ------------------------------------------------------------------ */

function setSaveStatus(status) {
  const el = $('#save-status');
  if (!el) return;
  el.dataset.state = status;
  const text = el.querySelector('.save-text');
  const time = $('#save-time');
  if (!text) return;
  if (status === 'pending' || status === 'saving') {
    text.textContent = 'שומר…';
    if (time) time.textContent = '';
  } else if (status === 'error') {
    text.textContent = 'שמירה נכשלה';
    if (time) time.textContent = '';
  } else if (status === 'saved') {
    text.textContent = 'נשמר';
    if (time) time.textContent = ui.lastSavedAt ? formatClock(ui.lastSavedAt) : '';
  } else {
    text.textContent = 'שמירה אוטומטית';
    if (time) time.textContent = '';
  }
}

function markDirty() {
  if (!state) return;
  ui.dirty = true;
  setSaveStatus('pending');
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(() => { flushSave().catch(() => {}); }, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  if (!state || !ui.dirty) return Promise.resolve({ ok: true, skipped: true });
  clearTimeout(ui.saveTimer);
  ui.saveTimer = null;
  ui.dirty = false;
  setSaveStatus('saving');
  ui.saveChain = ui.saveChain
    .catch(() => {})
    .then(async () => {
      const payload = JSON.parse(JSON.stringify(state));
      const result = await bridge.save(payload);
      if (!result || !result.ok) throw new Error((result && result.error) || 'שמירה נכשלה');
      ui.lastSavedAt = result.savedAt || Date.now();
      setSaveStatus('saved');
      return result;
    })
    .catch((err) => {
      ui.dirty = true;
      setSaveStatus('error');
      toast(`שמירה נכשלה: ${(err && err.message) || err}`, { duration: 7000 });
      return { ok: false, error: String((err && err.message) || err) };
    });
  return ui.saveChain;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function captureFocus() {
  const active = document.activeElement;
  if (!active || !active.dataset || !active.dataset.fk) return null;
  let start = null;
  let end = null;
  try {
    if (typeof active.selectionStart === 'number') {
      start = active.selectionStart;
      end = active.selectionEnd;
    }
  } catch { /* inputs without selection support */ }
  return { key: active.dataset.fk, start, end };
}

function restoreFocus(focus) {
  if (!focus) return;
  let el;
  try {
    el = document.querySelector(`[data-fk="${CSS.escape(focus.key)}"]`);
  } catch {
    return;
  }
  if (!el) return;
  try {
    el.focus({ preventScroll: true });
    if (focus.start != null && typeof el.setSelectionRange === 'function') {
      el.setSelectionRange(focus.start, focus.end);
    } else if (typeof el.setSelectionRange === 'function') {
      const length = el.value ? el.value.length : 0;
      el.setSelectionRange(length, length);
    }
  } catch { /* ignore */ }
}

function render(options = {}) {
  if (!state) return;
  closePopup();
  const focus = options.focusKey ? { key: options.focusKey, start: null, end: null } : captureFocus();
  const scrollTop = $('#task-list') ? $('#task-list').scrollTop : 0;
  const selection = activeSelection();

  renderSidebar(selection);
  renderHeader(selection);
  renderQuickAdd(selection);
  renderSort();
  renderTaskList(selection);
  renderStats(selection);

  const list = $('#task-list');
  if (list) list.scrollTop = scrollTop;
  restoreFocus(focus);
}

function renderSidebar(selection) {
  const { badges, overdue } = viewBadges();
  const counts = { all: badges.all, today: badges.today, week: badges.week, done: badges.done };

  $('#views').innerHTML = VIEW_DEFS.map((view) => {
    const active = selection.kind === 'view' && selection.id === view.id;
    const count = counts[view.id] || 0;
    const hot = view.id === 'today' && overdue > 0;
    return `
      <button class="view-item${active ? ' active' : ''}" data-select="view:${view.id}" type="button">
        <span class="vi-icon">${view.icon}</span>
        <span class="vi-label">${view.label}</span>
        <span class="vi-count${hot ? ' hot' : ''}">${count}</span>
      </button>`;
  }).join('');

  $('#group-list').innerHTML = state.groups.map((group) => {
    const active = selection.kind === 'group' && selection.id === group.id;
    const openCount = state.tasks.filter((task) => task.groupId === group.id && !task.done).length;
    return `
      <li class="group-row${active ? ' active' : ''}" data-select="group:${esc(group.id)}" data-group-id="${esc(group.id)}">
        <span class="g-dot" style="--c:${esc(group.color)}"></span>
        <span class="g-name">${esc(group.name)}</span>
        <span class="g-count">${openCount}</span>
        <button class="icon-btn g-menu" data-act="group-menu" data-id="${esc(group.id)}" type="button"
                title="אפשרויות קבוצה" aria-label="אפשרויות קבוצה">⋯</button>
      </li>`;
  }).join('');

  const pathEl = $('#save-path');
  if (pathEl && info && info.dataPath) {
    pathEl.textContent = info.dataPath;
    pathEl.title = info.dataPath;
  }
}

function renderHeader(selection) {
  const titleEl = $('#view-title');
  const subEl = $('#view-sub');
  if (selection.kind === 'group') {
    const group = findGroup(selection.id);
    titleEl.innerHTML = group
      ? `<span class="title-dot" style="--c:${esc(group.color)}"></span>${esc(group.name)}`
      : 'קבוצה';
  } else {
    const view = VIEW_DEFS.find((v) => v.id === selection.id) || VIEW_DEFS[0];
    titleEl.textContent = view.label;
  }

  const counts = scopeCounts(selection);
  const parts = [];
  const query = ui.search.trim();
  if (query) {
    const found = visibleTasks().length;
    parts.push(`נמצאו ${found} תוצאות עבור “${esc(query)}”`);
  } else {
    parts.push(`${counts.open} פתוחות`);
    if (counts.done) parts.push(`${counts.done} הושלמו`);
    if (selection.kind === 'view' && selection.id === 'today' && counts.total === 0) parts.push('אין משימות שמחכות להיום');
  }
  if (counts.overdue > 0) parts.push(`<span class="overdue-note">${counts.overdue} באיחור</span>`);
  subEl.innerHTML = parts.join(' · ');
}

function renderQuickAdd(selection) {
  const groupSelect = $('#quick-add-group');
  if (!groupSelect) return;
  let selected = ui.quickGroupId;
  if (!selected || !findGroup(selected)) {
    selected = selection.kind === 'group' ? selection.id : state.settings.lastGroupId;
  }
  if (!selected || !findGroup(selected)) selected = state.groups[0] ? state.groups[0].id : '';
  ui.quickGroupId = selected || null;
  groupSelect.innerHTML = state.groups.map((group) => (
    `<option value="${esc(group.id)}">${esc(group.name)}</option>`
  )).join('');
  if (selected) groupSelect.value = selected;
}

function renderSort() {
  const sortSelect = $('#sort');
  if (!sortSelect) return;
  sortSelect.innerHTML = SORT_OPTIONS.map((option) => (
    `<option value="${option.id}">${option.label}</option>`
  )).join('');
  sortSelect.value = state.settings.sort;
}

function renderTaskList(selection) {
  const list = visibleTasks();
  const container = $('#task-list');
  const empty = $('#empty-state');

  if (list.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = emptyStateHtml(selection);
    return;
  }

  container.classList.remove('hidden');
  empty.classList.add('hidden');
  container.innerHTML = list.map((task) => taskHtml(task, selection)).join('');
}

function emptyStateHtml(selection) {
  const query = ui.search.trim();
  if (query) {
    return `
      <div class="empty-icon">⌕</div>
      <div class="empty-title">לא נמצאו משימות</div>
      <div class="empty-sub">אין תוצאות עבור “${esc(query)}”. נסה מילה אחרת או נקה את החיפוש.</div>`;
  }
  if (selection.kind === 'view' && selection.id === 'today') {
    return `
      <div class="empty-icon">☀</div>
      <div class="empty-title">אין משימות להיום</div>
      <div class="empty-sub">הוסף משימה עם תאריך יעד להיום — היא תופיע כאן אוטומטית.</div>`;
  }
  if (selection.kind === 'view' && selection.id === 'week') {
    return `
      <div class="empty-icon">▦</div>
      <div class="empty-title">השבוע פנוי</div>
      <div class="empty-sub">אין משימות עם תאריך יעד בשבעת הימים הקרובים.</div>`;
  }
  if (selection.kind === 'view' && selection.id === 'done') {
    return `
      <div class="empty-icon">✓</div>
      <div class="empty-title">עוד לא הושלמו משימות</div>
      <div class="empty-sub">משימות שתסמן כבוצעו יופיעו כאן.</div>`;
  }
  if (selection.kind === 'group') {
    return `
      <div class="empty-icon">◇</div>
      <div class="empty-title">הקבוצה ריקה</div>
      <div class="empty-sub">הוסף משימה בתיבה שלמעלה, או גרור לכאן משימה מקבוצה אחרת.</div>`;
  }
  return `
    <div class="empty-icon">✦</div>
    <div class="empty-title">מתחילים מסדר</div>
    <div class="empty-sub">הוסף את המשימה הראשונה שלך בתיבה שלמעלה. אפשר לחלק אותה לתתי־משימות ולקבוצות.</div>`;
}

function taskHtml(task, selection) {
  const isDone = !!task.done;
  const isOpen = ui.expanded.has(task.id);
  const group = findGroup(task.groupId);
  const subtasks = task.subtasks || [];
  const subtasksDone = subtasks.filter((subtask) => subtask.done).length;
  const progress = subtasks.length ? Math.round((subtasksDone / subtasks.length) * 100) : 0;
  const due = describeDue(task.due, isDone);
  const showGroupChip = selection.kind !== 'group' && group;

  const chips = [];
  if (due) chips.push(`<span class="chip due ${due.cls}">${esc(due.text)}</span>`);
  if (task.priority && task.priority !== 'normal') {
    chips.push(`<span class="chip prio ${esc(task.priority)}">${esc(priorityLabel(task.priority))}</span>`);
  }
  if (task.notes.trim()) chips.push('<span class="chip notes-chip" title="יש הערות למשימה">✎</span>');
  if (showGroupChip) {
    chips.push(`<span class="chip group-chip" style="--c:${esc(group.color)}">${esc(group.name)}</span>`);
  }

  const meta = subtasks.length
    ? `<div class="task-meta">
         <span class="sub-progress" title="${subtasksDone} מתוך ${subtasks.length} תתי־משימות"><span style="width:${progress}%"></span></span>
         <span class="sub-count">${subtasksDone}/${subtasks.length} תתי־משימות</span>
       </div>`
    : '';

  return `
    <article class="task${isDone ? ' is-done' : ''}${isOpen ? ' open' : ''}"
             data-task-id="${esc(task.id)}" draggable="${isOpen ? 'false' : 'true'}">
      <div class="task-row" data-act="toggle-expand">
        <button class="check${isDone ? ' on' : ''}" data-act="toggle-task" type="button"
                title="${isDone ? 'סימון כלא בוצע' : 'סימון כבוצע'}" aria-label="${isDone ? 'סימון כלא בוצע' : 'סימון כבוצע'}"></button>
        <div class="task-body">
          <div class="task-title-line">
            <span class="task-title" data-act="edit-title" title="לחיצה לפתיחת הפרטים">${esc(task.title)}</span>
            ${chips.join('')}
          </div>
          ${meta}
        </div>
        <div class="task-actions">
          <button class="icon-btn chevron" data-act="toggle-expand" type="button"
                  title="${isOpen ? 'סגירת פרטים' : 'פתיחת פרטים'}" aria-label="${isOpen ? 'סגירת פרטים' : 'פתיחת פרטים'}">▾</button>
          <button class="icon-btn" data-act="task-menu" type="button"
                  title="פעולות נוספות" aria-label="פעולות נוספות">⋯</button>
        </div>
      </div>
      ${isOpen ? taskDetailsHtml(task) : ''}
    </article>`;
}

function taskDetailsHtml(task) {
  const groupOptions = state.groups.map((group) => (
    `<option value="${esc(group.id)}"${group.id === task.groupId ? ' selected' : ''}>${esc(group.name)}</option>`
  )).join('');

  const subtasksHtml = task.subtasks.map((subtask) => `
    <div class="subtask${subtask.done ? ' done' : ''}" data-subtask-id="${esc(subtask.id)}">
      <button class="check small${subtask.done ? ' on' : ''}" data-act="toggle-subtask" type="button"
              title="${subtask.done ? 'סימון כלא בוצע' : 'סימון כבוצע'}" aria-label="${subtask.done ? 'סימון כלא בוצע' : 'סימון כבוצע'}"></button>
      <span class="subtask-title" data-act="edit-subtask" title="לחיצה כפולה לעריכה">${esc(subtask.title)}</span>
      <button class="icon-btn" data-act="delete-subtask" type="button" title="מחיקת תת־משימה" aria-label="מחיקת תת־משימה">✕</button>
    </div>`).join('');

  return `
    <div class="task-details">
      <input class="title-input" data-role="title" data-fk="title-${esc(task.id)}"
             value="${esc(task.title)}" placeholder="כותרת המשימה" maxlength="500" aria-label="כותרת המשימה">

      <div class="detail-section">
        <div class="detail-label">תתי־משימות
          ${task.subtasks.length ? `<span class="muted">${task.subtasks.filter((s) => s.done).length}/${task.subtasks.length}</span>` : ''}
        </div>
        <div class="subtask-list">
          ${subtasksHtml}
          <div class="subtask-add-row">
            <span class="plus">+</span>
            <input class="subtask-add" data-role="subtask-add" data-fk="subadd-${esc(task.id)}"
                   placeholder="הוספת תת־משימה…" maxlength="500" aria-label="הוספת תת־משימה">
          </div>
        </div>
      </div>

      <div class="detail-controls">
        <label class="field">
          <span>עדיפות</span>
          <select class="select" data-role="priority">
            <option value="high"${task.priority === 'high' ? ' selected' : ''}>גבוהה</option>
            <option value="normal"${task.priority === 'normal' ? ' selected' : ''}>רגילה</option>
            <option value="low"${task.priority === 'low' ? ' selected' : ''}>נמוכה</option>
          </select>
        </label>
        <label class="field">
          <span>תאריך יעד</span>
          <input class="date-input" type="date" data-role="due" value="${esc(task.due || '')}">
        </label>
        <label class="field">
          <span>קבוצה</span>
          <select class="select" data-role="group">${groupOptions}</select>
        </label>
        <button class="btn danger-ghost" data-act="delete-task" type="button">מחיקת משימה</button>
      </div>

      <div>
        <div class="detail-label">הערות</div>
        <textarea class="notes" data-role="notes" data-fk="notes-${esc(task.id)}"
                  placeholder="הערות חופשיות…" maxlength="20000">${esc(task.notes)}</textarea>
      </div>

      <div class="detail-meta">
        <span>נוצר ${formatTimestamp(task.createdAt)}${task.done ? ' · הושלם' : ''}</span>
        <span>שמירה אוטומטית</span>
      </div>
    </div>`;
}

function renderStats(selection) {
  const visible = visibleTasks();
  const doneVisible = visible.filter((task) => task.done).length;
  const openVisible = visible.length - doneVisible;
  const total = state.tasks.length;
  const doneTotal = state.tasks.filter((task) => task.done).length;
  const pct = total ? Math.round((doneTotal / total) * 100) : 0;
  const counts = scopeCounts(selection);

  const parts = [];
  parts.push(`<span class="stat"><b>${openVisible}</b> פתוחות בתצוגה</span>`);
  parts.push(`<span class="stat"><b>${doneVisible}</b> הושלמו בתצוגה</span>`);
  if (counts.overdue) parts.push(`<span class="stat overdue"><b>${counts.overdue}</b> באיחור</span>`);
  parts.push('<span class="spacer"></span>');
  parts.push(`<span class="stat"><b>${doneTotal}</b> מתוך <b>${total}</b> הושלמו</span>`);
  parts.push(`<span class="stats-progress"><span style="width:${pct}%"></span></span>`);
  parts.push(`<span class="stat stats-pct">${pct}%</span>`);
  $('#stats').innerHTML = parts.join('');
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme() {
  const theme = state.settings.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  const button = $('#theme-toggle');
  if (button) {
    button.textContent = theme === 'dark' ? '☀' : '☾';
    button.title = theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה';
  }
  try { bridge.setTheme(theme); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

function pickDefaultGroup() {
  const selection = activeSelection();
  if (selection.kind === 'group' && findGroup(selection.id)) return selection.id;
  if (ui.quickGroupId && findGroup(ui.quickGroupId)) return ui.quickGroupId;
  if (state.settings.lastGroupId && findGroup(state.settings.lastGroupId)) return state.settings.lastGroupId;
  return state.groups[0] ? state.groups[0].id : null;
}

function addTask({ title, groupId, due }) {
  const clean = String(title || '').trim();
  if (!clean) return null;
  const resolvedGroup = groupId && findGroup(groupId) ? groupId : pickDefaultGroup();
  if (!resolvedGroup) {
    toast('צריך ליצור קבוצה לפני שמוסיפים משימה');
    return null;
  }
  const timestamp = Date.now();
  const task = {
    id: uid(),
    groupId: resolvedGroup,
    title: clean.slice(0, 500),
    notes: '',
    done: false,
    doneAt: null,
    priority: 'normal',
    due: due || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    subtasks: [],
  };
  state.tasks.unshift(task);
  state.settings.lastGroupId = resolvedGroup;
  ui.quickGroupId = resolvedGroup;
  markDirty();
  render();
  return task;
}

function toggleTask(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  task.done = !task.done;
  task.doneAt = task.done ? Date.now() : null;
  task.updatedAt = Date.now();
  if (task.done) {
    task.subtasks.forEach((subtask) => { subtask.done = true; });
  }
  markDirty();
  render();
}

function toggleSubtask(taskId, subtaskId) {
  const task = findTask(taskId);
  if (!task) return;
  const subtask = task.subtasks.find((item) => item.id === subtaskId);
  if (!subtask) return;
  subtask.done = !subtask.done;
  task.updatedAt = Date.now();

  const allDone = task.subtasks.length > 0 && task.subtasks.every((item) => item.done);
  if (allDone && !task.done) {
    task.done = true;
    task.doneAt = Date.now();
    toast('כל תתי־המשימות הושלמו — המשימה סומנה כבוצעה');
  } else if (!allDone && task.done) {
    task.done = false;
    task.doneAt = null;
  }
  markDirty();
  render();
}

function addSubtask(taskId, title) {
  const task = findTask(taskId);
  const clean = String(title || '').trim();
  if (!task || !clean) return;
  task.subtasks.push({ id: uid(), title: clean.slice(0, 500), done: false, createdAt: Date.now() });
  task.updatedAt = Date.now();
  markDirty();
  render({ focusKey: `subadd-${taskId}` });
}

function deleteSubtask(taskId, subtaskId) {
  const task = findTask(taskId);
  if (!task) return;
  const index = task.subtasks.findIndex((item) => item.id === subtaskId);
  if (index < 0) return;
  const [removed] = task.subtasks.splice(index, 1);
  task.updatedAt = Date.now();
  markDirty();
  render();
  toast('תת־המשימה נמחקה', {
    actionLabel: 'ביטול',
    duration: 6000,
    onAction: () => {
      task.subtasks.splice(Math.min(index, task.subtasks.length), 0, removed);
      markDirty();
      render();
      toast('תת־המשימה שוחזרה');
    },
  });
}

async function deleteTask(taskId) {
  const task = findTask(taskId);
  if (!task) return;
  const confirmed = await askConfirm({
    title: 'מחיקת משימה',
    body: `למחוק את “${task.title}”${task.subtasks.length ? ` ואת ${task.subtasks.length} תתי־המשימות שלה` : ''}?`,
    confirmText: 'מחיקה',
  });
  if (!confirmed) return;
  const index = state.tasks.findIndex((item) => item.id === taskId);
  if (index < 0) return;
  const [removed] = state.tasks.splice(index, 1);
  ui.expanded.delete(taskId);
  markDirty();
  render();
  toast('המשימה נמחקה', {
    actionLabel: 'ביטול',
    duration: 7000,
    onAction: () => {
      state.tasks.splice(Math.min(index, state.tasks.length), 0, removed);
      markDirty();
      render();
      toast('המשימה שוחזרה');
    },
  });
}

function duplicateTask(taskId) {
  const index = state.tasks.findIndex((item) => item.id === taskId);
  if (index < 0) return;
  const source = state.tasks[index];
  const timestamp = Date.now();
  const copy = {
    ...JSON.parse(JSON.stringify(source)),
    id: uid(),
    title: `${source.title} (עותק)`.slice(0, 500),
    done: false,
    doneAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    subtasks: source.subtasks.map((subtask) => ({
      id: uid(), title: subtask.title, done: subtask.done, createdAt: timestamp,
    })),
  };
  state.tasks.splice(index, 0, copy);
  markDirty();
  render();
  toast('המשימה שוכפלה');
}

function createGroup(name) {
  const clean = String(name || '').trim();
  if (!clean) return false;
  if (state.groups.some((group) => group.name === clean)) {
    toast(`קבוצה בשם “${clean}” כבר קיימת`);
    return false;
  }
  const group = {
    id: uid(),
    name: clean.slice(0, 120),
    color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length],
    collapsed: false,
    createdAt: Date.now(),
  };
  state.groups.push(group);
  state.settings.selection = { kind: 'group', id: group.id };
  state.settings.lastGroupId = group.id;
  ui.quickGroupId = group.id;
  markDirty();
  render();
  return true;
}

async function deleteGroup(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  if (state.groups.length === 1) {
    toast('אי אפשר למחוק את הקבוצה היחידה — אפשר לשנות את שמה');
    return;
  }
  const groupTasks = state.tasks.filter((task) => task.groupId === groupId);
  const confirmed = await askConfirm({
    title: 'מחיקת קבוצה',
    body: groupTasks.length
      ? `הקבוצה “${group.name}” מכילה ${groupTasks.length} משימות. מחיקת הקבוצה תמחק גם אותן.`
      : `למחוק את הקבוצה “${group.name}”?`,
    confirmText: 'מחיקה',
  });
  if (!confirmed) return;

  const snapshot = {
    group: JSON.parse(JSON.stringify(group)),
    tasks: JSON.parse(JSON.stringify(groupTasks)),
    index: state.groups.indexOf(group),
  };
  state.groups = state.groups.filter((item) => item.id !== groupId);
  state.tasks = state.tasks.filter((task) => task.groupId !== groupId);
  if (state.settings.selection.kind === 'group' && state.settings.selection.id === groupId) {
    state.settings.selection = { kind: 'view', id: 'all' };
  }
  if (state.settings.lastGroupId === groupId) state.settings.lastGroupId = state.groups[0].id;
  if (ui.quickGroupId === groupId) ui.quickGroupId = state.groups[0].id;
  markDirty();
  render();
  toast(`הקבוצה “${snapshot.group.name}” נמחקה`, {
    actionLabel: 'ביטול',
    duration: 7000,
    onAction: () => {
      state.groups.splice(Math.min(snapshot.index, state.groups.length), 0, snapshot.group);
      state.tasks.push(...snapshot.tasks);
      state.settings.selection = { kind: 'group', id: snapshot.group.id };
      markDirty();
      render();
      toast('הקבוצה שוחזרה');
    },
  });
}

function setGroupColor(groupId, color) {
  const group = findGroup(groupId);
  if (!group) return;
  group.color = color;
  markDirty();
  render();
}

function reorderTasks(sourceId, targetId, after) {
  const sourceIndex = state.tasks.findIndex((task) => task.id === sourceId);
  if (sourceIndex < 0) return;
  const [source] = state.tasks.splice(sourceIndex, 1);
  let targetIndex = state.tasks.findIndex((task) => task.id === targetId);
  if (targetIndex < 0) {
    state.tasks.splice(sourceIndex, 0, source);
    return;
  }
  if (after) targetIndex += 1;
  state.tasks.splice(targetIndex, 0, source);
  if (state.settings.sort !== 'manual') state.settings.sort = 'manual';
  markDirty();
  render();
}

function moveTaskToGroup(taskId, groupId) {
  const task = findTask(taskId);
  const group = findGroup(groupId);
  if (!task || !group || task.groupId === groupId) return;
  task.groupId = groupId;
  task.updatedAt = Date.now();
  markDirty();
  render();
  toast(`המשימה הועברה לקבוצה “${group.name}”`);
}

/* ------------------------------------------------------------------ */
/* Inline editing helpers                                              */
/* ------------------------------------------------------------------ */

function inlineEdit(element, currentValue, commit) {
  if (!element) return;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = currentValue;
  input.maxLength = 500;
  element.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (save && next && next !== currentValue) {
      commit(next);
    } else {
      render();
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function startSubtaskRename(taskId, subtaskId) {
  const task = findTask(taskId);
  if (!task) return;
  const subtask = task.subtasks.find((item) => item.id === subtaskId);
  if (!subtask) return;
  const row = document.querySelector(`[data-subtask-id="${CSS.escape(subtaskId)}"]`);
  const titleEl = row && row.querySelector('.subtask-title');
  if (!titleEl) return;
  inlineEdit(titleEl, subtask.title, (next) => {
    subtask.title = next;
    task.updatedAt = Date.now();
    markDirty();
    render();
  });
}

function startGroupRename(groupId) {
  const group = findGroup(groupId);
  if (!group) return;
  const row = document.querySelector(`.group-row[data-group-id="${CSS.escape(groupId)}"]`);
  const nameEl = row && row.querySelector('.g-name');
  if (!nameEl) return;
  inlineEdit(nameEl, group.name, (next) => {
    group.name = next;
    markDirty();
    render();
  });
}

/* ------------------------------------------------------------------ */
/* Popup menu                                                          */
/* ------------------------------------------------------------------ */

function closePopup() {
  if (ui.popup) {
    ui.popup.remove();
    ui.popup = null;
  }
}

function openPopup(anchor, items) {
  closePopup();
  const popup = document.createElement('div');
  popup.className = 'popup';

  for (const item of items) {
    if (item.type === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'popup-sep';
      popup.appendChild(sep);
      continue;
    }
    if (item.type === 'label') {
      const label = document.createElement('div');
      label.className = 'popup-label';
      label.textContent = item.label;
      popup.appendChild(label);
      continue;
    }
    if (item.type === 'colors') {
      const wrap = document.createElement('div');
      wrap.className = 'popup-colors';
      for (const color of item.colors) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = `swatch${color === item.selected ? ' selected' : ''}`;
        swatch.style.setProperty('--c', color);
        swatch.title = 'בחירת צבע';
        swatch.addEventListener('click', () => {
          closePopup();
          item.onPick(color);
        });
        wrap.appendChild(swatch);
      }
      popup.appendChild(wrap);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `popup-item${item.danger ? ' danger' : ''}`;
    button.innerHTML = `<span class="pi-icon">${item.icon || ''}</span><span>${esc(item.label)}</span>`;
    button.addEventListener('click', () => {
      closePopup();
      if (typeof item.run === 'function') item.run();
    });
    popup.appendChild(button);
  }

  document.body.appendChild(popup);

  const rect = anchor.getBoundingClientRect();
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  ui.popup = popup;
}

function openTaskMenu(task, anchor) {
  openPopup(anchor, [
    {
      key: 'toggle',
      label: task.done ? 'סימון כלא בוצע' : 'סימון כבוצע',
      icon: task.done ? '↺' : '✓',
      run: () => toggleTask(task.id),
    },
    {
      key: 'subtask',
      label: 'הוספת תת־משימה',
      icon: '＋',
      run: () => { ui.expanded.add(task.id); render({ focusKey: `subadd-${task.id}` }); },
    },
    { key: 'duplicate', label: 'שכפול משימה', icon: '⧉', run: () => duplicateTask(task.id) },
    { key: 'rename', label: 'עריכת כותרת', icon: '✎', run: () => { ui.expanded.add(task.id); render({ focusKey: `title-${task.id}` }); } },
    { type: 'sep' },
    { key: 'delete', label: 'מחיקת משימה', icon: '✕', danger: true, run: () => deleteTask(task.id) },
  ]);
}

function openGroupMenu(group, anchor) {
  openPopup(anchor, [
    { key: 'rename', label: 'שינוי שם', icon: '✎', run: () => startGroupRename(group.id) },
    { type: 'sep' },
    { type: 'label', label: 'צבע הקבוצה' },
    { type: 'colors', colors: GROUP_COLORS, selected: group.color, onPick: (color) => setGroupColor(group.id, color) },
    { type: 'sep' },
    { key: 'delete', label: 'מחיקת קבוצה', icon: '✕', danger: true, run: () => deleteGroup(group.id) },
  ]);
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

function askConfirm({ title, body, confirmText = 'אישור', cancelText = 'ביטול' }) {
  return new Promise((resolve) => {
    ui.confirmResolve = resolve;
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent = body;
    $('#confirm-ok').textContent = confirmText;
    $('#confirm-cancel').textContent = cancelText;
    const dialog = $('#confirm-dialog');
    if (!dialog.open) dialog.showModal();
  });
}

function settleConfirm(result) {
  const resolve = ui.confirmResolve;
  ui.confirmResolve = null;
  const dialog = $('#confirm-dialog');
  if (dialog.open) dialog.close();
  if (resolve) resolve(result);
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

function hideToast() {
  const el = $('#toast');
  if (el) el.classList.remove('show');
  clearTimeout(ui.toastTimer);
}

function toast(message, options = {}) {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(ui.toastTimer);
  el.innerHTML = '';

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = message;
  el.appendChild(text);

  if (options.actionLabel) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      hideToast();
      if (typeof options.onAction === 'function') options.onAction();
    });
    el.appendChild(action);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'סגירה');
  close.addEventListener('click', hideToast);
  el.appendChild(close);

  el.classList.add('show');
  const duration = options.duration || (options.actionLabel ? 7000 : 3400);
  ui.toastTimer = setTimeout(hideToast, duration);
}

/* ------------------------------------------------------------------ */
/* Sidebar / new group / import-export                                 */
/* ------------------------------------------------------------------ */

function showNewGroupForm() {
  const form = $('#new-group-form');
  form.classList.remove('hidden');
  const input = $('#new-group-input');
  input.value = '';
  input.focus();
}

function hideNewGroupForm() {
  $('#new-group-form').classList.add('hidden');
  $('#new-group-input').value = '';
}

async function exportData() {
  try {
    const result = await bridge.exportData(JSON.parse(JSON.stringify(state)));
    if (!result || result.canceled) return;
    if (!result.ok) {
      toast(`הייצוא נכשל: ${result.error}`);
      return;
    }
    toast(`הקובץ יוצא בהצלחה: ${result.path}`, { duration: 6000 });
  } catch (err) {
    toast(`הייצוא נכשל: ${(err && err.message) || err}`);
  }
}

async function importData() {
  try {
    const result = await bridge.importData();
    if (!result || result.canceled) return;
    if (!result.ok) {
      toast(`הייבוא נכשל: ${result.error}`);
      return;
    }
    state = result.data;
    ui.expanded.clear();
    ui.search = '';
    const search = $('#search');
    if (search) search.value = '';
    ui.quickGroupId = null;
    applyTheme();
    markDirty();
    render();
    toast('הנתונים יובאו בהצלחה');
  } catch (err) {
    toast(`הייבוא נכשל: ${(err && err.message) || err}`);
  }
}

function openDataFolder() {
  toast('הנתונים נשמרים בדפדפן הזה בלבד (localStorage) — לא בשרת. לגיבוי, השתמש ב״ייצוא״ כדי להוריד קובץ JSON.', { duration: 7000 });
}

/* ------------------------------------------------------------------ */
/* Drag & drop                                                         */
/* ------------------------------------------------------------------ */

function clearDropHints() {
  $$('.task.drop-before, .task.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  $$('.group-row.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

function cleanupDrag() {
  dragTaskId = null;
  clearDropHints();
  $$('.task.dragging').forEach((el) => el.classList.remove('dragging'));
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                      */
/* ------------------------------------------------------------------ */

function handleClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (ui.popup && !ui.popup.contains(target)
      && !target.closest('[data-act="task-menu"]')
      && !target.closest('[data-act="group-menu"]')) {
    closePopup();
  }

  const actionEl = target.closest('[data-act]');
  if (!actionEl) {
    // No action: a sidebar row selects a view/group.
    const selectable = target.closest('[data-select]');
    if (selectable) {
      const raw = selectable.dataset.select || '';
      const separator = raw.indexOf(':');
      const kind = raw.slice(0, separator);
      const id = raw.slice(separator + 1);
      if (kind === 'view' || kind === 'group') setSelection({ kind, id });
    }
    return;
  }
  const action = actionEl.dataset.act;
  const taskEl = actionEl.closest('.task');
  const taskId = taskEl ? taskEl.dataset.taskId : null;
  const task = taskId ? findTask(taskId) : null;

  switch (action) {
    case 'toggle-task':
      if (task) toggleTask(task.id);
      break;
    case 'toggle-expand': {
      if (!task) break;
      if (ui.expanded.has(task.id)) ui.expanded.delete(task.id);
      else ui.expanded.add(task.id);
      render();
      break;
    }
    case 'edit-title':
      if (task) {
        ui.expanded.add(task.id);
        render({ focusKey: `title-${task.id}` });
      }
      break;
    case 'task-menu':
      if (task) openTaskMenu(task, actionEl);
      break;
    case 'delete-task':
      if (task) deleteTask(task.id);
      break;
    case 'toggle-subtask': {
      const subtaskEl = actionEl.closest('.subtask');
      if (task && subtaskEl) toggleSubtask(task.id, subtaskEl.dataset.subtaskId);
      break;
    }
    case 'delete-subtask': {
      const subtaskEl = actionEl.closest('.subtask');
      if (task && subtaskEl) deleteSubtask(task.id, subtaskEl.dataset.subtaskId);
      break;
    }
    case 'edit-subtask':
      if (task) {
        const subtaskEl = actionEl.closest('.subtask');
        if (subtaskEl) startSubtaskRename(task.id, subtaskEl.dataset.subtaskId);
      }
      break;
    case 'group-menu': {
      const group = findGroup(actionEl.dataset.id);
      if (group) openGroupMenu(group, actionEl);
      break;
    }
    default:
      break;
  }
}

function handleDblClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const subtaskTitle = target.closest('.subtask-title');
  if (subtaskTitle) {
    const taskEl = subtaskTitle.closest('.task');
    const subtaskEl = subtaskTitle.closest('.subtask');
    if (taskEl && subtaskEl) startSubtaskRename(taskEl.dataset.taskId, subtaskEl.dataset.subtaskId);
    return;
  }

  const groupName = target.closest('.g-name');
  if (groupName) {
    const row = groupName.closest('.group-row');
    if (row) startGroupRename(row.dataset.groupId);
    return;
  }

  const taskTitle = target.closest('.task-title');
  if (taskTitle) {
    const taskEl = taskTitle.closest('.task');
    const task = taskEl && findTask(taskEl.dataset.taskId);
    if (task) {
      ui.expanded.add(task.id);
      render({ focusKey: `title-${task.id}` });
    }
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === 'search') {
    ui.search = target.value;
    render();
    return;
  }

  const role = target.dataset.role;
  if (!role) return;
  const taskEl = target.closest('.task');
  const task = taskEl ? findTask(taskEl.dataset.taskId) : null;
  if (!task) return;

  if (role === 'title') {
    task.title = target.value;
    task.updatedAt = Date.now();
    markDirty();
  } else if (role === 'notes') {
    task.notes = target.value;
    task.updatedAt = Date.now();
    markDirty();
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === 'sort') {
    state.settings.sort = target.value;
    markDirty();
    render();
    return;
  }
  if (target.id === 'quick-add-group') {
    ui.quickGroupId = target.value;
    state.settings.lastGroupId = target.value;
    markDirty();
    return;
  }

  const role = target.dataset.role;
  if (!role) return;
  const taskEl = target.closest('.task');
  const task = taskEl ? findTask(taskEl.dataset.taskId) : null;
  if (!task) return;

  if (role === 'priority') {
    task.priority = target.value;
    task.updatedAt = Date.now();
    markDirty();
    render();
  } else if (role === 'due') {
    task.due = target.value || null;
    task.updatedAt = Date.now();
    markDirty();
    render();
  } else if (role === 'group') {
    task.groupId = target.value;
    task.updatedAt = Date.now();
    markDirty();
    render();
  }
  // Title/notes edits are kept as-is in the DOM; derived UI refreshes on the
  // next render (e.g. collapsing the card) so typing never loses focus.
}

function handleKeyDown(event) {
  const target = event.target;
  const isEditing = target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  const modifier = event.ctrlKey || event.metaKey;

  if (modifier && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 'n' && event.shiftKey) {
      event.preventDefault();
      showNewGroupForm();
      return;
    }
    if (key === 'n') {
      event.preventDefault();
      const input = $('#quick-add-input');
      if (input) input.focus();
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      const search = $('#search');
      if (search) { search.focus(); search.select(); }
      return;
    }
    if (key === 's') {
      event.preventDefault();
      flushSave().then((result) => {
        if (result && result.ok && !result.skipped) toast('נשמר לדיסק');
      });
      return;
    }
  }

  if (event.key === 'Escape') {
    if (ui.popup) { closePopup(); return; }
    if (ui.confirmResolve) { settleConfirm(false); return; }
    if (!$('#new-group-form').classList.contains('hidden')) { hideNewGroupForm(); return; }
    const search = $('#search');
    if (document.activeElement === search && search.value) {
      search.value = '';
      ui.search = '';
      render();
      return;
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    if (target instanceof HTMLElement && target.dataset.role === 'subtask-add') {
      event.preventDefault();
      const taskEl = target.closest('.task');
      if (taskEl) {
        addSubtask(taskEl.dataset.taskId, target.value);
      }
      return;
    }
    if (target instanceof HTMLElement && target.dataset.role === 'title') {
      event.preventDefault();
      target.blur();
      return;
    }
    if (target instanceof HTMLElement && target.id === 'quick-add-input') {
      return; // handled by form submit
    }
  }

  if (event.key === 'Escape' && isEditing) target.blur();
}

function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (form.id === 'quick-add-form') {
    event.preventDefault();
    const input = $('#quick-add-input');
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    const selection = activeSelection();
    const dueInput = $('#quick-add-due');
    const due = dueInput.value || (selection.kind === 'view' && selection.id === 'today' ? todayISO() : null);
    addTask({ title, groupId: $('#quick-add-group').value, due });
    input.value = '';
    dueInput.value = '';
    input.focus();
    return;
  }

  if (form.id === 'new-group-form') {
    event.preventDefault();
    const input = $('#new-group-input');
    const created = createGroup(input.value);
    if (created) hideNewGroupForm();
    else input.focus();
  }
}

function handleDragStart(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const card = target.closest('.task');
  if (!card || card.getAttribute('draggable') === 'false') {
    event.preventDefault();
    return;
  }
  dragTaskId = card.dataset.taskId;
  card.classList.add('dragging');
  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragTaskId);
  } catch { /* ignore */ }
}

function handleDragOver(event) {
  if (!dragTaskId) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  const card = target.closest('.task');
  clearDropHints();

  if (card && card.dataset.taskId !== dragTaskId) {
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    const rect = card.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
    return;
  }

  const groupRow = target.closest('.group-row');
  if (groupRow) {
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
    groupRow.classList.add('drop-target');
  }
}

function handleDrop(event) {
  if (!dragTaskId) return;
  const target = event.target;
  if (!(target instanceof Element)) return;

  const card = target.closest('.task');
  if (card && card.dataset.taskId !== dragTaskId) {
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const sourceId = dragTaskId;
    cleanupDrag();
    reorderTasks(sourceId, card.dataset.taskId, after);
    return;
  }

  const groupRow = target.closest('.group-row');
  if (groupRow) {
    event.preventDefault();
    const sourceId = dragTaskId;
    cleanupDrag();
    moveTaskToGroup(sourceId, groupRow.dataset.groupId);
    return;
  }

  cleanupDrag();
}

/* ------------------------------------------------------------------ */
/* Static wiring                                                       */
/* ------------------------------------------------------------------ */

function bindStaticEvents() {
  document.addEventListener('click', handleClick);
  document.addEventListener('dblclick', handleDblClick);
  document.addEventListener('input', handleInput);
  document.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('dragstart', handleDragStart);
  document.addEventListener('dragover', handleDragOver);
  document.addEventListener('drop', handleDrop);
  document.addEventListener('dragend', cleanupDrag);
  document.addEventListener('dragleave', (event) => {
    if (!dragTaskId) return;
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !document.body.contains(related)) clearDropHints();
  });

  $('#theme-toggle').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    markDirty();
  });

  $('#add-task-btn').addEventListener('click', () => {
    const input = $('#quick-add-input');
    if (input) { input.focus(); input.select(); }
  });

  $('#add-group-btn').addEventListener('click', () => {
    const form = $('#new-group-form');
    if (form.classList.contains('hidden')) showNewGroupForm();
    else hideNewGroupForm();
  });

  $('#new-group-input').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideNewGroupForm();
    }
  });

  $('#export-btn').addEventListener('click', exportData);
  $('#import-btn').addEventListener('click', importData);
  $('#open-folder-btn').addEventListener('click', openDataFolder);

  $('#confirm-ok').addEventListener('click', (event) => {
    event.preventDefault();
    settleConfirm(true);
  });
  $('#confirm-cancel').addEventListener('click', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });
  $('#confirm-dialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    settleConfirm(false);
  });
  $('#confirm-dialog').addEventListener('close', () => {
    if (ui.confirmResolve) settleConfirm(false);
  });

  window.addEventListener('beforeunload', () => {
    if (ui.dirty && state) {
      try { bridge.saveSync(state); } catch { /* last chance failed */ }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && ui.dirty) flushSave().catch(() => {});
  });

  setInterval(() => {
    if (ui.dirty) flushSave().catch(() => {});
  }, STATUS_HEARTBEAT_MS);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function fatal(message) {
  window.__bootError = String(message);
  console.error('[boot]', message);
  document.body.innerHTML = `
    <div style="padding:48px;font-family:Segoe UI,Arial,sans-serif;color:#e9edf6;background:#0d0f13;height:100vh;direction:rtl">
      <h1 style="font-size:20px">לא ניתן לטעון את האפליקציה</h1>
      <p style="color:#aab3c6;line-height:1.6">${esc(message)}</p>
      <p style="color:#7b8699;font-size:12px">אפשר לסגור את החלון ולפתוח מחדש.</p>
    </div>`;
}

async function boot() {
  bindStaticEvents();

  let loaded;
  try {
    loaded = await bridge.load();
  } catch (err) {
    fatal(`שגיאה בטעינת הנתונים: ${(err && err.message) || err}`);
    return;
  }
  if (!loaded || !loaded.data) {
    fatal('לא התקבלו נתונים מהתהליך הראשי.');
    return;
  }

  state = loaded.data;
  info = {
    dataPath: loaded.dataPath,
    backupPath: loaded.backupPath,
    version: loaded.version,
    platform: loaded.platform,
  };

  const versionEl = $('#version');
  if (versionEl) versionEl.textContent = `v${loaded.version}`;
  const pathEl = $('#save-path');
  if (pathEl) {
    pathEl.textContent = loaded.dataPath;
    pathEl.title = `${loaded.dataPath}\nגיבוי אוטומטי: ${loaded.backupPath}`;
  }

  applyTheme();
  setSaveStatus('idle');
  ui.quickGroupId = activeSelection().kind === 'group'
    ? activeSelection().id
    : state.settings.lastGroupId;
  render();

  api.onSaved((payload) => {
    if (!payload) return;
    if (!ui.dirty) {
      ui.lastSavedAt = payload.at;
      setSaveStatus('saved');
    }
  });

  // Persist the initial document (first run) or the recovered document so the
  // data file on disk always reflects what the user sees.
  if (loaded.fresh || loaded.recovered) markDirty();

  try { bridge.ready(); } catch { /* ignore */ }

  if (loaded.recovered) {
    toast('הקבצה הראשית לא הייתה קריאה — הנתונים שוחזרו מהגיבוי האוטומטי.', { duration: 8000 });
  } else if (loaded.fresh) {
    setTimeout(() => {
      toast('ברוכים הבאים! ההוראות נמצאות במשימה הראשונה — אפשר למחוק אותה.', { duration: 7000 });
    }, 600);
  }

  const quickAdd = $('#quick-add-input');
  if (quickAdd) setTimeout(() => quickAdd.focus(), 120);
}

// Debug / automation hook (used by the automated smoke test).
window.__myTasks = {
  flushSave,
  getState: () => state,
  getInfo: () => info,
};

boot().catch((err) => {
  fatal(`שגיאה לא צפויה: ${(err && err.message) || err}`);
});
