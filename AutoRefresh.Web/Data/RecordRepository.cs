using System.Text;
using Microsoft.Data.Sqlite;

namespace AutoRefresh.Web.Data;

public sealed record Change(string Op, long Id, object?[]? Row);

/// <param name="Resync">True when the client is too far behind (or ahead of) the retained change log and must reload.</param>
public sealed record ChangeBatch(long UpToSeq, List<Change> Changes, bool Resync);

public sealed record Snapshot(IEnumerable<object> Columns, List<object?[]> Rows, long Seq);

/// <summary>
/// All SQLite access. Change detection is trigger-based: every INSERT/UPDATE/DELETE on Records
/// (from this app or any external tool) appends to ChangeLog, which the ChangeNotifier polls.
/// </summary>
public sealed class RecordRepository
{
    private readonly string _cs;
    private readonly int _seedRows;
    private readonly ILogger<RecordRepository> _log;

    public RecordRepository(IConfiguration cfg, IWebHostEnvironment env, ILogger<RecordRepository> log)
    {
        _log = log;
        var raw = cfg.GetConnectionString("Default") ?? "Data Source=App_Data/autorefresh.db";
        var b = new SqliteConnectionStringBuilder(raw);
        if (!Path.IsPathRooted(b.DataSource))
            b.DataSource = Path.Combine(env.ContentRootPath, b.DataSource);
        Directory.CreateDirectory(Path.GetDirectoryName(b.DataSource)!);
        _cs = b.ToString();
        _seedRows = cfg.GetValue("Seed:Rows", 10000);
    }

    public SqliteConnection Open()
    {
        var c = new SqliteConnection(_cs);
        c.Open();
        return c;
    }

    // ---------- setup ----------

    public void Initialize()
    {
        using var c = Open();
        Exec(c, "PRAGMA journal_mode=WAL;");

        var cols = string.Join(",\n  ", Schema.Columns.Select(x => $"{x.Name} {x.Sql}"));
        Exec(c, $"CREATE TABLE IF NOT EXISTS Records (\n  {cols}\n);");
        Exec(c, """
            CREATE TABLE IF NOT EXISTS ChangeLog (
              Seq INTEGER PRIMARY KEY AUTOINCREMENT,
              RecordId INTEGER NOT NULL,
              Op TEXT NOT NULL,
              ChangedAt TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TRIGGER IF NOT EXISTS trg_records_ai AFTER INSERT ON Records
              BEGIN INSERT INTO ChangeLog(RecordId, Op) VALUES (NEW.Id, 'I'); END;
            CREATE TRIGGER IF NOT EXISTS trg_records_au AFTER UPDATE ON Records
              BEGIN INSERT INTO ChangeLog(RecordId, Op) VALUES (NEW.Id, 'U'); END;
            CREATE TRIGGER IF NOT EXISTS trg_records_ad AFTER DELETE ON Records
              BEGIN INSERT INTO ChangeLog(RecordId, Op) VALUES (OLD.Id, 'D'); END;
            """);

        long count = Scalar<long>(c, "SELECT COUNT(*) FROM Records");
        if (count == 0 && _seedRows > 0) Seed(c, _seedRows);
    }

    private void Seed(SqliteConnection c, int rows)
    {
        _log.LogInformation("Seeding {Rows} records...", rows);
        var rnd = new Random(42);
        using var tx = c.BeginTransaction();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        var names = Schema.DataColumns.Select(x => x.Name).ToArray();
        cmd.CommandText = $"INSERT INTO Records ({string.Join(",", names)}) VALUES ({string.Join(",", names.Select(n => "@" + n))})";
        var ps = names.Select(n => cmd.Parameters.Add("@" + n, SqliteType.Text)).ToArray();
        for (int i = 0; i < rows; i++)
        {
            var vals = RandomData.Row(rnd);
            for (int j = 0; j < ps.Length; j++) ps[j].Value = vals[j] ?? DBNull.Value;
            cmd.ExecuteNonQuery();
        }
        // Seeding is the baseline, not a change to broadcast.
        using (var del = c.CreateCommand()) { del.Transaction = tx; del.CommandText = "DELETE FROM ChangeLog"; del.ExecuteNonQuery(); }
        tx.Commit();
        _log.LogInformation("Seeding complete.");
    }

