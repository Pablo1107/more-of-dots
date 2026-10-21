using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ReplaySim.Standalone;

// Terrain images do not contain unit IDs, types, cities or capitals. Number-only
// recordings need a deployment catalog as well as their PNG. Keep explicit map
// objects authoritative: custom scenarios may reuse an official terrain image.
internal static class BuiltInDeployments
{
    // Match format and simulation rules are separate: two teammates share each
    // color in 2v2, so its deployment is the same as a classic 1v1.
    internal static string NormalizeMode(string? mode) => mode?.Trim().ToLowerInvariant() ?? "";

    internal static string RulesMode(string? mode) => NormalizeMode(mode) switch
    {
        "experiment" => "experiment",
        "avalanche" => "avalanche",
        _ => "classic",
    };

    private static readonly Lazy<JsonElement> Catalog = new(() =>
    {
        using var stream = typeof(BuiltInDeployments).Assembly.GetManifestResourceStream("replay-deployments")
            ?? throw new InvalidOperationException("The built-in deployment catalog is missing.");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    });

    internal static bool TryResolve(JsonElement id, string? mode, out JsonElement map)
    {
        map = default;
        string? text = id.ValueKind switch
        {
            JsonValueKind.String => id.GetString(),
            JsonValueKind.Number => id.GetRawText(),
            _ => null,
        };
        if (!int.TryParse(text?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out int number)) return false;
        // Special modes need their saved layout. A multi-color match may use
        // the classic catalog only when that roster has the requested colors.
        string? profile = NormalizeMode(mode) switch
        {
            "" or "1v1" or "2v2" or "classic" or "experiment" or "avalanche" => RulesMode(mode),
            "v3" or "v4" => "classic",
            _ => null,
        };
        if (profile is null || !Catalog.Value.TryGetProperty(number.ToString(CultureInfo.InvariantCulture), out var entry)
            || !(entry.TryGetProperty(profile, out map) || TryConvert(entry, profile, out map))) return false;
        int requiredColors = NormalizeMode(mode) switch { "v3" => 3, "v4" => 4, _ => 0 };
        if (requiredColors > 0 && (!map.TryGetProperty("infantry", out var infantry)
            || infantry.GetArrayLength() != requiredColors))
        {
            map = default;
            return false;
        }
        return true;
    }

    // Classic and experimental matches share one layout. Experimental turns every
    // fifth infantry, counted back from the last and never the first, into motorised,
    // listed last first; tanks, cities, capitals and bridges are unchanged. This holds
    // on both sides of all 33 maps the catalog recovered in both modes, so a map known
    // in one mode is converted to the other.
    internal static bool TryConvert(JsonElement entry, string profile, out JsonElement map)
    {
        map = default;
        string source = profile switch { "classic" => "experiment", "experiment" => "classic", _ => "" };
        if (source.Length == 0 || !entry.TryGetProperty(source, out var known)) return false;
        var layout = JsonNode.Parse(known.GetRawText())!.AsObject();
        if (layout["infantry"] is not JsonArray infantry) return false;
        var motorised = layout["motorised"] as JsonArray;
        var sidesInfantry = new JsonArray();
        var sidesMotorised = new JsonArray();
        for (int side = 0; side < infantry.Count; side++)
        {
            var units = (infantry[side] as JsonArray ?? []).Select(unit => unit?.DeepClone()).ToList();
            var fast = (motorised?.ElementAtOrDefault(side) as JsonArray ?? []).Select(unit => unit?.DeepClone()).ToList();
            if (profile == "classic")
            {
                var merged = new JsonNode?[units.Count + fast.Count];
                var taken = new bool[merged.Length];
                for (int i = 0; i < fast.Count; i++)
                {
                    int at = merged.Length - 1 - 5 * i;
                    if (at < 1) return false;
                    (merged[at], taken[at]) = (fast[i], true);
                }
                int next = 0;
                for (int at = 0; at < merged.Length; at++)
                    if (!taken[at]) merged[at] = units[next++];
                sidesInfantry.Add(new JsonArray(merged));
                sidesMotorised.Add(new JsonArray());
            }
            else
            {
                if (fast.Count > 0) return false;
                bool converted(int at) => at >= 1 && (units.Count - 1 - at) % 5 == 0;
                sidesInfantry.Add(new JsonArray(units.Where((_, at) => !converted(at)).ToArray()));
                sidesMotorised.Add(new JsonArray(units.Where((_, at) => converted(at)).Reverse().ToArray()));
            }
        }
        layout["infantry"] = sidesInfantry;
        layout["motorised"] = sidesMotorised;
        map = JsonDocument.Parse(layout.ToJsonString()).RootElement.Clone();
        return true;
    }
}
