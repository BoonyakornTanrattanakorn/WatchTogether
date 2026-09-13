# Architecture

Orientation for someone (or some future session) picking this codebase up
cold. The README explains how to *run* the thing; this explains how it is
*built*, and which parts are load-bearing.

Companion document: [mistakes.md](mistakes.md), which records bugs that were
expensive to find and the reasoning that would have found them sooner. Read
both before changing sync, subtitles or layout.

## Shape

Five source files, no build step, two npm dependencies.

```
server.js    2287 lines. HTTP + WebSocket. Library index, range serving,
             room state, track discovery, subtitle and font extraction,
             the encode queue, the access gate.
db.js         296 lines. SQLite via node:sqlite. Users, invites, settings,
             per-user per-file track preferences.
auth.js       193 lines. Signed session cookies, the per-IP rate limiter.
pages.js      229 lines. Server-rendered login / register / setup / holding
             pages. Plain template strings.
watch.html   2651 lines. The entire client: player, sidebar, encode panel,
             accounts panel. One inline <script>, one inline <style>.
```

`ws` for the WebSocket, `jassub` for libass subtitle rendering. ffmpeg and
ffprobe are found on `PATH` and are optional-but-load-bearing: without them you
lose track pickers, subtitle extraction, codec warnings and the encode queue.

Needs Node 24+ for `node:sqlite`.

## The two halves

**HTTP serves bytes.** Media, subtitles, fonts, converted files, the vendored
libass build, and the server-rendered auth pages. Everything behind an access
gate.

**The WebSocket carries state.** Playback position, track choices, the room
roster, admin actions, the encode queue, the server log. One socket per client,
authenticated at the handshake.

The split matters: a `<video>` element cannot carry a session, so anything it
fetches has to work over plain authenticated HTTP with byte ranges. Anything
that needs to be pushed goes over the socket.

## Identity and the access gate

Sessions are a **signed cookie**, not a server-side table. The payload is
`userId.issuedAt.epoch` plus an HMAC over it.

- **Role and status are re-read from the database on every request.** The
  cookie proves who you are, never what you may do. Denying or deleting someone
  takes effect on their next request with no session store to sweep.
- **`session_epoch` is part of the signed payload.** Logging in bumps it, which
  invalidates every older cookie — so one account is one browser. This is
  deliberate: the same account in two tabs shows up as a duplicate in the roster
  and makes drop-detection meaningless.
- **The gate is default-deny.** Unauthenticated HTML requests redirect to
  `/login`; media, API and WebSocket requests get 401/403 with a *non-HTML*
  body. This is not a detail — redirecting a `<video>` element's request feeds
  it a login page, which the decoder reports as a corrupt file rather than as
  "you are signed out".
- **The WebSocket authenticates in `verifyClient`**, before the upgrade
  completes, so an unauthorised socket is never established at all. The username
  in "waiting for <name>" is therefore always the authenticated one.

`auth.userFor(req)` is the single source of truth for "who is this request",
used by both the HTTP gate and the WebSocket handshake so the two cannot drift.

## The library index

Files are addressed by **opaque id, never by path**: `/media/<sha1-prefix>`
looks up a pre-built in-memory index, so there is no path traversal to defend
against.

The id is a hash of the path *relative to its root*, mixed with the root's
index. Two consequences worth knowing:

- Moving the whole library keeps every id stable.
- **Reordering `MEDIA_DIRS` changes every id.** This is how converted files
  become orphaned — see the orphan handling in the encode queue.

`/list` rescans if the index is more than 10 seconds old.

## Room state

One `room` object per room name, held in a `Map`, deleted when the last client
leaves.

```js
{ name, clients: Set, src, label, paused, time, updatedAt,
  stalled: Set, audio, sub }
```

`time` + `updatedAt` are an **anchor**: where playback was, and the server clock
at which that was true. Every client extrapolates from it. `projectedTime(room)`
is the only correct way to ask "where should we be now".

