// Talking to Sonos speakers over their local UPnP/SOAP API (port 1400).

import dgram from 'node:dgram';
import {
  buildSoapEnvelope,
  parseSoapResponse,
  parseTag,
  parseZoneGroupState,
  hmsToSeconds,
  secondsToHms,
} from './util.js';

const SERVICES = {
  AVTransport: '/MediaRenderer/AVTransport/Control',
  RenderingControl: '/MediaRenderer/RenderingControl/Control',
  GroupRenderingControl: '/MediaRenderer/GroupRenderingControl/Control',
  ZoneGroupTopology: '/ZoneGroupTopology/Control',
};

export class SonosError extends Error {
  constructor(message, status = 502, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function soap(ip, service, action, args = {}, timeoutMs = 6000) {
  const body = buildSoapEnvelope(service, action, args);
  let res;
  let text;
  try {
    res = await fetch(`http://${ip}:1400${SERVICES[service]}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    const why = err?.cause?.code || err?.name || err?.message;
    throw new SonosError(`Couldn't reach the speaker at ${ip} (${why}).`, 504);
  }
  const parsed = parseSoapResponse(text, action);
  if (parsed.fault) {
    const c = parsed.fault.code ? ` (UPnP ${parsed.fault.code})` : '';
    throw new SonosError(`Sonos said ${parsed.fault.message}${c}.`, 502, parsed.fault.code);
  }
  if (!res.ok) throw new SonosError(`The speaker answered with HTTP ${res.status}.`, 502);
  return parsed.values;
}

// ---- Discovery --------------------------------------------------------------

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH =
  'M-SEARCH * HTTP/1.1\r\n' +
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 1\r\n' +
  'ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n';

// Returns a list of speaker IPs that answered, in answer order.
export function ssdpDiscover({ timeoutMs = 2500, localIp } = {}) {
  return new Promise((resolve) => {
    const found = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    let earlyTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(earlyTimer);
      try { sock.close(); } catch { /* ignore */ }
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    sock.on('error', (err) => {
      console.log(`[sonos] SSDP socket error: ${err.message}`);
      finish();
    });
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (!/ZonePlayer|Sonos/i.test(text)) return;
      const loc = /^location:\s*(\S+)/im.exec(text);
      let ip = rinfo.address;
      if (loc) { try { ip = new URL(loc[1]).hostname; } catch { /* ignore */ } }
      if (!found.includes(ip)) found.push(ip);
      // One speaker is enough to read the whole topology; give others a moment.
      if (!earlyTimer) earlyTimer = setTimeout(finish, 400);
    });
    sock.bind(0, () => {
      try { if (localIp) sock.setMulticastInterface(localIp); } catch { /* ignore */ }
      const buf = Buffer.from(SEARCH);
      for (const delay of [0, 300, 900]) {
        setTimeout(() => { if (!done) sock.send(buf, SSDP_PORT, SSDP_ADDR); }, delay);
      }
    });
  });
}

// ---- Topology ---------------------------------------------------------------

const modelCache = new Map(); // uuid -> model name
let topology = { at: 0, groups: [] };
let knownIps = new Set();

async function fetchModel(ip) {
  try {
    const res = await fetch(`http://${ip}:1400/xml/device_description.xml`, {
      signal: AbortSignal.timeout(4000),
    });
    const xml = await res.text();
    return parseTag(xml, 'modelName') || parseTag(xml, 'displayName') || 'Sonos';
  } catch {
    return 'Sonos';
  }
}

async function readTopology(ip) {
  const v = await soap(ip, 'ZoneGroupTopology', 'GetZoneGroupState');
  const groups = parseZoneGroupState(v.ZoneGroupState || '');
  await Promise.all(
    groups.flatMap((g) => g.members).map(async (m) => {
      if (!modelCache.has(m.uuid)) modelCache.set(m.uuid, await fetchModel(m.ip));
      m.model = modelCache.get(m.uuid);
    }),
  );
  return groups;
}

export async function getTopology({ refresh = false, localIp } = {}) {
  if (!refresh && topology.groups.length && Date.now() - topology.at < 30_000) return topology.groups;
  const discovered = await ssdpDiscover({ localIp });
  const candidates = [...new Set([...discovered, ...knownIps])];
  if (!candidates.length) {
    throw new SonosError(
      "No Sonos speakers found. Check the Mac is on the same wifi as the speakers.",
      503,
    );
  }
  let lastErr;
  for (const ip of candidates) {
    try {
      const groups = await readTopology(ip);
      topology = { at: Date.now(), groups };
      knownIps = new Set(groups.flatMap((g) => g.members.map((m) => m.ip)));
      return groups;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function findGroup(groupId, opts = {}) {
  if (!groupId || typeof groupId !== 'string') {
    throw new SonosError('Please choose a speaker (groupId is missing).', 400);
  }
  let groups = await getTopology(opts);
  let g = groups.find((x) => x.id === groupId);
  if (!g) {
    groups = await getTopology({ ...opts, refresh: true });
    g = groups.find((x) => x.id === groupId);
  }
  if (!g) {
    throw new SonosError(
      "That speaker group wasn't found. It may have been regrouped in the Sonos app, so refresh the speaker list.",
      404,
    );
  }
  return g;
}

// ---- Transport --------------------------------------------------------------

export async function getTransportState(ip) {
  const v = await soap(ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 });
  return v.CurrentTransportState || 'STOPPED';
}

export async function getPositionInfo(ip) {
  const v = await soap(ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 });
  return {
    trackUri: v.TrackURI || '',
    metadata: v.TrackMetaData || '',
    position: hmsToSeconds(v.RelTime),
    duration: hmsToSeconds(v.TrackDuration),
  };
}

export async function getMediaUri(ip) {
  const v = await soap(ip, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 });
  return v.CurrentURI || '';
}

export async function getGroupVolume(ip) {
  const v = await soap(ip, 'GroupRenderingControl', 'GetGroupVolume', { InstanceID: 0 });
  return Number(v.CurrentVolume) || 0;
}

export async function setGroupVolume(ip, volume) {
  await soap(ip, 'GroupRenderingControl', 'SnapshotGroupVolume', { InstanceID: 0 });
  await soap(ip, 'GroupRenderingControl', 'SetGroupVolume', { InstanceID: 0, DesiredVolume: volume });
}

export async function setUri(ip, uri, didl) {
  await soap(ip, 'AVTransport', 'SetAVTransportURI', {
    InstanceID: 0,
    CurrentURI: uri,
    CurrentURIMetaData: didl,
  });
}

export const play = (ip) => soap(ip, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 });
export const pause = (ip) => soap(ip, 'AVTransport', 'Pause', { InstanceID: 0 });
export const stop = (ip) => soap(ip, 'AVTransport', 'Stop', { InstanceID: 0 });

