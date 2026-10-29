import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXml,
  unescapeXml,
  parseTag,
  parseAttrs,
  hmsToSeconds,
  secondsToHms,
  parseRange,
  buildDidl,
  buildSoapEnvelope,
  parseSoapResponse,
  parseZoneGroupState,
  ourVideoIdFromUri,
  isVideoId,
} from '../util.js';
import { parseDidl } from '../sonos.js';

const NASTY = `Tom & Jerry <live> "quoted" it's 🎵 café`;

test('escapeXml escapes the five XML specials and leaves emoji alone', () => {
  assert.equal(escapeXml(NASTY), 'Tom &amp; Jerry &lt;live&gt; &quot;quoted&quot; it&apos;s 🎵 café');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(42), '42');
});

test('unescapeXml reverses escapeXml, including numeric entities', () => {
  assert.equal(unescapeXml(escapeXml(NASTY)), NASTY);
  assert.equal(unescapeXml('&#38; &#x1F3B5; &#233;'), '& 🎵 é');
  // &amp; last, so a literal "&amp;lt;" becomes "&lt;", not "<"
  assert.equal(unescapeXml('&amp;lt;'), '&lt;');
});

test('DIDL in a SOAP envelope is escaped twice and survives a round trip', () => {
  const didl = buildDidl({
    uri: 'http://192.168.1.10:8787/stream/jNQXAC9IVRw.mp3',
    title: NASTY,
    creator: 'A & B',
    albumArtUri: 'http://192.168.1.10:8787/art/jNQXAC9IVRw.jpg',
    durationSeconds: 19,
  });
  assert.match(didl, /<dc:title>Tom &amp; Jerry &lt;live&gt;/);
  assert.match(didl, /duration="0:00:19"/);
  assert.match(didl, /<upnp:class>object\.item\.audioItem\.musicTrack<\/upnp:class>/);
  const env = buildSoapEnvelope('AVTransport', 'SetAVTransportURI', { InstanceID: 0, CurrentURIMetaData: didl });
  // Inside the envelope the title's & is double escaped and no raw < from the DIDL remains.
  assert.ok(env.includes('Tom &amp;amp; Jerry &amp;lt;live&amp;gt;'));
  const inner = parseTag(env, 'CurrentURIMetaData');
  assert.equal(inner, didl);
  assert.equal(parseTag(inner, 'title'), NASTY);
  assert.equal(parseTag(inner, 'creator'), 'A & B');
});

test('parseTag handles prefixes, self-closing tags and absence', () => {
  assert.equal(parseTag('<u:X>1</u:X>', 'X'), '1');
  assert.equal(parseTag('<a><X/></a>', 'X'), '');
  assert.equal(parseTag('<a></a>', 'X'), null);
  assert.equal(parseTag('<dc:title>a &amp; b</dc:title>', 'title'), 'a & b');
});

test('parseAttrs reads quoted attributes and unescapes them', () => {
  assert.deepEqual(parseAttrs(` UUID="R1" ZoneName="Kids &amp; Co" Invisible='1'`), {
    UUID: 'R1',
    ZoneName: 'Kids & Co',
    Invisible: '1',
  });
});

test('hmsToSeconds parses Sonos RelTime and TrackDuration', () => {
  assert.equal(hmsToSeconds('0:00:19'), 19);
  assert.equal(hmsToSeconds('1:02:03'), 3723);
  assert.equal(hmsToSeconds('12:34'), 754);
  assert.equal(hmsToSeconds('0:03:05.500'), 185);
  assert.equal(hmsToSeconds('NOT_IMPLEMENTED'), 0);
  assert.equal(hmsToSeconds(''), 0);
  assert.equal(hmsToSeconds(undefined), 0);
});

test('secondsToHms formats seek targets', () => {
  assert.equal(secondsToHms(0), '0:00:00');
  assert.equal(secondsToHms(75), '0:01:15');
  assert.equal(secondsToHms(3723.9), '1:02:03');
  assert.equal(secondsToHms(-5), '0:00:00');
});

test('parseRange covers the forms Sonos and browsers send', () => {
  const size = 1000;
  assert.equal(parseRange(undefined, size), null);
  assert.deepEqual(parseRange('bytes=0-99', size), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=100-', size), { start: 100, end: 999 });
  assert.deepEqual(parseRange('bytes=-500', size), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', size), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', size), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=0-0', size), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=10-19, 30-39', size), { start: 10, end: 19 });
  assert.equal(parseRange('bytes=1000-', size), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', size), 'unsatisfiable');
  assert.equal(parseRange('bytes=50-10', size), null);
  assert.equal(parseRange('items=0-1', size), null);
  assert.equal(parseRange('bytes=abc', size), null);
});

test('parseSoapResponse reads values from a real GetPositionInfo response', () => {
  const xml =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
    '<Track>1</Track><TrackDuration>0:00:19</TrackDuration>' +
    '<TrackMetaData>&lt;DIDL-Lite&gt;&lt;item&gt;&lt;dc:title&gt;Me at the zoo &amp;amp; more&lt;/dc:title&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</TrackMetaData>' +
    '<TrackURI>http://192.168.1.10:8787/stream/jNQXAC9IVRw.mp3</TrackURI>' +
    '<RelTime>0:00:07</RelTime><AbsTime>NOT_IMPLEMENTED</AbsTime><RelCount>2147483647</RelCount>' +
    '</u:GetPositionInfoResponse></s:Body></s:Envelope>';
  const { fault, values } = parseSoapResponse(xml, 'GetPositionInfo');
  assert.equal(fault, null);
  assert.equal(values.TrackDuration, '0:00:19');
  assert.equal(values.RelTime, '0:00:07');
  assert.equal(values.TrackURI, 'http://192.168.1.10:8787/stream/jNQXAC9IVRw.mp3');
  assert.equal(parseTag(values.TrackMetaData, 'title'), 'Me at the zoo & more');
});

