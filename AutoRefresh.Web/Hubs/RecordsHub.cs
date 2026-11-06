using AutoRefresh.Web.Data;
using Microsoft.AspNetCore.SignalR;

namespace AutoRefresh.Web.Hubs;

public sealed class RecordsHub(RecordRepository repo) : Hub
{
    /// <summary>Called by a client after (re)connecting to fetch whatever it missed.</summary>
    public ChangeBatch GetChangesSince(long seq) => repo.GetChangesSince(seq);
}
