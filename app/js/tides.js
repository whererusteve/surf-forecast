// Tide predictions for the selected spot's nearest station.
// BC: Fisheries and Oceans Canada (IWLS API). Washington: NOAA CO-OPS.
// Both give high/low times; we draw a smooth curve between them.

const cache = new Map();

export async function fetchTides(station, fromMs, toMs) {
  const key = `${station.src}:${station.id}`;
  if (cache.has(key)) return cache.get(key);
  // pad a day either side so the curve has highs/lows to interpolate between
  const from = new Date(fromMs - 864e5);
  const to = new Date(toMs + 864e5);
  let events;
  if (station.src === "dfo") {
    const iso = (d) => d.toISOString().slice(0, 19) + "Z";
    const url = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${station.id}/data` +
      `?time-series-code=wlp-hilo&from=${iso(from)}&to=${iso(to)}`;
    const data = await (await fetch(url)).json();
    events = data.map((e) => ({ t: Date.parse(e.eventDate), v: e.value }));
  } else {
    const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
    const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter" +
      `?station=${station.id}&product=predictions&datum=MLLW&time_zone=gmt&units=metric` +
      `&format=json&interval=hilo&begin_date=${ymd(from)}&end_date=${ymd(to)}&application=surf-forecast`;
    const data = await (await fetch(url)).json();
    events = (data.predictions || []).map((p) => ({
      t: Date.parse(p.t.replace(" ", "T") + ":00Z"), v: parseFloat(p.v), type: p.type,
    }));
  }
  events.sort((a, b) => a.t - b.t);
  // label highs and lows by comparing neighbours
  events.forEach((e, i) => {
    if (!e.type) {
      const nb = events[i + 1] || events[i - 1];
      e.type = nb && e.v > nb.v ? "H" : "L";
    }
  });
  cache.set(key, events);
  return events;
}

/** Tide height at time t (ms) using cosine interpolation between high/low events. */
export function tideAt(events, t) {
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
    }
  }
  return null;
}

/** "Rising" / "Falling" plus the next high or low. */
export function tideState(events, t) {
  const next = events.find((e) => e.t > t);
  if (!next) return null;
  return { rising: next.type === "H", next };
}
