// Pure helpers: no I/O, safe to import from tests.

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(v) {
  return typeof v === 'string' && VIDEO_ID_RE.test(v);
}

// XML text/attribute escaping. Emoji and other non-ASCII pass through as UTF-8.
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Raw (still escaped) inner text of the first <Name>, tolerant of a namespace
// prefix (<u:Name>, <dc:title>) and of self-closing tags. Returns null if absent.
export function rawTag(xml, name) {
  const n = reEscape(name);
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${n}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${n}>)`);
  const m = re.exec(xml);
  if (!m) return null;
  return m[1] ?? '';
}

// Unescaped inner text of the first <Name>, or null.
export function parseTag(xml, name) {
  const raw = rawTag(xml, name);
  return raw === null ? null : unescapeXml(raw);
}

// Attributes of an XML start tag string, values unescaped.
export function parseAttrs(tagText) {
  const attrs = {};
  const re = /([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagText))) attrs[m[1]] = unescapeXml(m[2] ?? m[3] ?? '');
  return attrs;
}

// "H:MM:SS" (also "MM:SS", "H:MM:SS.mmm") to seconds. Anything unparseable
// (NOT_IMPLEMENTED, empty) is 0.
export function hmsToSeconds(value) {
  if (typeof value !== 'string') return 0;
  const s = value.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return 0;
  const parts = s.split(':').map(Number);
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return Math.floor(total);
}

export function secondsToHms(seconds) {
  const t = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Parse a Range header against a file size.
// Returns null (no usable range, serve the whole file), 'unsatisfiable',
// or { start, end } inclusive. Only the first range of a multi-range header is used.
export function parseRange(header, size) {
  if (!header || typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!m) return null;
  const first = m[1].split(',')[0].trim();
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (!r) return null;
  const [, a, b] = r;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return null;
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

// DIDL-Lite metadata for one track. Values are escaped here once; the caller
// escapes the whole document again when it goes inside the SOAP envelope.
export function buildDidl({ uri, title, creator, albumArtUri, durationSeconds }) {
  const dur = durationSeconds ? ` duration="${secondsToHms(durationSeconds)}"` : '';
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    '<item id="-1" parentID="-1" restricted="true">' +
    `<res protocolInfo="http-get:*:audio/mpeg:*"${dur}>${escapeXml(uri)}</res>` +
    `<dc:title>${escapeXml(title || 'YouTube audio')}</dc:title>` +
    (creator ? `<dc:creator>${escapeXml(creator)}</dc:creator>` : '') +
    (albumArtUri ? `<upnp:albumArtURI>${escapeXml(albumArtUri)}</upnp:albumArtURI>` : '') +
    '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
    '</item></DIDL-Lite>'
  );
}

export function buildSoapEnvelope(service, action, args = {}) {
  const body = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}>` +
    '</s:Body></s:Envelope>'
  );
}

const UPNP_ERRORS = {
  401: 'the speaker did not recognise that command',
  402: 'the speaker rejected the request as invalid',
  701: 'the speaker is not in a state to do that right now',
  711: 'the speaker could not seek to that point',
  712: 'the speaker does not support that play mode',
  714: 'the speaker could not play that kind of audio',
  716: 'the speaker could not find that track',
  718: 'the speaker rejected that position',
  800: 'the speaker refused the command',
};

// Parse a SOAP body. Returns { fault: null, values } or { fault: { code, message } }.
export function parseSoapResponse(xml, action) {
  if (/<(?:[A-Za-z0-9_]+:)?Fault[\s>]/.test(xml)) {
    const code = Number(parseTag(xml, 'errorCode')) || null;
    const detail = parseTag(xml, 'errorDescription') || parseTag(xml, 'faultstring') || '';
    const message = (code && UPNP_ERRORS[code]) || detail || 'the speaker returned an error';
    return { fault: { code, message } };
  }
  const inner = rawTag(xml, `${action}Response`);
  const values = {};
  if (inner) {
    const re = /<([A-Za-z0-9_]+)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let m;
    while ((m = re.exec(inner))) values[m[1]] = unescapeXml(m[2] ?? '');
  }
  return { fault: null, values };
}

// Pull the visible groups out of a ZoneGroupState document (already unescaped once).
export function parseZoneGroupState(stateXml) {
  const groups = [];
  const groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/g;
  let g;
  while ((g = groupRe.exec(stateXml))) {
    const gAttrs = parseAttrs(g[1]);
    const members = [];
    const memberRe = /<ZoneGroupMember\b([^>]*?)\/?>/g;
    let m;
    while ((m = memberRe.exec(g[2]))) {
      const a = parseAttrs(m[1]);
      if (a.Invisible === '1') continue;
      let ip = null;
      try { ip = new URL(a.Location).hostname; } catch { /* ignore */ }
      members.push({ uuid: a.UUID, name: a.ZoneName, ip });
    }
    if (!members.length) continue;
    const coordinator = gAttrs.Coordinator;
    members.sort((x, y) => (x.uuid === coordinator ? -1 : y.uuid === coordinator ? 1 : 0));
    const coord = members.find((x) => x.uuid === coordinator);
    if (!coord) continue;
    groups.push({
      id: coordinator,
      name: members.map((x) => x.name).join(' + '),
      coordinatorIp: coord.ip,
      members,
    });
  }
  return groups;
}

// Which of our videos (if any) a Sonos TrackURI points at.
export function ourVideoIdFromUri(uri, ourHosts, port) {
  if (!uri) return null;
  let u;
  try { u = new URL(uri); } catch { return null; }
  if (u.protocol !== 'http:' || String(u.port) !== String(port)) return null;
  if (!ourHosts.includes(u.hostname)) return null;
  const m = /^\/stream\/([A-Za-z0-9_-]{11})\.mp3$/.exec(u.pathname);
  return m ? m[1] : null;
}
