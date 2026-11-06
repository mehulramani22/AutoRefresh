/*
 * Live grid – DataTables edition (same behaviour as grid.js, rendered by DataTables.js).
 *  - The whole table is loaded ONCE and handed to DataTables (client-side mode, deferRender).
 *  - Paging (100/page), sorting and filtering are client side. DataTables' own search box, pager and
 *    header-sort handler are switched off so the behaviour matches grid.js exactly: substring global
 *    search, per-column contains / numeric operators (> < >= <= =), asc -> desc -> Id-order sort cycle.
 *  - SignalR pushes only changed rows. They are merged into DataTables' in-memory data via the row API,
 *    so any row is current whether or not its page is visible. Visible rows get only the changed
 *    cells patched (and flashed); no page reload and no table reload.
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

    const state = {
        cols: [],
        rows: new Map(),     // id -> row array (used for edit dialog & counts)
        sortCol: -1,
        sortDir: 1,
        colFilters: [],
        search: '',
        tests: [],           // active filter predicates (applied through DataTables' search hook)
        seq: 0,
        changeCount: 0,
        built: false,
    };
    let dt = null;           // DataTables API instance

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

    // ---------- filtering (plugged into DataTables' search pipeline) ----------
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

    function buildTests() {
        const tests = [];
        state.colFilters.forEach((f, i) => { const m = matcher(i, f); if (m) tests.push(m); });
        const q = state.search.trim().toLowerCase();
        const kinds = state.cols.map((c) => c.kind);
        if (q) tests.push((row) => row.some((v, i) => fmt(kinds[i], v).toLowerCase().includes(q)));
        state.tests = tests;
    }

    // Custom sort types so ordering matches grid.js: empty values always last, natural/numeric string compare.
    const cmp = (a, b, dir, numeric) => {
        const an = a == null || a === '', bn = b == null || b === '';
        if (an && bn) return 0;
        if (an) return 1;               // nulls last in both directions
        if (bn) return -1;
        const c = numeric ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
        return c * dir;
    };
    DataTable.ext.type.order['gnum-asc'] = (a, b) => cmp(a, b, 1, true);
    DataTable.ext.type.order['gnum-desc'] = (a, b) => cmp(a, b, -1, true);
    DataTable.ext.type.order['gstr-asc'] = (a, b) => cmp(a, b, 1, false);
    DataTable.ext.type.order['gstr-desc'] = (a, b) => cmp(a, b, -1, false);

    DataTable.ext.search.push((settings, _searchData, _idx, rowData) => {
        if (settings.nTable !== el.grid) return true;
        for (const t of state.tests) if (!t(rowData)) return false;
        return true;
    });

    // ---------- table construction ----------
    function buildHeader() {
        const head = ['<tr class="head"><th class="c-act"></th>'];
        const filt = ['<tr class="filters"><th class="c-act"></th>'];
        state.cols.forEach((c, i) => {
            const cls = (i === 0 ? 'c-id ' : '') + (NUMERIC.has(c.kind) ? 'num' : '');
            head.push(`<th class="${cls}" data-col="${i}">${c.name}<span class="sort-ind"></span></th>`);
            const ph = NUMERIC.has(c.kind) ? '>, <, =…' : 'filter…';
            filt.push(`<th class="${i === 0 ? 'c-id' : ''}"><input data-col="${i}" placeholder="${ph}" autocomplete="off"></th>`);
        });
        el.grid.tHead.innerHTML = head.join('') + '</tr>' + filt.join('') + '</tr>';
    }

    function createTable(rows) {
        buildHeader();
        const columns = [{
            data: null, orderable: false, searchable: false, className: 'c-act',
            render: () => '<button data-act="edit" title="Edit">✎</button><button data-act="del" title="Delete">🗑</button>',
        }];
        state.cols.forEach((c, i) => {
            columns.push({
                data: i,
                type: NUMERIC.has(c.kind) || c.kind === 'bool' ? 'gnum' : 'gstr',
                className: (i === 0 ? 'c-id ' : '') + (NUMERIC.has(c.kind) ? 'num' : c.kind === 'bool' ? 'bool' : ''),
                // display is formatted + escaped; sort uses the raw value
                render: (v, type) => (type === 'display' ? esc(fmt(c.kind, v)) : v),
            });
        });

        dt = new DataTable(el.grid, {
            data: rows,
            columns,
            deferRender: true,
            pageLength: PAGE_SIZE,
            paging: true,
            searching: true,          // required for the custom search hook; the built-in box is not rendered
            info: false,
            lengthChange: false,
            autoWidth: false,
            ordering: { indicators: false },
            order: [[1, 'asc']],
            layout: { topStart: null, topEnd: null, bottomStart: null, bottomEnd: null },
            createdRow: (tr, data) => { tr.dataset.id = data[0]; },
        });
        dt.on('draw', onDraw);
    }

    function onDraw() {
        el.total.textContent = state.rows.size.toLocaleString();
        el.filtered.textContent = dt.page.info().recordsDisplay.toLocaleString();
        renderPager();
    }

    function updateSortIndicators() {
        el.grid.tHead.querySelectorAll('tr.head th[data-col]').forEach((th) => {
            const i = +th.dataset.col;
            th.querySelector('.sort-ind').textContent = i === state.sortCol ? (state.sortDir === 1 ? '▲' : '▼') : '';
        });
    }

    function applyOrder() {
        // Always tie-break on Id so ordering is stable.
        dt.order(state.sortCol < 0 ? [[1, 'asc']] : [[state.sortCol + 1, state.sortDir === 1 ? 'asc' : 'desc'], [1, 'asc']]);
        updateSortIndicators();
    }

    function renderPager() {
        const info = dt.page.info();
        const pc = Math.max(1, info.pages), p = info.page + 1, n = info.recordsDisplay;
        const from = n ? info.start + 1 : 0;
        const to = info.end;
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
        void node.offsetWidth;
        node.classList.add(cls);
        node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
    }

    // ---------- data loading ----------
    async function loadSnapshot() {
        const res = await fetch('/api/records');
        if (!res.ok) throw new Error('Snapshot failed: ' + res.status);
        const snap = await res.json();
        state.seq = snap.seq;
        state.rows = new Map(snap.rows.map((r) => [r[0], r]));
        if (!state.built) {
            state.cols = snap.columns;
            state.colFilters = snap.columns.map(() => '');
            el.loading.hidden = true;
            el.grid.hidden = false;
            createTable(snap.rows);
            state.built = true;
            updateSortIndicators();
            dt.draw();
        } else {
            dt.clear().rows.add(snap.rows).draw(false);   // resync: keep filters, sort and page
        }
    }

    // ---------- applying pushed changes ----------
    function applyChanges(batch) {
        if (batch.resync) { loadSnapshot(); return; }
        if (batch.upToSeq <= state.seq || !batch.changes.length) return;

        const updates = new Map();   // id -> new row (rows we already have)
        const inserts = [];
        const deletes = new Set();
        for (const ch of batch.changes) {
            if (ch.op === 'delete') { if (state.rows.has(ch.id)) deletes.add(ch.id); }
            else if (state.rows.has(ch.id)) updates.set(ch.id, ch.row);
            else inserts.push(ch.row);
        }

        // 1) Updates: patch DataTables' data in place (its cached cells refresh; no redraw, so the row
        //    keeps its position until the user pages, sorts or filters – same as grid.js).
        const patched = new Map();   // id -> changed column indexes
        if (updates.size) {
            dt.rows((_i, data) => updates.has(data[0])).every(function () {
                const old = this.data();
                const next = updates.get(old[0]);
                const cols = [];
                for (let i = 0; i < next.length; i++) if (!sameVal(old[i], next[i])) cols.push(i);
                if (cols.length) { this.data(next); patched.set(old[0], cols); }
                state.rows.set(old[0], next);
            });
        }

        // 2) Deletes / inserts.
        let structural = false;
        if (deletes.size) {
            dt.rows((_i, data) => deletes.has(data[0])).remove();
            deletes.forEach((id) => state.rows.delete(id));
            structural = true;
        }
        let added = null;
        if (inserts.length) {
            added = dt.rows.add(inserts).indexes().toArray();
            inserts.forEach((r) => state.rows.set(r[0], r));
            structural = true;
        }

        state.seq = batch.upToSeq;
        state.changeCount += batch.changes.length;
        el.changes.textContent = state.changeCount.toLocaleString();
        el.last.textContent = new Date().toLocaleTimeString();

        // Inserts/deletes change counts and page content: re-filter/sort and redraw, staying on this page.
        if (structural) dt.draw(false);

        if (added) {
            dt.rows(added).nodes().toArray().forEach((tr) => { if (tr) flash(tr, 'flash-new'); });
        }
        if (patched.size) {
            dt.rows((_i, data) => patched.has(data[0])).every(function () {
                const tr = this.node();                       // null when the row is not on the visible page
                if (!tr) return;
                for (const i of patched.get(this.data()[0])) flash(tr.cells[i + 1], 'flash');
            });
        }
    }

    // ---------- UI events ----------
    function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
    function refilter() { buildTests(); dt.draw(); }          // draw() resets to page 1
    const refilterSoon = debounce(refilter, 200);

    el.search.addEventListener('input', () => { state.search = el.search.value; refilterSoon(); });

    el.grid.tHead.addEventListener('input', (e) => {
        if (e.target.matches('input[data-col]')) { state.colFilters[+e.target.dataset.col] = e.target.value; refilterSoon(); }
    });

    // Capture phase + stopPropagation: our asc -> desc -> Id-order cycle replaces DataTables' own header sorting.
    const headSort = (e) => {
        const th = e.target.closest('tr.head th[data-col]');
        if (!th) return;
        e.stopPropagation();
        if (e.type === 'keydown' && e.key !== 'Enter') return;
        const i = +th.dataset.col;
        if (state.sortCol !== i) { state.sortCol = i; state.sortDir = 1; }
        else if (state.sortDir === 1) state.sortDir = -1;
        else state.sortCol = -1;                       // third click: back to Id order
        applyOrder();
        dt.draw();
    };
    el.grid.tHead.addEventListener('click', headSort, true);
    el.grid.tHead.addEventListener('keydown', headSort, true);

    el.clear.addEventListener('click', () => {
        state.search = ''; el.search.value = '';
        state.colFilters = state.colFilters.map(() => '');
        el.grid.tHead.querySelectorAll('input[data-col]').forEach((i) => { i.value = ''; });
        state.sortCol = -1; state.sortDir = 1;
        applyOrder();
        refilter();
    });

    el.pager.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-p]');
        if (!b || b.disabled) return;
        dt.page(+b.dataset.p - 1).draw('page');
    });
    el.pager.addEventListener('change', (e) => {
        if (e.target.id === 'goto') {
            const pc = Math.max(1, dt.page.info().pages);
            dt.page(Math.min(pc, Math.max(1, parseInt(e.target.value, 10) || 1)) - 1).draw('page');
        }
    });

    // ---------- add / edit / delete (results return through SignalR) ----------
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

    el.grid.addEventListener('click', async (e) => {
        const btn = e.target.closest('tbody button[data-act]');
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

    async function catchUp() { applyChanges(await hub.invoke('GetChangesSince', state.seq)); }

    async function connect() {
        try { await hub.start(); setConn('on', 'Live'); await catchUp(); }
        catch { setConn('off', 'Offline'); setTimeout(connect, 5000); }
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
