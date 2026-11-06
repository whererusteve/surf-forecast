// Sun elevation above the horizon (degrees) for a place and time.
// Standard low-precision solar formula — accurate to well under a degree, plenty
// for deciding "is there enough light to surf?".

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function sunElevation(lat, lon, tMs) {
  const d = tMs / 864e5 + 2440587.5 - 2451545.0; // days since 1 Jan 2000, noon UTC
  const g = rad((357.529 + 0.98560028 * d) % 360);
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = rad(gmst * 15 + lon) - ra;
  const el = Math.asin(Math.sin(rad(lat)) * Math.sin(dec) + Math.cos(rad(lat)) * Math.cos(dec) * Math.cos(ha));
  return deg(el);
}

/** Surfable light: from roughly first light to last light. */
export function isDaylight(lat, lon, tMs) {
  return sunElevation(lat, lon, tMs) > -4;
}
