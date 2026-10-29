# Companion API

What the companion on port 8787 answers. The extension only ever talks to this.

Port 8787, listens on all interfaces. `/api/*` only answers requests from 127.0.0.1/::1 (403 otherwise). `/stream/*` and `/art/*` are open to the LAN (Sonos needs them). All JSON. Requests carrying an `Origin` header other than `chrome-extension://...` get 403, so web pages open in the browser can't drive your speakers.

Errors: non-2xx with `{ "error": "human readable sentence" }`.

1. `GET /api/health` -> `{ ok: true, version, lanIp }`
2. `GET /api/speakers[?refresh=1]` -> `{ groups: [ { id, name, coordinatorIp, members: [ { uuid, name, ip, model } ], volume, state } ] }`
   - `id` = coordinator UUID. `name` = member room names joined with " + ", coordinator first. `state` = PLAYING | PAUSED_PLAYBACK | STOPPED | TRANSITIONING. `volume` = group volume 0-100.
   - Discovery by SSDP (ST urn:schemas-upnp-org:device:ZonePlayer:1) then ZoneGroupTopology GetZoneGroupState. Cache 30 s. Skip invisible/satellite members.
3. `POST /api/play` body `{ videoId, groupId, startSeconds?, title?, channel?, thumbnail? }`
   - Blocks until the speaker reports PLAYING (timeout 180 s), then returns the same shape as status.
   - Prepares `~/Library/Caches/youtube-to-sonos/<videoId>.mp3` via yt-dlp (192k MP3) if not cached; one job per videoId at a time (second caller waits on the first).
   - Metadata from yt-dlp if title etc. missing. Sets DIDL-Lite metadata (dc:title, dc:creator, upnp:albumArtURI pointing at `/art/<videoId>.jpg` served from the cache, upnp:class object.item.audioItem.musicTrack).
   - SetAVTransportURI on the coordinator, Play, then Seek REL_TIME to startSeconds if > 3.
4. `GET /api/status?groupId=` -> `{ groupId, state, videoId|null, title, channel, thumbnail, position, duration, volume, isOurs }` (seconds as numbers; `isOurs` true when the track URI points at this companion).
5. `POST /api/control` body `{ groupId, action }`, action = pause | resume | stop -> status shape.
6. `POST /api/seek` body `{ groupId, seconds }` -> status shape.
7. `POST /api/volume` body `{ groupId, volume }` -> status shape (GroupRenderingControl SetGroupVolume on the coordinator).
8. `GET /stream/<videoId>.mp3` audio/mpeg, Content-Length, Range/206 support, HEAD.
9. `GET /art/<videoId>.jpg` thumbnail.
