namespace AutoRefresh.Web.Data;

/// <summary>Column definition. Kind drives client formatting/sorting: int, decimal, text, bool, date, datetime.</summary>
public sealed record Col(string Name, string Sql, string Kind);

public static class Schema
{
    /// <summary>The 30 columns of the Records table (Id + 29 data columns).</summary>
    public static readonly Col[] Columns =
    [
        new("Id", "INTEGER PRIMARY KEY AUTOINCREMENT", "int"),
        new("FirstName", "TEXT", "text"),
        new("LastName", "TEXT", "text"),
        new("Email", "TEXT", "text"),
        new("Phone", "TEXT", "text"),
        new("Company", "TEXT", "text"),
        new("Department", "TEXT", "text"),
        new("JobTitle", "TEXT", "text"),
        new("Address", "TEXT", "text"),
        new("City", "TEXT", "text"),
        new("State", "TEXT", "text"),
        new("Country", "TEXT", "text"),
        new("PostalCode", "TEXT", "text"),
        new("Status", "TEXT", "text"),
        new("Priority", "TEXT", "text"),
        new("Category", "TEXT", "text"),
        new("Region", "TEXT", "text"),
        new("Amount", "REAL", "decimal"),
        new("Quantity", "INTEGER", "int"),
        new("Discount", "REAL", "decimal"),
        new("Tax", "REAL", "decimal"),
        new("Score", "INTEGER", "int"),
        new("Rating", "REAL", "decimal"),
        new("IsActive", "INTEGER", "bool"),
        new("IsVerified", "INTEGER", "bool"),
        new("CreatedDate", "TEXT", "date"),
        new("UpdatedDate", "TEXT", "datetime"),
        new("DueDate", "TEXT", "date"),
        new("Notes", "TEXT", "text"),
        new("Tags", "TEXT", "text"),
    ];

    public static readonly Col[] DataColumns = Columns.Skip(1).ToArray();

    public static readonly Dictionary<string, Col> ByName =
        Columns.ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);

    public static string SelectList => string.Join(", ", Columns.Select(c => c.Name));
}
