using System.Text.Json;
using AutoRefresh.Web.Data;
using AutoRefresh.Web.Services;
using Microsoft.AspNetCore.Mvc;

namespace AutoRefresh.Web.Controllers;

[ApiController]
[Route("api")]
public sealed class ApiController(RecordRepository repo, SimulatorService sim) : ControllerBase
{
    /// <summary>Entire table in one call (rows as compact arrays) + the change-log position of the snapshot.</summary>
    [HttpGet("records")]
    public IActionResult GetAll() => Ok(repo.GetSnapshot());

    [HttpPost("records")]
    public IActionResult Create([FromBody] Dictionary<string, JsonElement> body)
    {
        var values = Convert(body);
        values.TryAdd("CreatedDate", DateTime.UtcNow.ToString("yyyy-MM-dd"));
        values["UpdatedDate"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");
        return Ok(new { id = repo.Insert(values) });
    }

    [HttpPut("records/{id:long}")]
    public IActionResult Update(long id, [FromBody] Dictionary<string, JsonElement> body)
    {
        var values = Convert(body);
        values["UpdatedDate"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss");
        return repo.Update(id, values) ? NoContent() : NotFound();
    }

    [HttpDelete("records/{id:long}")]
    public IActionResult Delete(long id) => repo.Delete(id) ? NoContent() : NotFound();

    // ----- simulator (demo only) -----

    [HttpGet("simulator")]
    public IActionResult SimStatus() => Ok(new { running = sim.Running, rate = sim.Rate });

    [HttpPost("simulator/start")]
    public IActionResult SimStart([FromQuery] int rate = 5)
    {
        sim.Start(rate);
        return Ok(new { running = sim.Running, rate = sim.Rate });
    }

    [HttpPost("simulator/stop")]
    public IActionResult SimStop()
    {
        sim.Stop();
        return Ok(new { running = sim.Running, rate = sim.Rate });
    }

    /// <summary>Maps JSON values onto column types; unknown columns and Id are ignored.</summary>
    private static Dictionary<string, object?> Convert(Dictionary<string, JsonElement> body)
    {
        var result = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, el) in body)
        {
            if (!Schema.ByName.TryGetValue(key, out var col) || col.Name == "Id") continue;
            if (el.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) { result[col.Name] = null; continue; }
            result[col.Name] = col.Kind switch
            {
                "bool" => el.ValueKind == JsonValueKind.True || (el.ValueKind == JsonValueKind.Number && el.GetDouble() != 0) ? 1L : 0L,
                "int" => el.ValueKind == JsonValueKind.Number ? (long)el.GetDouble() : long.TryParse(el.ToString(), out var l) ? l : null,
                "decimal" => el.ValueKind == JsonValueKind.Number ? el.GetDouble() : double.TryParse(el.ToString(), out var d) ? d : null,
                _ => el.ToString(),
            };
        }
        return result;
    }
}
