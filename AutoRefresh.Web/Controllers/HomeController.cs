using Microsoft.AspNetCore.Mvc;

namespace AutoRefresh.Web.Controllers;

public sealed class HomeController : Controller
{
    public IActionResult Index() => View();
}
