using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace ReplaySim.Standalone;

/// The compact playback output (docs/replay-frames.md): the static record once, then
/// deflated chunks of binary frames that hold only what the player draws. The first
/// frame of each chunk is complete; later frames repeat paths, contours and the
/// economy only when they change.
internal sealed partial class Simulator
{
    internal static readonly byte[] FrameMagic = "WODFRM1\n"u8.ToArray();
    internal const byte StaticRecord = 1, ChunkRecord = 2, BinaryFrames = 1;
    internal const int ChunkFrames = 60;
    // Fading deaths are drawn for 75 frames.
    private const int DeathWindow = 100;
    private static readonly string[] UnitTypes = ["infantry", "tank", "motorised"];
    private static readonly string[] Terrains = ["plain", "forest", "sand", "river", "mountain", "bridge", "hill", "snow", "mud", "city"];

    private readonly record struct Death(int Frame, Vec Position, int Color, string Type, bool Ship);
    private readonly List<Death> deaths = [];

    public long WriteChunks(Stream output, Options options)
    {
        if (!options.RenderState) throw new ArgumentException("Binary frames need render state.");
        renderState = true;
        output.Write(FrameMagic);
        var header = new StringWriter();
        WriteStatic(header);
        WriteRecord(output, StaticRecord, Encoding.UTF8.GetBytes(header.ToString().TrimEnd()));
        var chunk = new ChunkBuilder();
        long frames = 0;
        try
        {
            Run(options, frame =>
            {
                WriteFrame(chunk, frame);
                chunk.Add(frame, FightCount, TakeProducedSides());
                frames++;
                // The first frame goes out alone so playback can start at once.
                if (frames == 1 || chunk.Count == ChunkFrames) chunk.Flush(output);
            });
        }
        finally
        {
            // Frames simulated before a failure stay playable.
            chunk.Flush(output);
        }
        return frames;
    }

    internal static void WriteRecord(Stream output, byte kind, ReadOnlySpan<byte> payload)
    {
        Span<byte> header = stackalloc byte[5];
        header[0] = kind;
        BinaryPrimitives.WriteUInt32LittleEndian(header[1..], (uint)payload.Length);
        output.Write(header);
        output.Write(payload);
    }

    private void WriteFrame(ChunkBuilder chunk, int frame)
    {
        var w = chunk.Frames;
        bool key = chunk.Count == 0;
        if (key) chunk.Paths.Clear();
        w.Write((uint)frame);
        int live = 0;
        foreach (var u in replay.Units) if (u.Active && u.Health > 0) live++;
        w.Write((ushort)live);
        foreach (var u in replay.Units)
        {
            if (!u.Active || u.Health <= 0) continue;
            w.Write((ushort)u.Id);
            w.Write((byte)u.Owner);
            w.Write((byte)Math.Max(0, Array.IndexOf(UnitTypes, u.Type)));
            w.Write((byte)((u.Ship ? 1 : 0) | (u.InCity ? 2 : 0) | (u.Healing ? 4 : 0)));
            w.Write((byte)Math.Max(0, Array.IndexOf(Terrains, u.Terrain)));
            w.Write((ushort)Math.Min(u.WaterTimer, ushort.MaxValue));
            w.Write((ushort)Math.Min(u.ShipTimer, ushort.MaxValue));
            w.Write((float)u.Position.X); w.Write((float)u.Position.Y);
            // Health picks the unit's sprite at exact thresholds, so it keeps full precision.
            w.Write(u.Health); w.Write((float)u.MaxHealth); w.Write((float)u.Morale);
            w.Write((float)u.Facing.X); w.Write((float)u.Facing.Y);
            w.Write((float)u.FirstVisualDirection.X); w.Write((float)u.FirstVisualDirection.Y);
            w.Write((float)u.VisualDirection.X); w.Write((float)u.VisualDirection.Y);
            w.Write((float)u.FirstVibration); w.Write((float)u.SecondVibration);
            var path = System.Runtime.InteropServices.CollectionsMarshal.AsSpan(u.Path)[Math.Min(u.PathIndex, u.Path.Count)..];
            if (chunk.Paths.TryGetValue(u.Id, out var previous) && previous.AsSpan().SequenceEqual(path)) w.Write(ushort.MaxValue);
            else
            {
                chunk.Paths[u.Id] = path.ToArray();
                w.Write((ushort)path.Length);
                foreach (var p in path) { w.Write((float)p.X); w.Write((float)p.Y); }
            }
        }
        // A complete frame carries the deaths that are still fading; the others add new ones.
        var recent = key ? deaths.Where(d => frame - d.Frame < DeathWindow).ToList() : deaths.Skip(chunk.Deaths).ToList();
        chunk.Deaths = deaths.Count;
        w.Write((ushort)recent.Count);
        foreach (var d in recent)
        {
            w.Write((uint)d.Frame); w.Write((byte)d.Color); w.Write((byte)Math.Max(0, Array.IndexOf(UnitTypes, d.Type)));
            w.Write((byte)(d.Ship ? 1 : 0)); w.Write((float)d.Position.X); w.Write((float)d.Position.Y);
        }
        var contours = territory.Regions is null ? null : territory.Contours();
        string core = CoreJson(chunk.Text);
        bool contoursChanged = key || !ReferenceEquals(contours, chunk.Contours), coreChanged = key || core != chunk.Core;
        w.Write((byte)((contoursChanged ? 1 : 0) | (coreChanged ? 2 : 0)));
        if (contoursChanged)
        {
            chunk.Contours = contours;
            w.Write((byte)(contours?.Length ?? 0));
            foreach (var side in contours ?? [])
            {
                w.Write((ushort)side.Count);
                foreach (var polygon in side)
                {
                    // Neighbouring sides share these vertices exactly; front lines match them.
                    w.Write((uint)polygon.Length);
                    foreach (var p in polygon) { w.Write(p.X); w.Write(p.Y); }
                }
            }
        }
        if (coreChanged)
        {
            chunk.Core = core;
            var bytes = Encoding.UTF8.GetBytes(core);
            w.Write((uint)bytes.Length);
            w.Write(bytes);
        }
    }

