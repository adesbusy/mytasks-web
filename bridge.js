'use strict';

/**
 * משימות שלי — Web storage adapter.
 *
 * The desktop app talks to the Electron main process over `window.api` (see
 * preload.js). The web build replaces that bridge with an in-browser adapter:
 * the document is persisted to localStorage, export/import become a file
 * download / file picker, and the desktop-only "open data folder" action is a
 * no-op. The renderer (renderer.js) is otherwise identical, so behaviour and
 * data format match the desktop app exactly — a JSON exported here imports
 * straight into the Windows app and vice versa.
 */

(function installWebBridge() {
  const STORAGE_KEY = 'mytasks.web.v1';
  const VERSION = '1.4.0-web';

  /* ---------------- helpers ---------------- */

  const uid = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const now = () => Date.now();

  function isoLocal(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function dayOffset(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return isoLocal(d);
  }

  /* ---------------- default data (mirrors main.js) ---------------- */

  function createDefaultData() {
    const ts = now();
    const gGeneral = uid();
    const gWork = uid();
    const gHome = uid();
    const welcomeRecordId = uid();
    return {
      version: 1,
      groups: [
        { id: gGeneral, name: 'כללי', color: '#7c9cff', collapsed: false, createdAt: ts },
        { id: gWork, name: 'עבודה', color: '#ffb454', collapsed: false, createdAt: ts + 1 },
        { id: gHome, name: 'בית', color: '#3ddc97', collapsed: false, createdAt: ts + 2 },
      ],
      tasks: [
        {
          id: uid(),
          groupId: gGeneral,
          title: 'ברוכים הבאים למשימות שלי 👋',
          notes: 'זו גרסת הדפדפן של האפליקציה. הנתונים נשמרים בדפדפן זה (לא בשרת) — אפשר לייצא לקובץ JSON ולגבות.',
          done: false,
          doneAt: null,
          priority: 'normal',
          due: dayOffset(0),
          createdAt: ts + 10,
          updatedAt: ts + 10,
          subtasks: [
            { id: uid(), title: 'לסמן תת־משימה כבוצעת בלחיצה על העיגול', done: false, createdAt: ts + 11 },
            { id: uid(), title: 'להוסיף תת־משימה חדשה בשדה בתחתית הרשימה', done: false, createdAt: ts + 12 },
            { id: uid(), title: 'לייצא את הנתונים לקובץ JSON כגיבוי', done: false, createdAt: ts + 13 },
          ],
        },
        {
          id: uid(),
          groupId: gWork,
          title: 'להכין מצגת ללקוח',
          notes: '',
          done: false,
          doneAt: null,
          priority: 'high',
          due: dayOffset(2),
          createdAt: ts + 20,
          updatedAt: ts + 20,
          subtasks: [
            { id: uid(), title: 'לאסוף נתונים', done: true, createdAt: ts + 21 },
            { id: uid(), title: 'לבנות שקופיות', done: false, createdAt: ts + 22 },
            { id: uid(), title: 'חזרה עם הצוות', done: false, createdAt: ts + 23 },
          ],
        },
        {
          id: uid(),
          groupId: gHome,
          title: 'קניות לשבת',
          notes: '',
          done: false,
          doneAt: null,
          priority: 'normal',
          due: dayOffset(0),
          createdAt: ts + 30,
          updatedAt: ts + 30,
          subtasks: [
            { id: uid(), title: 'חלב', done: false, createdAt: ts + 31 },
            { id: uid(), title: 'לחם', done: false, createdAt: ts + 32 },
            { id: uid(), title: 'ירקות', done: false, createdAt: ts + 33 },
          ],
        },
        {
          id: uid(),
          groupId: gHome,
          title: 'לתקן את הברז במטבח',
          notes: '',
          done: false,
          doneAt: null,
          priority: 'low',
          due: dayOffset(-1),
          createdAt: ts + 40,
          updatedAt: ts + 40,
          subtasks: [],
        },
        {
          id: uid(),
          groupId: gWork,
          title: 'לתכנן את השבוע הבא',
          notes: '',
          done: false,
          doneAt: null,
          priority: 'normal',
          due: null,
          createdAt: ts + 50,
          updatedAt: ts + 50,
          subtasks: [],
        },
        {
          id: uid(),
          groupId: gGeneral,
          title: 'לקרוא 20 דקות',
          notes: '',
          done: true,
          doneAt: ts - 3_600_000,
          priority: 'low',
          due: dayOffset(0),
          createdAt: ts + 60,
          updatedAt: ts + 60,
          subtasks: [],
        },
      ],
      records: [
        {
          id: welcomeRecordId,
          parentId: null,
          title: 'ברוכים הבאים לפנקס הרשומות 📒',
          body: 'כאן אפשר לשמור רשומות חופשיות — הערות, רעיונות, מספרי טלפון, מתכונים וכל דבר שאינו משימה.\n\nלחיצה על רשומה פותחת את העורך: כותרת, תוכן, הצמדה למעלה וצבע. רשומה יכולה להכיל תתי־רשומות — מהתפריט ⋯ או בכפתור “＋ תת־רשומה” שבתוך העורך, ואפשר גם לגרור רשומה על רשומה אחרת. הכל נשמר אוטומטית כמו המשימות.',
          color: '#7c9cff',
          pinned: false,
          createdAt: ts,
          updatedAt: ts,
        },
        {
          id: uid(),
          parentId: welcomeRecordId,
          title: 'כך נראית תת־רשומה 🪆',
          body: 'זו רשומה שמקוננת תחת הרשומה שלמעלה. אפשר לקנן גם תחתיה, עד 6 רמות. כדי לבטל את הקינון: תפריט ⋯ → “הוצאה לרמה הראשית”, או גררו אותה על רשומה אחרת.',
          color: '#3ddc97',
          pinned: false,
          createdAt: ts + 1,
          updatedAt: ts + 1,
        },
      ],
      settings: {
        theme: 'dark',
        selection: { kind: 'view', id: 'all' },
        sort: 'manual',
        recordsSort: 'updated',
        lastGroupId: gGeneral,
        showCompleted: true,
      },
    };
  }

  /* ---------------- validation / normalization (mirrors main.js) ---------------- */

  function isStateShape(value) {
    return !!value && typeof value === 'object'
      && Array.isArray(value.groups)
      && Array.isArray(value.tasks)
      && !!value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings);
  }

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const PRIORITIES = new Set(['low', 'normal', 'high']);
  const SORTS = new Set(['manual', 'due', 'priority', 'created', 'alpha']);
  const VIEWS = new Set(['all', 'today', 'week', 'done']);
  const RECORD_SORTS = new Set(['updated', 'created', 'alpha']);
  // How many levels of records-in-records are allowed (a root record is level 1).
  // Keep in sync with main.js / src/renderer.js.
  const RECORD_MAX_LEVELS = 6;

  /**
   * Repairs record nesting after loading/importing: unknown or self parents are
   * dropped, and cycles or over-deep chains are flattened back to the top level.
   * Records are stored as a flat list with a parentId pointer.
   */
  function normalizeRecordParents(records) {
    const byId = new Map();
    for (const record of records) {
      // Ids must be unique: a duplicate id (e.g. from a hand-edited import) would
      // make findRecord/delete hit both records. Keep the first, re-id the rest.
      if (byId.has(record.id)) record.id = uid();
      byId.set(record.id, record);
    }
    for (const record of records) {
      record.parentId = record.parentId
        && byId.has(record.parentId)
        && record.parentId !== record.id
        ? record.parentId
        : null;
      if (!record.parentId) continue;

      let depth = 0;
      let node = record;
      const seen = new Set();
      let valid = true;
      while (node && node.parentId) {
        if (seen.has(node.id) || depth >= RECORD_MAX_LEVELS) { valid = false; break; }
        seen.add(node.id);
        depth += 1;
        node = byId.get(node.parentId);
        if (!node) { valid = false; break; }
      }
      if (!valid || depth >= RECORD_MAX_LEVELS) record.parentId = null;
    }
  }

  function normalizeState(raw) {
    const s = raw;
    s.version = 1;
    s.groups = s.groups
      .filter((g) => g && typeof g === 'object' && typeof g.id === 'string' && g.id)
      .map((g) => ({
        id: g.id,
        name: String(g.name ?? 'ללא שם').slice(0, 120),
        color: typeof g.color === 'string' && /^#[0-9a-f]{6}$/i.test(g.color) ? g.color : '#7c9cff',
        collapsed: !!g.collapsed,
        createdAt: Number(g.createdAt) || now(),
      }));
    if (s.groups.length === 0) {
      s.groups.push({ id: uid(), name: 'כללי', color: '#7c9cff', collapsed: false, createdAt: now() });
    }
    const groupIds = new Set(s.groups.map((g) => g.id));
    const fallbackGroup = s.groups[0].id;

    s.tasks = s.tasks
      .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && t.id)
      .map((t) => ({
        id: t.id,
        groupId: groupIds.has(t.groupId) ? t.groupId : fallbackGroup,
        title: String(t.title ?? '').slice(0, 500),
        notes: String(t.notes ?? '').slice(0, 20_000),
        done: !!t.done,
        doneAt: t.done ? Number(t.doneAt) || now() : null,
        priority: PRIORITIES.has(t.priority) ? t.priority : 'normal',
        due: typeof t.due === 'string' && ISO_DATE.test(t.due) ? t.due : null,
        createdAt: Number(t.createdAt) || now(),
        updatedAt: Number(t.updatedAt) || now(),
        subtasks: Array.isArray(t.subtasks)
          ? t.subtasks
            .filter((st) => st && typeof st === 'object')
            .map((st) => ({
              id: typeof st.id === 'string' && st.id ? st.id : uid(),
              title: String(st.title ?? '').slice(0, 500),
              done: !!st.done,
              createdAt: Number(st.createdAt) || now(),
            }))
          : [],
      }));

    s.records = Array.isArray(s.records)
      ? s.records
        .filter((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id)
        .map((r) => ({
          id: r.id,
          parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null,
          title: String(r.title ?? '').slice(0, 300),
          body: String(r.body ?? '').slice(0, 20_000),
          color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#7c9cff',
          pinned: !!r.pinned,
          createdAt: Number(r.createdAt) || now(),
          updatedAt: Number(r.updatedAt) || now(),
        }))
      : [];
    normalizeRecordParents(s.records);

    const settings = s.settings;
    let selection = { kind: 'view', id: 'all' };
    if (settings.selection && settings.selection.kind === 'records') {
      selection = { kind: 'records' };
    } else if (settings.selection && settings.selection.kind === 'group' && groupIds.has(settings.selection.id)) {
      selection = { kind: 'group', id: settings.selection.id };
    } else if (settings.selection && settings.selection.kind === 'view' && VIEWS.has(settings.selection.id)) {
      selection = { kind: 'view', id: settings.selection.id };
    }
    s.settings = {
      theme: settings.theme === 'light' ? 'light' : 'dark',
      selection,
      sort: SORTS.has(settings.sort) ? settings.sort : 'manual',
      recordsSort: RECORD_SORTS.has(settings.recordsSort) ? settings.recordsSort : 'updated',
      lastGroupId: groupIds.has(settings.lastGroupId) ? settings.lastGroupId : fallbackGroup,
      showCompleted: settings.showCompleted !== false,
    };
    return s;
  }

  /* ---------------- storage ---------------- */

  function loadRaw() {
    try {
      const s = window.localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      const parsed = JSON.parse(s);
      if (!isStateShape(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function load() {
    const raw = loadRaw();
    if (raw) {
      return {
        data: normalizeState(raw),
        recovered: false,
        fresh: false,
        dataPath: 'דפדפן (localStorage)',
        backupPath: '',
        version: VERSION,
        platform: 'web',
      };
    }
    return {
      data: normalizeState(createDefaultData()),
      recovered: false,
      fresh: true,
      dataPath: 'דפדפן (localStorage)',
      backupPath: '',
      version: VERSION,
      platform: 'web',
    };
  }

  function save(state) {
    try {
      const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
      const json = JSON.stringify(normalized);
      window.localStorage.setItem(STORAGE_KEY, json);
      return Promise.resolve({ ok: true, savedAt: Date.now(), bytes: json.length });
    } catch (err) {
      return Promise.resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }

  function saveSync(state) {
    if (!isStateShape(state)) return { ok: false, error: 'invalid-state' };
    try {
      const normalized = normalizeState(JSON.parse(JSON.stringify(state)));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      return { ok: true, savedAt: Date.now() };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  function info() {
    return { version: VERSION, dataPath: 'דפדפן (localStorage)', backupPath: '', dataDir: '' };
  }

  function openDataFolder() {
    return Promise.resolve({ ok: true, path: 'דפדפן (localStorage)' });
  }

  function setTheme() {
    return Promise.resolve({ ok: true, theme: 'web' });
  }

  /* ---------------- export / import ---------------- */

  function exportData(state) {
    return new Promise((resolve) => {
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `mytasks-${stamp}.json`;
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve({ ok: true, path: filename });
      } catch (err) {
        resolve({ ok: false, error: String((err && err.message) || err) });
      }
    });
  }

  function importData() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.style.display = 'none';
      const cleanup = () => { input.remove(); };
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        cleanup();
        if (!file) { resolve({ ok: false, canceled: true }); return; }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result));
            if (!isStateShape(parsed)) {
              resolve({ ok: false, error: 'הקובץ אינו בפורמט נתוני משימות תקין' });
              return;
            }
            resolve({ ok: true, data: normalizeState(parsed), path: file.name });
          } catch (err) {
            resolve({ ok: false, error: String((err && err.message) || err) });
          }
        };
        reader.onerror = () => resolve({ ok: false, error: 'קריאת הקובץ נכשלה' });
        reader.readAsText(file, 'utf8');
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  /* ---------------- misc bridge surface ---------------- */

  function onSaved() {
    // No cross-process notification in the web build; the save() promise already
    // resolves after localStorage is written, so this is a no-op.
    return () => {};
  }

  function ready() {
    // Present only for parity with the desktop preload; nothing to signal here.
  }

  window.api = {
    load,
    save,
    saveSync,
    info,
    openDataFolder,
    setTheme,
    exportData,
    importData,
    onSaved,
    ready,
  };
})();
