/*
 * Live grid.
 *  - Loads the whole table ONCE (/api/records) and keeps it in memory (Map keyed by Id).
 *  - Paging, sorting and filtering are 100% client side over that in-memory set.
 *  - SignalR pushes only the changed rows. They are merged into the in-memory set, so a row is
 *    always current whether or not its page is on screen. If the row is on the visible page only
 *    the changed cells are patched (and flashed); the page is never reloaded.
 */
(() => {
    'use strict';

    const PAGE_SIZE = 100;

    const $ = (id) => document.getElementById(id);
    const el = {
        conn: $('conn'), grid: $('grid'), loading: $('loading'), pager: $('pager'),
        total: $('stat-total'), filtered: $('stat-filtered'), last: $('stat-last'), changes: $('stat-changes'),
        search: $('global-search'), clear: $('btn-clear'), add: $('btn-add'),
        simBtn: $('btn-sim'), simRate: $('sim-rate'),
        dlg: $('dlg'), dlgForm: $('dlg-form'), dlgTitle: $('dlg-title'), dlgFields: $('dlg-fields'), dlgCancel: $('dlg-cancel'),
    };
    const thead = el.grid.tHead;
    const tbody = el.grid.tBodies[0];

    const state = {
        cols: [],            // [{name, kind}]
        rows: new Map(),     // id -> row array (mutated in place on update)
        view: [],            // filtered + sorted row arrays
        page: 1,
        sortCol: -1,
        sortDir: 1,
        colFilters: [],      // per column filter text
        search: '',
        seq: 0,              // change-log position this client has applied up to
        changeCount: 0,
        built: false,
    };
    const pageTr = new Map(); // id -> <tr> currently rendered

    // ---------- formatting ----------
    const NUMERIC = new Set(['int', 'decimal']);

    function fmt(kind, v) {
        if (v === null || v === undefined) return '';
        switch (kind) {
            case 'bool': return v ? 'Yes' : 'No';
            case 'decimal': return Number(v).toFixed(2);
            case 'datetime': return String(v).replace('T', ' ');
            default: return String(v);
        }
    }
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sameVal = (a, b) => a === b || (a == null && b == null);

    // ---------- data loading ----------
    async function loadSnapshot() {
        const res = await fetch('/api/records');
        if (!res.ok) throw new Error('Snapshot failed: ' + res.status);
        const snap = await res.json();
        if (!state.built) {
            state.cols = snap.columns;
            state.colFilters = snap.columns.map(() => '');
        }
        state.rows = new Map(snap.rows.map((r) => [r[0], r]));
        state.seq = snap.seq;
        if (!state.built) buildHeader();
        state.built = true;
        el.loading.hidden = true;
        el.grid.hidden = false;
        recomputeView();
        renderPage();
    }

    // ---------- view (filter + sort + page), all client side ----------
    function matcher(colIdx, text) {
        const kind = state.cols[colIdx].kind;
        const t = text.trim();
        if (!t) return null;
        if (NUMERIC.has(kind)) {
            const m = /^(>=|<=|>|<|=)?\s*(-?\d+(?:\.\d+)?)$/.exec(t);
            if (m) {
                const n = parseFloat(m[2]);
                const op = m[1] || '=';
                return (row) => {
                    const v = row[colIdx];
                    if (v === null) return false;
                    return op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n : op === '<=' ? v <= n : v === n;
                };
            }
        }
        const lower = t.toLowerCase();
        return (row) => fmt(kind, row[colIdx]).toLowerCase().includes(lower);
    }

    function recomputeView() {
        const tests = [];
        state.colFilters.forEach((f, i) => { const m = matcher(i, f); if (m) tests.push(m); });
        const q = state.search.trim().toLowerCase();
        const kinds = state.cols.map((c) => c.kind);
        if (q) tests.push((row) => row.some((v, i) => fmt(kinds[i], v).toLowerCase().includes(q)));

        let arr = [];
        for (const row of state.rows.values()) {
            let ok = true;
            for (const t of tests) { if (!t(row)) { ok = false; break; } }
            if (ok) arr.push(row);
        }

        const ci = state.sortCol < 0 ? 0 : state.sortCol;
        const dir = state.sortCol < 0 ? 1 : state.sortDir;
        const kind = state.cols[ci].kind;
        const numeric = NUMERIC.has(kind) || kind === 'bool';
        arr.sort((a, b) => {
            const x = a[ci], y = b[ci];
            if (x == null && y == null) return a[0] - b[0];
            if (x == null) return 1;           // nulls last regardless of direction
            if (y == null) return -1;
            const c = numeric ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
            return c !== 0 ? c * dir : a[0] - b[0];
        });
        state.view = arr;
        el.total.textContent = state.rows.size.toLocaleString();
        el.filtered.textContent = arr.length.toLocaleString();
    }

    const pageCount = () => Math.max(1, Math.ceil(state.view.length / PAGE_SIZE));

    // ---------- rendering ----------
    function buildHeader() {
        const head = ['<tr class="head"><th class="c-act"></th>'];
        const filt = ['<tr class="filters"><th class="c-act"></th>'];
        state.cols.forEach((c, i) => {
            const cls = (i === 0 ? 'c-id ' : '') + (NUMERIC.has(c.kind) ? 'num' : '');
            head.push(`<th class="${cls}" data-col="${i}">${c.name}<span class="sort-ind"></span></th>`);
            const ph = NUMERIC.has(c.kind) ? '>, <, =…' : 'filter…';
            filt.push(`<th class="${i === 0 ? 'c-id' : ''}"><input data-col="${i}" placeholder="${ph}" autocomplete="off"></th>`);
        });
        thead.innerHTML = head.join('') + '</tr>' + filt.join('') + '</tr>';
        updateSortIndicators();
    }

    function updateSortIndicators() {
        thead.querySelectorAll('tr.head th[data-col]').forEach((th) => {
            const i = +th.dataset.col;
            th.querySelector('.sort-ind').textContent = i === state.sortCol ? (state.sortDir === 1 ? '▲' : '▼') : '';
        });
    }

    function rowHtml(row) {
        const out = [`<tr data-id="${row[0]}"><td class="c-act"><button data-act="edit" title="Edit">✎</button><button data-act="del" title="Delete">🗑</button></td>`];
        for (let i = 0; i < state.cols.length; i++) {
            const k = state.cols[i].kind;
            const cls = (i === 0 ? 'c-id ' : '') + (NUMERIC.has(k) ? 'num' : k === 'bool' ? 'bool' : '');
            out.push(`<td class="${cls}">${esc(fmt(k, row[i]))}</td>`);
        }
        return out.join('') + '</tr>';
    }

    function renderPage() {
        const pc = pageCount();
        if (state.page > pc) state.page = pc;
        if (state.page < 1) state.page = 1;
        const start = (state.page - 1) * PAGE_SIZE;
        const slice = state.view.slice(start, start + PAGE_SIZE);
        tbody.innerHTML = slice.map(rowHtml).join('');
        pageTr.clear();
        for (const tr of tbody.rows) pageTr.set(+tr.dataset.id, tr);
        renderPager();
    }

    function renderPager() {
        const pc = pageCount(), p = state.page, n = state.view.length;
        const from = n ? (p - 1) * PAGE_SIZE + 1 : 0;
        const to = Math.min(p * PAGE_SIZE, n);
        const nums = new Set([1, pc, p - 2, p - 1, p, p + 1, p + 2].filter((x) => x >= 1 && x <= pc));
        const parts = [`<span class="info">Rows ${from.toLocaleString()}–${to.toLocaleString()} of ${n.toLocaleString()}</span>`];
        parts.push(`<button data-p="1" ${p === 1 ? 'disabled' : ''}>«</button>`);
        parts.push(`<button data-p="${p - 1}" ${p === 1 ? 'disabled' : ''}>‹</button>`);
        let prev = 0;
        [...nums].sort((a, b) => a - b).forEach((x) => {
            if (x - prev > 1) parts.push('<span>…</span>');
            parts.push(`<button data-p="${x}" class="${x === p ? 'cur' : ''}">${x}</button>`);
            prev = x;
        });
        parts.push(`<button data-p="${p + 1}" ${p === pc ? 'disabled' : ''}>›</button>`);
        parts.push(`<button data-p="${pc}" ${p === pc ? 'disabled' : ''}>»</button>`);
        parts.push(`<span>Go to <input id="goto" type="number" min="1" max="${pc}" value="${p}"> of ${pc}</span>`);
        el.pager.innerHTML = parts.join('');
    }

    function flash(node, cls) {
        node.classList.remove(cls);
        void node.offsetWidth; // restart the CSS animation
        node.classList.add(cls);
        node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
    }

    // ---------- applying pushed changes ----------
    function applyChanges(batch) {
        if (batch.resync) { loadSnapshot(); return; }
        if (batch.upToSeq <= state.seq || !batch.changes.length) return;

        let structural = false;          // insert or delete => counts/pages change
        const newIds = new Set();
        const patched = [];              // {id, cols:[...]} for rows updated in place

        for (const ch of batch.changes) {
            if (ch.op === 'delete') {
                if (state.rows.delete(ch.id)) structural = true;
                continue;
            }
            const existing = state.rows.get(ch.id);
            if (!existing) {
                state.rows.set(ch.id, ch.row);
                newIds.add(ch.id);
                structural = true;
                continue;
            }
            const cols = [];
            for (let i = 0; i < ch.row.length; i++) {
                if (!sameVal(existing[i], ch.row[i])) { existing[i] = ch.row[i]; cols.push(i); }
            }
            if (cols.length) patched.push({ id: ch.id, cols });
        }

        state.seq = batch.upToSeq;
        state.changeCount += batch.changes.length;
        el.changes.textContent = state.changeCount.toLocaleString();
        el.last.textContent = new Date().toLocaleTimeString();

        if (structural) {
            // Rows were added/removed: recompute filter/sort/paging, then redraw the current page.
            recomputeView();
            renderPage();
            for (const id of newIds) { const tr = pageTr.get(id); if (tr) flash(tr, 'flash-new'); }
        } else {
            el.total.textContent = state.rows.size.toLocaleString();
        }

        // Cell-level patch for updated rows that are on screen (after a redraw this just re-flashes).
        for (const { id, cols } of patched) {
            const tr = pageTr.get(id);
            if (!tr) continue;                       // not on this page; data is already current in memory
            const row = state.rows.get(id);
            for (const i of cols) {
                const td = tr.cells[i + 1];
                const text = fmt(state.cols[i].kind, row[i]);
                if (td.textContent !== text) td.textContent = text;
                flash(td, 'flash');
            }
        }
    }

    // ---------- UI events ----------
    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

    function refilter() { state.page = 1; recomputeView(); renderPage(); }
    const refilterSoon = debounce(refilter, 200);

    el.search.addEventListener('input', () => { state.search = el.search.value; refilterSoon(); });

    thead.addEventListener('input', (e) => {
        if (e.target.matches('input[data-col]')) { state.colFilters[+e.target.dataset.col] = e.target.value; refilterSoon(); }
    });

    thead.addEventListener('click', (e) => {
        const th = e.target.closest('tr.head th[data-col]');
        if (!th) return;
        const i = +th.dataset.col;
        if (state.sortCol !== i) { state.sortCol = i; state.sortDir = 1; }
        else if (state.sortDir === 1) state.sortDir = -1;
        else state.sortCol = -1;                       // third click: back to Id order
        updateSortIndicators();
        state.page = 1;
        recomputeView();
        renderPage();
    });

    el.clear.addEventListener('click', () => {
        state.search = ''; el.search.value = '';
        state.colFilters = state.colFilters.map(() => '');
        thead.querySelectorAll('input[data-col]').forEach((i) => { i.value = ''; });
        state.sortCol = -1; state.sortDir = 1;
        updateSortIndicators();
        refilter();
    });

    el.pager.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-p]');
        if (!b || b.disabled) return;
        state.page = +b.dataset.p;
        renderPage();
    });
    el.pager.addEventListener('change', (e) => {
        if (e.target.id === 'goto') {
            state.page = Math.min(pageCount(), Math.max(1, parseInt(e.target.value, 10) || 1));
            renderPage();
        }
    });

    // ---------- add / edit / delete (results come back through SignalR, not a local refresh) ----------
    let editingId = null;

    function openDialog(row) {
        editingId = row ? row[0] : null;
        el.dlgTitle.textContent = row ? `Edit record #${row[0]}` : 'Add record';
        el.dlgFields.innerHTML = '';
        state.cols.forEach((c, i) => {
            if (c.name === 'UpdatedDate' || (c.name === 'Id' && !row)) return;
            const v = row ? row[i] : null;
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.name = c.name;
            if (c.name === 'Id') input.disabled = true;
            if (c.kind === 'bool') {
                input.type = 'checkbox'; input.checked = !!v; label.className = 'chk';
                label.append(input, c.name);
            } else {
                input.type = NUMERIC.has(c.kind) ? 'number' : c.kind === 'date' ? 'date' : 'text';
                if (c.kind === 'decimal') input.step = 'any';
                input.value = v ?? '';
                label.append(c.name, input);
            }
            el.dlgFields.append(label);
        });
        el.dlg.showModal();
    }

    function formPayload() {
        const body = {};
        state.cols.forEach((c) => {
            const input = el.dlgFields.querySelector(`[name="${c.name}"]`);
            if (!input || input.disabled) return;
            if (c.kind === 'bool') body[c.name] = input.checked;
            else if (input.value === '') body[c.name] = null;
            else if (NUMERIC.has(c.kind)) body[c.name] = Number(input.value);
            else body[c.name] = input.value;
        });
        return body;
    }

    el.add.addEventListener('click', () => openDialog(null));
    el.dlgCancel.addEventListener('click', () => el.dlg.close());
    el.dlgForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = editingId ? `/api/records/${editingId}` : '/api/records';
        const res = await fetch(url, {
            method: editingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formPayload()),
        });
        if (!res.ok) { alert('Save failed (' + res.status + ')'); return; }
        el.dlg.close();
    });

    tbody.addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const id = +btn.closest('tr').dataset.id;
        if (btn.dataset.act === 'edit') openDialog(state.rows.get(id));
        else if (confirm(`Delete record #${id}?`)) await fetch(`/api/records/${id}`, { method: 'DELETE' });
    });

    // ---------- simulator ----------
    function showSim(s) {
        el.simBtn.textContent = s.running ? 'Stop' : 'Start';
        el.simBtn.classList.toggle('running', s.running);
        if (s.running) el.simRate.value = String(s.rate);
    }
    el.simBtn.addEventListener('click', async () => {
        const running = el.simBtn.classList.contains('running');
        const url = running ? '/api/simulator/stop' : `/api/simulator/start?rate=${el.simRate.value}`;
        showSim(await (await fetch(url, { method: 'POST' })).json());
    });
    el.simRate.addEventListener('change', async () => {
        if (el.simBtn.classList.contains('running'))
            showSim(await (await fetch(`/api/simulator/start?rate=${el.simRate.value}`, { method: 'POST' })).json());
    });

    // ---------- SignalR ----------
    function setConn(kind, text) { el.conn.className = 'pill pill-' + kind; el.conn.textContent = text; }

    const hub = new signalR.HubConnectionBuilder()
        .withUrl('/hubs/records')
        .withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 10000, 10000, 10000, 10000, 10000])
        .build();

    hub.on('recordsChanged', applyChanges);
    hub.onreconnecting(() => setConn('wait', 'Reconnecting…'));
    hub.onreconnected(async () => { setConn('on', 'Live'); await catchUp(); });
    hub.onclose(() => { setConn('off', 'Offline'); setTimeout(connect, 5000); });

    async function catchUp() {
        // Anything that changed while we were disconnected (or between snapshot and connect).
        applyChanges(await hub.invoke('GetChangesSince', state.seq));
    }

    async function connect() {
        try {
            await hub.start();
            setConn('on', 'Live');
            await catchUp();
        } catch {
            setConn('off', 'Offline');
            setTimeout(connect, 5000);
        }
    }

    // ---------- boot ----------
    (async () => {
        try {
            showSim(await (await fetch('/api/simulator')).json());
            await loadSnapshot();
            await connect();
        } catch (err) {
            el.loading.textContent = 'Failed to load: ' + err.message;
        }
    })();
})();
