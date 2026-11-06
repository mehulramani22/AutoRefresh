using Microsoft.AspNetCore.Mvc;

namespace AutoRefresh.Web.Controllers;

public sealed class HomeController : Controller
{
    public IActionResult Index() => View();

    /// <summary>Same live grid rendered by DataTables.js (the default page uses the custom grid).</summary>
    [HttpGet("/datatable")]
    public IActionResult DataTable() => View();
}
