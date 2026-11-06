using AutoRefresh.Web.Data;
using AutoRefresh.Web.Hubs;
using AutoRefresh.Web.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllersWithViews();
builder.Services.AddSignalR();
builder.Services.AddResponseCompression(o => o.EnableForHttps = true);
builder.Services.AddSingleton<RecordRepository>();
builder.Services.AddSingleton<SimulatorService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SimulatorService>());
builder.Services.AddHostedService<ChangeNotifier>();

var app = builder.Build();

app.Services.GetRequiredService<RecordRepository>().Initialize();

app.UseResponseCompression();
app.UseStaticFiles();
app.UseRouting();

app.MapControllers();
app.MapHub<RecordsHub>("/hubs/records");
app.MapControllerRoute("default", "{controller=Home}/{action=Index}/{id?}");

app.Run();
