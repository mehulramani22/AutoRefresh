# AutoRefresh – real-time table refresh (ASP.NET Core 8 + SQLite)

A 30-column / 10,000-row table is loaded **once** into the browser. After that, only rows that
change in the database are pushed to the page (no page reload, no table reload).

## Run

```bash
cd AutoRefresh.Web
dotnet run --urls http://localhost:5080
```

Open http://localhost:5080. The SQLite file (`App_Data/autorefresh.db`) is created and seeded with
10,000 rows on first start (change `Seed:Rows` in `appsettings.json` to resize).

## How it works

| Piece | Role |
|---|---|
| `Records` table | 30 columns, 10,000 rows. |
| `ChangeLog` table + 3 triggers | Every INSERT / UPDATE / DELETE on `Records` – from the app **or any external tool** – appends `(Seq, RecordId, Op)`. |
| `ChangeNotifier` (BackgroundService) | Polls `ChangeLog` every 500 ms, collapses to one upsert/delete per record, pushes the changed rows over SignalR (`/hubs/records`). |
| `GET /api/records` | Whole table in one call (compact arrays, gzip) + the `ChangeLog` position of that snapshot. |
| `wwwroot/js/grid.js` | Keeps all rows in memory; **client-side** paging (100/page), sorting, global + per-column filtering. Pushed changes are merged into the in-memory set, so any row is up to date whether or not its page is visible. On-screen rows get only the changed cells patched and flashed. Inserts/deletes update counts and pages. Filters/sorts/paging always operate on the latest data. |
| Reconnect | On reconnect the client asks `GetChangesSince(lastSeq)`; if it is too far behind it reloads the snapshot. |

Per-column filters on numeric columns accept `>`, `<`, `>=`, `<=`, `=` (e.g. `>1000`).

## Two front ends (same backend, same behaviour)

| URL | Implementation |
|---|---|
| `/` | Hand-written grid (`wwwroot/js/grid.js`) |
| `/datatable` | [DataTables.js](https://datatables.net) 2.x + jQuery (`wwwroot/js/datatable-grid.js`) |

The DataTables page keeps the exact behaviour of the custom grid: DataTables' own search box, pager and
header sorting are replaced by the same substring global search, per-column filters (incl. numeric
`> < >= <= =`), asc → desc → Id-order sort cycle (empty values last) and 100-row pager. Pushed changes
go through the DataTables row API (`row().data()`, `rows.add()`, `rows().remove()`); updated rows are
patched in place without a redraw. Libraries are vendored in `wwwroot/lib` (no CDN needed).

## Trying it

* **Simulator** (top-right): writes random updates/inserts/deletes straight to the DB at 1–50 ops/s.
* **+ Add record / ✎ / 🗑**: write through the API; the grid updates from the SignalR push, not locally.
* **External change** (open the grid in two windows, or edit the DB directly):

```bash
sqlite3 AutoRefresh.Web/App_Data/autorefresh.db "UPDATE Records SET Status='Closed' WHERE Id=42"
```

## API

`GET /api/records` · `POST /api/records` · `PUT /api/records/{id}` · `DELETE /api/records/{id}` ·
`GET /api/simulator` · `POST /api/simulator/start?rate=N` · `POST /api/simulator/stop`