Getting this wrong is the source of most sync bugs. See
[mistakes.md](mistakes.md) — the anchor going stale, and the host being
measured against its own reflection, were both real.

## Sync

The design in one line: **the host is the reference; viewers follow; nobody
seeks anybody unless they are badly out.**

- The **host** never runs drift correction. Measuring the host against room time
  is circular, because room time *is* the host's last report.
- The host sends a `heartbeat` every 2s with its true position. The server
  re-anchors on it and only re-broadcasts when the figure moved more than 0.5s,
  so a steady stream of heartbeats is not itself a source of jitter. A heartbeat
  is **not a control**: it never plays, pauses or seeks anyone, and it is
  ignored while the room is paused or holding for a buffering viewer.
- **Viewers** correct in two continuous bands with no gap between them:

  | drift | action |
  |---|---|
  | < 0.05s (`NUDGE`) | leave alone |
  | 0.05s – 2.5s | lean on `playbackRate`, scaled with the error (floor 2%, cap 12%) |
  | > 2.5s (`HARD_SEEK`) | seek |

  Both thresholds are defined adjacent to each other in `watch.html`
  deliberately, because a gap between them once stranded viewers permanently.

  `NUDGE` is not just "don't bother" — it is the drift the room settles at,
  because correction only engages past it and a host's own `playbackRate` is
  never exactly 1.000. The loop runs every 250ms, not 1000ms, so a real
  disturbance (a throttled tab, a stall) is caught within one tick rather than
  travelling most of the way back out of band first. Verified end-to-end with
  two real browsers against the real server: untouched, drift holds at 1-3ms;
  recovering from a forced ~700ms gap, it's back under 100ms in about 15s and
  settles at ~47ms indefinitely.

  **Pausing is the one moment held to zero, not to `NUDGE`.** A paused seek
  causes no stutter to worry about, so `apply()` always seeks a viewer to the
  host's exact reported position on pause — no dead zone at all. Measured: a
  viewer forced 150ms-1.2s out of position lands within 1ms of the host's
  frame the instant the host pauses. The old code only corrected pause gaps
  over 250ms, so anything smaller was left uncorrected indefinitely — exactly
  backwards for the moment where correcting is free.

- The **clock offset** is not a single sample. Eight ping/pong samples are kept
  and the one with the **lowest round trip** wins — latency is only ever added
  to a packet, never subtracted, so the quickest exchange is the least
  contaminated. A fresh connection measures five times in two seconds, then
  every five seconds (which doubles as the tunnel keepalive). Correction refuses
  to act until the clock has been measured at least once.

- **A resume is scheduled, not applied immediately — this is what makes
  "click play" land at the same instant for everyone, host included.**
  Applying a resume the moment the `control` message is received staggers
  everyone's actual start by however long their own leg of the broadcast
  happened to take, and the host's own leg (click → `v.play()` resolving) is
  no exception — a host who un-pauses their own player is not a reference
  point here, they are just the first person whose trip finished.

  So the server does not flip `room.paused` to `false` on a resume. It picks
  `playAt = Date.now() + PLAY_LEAD_MS` (700ms), broadcasts an ordinary-looking
  paused state at the target position with `playAt` riding along, and only
  flips to actually playing — with a second broadcast — once a server-side
  timer confirms `playAt` has passed and nothing cancelled it. Every client
  (including the host) translates `playAt` through the same clock `offset`
  the drift loop already trusts and schedules its own local `v.play()` for
  that instant — so nobody is waiting on a second network round trip to
  start, they are all counting down independently against the same instant.
  700ms is comfortably above the "high latency" threshold the client already
  warns about for its own RTT (400ms).

  A resume is the only `control` transition scheduled this way — pausing and
  seeking-while-playing still apply at once, because there is nothing to
  schedule *to* for a pause, and scheduling a seek would just make scrubbing
  feel laggy for no syncing benefit the drift loop doesn't already provide.

  **The host's own play button can't be intercepted before it fires** — it's
  native browser chrome. What can be caught is the resulting `play` event:
  `control()` immediately pauses straight back before the frame advances, so
  the host's own video also waits out the lead time rather than getting a
  head start. That re-entrant `v.pause()` call itself fires a `pause` event —
  asynchronously, not in the same tick, confirmed by tracing — so suppressing
  the spurious second `control` message it would otherwise send needs a flag
  cleared on a short timer, not cleared right after the call. See mistake 9
  for why this one was hard to catch: the two messages both really do reach
  the server, in order, and the second really does cancel the schedule the
  first one just created.

  Verified with two real browsers and a real gesture on the host's play
  button (not `v.play()` called from test code): host and viewer start
  playing within 1-3ms of each other, repeatably. Cancelling mid-countdown
  (pausing again before `playAt` fires) was verified to leave the room
  paused, never having started.