export async function seek(ip, seconds) {
  const args = { InstanceID: 0, Unit: 'REL_TIME', Target: secondsToHms(seconds) };
  try {
    await soap(ip, 'AVTransport', 'Seek', args);
  } catch (err) {
    // Seeking straight after Play can fault while the track is still loading.
    if (err.code !== 701 && err.code !== 711) throw err;
    await new Promise((r) => setTimeout(r, 600));
    await soap(ip, 'AVTransport', 'Seek', args);
  }
}

export async function waitForState(ip, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await getTransportState(ip);
    if (wanted.includes(state)) return state;
    await new Promise((r) => setTimeout(r, 400));
  }
  return state;
}

// Title, artist and art from a track's DIDL-Lite (as Sonos reports it).
export function parseDidl(didl, speakerIp) {
  if (!didl || didl === 'NOT_IMPLEMENTED') return { title: null, channel: null, thumbnail: null };
  let art = parseTag(didl, 'albumArtURI');
  if (art && art.startsWith('/')) art = `http://${speakerIp}:1400${art}`;
  return {
    title: parseTag(didl, 'title') || parseTag(didl, 'streamContent') || null,
    channel: parseTag(didl, 'creator') || parseTag(didl, 'artist') || null,
    thumbnail: art || null,
  };
}