test('parseSoapResponse handles empty and self-closing values', () => {
  const xml = '<s:Envelope><s:Body><u:SetAVTransportURIResponse xmlns:u="x"></u:SetAVTransportURIResponse></s:Body></s:Envelope>';
  assert.deepEqual(parseSoapResponse(xml, 'SetAVTransportURI'), { fault: null, values: {} });
  const xml2 = '<s:Envelope><s:Body><u:GetMediaInfoResponse><NrTracks>0</NrTracks><CurrentURI></CurrentURI><NextURI/></u:GetMediaInfoResponse></s:Body></s:Envelope>';
  assert.deepEqual(parseSoapResponse(xml2, 'GetMediaInfo').values, { NrTracks: '0', CurrentURI: '', NextURI: '' });
});

test('parseSoapResponse turns a UPnP fault into a readable message', () => {
  const xml =
    '<s:Envelope><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>' +
    '<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>701</errorCode></UPnPError></detail>' +
    '</s:Fault></s:Body></s:Envelope>';
  const { fault } = parseSoapResponse(xml, 'Pause');
  assert.equal(fault.code, 701);
  assert.match(fault.message, /not in a state/);
});

test('parseZoneGroupState lists visible groups with the coordinator first', () => {
  const state =
    '<ZoneGroupState><ZoneGroups>' +
    '<ZoneGroup Coordinator="RINCON_B" ID="RINCON_B:1">' +
    '<ZoneGroupMember UUID="RINCON_S" Location="http://192.168.1.38:1400/xml/device_description.xml" ZoneName="Shower"/>' +
    '<ZoneGroupMember UUID="RINCON_B" Location="http://192.168.1.34:1400/xml/device_description.xml" ZoneName="Bedroom"/>' +
    '</ZoneGroup>' +
    '<ZoneGroup Coordinator="RINCON_D" ID="RINCON_D:2">' +
    '<ZoneGroupMember UUID="RINCON_D" Location="http://192.168.1.37:1400/xml/device_description.xml" ZoneName="Dining Room">' +
    '<Satellite UUID="RINCON_SAT" Location="http://192.168.1.50:1400/x.xml" ZoneName="Dining Room" Invisible="1"/>' +
    '</ZoneGroupMember></ZoneGroup>' +
    '<ZoneGroup Coordinator="RINCON_H" ID="RINCON_H:3">' +
    '<ZoneGroupMember UUID="RINCON_H" Location="http://192.168.1.60:1400/x.xml" ZoneName="BOOST" Invisible="1"/>' +
    '</ZoneGroup>' +
    '</ZoneGroups></ZoneGroupState>';
  const groups = parseZoneGroupState(state);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    id: 'RINCON_B',
    name: 'Bedroom + Shower',
    coordinatorIp: '192.168.1.34',
    members: [
      { uuid: 'RINCON_B', name: 'Bedroom', ip: '192.168.1.34' },
      { uuid: 'RINCON_S', name: 'Shower', ip: '192.168.1.38' },
    ],
  });
  assert.equal(groups[1].name, 'Dining Room');
  assert.equal(groups[1].members.length, 1);
});

test('parseDidl reads title, creator and makes relative art absolute', () => {
  const didl =
    '<DIDL-Lite><item><dc:title>Song &amp; Dance</dc:title><dc:creator>Band</dc:creator>' +
    '<upnp:albumArtURI>/getaa?s=1&amp;u=x</upnp:albumArtURI></item></DIDL-Lite>';
  assert.deepEqual(parseDidl(didl, '192.168.1.37'), {
    title: 'Song & Dance',
    channel: 'Band',
    thumbnail: 'http://192.168.1.37:1400/getaa?s=1&u=x',
  });
  assert.deepEqual(parseDidl('', '1.2.3.4'), { title: null, channel: null, thumbnail: null });
});

test('ourVideoIdFromUri only claims our own stream URLs', () => {
  const hosts = ['192.168.1.10'];
  assert.equal(ourVideoIdFromUri('http://192.168.1.10:8787/stream/jNQXAC9IVRw.mp3', hosts, 8787), 'jNQXAC9IVRw');
  assert.equal(ourVideoIdFromUri('http://192.168.1.99:8787/stream/jNQXAC9IVRw.mp3', hosts, 8787), null);
  assert.equal(ourVideoIdFromUri('http://192.168.1.10:8799/test.mp3', hosts, 8787), null);
  assert.equal(ourVideoIdFromUri('x-rincon-queue:RINCON_B#0', hosts, 8787), null);
  assert.equal(ourVideoIdFromUri('', hosts, 8787), null);
});

test('isVideoId blocks anything that is not an 11 character ID', () => {
  assert.ok(isVideoId('jNQXAC9IVRw'));
  assert.ok(isVideoId('a-b_c-d_e-f'));
  assert.ok(!isVideoId('../../etc/pa'));
  assert.ok(!isVideoId('short'));
  assert.ok(!isVideoId(null));
});
