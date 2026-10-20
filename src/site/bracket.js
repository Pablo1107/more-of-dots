// Lays out a Challonge bracket from its match list. Rounds are numbered as
// Challonge numbers them: 1, 2, … for the winners bracket and -1, -2, … for the
// losers bracket; in a double elimination the last winners round is the grand
// final and its reset. A match's earlier matches are found by its players: each
// player arrived as the winner of a match in the round before.
export const box = { width: 196, height: 52, gap: 60, left: 40, top: 52 };

const winnerOf = (match) => (match.winner === 1 ? match.player1 : match.player2);
const loserOf = (match) => (match.winner === 1 ? match.player2 : match.player1);
const powerOfTwo = (n) => n > 0 && (n & (n - 1)) === 0;

/// The rounds of one side in column order, and the grand final matches.
export function sides(matches) {
  const double = matches.some((m) => m.round < 0);
  const rounds = (sign) =>
    [...new Set(matches.filter((m) => Math.sign(m.round) === sign).map((m) => m.round))].sort((a, b) => Math.abs(a) - Math.abs(b));
  const winners = rounds(1);
  const finalRound = double ? winners.pop() : null;
  return {
    winners,
    losers: rounds(-1),
    finals: matches.filter((m) => m.round === finalRound).sort((a, b) => a.id - b.id),
  };
}

/// Column titles as Challonge shows them.
export function roundName(round, { winners, losers }) {
  if (round < 0) return `Losers Round ${-round}`;
  const last = winners.at(-1);
  if (!losers.length) return round === last ? "Finals" : round === last - 1 ? "Semifinals" : `Round ${round}`;
  if (round > last) return "Finals";
  return round === last ? "Semifinals" : `Round ${round}`;
}

/// Boxes `{ match, x, y }` (y is the box's centre) and connector lines `{ x, y, w, h }`.
export function layout(matches, rounds, { spacing, offset }) {
  const { width, gap, left, top } = box;
  const byRound = new Map(rounds.map((r) => [r, matches.filter((m) => m.round === r).sort((a, b) => a.id - b.id)]));
  const place = new Map();
  rounds.forEach((round, column) => {
    const before = byRound.get(rounds[column - 1]) ?? [];
    for (const match of byRound.get(round))
      place.set(match, {
        match,
        x: left + column * (width + gap),
        from: [before.find((m) => winnerOf(m) === match.player1), before.find((m) => winnerOf(m) === match.player2)].filter(Boolean),
      });
  });
  // The first full round sets the spacing; earlier rounds sit beside the match
  // they feed and later rounds between the matches that feed them.
  const base = rounds.findIndex((r) => powerOfTwo(byRound.get(r).length));
  byRound.get(rounds[base]).forEach((m, k) => (place.get(m).y = top + k * spacing + spacing / 2));
  for (let column = base - 1; column >= 0; column--)
    byRound.get(rounds[column]).forEach((m, k) => {
      const next = byRound.get(rounds[column + 1]).find((n) => place.get(n).from.includes(m));
      place.get(m).y = next
        ? place.get(next).y + (winnerOf(m) === next.player1 ? -offset : offset)
        : top + k * spacing + spacing / 2;
    });
  for (let column = base + 1; column < rounds.length; column++)
    for (const m of byRound.get(rounds[column])) {
      const from = place.get(m).from.map((f) => place.get(f));
      place.get(m).y = from.length ? from.reduce((sum, f) => sum + f.y, 0) / from.length : top;
    }
  const boxes = rounds.flatMap((r) => byRound.get(r).map((m) => place.get(m)));
  const lines = [];
  for (const b of boxes) if (b.from.length) connect(lines, b, b.from.map((f) => place.get(f)));
  return { boxes, lines, height: top + byRound.get(rounds[base]).length * spacing + 24, place };
}

/// Elbow lines from the right edge of each earlier box to the left of `to`,
/// leaving room before `to` for its match number.
export function connect(lines, to, from) {
  const middle = to.x - box.gap / 2;
  for (const f of from) lines.push({ x: f.x + box.width, y: f.y - 1, w: middle - f.x - box.width, h: 2 });
  const ys = from.map((f) => f.y).concat(to.y);
  const low = Math.min(...ys),
    high = Math.max(...ys);
  if (high - low > 1) lines.push({ x: middle - 1, y: low - 1, w: 2, h: high - low + 2 });
  lines.push({ x: middle, y: to.y - 1, w: box.gap / 2 - 26, h: 2 });
}

/// Where a match's winner and loser play next, as match ids (null when out).
export function nextMatches(match, matches) {
  const { finals } = sides(matches);
  const plays = (m, name) => m.player1 === name || m.player2 === name;
  const first = (list) => list.sort((a, b) => Math.abs(a.round) - Math.abs(b.round) || a.id - b.id)[0]?.id ?? null;
  const winner = winnerOf(match);
  const final = finals.includes(match);
  const sameSide = final ? [] : matches.filter((m) =>
    !finals.includes(m) && Math.sign(m.round) === Math.sign(match.round) && Math.abs(m.round) > Math.abs(match.round) && plays(m, winner));
  const next = first(sameSide) ?? first(finals.filter((m) => m.id > match.id && plays(m, winner)));
  // Only the winners bracket drops its losers into the losers bracket.
  const drop = match.round > 0 && !final ? first(matches.filter((m) => m.round < 0 && plays(m, loserOf(match)))) : null;
  return { winner: next, loser: drop };
}
