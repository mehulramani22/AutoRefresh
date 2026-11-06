using AutoRefresh.Web.Data;
using AutoRefresh.Web.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace AutoRefresh.Web.Services;

/// <summary>
/// Polls ChangeLog (populated by DB triggers) and pushes only the changed rows to all browsers.
/// </summary>
public sealed class ChangeNotifier(RecordRepository repo, IHubContext<RecordsHub> hub, ILogger<ChangeNotifier> log)
    : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(500);

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        long last = repo.CurrentSeq();
        var lastPrune = DateTime.UtcNow;
        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(ct))
        {
            try
            {
                var batch = repo.BuildBatch(last);
                if (batch.Changes.Count > 0)
                {
                    last = batch.UpToSeq;
                    await hub.Clients.All.SendAsync("recordsChanged", batch, ct);
                }

                if (DateTime.UtcNow - lastPrune > TimeSpan.FromMinutes(10))
                {
                    repo.PruneChangeLog();
                    lastPrune = DateTime.UtcNow;
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                log.LogError(ex, "Change polling failed; will retry.");
            }
        }
    }
}