### The echo guard

Obeying a state message means calling seek/play/pause on our own element, which
fires the same events a person pressing the button would. Sending those back
would bounce the room's state at it.

So `send()` suppresses outbound messages for 300ms after applying state — but
**only for `control`**, named in an `ECHOABLE` set. Nothing else can echo:
health reports describe this browser's buffer, and admin commands are
deliberate instructions. Suppressing those caused two separate bugs.

It is released on a **timer, not on the promise**, because `v.play()` can stay
pending indefinitely while buffering, and latching the guard that long would
swallow the viewer's own input. A sequence number on state messages would be
more correct; the timer is a known, documented compromise.

## Buffering and holds

A viewer whose buffer runs dry sends `stall`; the server freezes the anchor and
tells everyone who it is waiting for. `ready` releases it. A stalled viewer who
does not recover in **15s** is carried on without — better one person behind
than everyone frozen.

`bye` distinguishes a deliberate tab close from a dropped connection. A drop
mid-playback pauses the room and names who; a `bye` does not.

## Media compatibility, and the encode queue

The hard constraint: **browsers cannot decode HEVC**, in any container, 8-bit or
10-bit, without an OS codec nobody can rely on. 10-bit fails even where the
codec works. DTS and TrueHD decode nowhere. MKV is fine in Chromium, absent in
Firefox. FLAC is fine.

A missing codec surfaces as `MEDIA_ERR_NETWORK` with a demuxer error, which
reads as a network fault and sends you debugging the tunnel. So `/tracks/<id>`
reports a **playability verdict** from the ffprobe data it was already
collecting, and the client uses that instead of letting the decoder fail.

`/tracks/<id>`'s verdict is backed by ffprobe, a real subprocess, so it is
cached — not just in memory (`trackCache`, cleared by a restart) but in
`track_cache` in sqlite. This is a deliberate exception to db.js's stated
"derived data stays in memory" rule: the id is a content hash, so a stored row
is never wrong, only possibly for a file that no longer exists (still checked
on every read), and the alternative was every server restart re-shelling out to
ffprobe for an entire library — hundreds of requests — the moment a host's page
first asked the Encode panel to render. `/list` exposes the persisted verdict
per file (`playable`) for free; the client's `probeLibrary()` only calls
`/tracks/<id>` for a file `/list` reports as `null` (never probed by anyone,
ever), not merely "not probed this page load".

Unplayable files are converted **ahead of time**, from the admin's Encode panel.
This replaced on-demand transcoding, and the reasoning is worth preserving:

> A fragmented-MP4 pipe has no index, so the browser cannot seek in it. Every
> seek restarted ffmpeg, which cost more than the seek saved. Working around
> that meant the client grew a substitute scrub bar, a substitute clock, and a
> subtitle time offset — and two encoders ran at once on a machine that was also
> serving video. The first minutes of any unplayable film were spent fighting
> all of that, in front of everyone who had turned up to watch it.

Now: `GET /transcode/<id>` serves a finished file or answers **409**. It never
starts an encoder. The queue runs **one at a time**, keeps going when the room
empties (it is work requested ahead of time), and reports progress from ffmpeg's
`-progress` stream rather than by scraping stderr.