    // ---------- reads ----------

    /// <summary>Whole table plus the change-log position it corresponds to (read in one snapshot).</summary>
    public Snapshot GetSnapshot()
    {
        using var c = Open();
        using var tx = c.BeginTransaction(deferred: true);
        long seq = CurrentSeq(c, tx);
        var rows = new List<object?[]>(_seedRows);
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = $"SELECT {Schema.SelectList} FROM Records ORDER BY Id";
        using var r = cmd.ExecuteReader();
        while (r.Read()) rows.Add(ReadRow(r));
        var cols = Schema.Columns.Select(x => (object)new { name = x.Name, kind = x.Kind });
        return new Snapshot(cols, rows, seq);
    }

    public long CurrentSeq()
    {
        using var c = Open();
        return CurrentSeq(c, null);
    }

    private static long CurrentSeq(SqliteConnection c, SqliteTransaction? tx)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='ChangeLog'), 0)";
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    /// <summary>Collapses everything after fromSeq into one upsert/delete per record, using current row state.</summary>
    public ChangeBatch BuildBatch(long fromSeq)
    {
        using var c = Open();
        using var tx = c.BeginTransaction(deferred: true);

        long upTo = fromSeq;
        var ids = new List<long>();
        var seen = new HashSet<long>();
        using (var cmd = c.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = "SELECT Seq, RecordId FROM ChangeLog WHERE Seq > @s ORDER BY Seq";
            cmd.Parameters.AddWithValue("@s", fromSeq);
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                upTo = r.GetInt64(0);
                long id = r.GetInt64(1);
                if (seen.Add(id)) ids.Add(id);
            }
        }

        var current = new Dictionary<long, object?[]>();
        foreach (var chunk in ids.Chunk(500))
        {
            using var cmd = c.CreateCommand();
            cmd.Transaction = tx;
            var sb = new StringBuilder($"SELECT {Schema.SelectList} FROM Records WHERE Id IN (");
            for (int i = 0; i < chunk.Length; i++)
            {
                sb.Append(i == 0 ? "@p" : ",@p").Append(i);
                cmd.Parameters.AddWithValue("@p" + i, chunk[i]);
            }
            cmd.CommandText = sb.Append(')').ToString();
            using var r = cmd.ExecuteReader();
            while (r.Read()) { var row = ReadRow(r); current[Convert.ToInt64(row[0])] = row; }
        }

        var changes = ids.Select(id => current.TryGetValue(id, out var row)
            ? new Change("upsert", id, row)
            : new Change("delete", id, null)).ToList();
        return new ChangeBatch(upTo, changes, false);
    }

    /// <summary>Catch-up for a reconnecting client.</summary>
    public ChangeBatch GetChangesSince(long seq)
    {
        long cur, min;
        using (var c = Open())
        {
            cur = CurrentSeq(c, null);
            min = Scalar<long?>(c, "SELECT MIN(Seq) FROM ChangeLog") ?? cur + 1;
        }
        if (seq > cur || seq < min - 1) return new ChangeBatch(cur, [], true);
        return BuildBatch(seq);
    }

    public void PruneChangeLog()
    {
        using var c = Open();
        Exec(c, "DELETE FROM ChangeLog WHERE ChangedAt < datetime('now','-1 hour')");
    }

    private static object?[] ReadRow(SqliteDataReader r)
    {
        var row = new object?[r.FieldCount];
        for (int i = 0; i < row.Length; i++) row[i] = r.IsDBNull(i) ? null : r.GetValue(i);
        return row;
    }

    // ---------- writes (used by the API and the simulator) ----------

    public long Insert(IDictionary<string, object?> values)
    {
        using var c = Open();
        return Insert(c, null, values);
    }

    private static long Insert(SqliteConnection c, SqliteTransaction? tx, IDictionary<string, object?> values)
    {
        var data = Schema.DataColumns.Where(x => values.ContainsKey(x.Name)).ToList();
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = data.Count == 0
            ? "INSERT INTO Records DEFAULT VALUES; SELECT last_insert_rowid();"
            : $"INSERT INTO Records ({string.Join(",", data.Select(x => x.Name))}) VALUES ({string.Join(",", data.Select(x => "@" + x.Name))}); SELECT last_insert_rowid();";
        foreach (var x in data) cmd.Parameters.AddWithValue("@" + x.Name, values[x.Name] ?? DBNull.Value);
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    public bool Update(long id, IDictionary<string, object?> values)
    {
        using var c = Open();
        return Update(c, null, id, values);
    }

    private static bool Update(SqliteConnection c, SqliteTransaction? tx, long id, IDictionary<string, object?> values)
    {
        var data = Schema.DataColumns.Where(x => values.ContainsKey(x.Name)).ToList();
        if (data.Count == 0) return false;
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = $"UPDATE Records SET {string.Join(",", data.Select(x => $"{x.Name}=@{x.Name}"))} WHERE Id=@id";
        foreach (var x in data) cmd.Parameters.AddWithValue("@" + x.Name, values[x.Name] ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    public bool Delete(long id)
    {
        using var c = Open();
        return Delete(c, null, id);
    }

    private static bool Delete(SqliteConnection c, SqliteTransaction? tx, long id)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "DELETE FROM Records WHERE Id=@id";
        cmd.Parameters.AddWithValue("@id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    /// <summary>Applies n random operations (80% update, 10% insert, 10% delete) in one transaction.</summary>
    public void RunRandomOps(int n, Random rnd)
    {
        using var c = Open();
        using var tx = c.BeginTransaction();
        long maxId = Scalar<long?>(c, "SELECT MAX(Id) FROM Records", tx) ?? 0;
        for (int i = 0; i < n; i++)
        {
            double p = rnd.NextDouble();
            if (p < 0.10 || maxId == 0)
            {
                var vals = RandomData.Row(rnd);
                var dict = new Dictionary<string, object?>();
                for (int j = 0; j < vals.Length; j++) dict[Schema.DataColumns[j].Name] = vals[j];
                Insert(c, tx, dict);
                continue;
            }

            long id = PickId(c, tx, rnd, maxId);
            if (id == 0) continue;
            if (p < 0.20) { Delete(c, tx, id); continue; }

            var changes = new Dictionary<string, object?>();
            int k = rnd.Next(1, 4);
            for (int j = 0; j < k; j++)
            {
                var col = RandomData.Mutable[rnd.Next(RandomData.Mutable.Length)];
                changes[col] = RandomData.Generators[col](rnd);
            }
            changes["UpdatedDate"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");
            Update(c, tx, id, changes);
        }
        tx.Commit();
    }

    private static long PickId(SqliteConnection c, SqliteTransaction tx, Random rnd, long maxId)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "SELECT Id FROM Records WHERE Id >= @x ORDER BY Id LIMIT 1";
        cmd.Parameters.AddWithValue("@x", rnd.NextInt64(1, maxId + 1));
        var o = cmd.ExecuteScalar();
        return o is null ? 0 : Convert.ToInt64(o);
    }

    // ---------- helpers ----------

    private static void Exec(SqliteConnection c, string sql)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static T Scalar<T>(SqliteConnection c, string sql, SqliteTransaction? tx = null)
    {
        using var cmd = c.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        var o = cmd.ExecuteScalar();
        if (o is null or DBNull) return default!;
        var t = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
        return (T)Convert.ChangeType(o, t);
    }
}