    // Written by hand: this runs every frame to find out whether anything changed.
    private string CoreJson(StringWriter writer)
    {
        writer.GetStringBuilder().Clear();
        writer.Write("{\"economy\":{\"fields\":{\"zrtyz\":"); WriteNumbers(writer, economy.Funds);
        writer.Write(",\"zasdxz\":"); WriteList(writer, economy.Balances, WriteNumbers);
        writer.Write(",\"industrial_zone\":"); WriteList(writer, economy.IndustrialZones, WriteIntegers);
        writer.Write(",\"city_enc\":"); WriteList(writer, economy.HasPaid ? economy.CityGroups : [], (w, groups) => WriteList(w, groups, WriteIntegers));
        writer.Write("}},\"troop_casualties\":"); WriteIntegers(writer, troopCasualties);
        writer.Write(",\"strength\":"); WriteIntegers(writer, strength);
        writer.Write(",\"capitals\":[");
        bool first = true;
        for (int side = 0; side < economy.Capitals.Length; side++)
        {
            int city = economy.Capitals[side];
            if (!economy.IsCity(city)) continue;
            if (!first) writer.Write(',');
            first = false;
            writer.Write("{\"position\":"); WriteVec(writer, replay.Map.Cities[city]);
            writer.Write(",\"color\":"); writer.Write(side); writer.Write(",\"city_index\":"); writer.Write(city); writer.Write('}');
        }
        writer.Write("],\"city_colors\":"); WriteIntegers(writer, territory.CityColors);
        writer.Write('}');
        return writer.ToString();
    }

    private static void WriteList<T>(TextWriter writer, IEnumerable<T> items, Action<TextWriter, T> write)
    {
        writer.Write('[');
        bool first = true;
        foreach (var item in items) { if (!first) writer.Write(','); first = false; write(writer, item); }
        writer.Write(']');
    }
    private static void WriteNumbers(TextWriter writer, IEnumerable<double> values) => WriteList(writer, values, WriteNumber);
    private static void WriteIntegers(TextWriter writer, IEnumerable<int> values) => WriteList(writer, values, (w, value) => w.Write(value));

    private sealed class ChunkBuilder
    {
        private readonly MemoryStream raw = new();
        private readonly List<(int Frame, int Fighting, int Produced)> header = [];
        public BinaryWriter Frames { get; }
        public int Count => header.Count;
        // What the previous frame of this chunk carried.
        public Dictionary<int, Vec[]> Paths { get; } = [];
        public List<Vec[]>[]? Contours;
        public string? Core;
        public StringWriter Text { get; } = new(System.Globalization.CultureInfo.InvariantCulture);
        public int Deaths;

        public ChunkBuilder() => Frames = new BinaryWriter(raw);

        private long complete;

        public void Add(int frame, int fighting, int produced)
        {
            header.Add((frame, fighting, produced));
            Frames.Flush();
            complete = raw.Length;
        }

        public void Flush(Stream output)
        {
            if (header.Count == 0) return;
            // A frame that failed while it was being written is left out.
            Frames.Flush();
            raw.SetLength(complete);
            var payload = new MemoryStream();
            using (var w = new BinaryWriter(payload, Encoding.UTF8, leaveOpen: true))
            {
                w.Write(BinaryFrames);
                w.Write((uint)header.Count);
                foreach (var row in header) w.Write((uint)row.Frame);
                foreach (var row in header) w.Write((uint)row.Fighting);
                foreach (var row in header) w.Write((uint)row.Produced);
            }
            using (var deflate = new DeflateStream(payload, CompressionLevel.Fastest, leaveOpen: true))
                raw.WriteTo(deflate);
            WriteRecord(output, ChunkRecord, payload.GetBuffer().AsSpan(0, (int)payload.Length));
            output.Flush();
            raw.SetLength(complete = 0);
            header.Clear();
        }
    }
}