A finished encode is `<CACHE_DIR>/<id>.<slug>.mp4` plus a `.done` marker — the
marker is what distinguishes a complete encode from one killed halfway, which
would otherwise play as a truncated film. `.part` files are reaped on process
`exit` (not at kill time: the signal is asynchronous, and on Windows an open
handle makes the unlink fail) and swept at startup.

**The slug is cosmetic, never authoritative.** It exists so a human looking at
`CACHE_DIR` (or a filename in a log line) can tell which episode a cache file
is without cross-referencing ids — the id, everything before the first `.`, is
still the only thing any lookup keys on. `findCachePath(id)` globs for
`<id>.*.mp4` (falling back to the bare `<id>.mp4` a pre-existing cache or an
orphan fixture may have) rather than assuming the exact name, precisely
because the slug can collide, go stale after a rename upstream, or simply be
absent — none of which should ever make a conversion unfindable.

**Orphans** are converted files whose source id is no longer in the library —
deleted, moved, or `MEDIA_DIRS` reordered. They count against the disk budget
forever, so the panel lists them with a Delete button. That delete refuses any
id still in the library, so it cannot become a way to remove the film everyone
is about to watch.

## Subtitles

Two renderers, exactly one live at a time.

**libass (via JASSUB) for ASS/SSA.** ffmpeg's WebVTT muxer keeps timing and line
breaks and throws away font, size, colour, outline, border style and position —
fine for dialogue, wrong for anything typeset. So raw ASS goes to the browser
untouched and is painted on a canvas over the video, with the container's
embedded fonts extracted and handed to the renderer so signs keep their metrics.

**The browser's own `<track>` for everything else**, and for ASS if libass fails
to start.

Three things this depends on:

1. **The page is cross-origin isolated.** libass is a pthreads build needing
   `SharedArrayBuffer`, which requires `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp`. Everything loaded is
   same-origin so this costs nothing today — but any third-party script, font or
   image added later is blocked unless it sends its own CORP header.
2. **`<n>` in `/subs/<id>/<n>` indexes the published list, not ffmpeg's.** The
   list has bitmap formats (PGS, VOBSUB) filtered out, so `-map 0:s:<n>` would
   count them back in and hand back the wrong track. The route maps by the
   stream's **absolute index**, recorded by the probe.
3. **Rendering is driven by `requestVideoFrameCallback`**, which only fires
   while frames are presented. Subtitles appear when playback starts; a long
   pause holds the last drawn frame.

`tracksFor` vs `tracksReadyFor` is a distinction that matters: the first is
claimed *before* the `/tracks/` fetch starts, the second only once the list has
actually arrived. Anything deciding "does this file have subtitles" must use the
second, or it will read "not fetched yet" as "no subtitles".

## Layout

**The stage is the picture.** `#stage` gives itself
`aspect-ratio: var(--ar)`, set from `videoWidth`/`videoHeight` on
`loadedmetadata`. Whichever of width or height binds first, the other follows,
and the centring grid absorbs the remainder.

This single rule carries a lot of weight, because the subtitle canvas and the
autoplay overlay are both positioned against `#stage`. **If the stage is ever
larger than the rendered picture, subtitles are drawn on the letterbox or below
the frame.** Any rule that resizes the video must resize the stage, not the
video inside it.

**The stage gets exactly one definite axis** — `width: min(1100px, 100%)`,
`max-height: 100%`, and no `height`. This is not stylistic. `aspect-ratio` is
ignored when both axes are definite, and `main` centres its items rather than
stretching them, so with neither axis definite the stage collapses to the
video's intrinsic size. Both failures were shipped and reverted; see mistake 5b.

