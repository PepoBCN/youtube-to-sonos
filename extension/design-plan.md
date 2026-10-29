# YouTube to Sonos extension, design plan (29 Oct 2026)

Method: `~/.claude/skills/design-first/SKILL.md`, scaled down to a toolbar popup and one in-page panel.

## World

The front panel of a piece of hi-fi kit: a Braun receiver or a Teenage Engineering box. Engraved labels, a row of selector keys, one orange lamp that tells you something is on, readouts in a fixed-width face. Not a SaaS widget.

## References (real CSS read on 29 Oct 2026)

1. Teenage Engineering (`teenage.engineering`, `/assets/root.*.css`). Variables: `--te-black #0f0e12`, `--te-white #f5f5f5`, greys `#e5e5e5 #ccc #b2b2b2 #767676 #4d4d4d #272727`, `--te-orange #f05a24`, `border-radius: 0` on tiles and buttons. Taken: the orange as the single lamp colour, and the black and off-white as the two bases.
2. Braun Audio (`braun-audio.com`, `/wro/braun_responsive.css`). Fonts `IBM Plex Sans Condensed` and `neue-haas-grotesk`, `text-transform: uppercase` 89 times with `letter-spacing: 0.2px`, `border-radius: 0` 72 times, dark grey `#3c3c3c`. Taken: IBM Plex Sans Condensed for every label, and the square, hard-edged keys. Labels stay in sentence case (Josh's rule) but keep the small size and slight tracking of an engraved legend.
3. Vitsoe (`vitsoe.com/gb`, `screen-responsive.css`, the Dieter Rams shelving company). `Linotype Univers W01`, hairline grey `#c2c2c2` (186 uses), panel grey `#f0f0f0`, radii of `2px`. Taken: the 1px `#c2c2c2` hairlines that divide the popup into sections, like the seams between panels on a unit.

Also read, not used: Nothing (`Ndot`, `Geist Mono`, too much of a phone-brand voice) and KEF (Shopify theme with Inter).

## System

1. Colours
   1. Light base (popup, default): face `#f0f0ee`, ink `#0f0e12`, secondary ink `#4d4d4d`, muted `#767676`, hairline `#c2c2c2`, key face `#ffffff`.
   2. Dark base (popup in dark mode, and the in-page panel always): face `#141414`, raised `#1d1d1d`, ink `#f5f5f5`, secondary `#b2b2b2`, muted `#7f7f7f`, hairline `#3c3c3c`.
   3. One accent: `#f05a24`. Used only as the lamp: the selected speaker's indicator, the "companion connected" lamp, the progress fill and the volume fill. Never as a button fill or text colour.
   4. Errors are plain ink text with a hairline box, no red. The companion-down lamp is unlit (hollow), which on a real unit means off.
2. Type
   1. IBM Plex Sans Condensed 400, 500, 600 for labels, titles and buttons.
   2. IBM Plex Mono 400, 500 for readouts: times, volume numbers, the install command.
   3. Both bundled in `fonts/` as woff2 so nothing loads from Google at run time.
3. Shape and motion
   1. Square corners everywhere (0 radius), 1px hairlines, no shadows inside the popup. The in-page panel gets one flat 1px border so it separates from video.
   2. Keys press down 1px on `:active`, like a mechanical switch.
   3. The only animation: an indeterminate bar while the companion prepares audio, because that wait is real (up to a minute) and the bar shows it is working.

## Refuse list

1. Gradients, glassmorphism, glows, blurred backdrops, drop shadows as decoration.
2. Rounded pill buttons and card soup.
3. Emoji as icons. Icons are inline SVG drawn for this: a speaker cabinet with a cone and a tweeter.
4. More than one accent. YouTube red is never used.
5. Copy with exclamation marks, Title Case, em dashes, "seamless", "unlock", "elevate" or any of the banned words.
6. Spinners that loop forever with no words. Every wait says what it is waiting for.

## Screens (popup and panel), what each shows and the real data behind it

| Screen | Shows | Real data |
| --- | --- | --- |
| Popup header | Name, companion lamp (lit or unlit) and "Connected" or "Not running" | `GET /api/health` |
| Popup, this tab | Thumbnail, title, channel, "From 3:12" | Active YouTube tab: URL, content script reads title, channel and `video.currentTime` |
| Popup, not on YouTube | One line: open a YouTube video to send it | Active tab URL |
| Popup, speakers | Selector keys, one per group, lamp on the chosen one, state and volume readout | `GET /api/speakers`, last speaker from `chrome.storage.local` |
| Popup, play key | "Play on Dining Room" | Selected group |
| Popup, preparing | Indeterminate bar and "Preparing audio on Dining Room. Long videos can take a minute." | Pending job in `chrome.storage.session` |
| Popup, now playing | Thumbnail, title, channel, progress bar with mono times, pause or resume, stop, volume fader with readout | `GET /api/status` every 2 s while open |
| Popup, error | The companion's own sentence, a "Try again" key | `{ error }` from the companion |
| Popup, companion down | "The companion isn't running." The command in a mono box, "Copy command" and "Try again" keys | Failed `fetch` |
| In-page button | Speaker cabinet icon in the player's right-hand controls | YouTube's `.ytp-right-controls` |
| In-page panel | Dark plate in the player: "Play on" label, selector keys, preparing bar, result line | Same API through the service worker |
