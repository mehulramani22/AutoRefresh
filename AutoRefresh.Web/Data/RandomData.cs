namespace AutoRefresh.Web.Data;

/// <summary>Generates realistic-looking random values for seeding and for the change simulator.</summary>
public static class RandomData
{
    private static readonly string[] First = ["Aarav", "Olivia", "Liam", "Emma", "Noah", "Sofia", "Mehul", "Priya", "Ethan", "Mia", "Lucas", "Ava", "Arjun", "Isha", "Daniel", "Chloe", "Rohan", "Zara", "Kenji", "Elena"];
    private static readonly string[] Last = ["Sharma", "Smith", "Johnson", "Patel", "Brown", "Garcia", "Ramani", "Miller", "Davis", "Khan", "Wilson", "Lopez", "Tanaka", "Rossi", "Muller", "Singh", "Clark", "Nguyen", "Cohen", "Silva"];
    private static readonly string[] Companies = ["Acme Corp", "Globex", "Initech", "Umbrella", "Hooli", "Stark Industries", "Wayne Enterprises", "Wonka", "Cyberdyne", "Soylent", "Vandelay", "Tyrell"];
    private static readonly string[] Departments = ["Sales", "Finance", "Operations", "HR", "IT", "Legal", "Marketing", "Support"];
    private static readonly string[] Titles = ["Analyst", "Manager", "Director", "Associate", "Engineer", "Consultant", "Specialist", "Lead"];
    private static readonly string[] Streets = ["Main St", "Park Ave", "Oak Rd", "Maple Dr", "Cedar Ln", "Lake View", "Hill Rd", "Station Rd"];
    private static readonly string[] Cities = ["Mumbai", "Pune", "London", "New York", "Berlin", "Singapore", "Sydney", "Toronto", "Dublin", "Paris"];
    private static readonly string[] States = ["MH", "KA", "NY", "CA", "TX", "ENG", "NSW", "ON", "BE", "IDF"];
    private static readonly string[] Countries = ["India", "USA", "UK", "Germany", "Singapore", "Australia", "Canada", "Ireland", "France"];
    private static readonly string[] Statuses = ["New", "Open", "In Progress", "On Hold", "Resolved", "Closed"];
    private static readonly string[] Priorities = ["Low", "Medium", "High", "Critical"];
    private static readonly string[] Categories = ["Billing", "Delivery", "Quality", "Account", "Technical", "General"];
    private static readonly string[] Regions = ["APAC", "EMEA", "NA", "LATAM"];
    private static readonly string[] Words = ["follow up", "escalated", "awaiting reply", "verified", "duplicate", "priority client", "renewal", "audit", "migrated", "reviewed"];
    private static readonly string[] Tags = ["vip", "new", "churn-risk", "upsell", "partner", "trial", "legacy", "premium"];

    private static string Pick(Random r, string[] a) => a[r.Next(a.Length)];
    private static string Date(Random r, int minDays, int maxDays) => DateTime.UtcNow.Date.AddDays(r.Next(minDays, maxDays)).ToString("yyyy-MM-dd");

    /// <summary>Generators for each non-Id column, keyed by column name.</summary>
    public static readonly Dictionary<string, Func<Random, object?>> Generators = new(StringComparer.OrdinalIgnoreCase)
    {
        ["FirstName"] = r => Pick(r, First),
        ["LastName"] = r => Pick(r, Last),
        ["Email"] = r => $"{Pick(r, First).ToLowerInvariant()}.{Pick(r, Last).ToLowerInvariant()}{r.Next(1000)}@example.com",
        ["Phone"] = r => $"+{r.Next(1, 99)}-{r.Next(100, 999)}-{r.Next(1000, 9999)}",
        ["Company"] = r => Pick(r, Companies),
        ["Department"] = r => Pick(r, Departments),
        ["JobTitle"] = r => Pick(r, Titles),
        ["Address"] = r => $"{r.Next(1, 999)} {Pick(r, Streets)}",
        ["City"] = r => Pick(r, Cities),
        ["State"] = r => Pick(r, States),
        ["Country"] = r => Pick(r, Countries),
        ["PostalCode"] = r => r.Next(10000, 99999).ToString(),
        ["Status"] = r => Pick(r, Statuses),
        ["Priority"] = r => Pick(r, Priorities),
        ["Category"] = r => Pick(r, Categories),
        ["Region"] = r => Pick(r, Regions),
        ["Amount"] = r => Math.Round(r.NextDouble() * 100000, 2),
        ["Quantity"] = r => (long)r.Next(1, 500),
        ["Discount"] = r => Math.Round(r.NextDouble() * 30, 2),
        ["Tax"] = r => Math.Round(r.NextDouble() * 18, 2),
        ["Score"] = r => (long)r.Next(0, 101),
        ["Rating"] = r => Math.Round(1 + r.NextDouble() * 4, 1),
        ["IsActive"] = r => (long)(r.Next(10) < 8 ? 1 : 0),
        ["IsVerified"] = r => (long)(r.Next(10) < 6 ? 1 : 0),
        ["CreatedDate"] = r => Date(r, -1095, 0),
        ["UpdatedDate"] = r => DateTime.UtcNow.AddMinutes(-r.Next(0, 100000)).ToString("yyyy-MM-ddTHH:mm:ss"),
        ["DueDate"] = r => Date(r, 0, 365),
        ["Notes"] = r => $"{Pick(r, Words)} #{r.Next(1000)}",
        ["Tags"] = r => $"{Pick(r, Tags)},{Pick(r, Tags)}",
    };

    /// <summary>Columns the simulator may mutate when it "updates" a row.</summary>
    public static readonly string[] Mutable =
    [
        "Status", "Priority", "Category", "City", "Amount", "Quantity", "Discount", "Tax",
        "Score", "Rating", "IsActive", "IsVerified", "DueDate", "Notes", "Tags",
    ];

    public static object?[] Row(Random r) => Schema.DataColumns.Select(c => Generators[c.Name](r)).ToArray();
}