**Fullscreen is the exception: there the stage is the screen, not the picture.**
The UA stylesheet forces `width`/`height: 100%` with `max-width`/`max-height:
none` on a fullscreened element, at a precedence an id selector cannot beat — so
this is not a choice. `#stage:fullscreen` states it explicitly with
`aspect-ratio: auto`, and the video letterboxes itself inside via `object-fit:
contain` against the stage's black background. Use `display: block`, **not** a
centring grid: `place-items: center` makes the video shrink-to-fit its own
content instead of honouring `height: 100%`, which overflows a 4:3 picture off
the bottom of a 16:9 screen (mistake 5c).

Subtitles survive that exception because jassub never looks at the stage: it
measures the *video's* box and sets the canvas's own width, height, top and left
from it. Verified with a real 4:3 file and a live libass renderer — canvas and
picture agreed to 0.0px windowed and fullscreen, confirmed by screenshot.

**Test layout changes with a 4:3 fixture, not a 16:9 one.** In 16:9 the video's
box and its picture coincide, which hides every bug in this section.

**The page never scrolls, at any size or role.** `body` is a hard `100dvh` with
`overflow: hidden`, and every list that can grow scrolls inside its own pane.
Panels are bounded by their container, never by `dvh` units — a `78dvh` video
ignores the header above it.

**Fullscreen always targets the stage, never the `<video>`.** The browser's own
fullscreen button takes the video element alone, and the subtitle canvas is a
sibling of it — so it stays behind on the page and subtitles vanish exactly when
someone most wants them. `fullscreenchange` catches that and promotes the stage;
Safari's element-only fullscreen is caught via `webkitbeginfullscreen`.

**The promotion can silently fail, and there is no fix for that — only a
notice.** `requestFullscreen()` only succeeds inside the call stack of a real
user gesture. By the time `fullscreenchange` fires and calls
`exitFullscreen()`, that gesture is spent; the follow-up
`stageEl.requestFullscreen()` in the `.then()` is a plain async callback and
Chrome refuses it (`Permissions check failed`, confirmed by direct test — also
tried requesting the stage *without* an intervening exit, i.e. swapping the
fullscreen element directly; refused with the same error). When it's refused,
the whole page silently drops out of fullscreen — no video, no stage — which
reads as "the fullscreen button doesn't work" with no clue why. The `.catch()`
now shows a notice pointing at the app's own fullscreen button instead of
swallowing the failure. There is no way to make the native button's promotion
reliable; the notice is the fix.

Viewers and hosts both get the header. Viewers lose only the sidebar, which is
removed from the layout rather than hidden so the grid collapses to one column.

## Autoplay

A browser will not start playback with sound until that viewer has interacted
with the page, so a guest who just opens the link sits on a still frame while
the host sees "N watching" and assumes everyone is fine. The tell is that
**pause propagates but play doesn't** — `v.pause()` never needs permission,
`v.play()` does.

Handled in two steps: retry muted (which browsers allow), then an overlay asking
for a click to restore sound. If even muted playback is refused, the overlay
says so instead. Guests' autoplay failures are forwarded to the server log so
the host sees them without having to ask.

## Testing

Nine plain-node suites, no framework. `npm test` runs them in sequence; each
spawns a real server on its own port with its own temp `DATA_DIR`.

| Suite | Covers |
|---|---|
| `run` `db` `auth` `ids` | fast in-process units |
| `body` | request-body decoding, over a raw socket |
| `gate` | the access-gate matrix |
| `ws` | websocket handshake and auth |
| `admin` | account management |
| `room` | room behaviour, tracks, the encode queue |
| `cpu` | encoder lifetime — counts real ffmpeg processes |

`cpu.js` is the one that catches things the others cannot: the rest check what a
route returns, it checks what is left *running* afterwards. It needs a genuinely
slow encode to observe, and it refuses to report a pass it did not earn — a
stubbed ffmpeg or a fixture timeout fails rather than skipping quietly.

## Config

`.env` in the project directory, overridden by real environment variables. Only
`MEDIA_DIRS` must be set. `.env` and `/data/` are gitignored.

`SERVER_SECRET` is generated and stored on first run; rotating it signs everyone
out. `SETUP_TOKEN` is generated per-run unless set, and `/setup` stops existing
once an admin exists.
