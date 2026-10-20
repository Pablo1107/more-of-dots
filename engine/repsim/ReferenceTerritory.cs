namespace ReplaySim.Standalone;

// Native influence grid: x-major float32 sums, then stable side-order argmax.
// The contour and supply polygon phases are recovered separately.
internal sealed class ReferenceTerritory
{
    private readonly Replay replay;
    private readonly int width, height;
    private static readonly float[] DotKernel = Kernel(12, 3, 5);
    private static readonly float[] CityKernel = Kernel(90, 2, 1);
    // Replaced only when the grid changes, so callers can cache by reference.
    public byte[]? Regions { get; private set; }
    public int[] CityColors { get; }
    public HashSet<int> InfluenceUnits { get; private set; } = [];
    // The grid depends only on each influencing unit's cell and the city colors.
    private List<int> inputs = [], previousInputs = [];
    private byte[]? contourRegions;
    private List<Vec[]>[]? contours;

    public ReferenceTerritory(Replay replay)
    {
        this.replay = replay;
        width = replay.Map.Width / 10; height = replay.Map.Height / 10;
        CityColors = replay.Map.Cities.Select(city => replay.Units.MinBy(u => (u.Position - city).LengthSquared)!.Owner).ToArray();
    }

    public void Update(HashSet<int> influenceUnits)
    {
        InfluenceUnits = influenceUnits;
        // Repeating an update with the same inputs leaves the grid as it is.
        inputs.Clear();
        foreach (var unit in replay.Units)
            if (influenceUnits.Contains(unit.Id) && !unit.Ship) { inputs.Add(unit.Owner); inputs.Add((int)(unit.Position.X / 10)); inputs.Add((int)(unit.Position.Y / 10)); }
        inputs.Add(-1);
        inputs.AddRange(CityColors);
        if (Regions is not null && inputs.SequenceEqual(previousInputs)) return;
        (inputs, previousInputs) = (previousInputs, inputs);
        var influence = Enumerable.Range(0, replay.SideCount).Select(_ => new float[width * height]).ToArray();
        for (int side = 0; side < replay.SideCount; side++)
        {
            foreach (var unit in replay.Units)
                if (influenceUnits.Contains(unit.Id) && unit.Owner == side && !unit.Ship) Add(influence[side], unit.Position, DotKernel, 12);
            for (int city = 0; city < CityColors.Length; city++)
                if (CityColors[city] == side) Add(influence[side], replay.Map.Cities[city], CityKernel, 90);
        }
        var next = new byte[width * height];
        for (int i = 0; i < next.Length; i++)
        {
            float max = influence[0][i];
            for (int side = 1; side < replay.SideCount; side++) if (influence[side][i] >= max) { max = influence[side][i]; next[i] = (byte)side; }
            if (Regions is not null && next[i] != Regions[i] && max < 1e-5f)
                next[i] = Regions[i];
        }
        if (Regions is null || !next.AsSpan().SequenceEqual(Regions)) Regions = next;
        for (int i = 0; i < CityColors.Length; i++) CityColors[i] = OwnerAt(replay.Map.Cities[i]);
    }

    public int OwnerAt(Vec point) => Regions![Math.Clamp((int)(point.X / 10), 0, width - 1) * height + Math.Clamp((int)(point.Y / 10), 0, height - 1)];

    /// The same lists are returned until the grid changes. Callers must not modify them.
    public List<Vec[]>[] Contours()
    {
        if (contours is null || !ReferenceEquals(contourRegions, Regions))
        {
            contourRegions = Regions;
            contours = Enumerable.Range(0, replay.SideCount).Select(side => ReferenceContours.Extract(Regions!, side, width, height)).ToArray();
        }
        return contours;
    }

    public (List<List<int>>[] Dots, List<List<int>>[] Cities) GridGroups()
    {
        var dots = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        var cities = Enumerable.Range(0, replay.SideCount).Select(_ => new List<List<int>>()).ToArray();
        var contours = Contours();
        for (int side = 0; side < replay.SideCount; side++)
        for (int i = 0; i < contours[side].Count; i++)
        {
            var polygon = contours[side][i];
            var children = contours[side].Where(other => ReferenceContours.Inside(other[0], polygon)).ToArray();
            bool InGroup(Vec p) => ReferenceContours.Inside(p, polygon) && !children.Any(child => ReferenceContours.Inside(p, child));
            dots[side].Add(replay.Units.Where(u => InfluenceUnits.Contains(u.Id) && u.Owner == side && InGroup(u.Position)).Select(u => u.Id).ToList());
            cities[side].Add(Enumerable.Range(0, CityColors.Length).Where(city => CityColors[city] == side && InGroup(replay.Map.Cities[city])).ToList());
        }
        return (dots, cities);
    }

    private void Add(float[] influence, Vec point, float[] kernel, int radius)
    {
        int centerX = (int)(point.X / 10), centerY = (int)(point.Y / 10), size = 2 * radius + 1;
        int top = Math.Max(0, centerY - radius), length = Math.Min(height - 1, centerY + radius) - top + 1;
        if (length <= 0) return;
        // Each cell is a separate float32 sum, so adding a column in vectors gives the
        // same values in the same order as one cell at a time.
        int lanes = System.Numerics.Vector<float>.Count;
        for (int x = Math.Max(0, centerX - radius); x <= Math.Min(width - 1, centerX + radius); x++)
        {
            var target = influence.AsSpan(x * height + top, length);
            var source = kernel.AsSpan((x - centerX + radius) * size + top - centerY + radius, length);
            int y = 0;
            for (; y <= length - lanes; y += lanes)
                (new System.Numerics.Vector<float>(target[y..]) + new System.Numerics.Vector<float>(source[y..])).CopyTo(target[y..]);
            for (; y < length; y++) target[y] += source[y];
        }
    }

    private static float[] Kernel(int radius, int power, double strength)
    {
        int size = 2 * radius + 1;
        var result = new float[size * size];
        for (int x = -radius; x <= radius; x++)
        for (int y = -radius; y <= radius; y++)
            result[(x + radius) * size + y + radius] = (float)(strength / (1 + Math.Pow(x * x + y * y, power)));
        return result;
    }
}
