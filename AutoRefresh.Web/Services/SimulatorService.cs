using AutoRefresh.Web.Data;

namespace AutoRefresh.Web.Services;

/// <summary>Demo helper: writes random updates/inserts/deletes straight to the database at a chosen rate.</summary>
public sealed class SimulatorService(RecordRepository repo, ILogger<SimulatorService> log) : BackgroundService
{
    private volatile int _rate;

    public bool Running => _rate > 0;
    public int Rate => _rate;

    public void Start(int opsPerSecond) => _rate = Math.Clamp(opsPerSecond, 1, 200);
    public void Stop() => _rate = 0;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var rnd = new Random();
        const double tickSeconds = 0.25;
        double credit = 0;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(tickSeconds));
        while (await timer.WaitForNextTickAsync(ct))
        {
            int rate = _rate;
            if (rate == 0) { credit = 0; continue; }
            credit += rate * tickSeconds;
            int n = (int)credit;
            if (n == 0) continue;
            credit -= n;
            try { repo.RunRandomOps(n, rnd); }
            catch (Exception ex) { log.LogError(ex, "Simulator tick failed."); }
        }
    }
}
