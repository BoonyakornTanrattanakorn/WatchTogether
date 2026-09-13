# Watch Together

Video sync app served through a Cloudflare tunnel. An admin controls playback;
everyone else watches in a browser with no install. Accounts are required —
viewers register with an invite code and the admin approves them.

## Running it

```bash
npm install
cp .env.example .env    # then set MEDIA_DIRS to your library
npm run doctor          # optional: checks node, ffmpeg and the data directory
npm start
```

The only setting you have to fill in is **`MEDIA_DIRS`** — where your videos
are. Add `RECURSIVE=1` alongside it to scan subfolders, which is what you want
for a library organised by show or season.

A path on the command line still overrides the file, if you prefer that:

```bash
node server.js -r "/path/to/your/library"
```

Needs **Node 24 or newer** — the database uses `node:sqlite`, which does not
exist in older releases.

Two npm dependencies: `ws` for the WebSocket, and `jassub` for ASS subtitle
rendering. ffmpeg and ffprobe are found on `PATH` and are technically optional,
but without them you lose track pickers, subtitle extraction, codec warnings
and the encode queue — which is most of what makes awkward files playable.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Same, with `--verbose` request and room logging |
| `npm run doctor` | Report what is installed and what each gap costs |
| `npm test` | The whole suite |
| `npm run test:unit` | Just the fast in-process tests |
| `npm run test:body` / `:gate` / `:ws` / `:admin` / `:room` / `:cpu` | One suite at a time |
| `npm run reset-admin -- <username>` | Reset a password and promote to admin |

The `cpu` suite watches ffmpeg's process lifetime while it encodes, which
means its fixture has to stay slow enough to observe mid-flight. That used to
be 600s of 1080p at 24fps inside a 120s budget — marginal enough that a
loaded machine missed the window, and the failure mode was the suite quietly
reporting "no ffmpeg/libx265" and skipping every assertion rather than
failing. The fixture is now 4fps instead (the re-encode still has to walk the
whole timeline, so it stays observably slow) with a larger budget, and a
fixture timeout now fails the suite instead of masquerading as a legitimate
skip. The whole suite went from roughly 2 minutes, and often skipping, to a
reliable 40 seconds.

On a first run the server prints a setup token it generated for that run. Open
`/setup`, enter that token, and create the admin account. This is a
once-per-deployment step; afterwards the route stops existing.

Set `SETUP_TOKEN` yourself if you need it to survive a restart — the generated
one only lives as long as the process, so restarting before setup is finished
prints a new token.

Config comes from `.env` in this directory (see `.env.example`). Real
environment variables override it, so a systemd unit or a one-off
`PORT=9000 node server.js` still wins.

| Variable | Default | Purpose |
|---|---|---|
| `SETUP_TOKEN` | generated per run | Required at `/setup` on first run. Printed at startup when unset; set it explicitly to keep the same token across restarts. |
| `PORT` | `8090` | HTTP + WebSocket port |
| `MEDIA_DIRS` | cwd | Roots separated by `;` or `:`, used when no arguments are given |
| `RECURSIVE` | unset | `1` scans subfolders, same as passing `-r` |
| `DATA_DIR` | `./data` | Where `app.db` lives |
| `SERVER_SECRET` | generated | Signs session cookies. Generated and stored on first run; rotating it signs everyone out. |
| `ALLOW_REGISTRATION` | `1` | Set to `0` to close registration entirely |
| `CACHE_DIR` | `DATA_DIR/transcoded` | Where converted files are kept. The largest thing the server writes — point it at an external disk on a machine with a small system drive. |
| `TRANSCODE_CACHE_GB` | `20` | Disk budget for converted files |
| `TRANSCODE_THREADS` | half the cores | Total CPU threads for transcoding, across every conversion at once |

On Windows, quote UNC paths — PowerShell's `Start-Process -ArgumentList`
splits on spaces unless the argument is quoted.

## Accounts

Two roles. **Admin** controls playback, picks files, and approves users.
**Viewer** watches and controls their own volume — nothing else.

Registration needs an invite code *and* an admin's approval. A pending user can
sign in but sees only a holding page: they are not admitted to the room and
cannot fetch media. Denying or deleting someone takes effect on their very next
request, because role and status are read from the database rather than trusted
from the session cookie.

Passwords are scrypt-hashed. Sessions are a signed cookie, valid 30 days.

The request body used to be assembled with `body += chunk`, which coerces
each incoming Buffer to a UTF-8 string independently. A multi-byte character
split across a TCP chunk boundary decoded as two invalid halves on either
side of the split and came out as replacement characters — silently wrong,
not an error. That corrupted a password, username or invite code containing
any non-ASCII character, and only sometimes, because where the split falls
depends on packet timing and MTU. A VPN changes both, which is why it looked
like "I can't log in when I'm on a VPN" rather than an encoding bug. Fixed by
collecting the chunks as Buffers and decoding once —
`Buffer.concat(chunks).toString('utf8')` — after which the size cap counts
bytes rather than string length. Measured against a body containing 2-, 3-
and 4-byte UTF-8 characters: 11 of the 52 possible split points corrupted it
under the old code, 0 under the new. `test/body.js` (`npm run test:body`)
drives this over a raw socket, writing the body in two `write()` calls to
force a chunk boundary, and checks login succeeds at every offset. It has to
bypass a normal HTTP client to do that — a browser form submit percent-encodes
non-ASCII before it hits the wire, so the bytes are pure ASCII and a browser
could never trigger this. The test sends raw UTF-8, which is what the
clients that *don't* percent-encode send, and is the population the bug
actually hurt.

Invites and approvals are handled from the **Accounts** panel in the footer,
which admins see and viewers do not. It runs over the same WebSocket as
playback, so two admins working at once see each other's changes without
refreshing. Every command re-checks admin rights on the server — the hidden
button is a convenience, not the guard.

## Running a session — admin

You are the admin if you created the account at `/setup`. Whoever holds that
account controls playback for everyone.

### 1. Start the server

```bash
npm start
```

With `MEDIA_DIRS` set in `.env`, as above. Pass several roots separated by `;`
if your media is split up, and set `RECURSIVE=1` to include subfolders. The
startup banner tells you how many files were indexed and how many people are
waiting for approval.

### 2. Invite someone

Press **Accounts** in the footer. Under *Invite someone*, set how many people
the code should admit and how many days it should last (`0` = never expires),
then **Create code**.

You get an invite **link** — `https://your-tunnel/register?invite=CODE` — with a
**Copy link** button. Send that and there is nothing else to explain: it opens
the registration form with the code already filled in, so they only pick a
username and password. The bare code sits under the link for anyone you are
telling over voice, and typing it by hand still works.

The link is built from the address you're on, so it carries your tunnel
hostname automatically.

**Revoke** kills a code immediately — anyone who already registered with it
keeps their account.

### 3. Approve them

When someone registers, the **Accounts** button grows a badge with the number
waiting, and they appear at the top of *People* marked `waiting`. No refresh:
the panel updates over the same connection that drives playback.

**Approve** lets them in, **Deny** refuses them. Either takes effect on their
very next request — a denied viewer is disconnected on the spot rather than
watching on until they happen to reload. Denied people can be **Restore**d, and
**Delete** removes an account outright.

You cannot deny or delete the only admin account; the panel refuses, so a
deployment can't be locked out of itself.

### 4. Play something

Open the tunnel URL and sign in. The sidebar has four tabs:

The controls sit above the tabs — **Play this for everyone**, the `audio` and
`subs` selectors, and **Accounts** — so a long file list can never push them
off the screen.

**Library** — a searchable list grouped by folder. Type to filter, click to
select, then **Play this for everyone** (or double-click to play straight
away). Your play, pause and seek drive every viewer.

**People** — everyone connected, with a coloured dot for how they're doing:
`synced`, `buffering`, `behind 3.2s`, or `high latency`, plus their round-trip
time. Latency and drift are self-reported by each viewer's browser, so treat
them as a diagnostic rather than a guarantee. This is where you look when
someone says the video is stuttering.

**Encode** — files a browser cannot decode, and what to do about them. Queue
one, watch it convert, play it when it says `ready`. Admin-only; see
[Encoding](#encoding-from-the-encode-panel).

**Stats** — machine CPU, this app's CPU, upload and disk-read throughput,
uptime and memory. **Admin-only**: viewers get the People tab but never see the
server's vitals.

**Log** — the server log, admin-only, without needing shell access. It holds
the last 400 lines and streams new ones while the tab is open.

The `audio` and `subs` selectors appear when a file offers a choice. Those are
room-wide — everyone reads the same subtitles — and your choice is **remembered
per file**, so picking English subs once brings them back next time.

When someone is still buffering, the header reads `waiting for <name>` and
playback holds until they catch up.

### 5. Convert anything the browser can't play

Open **Encode**. Anything a browser cannot decode is listed with the reason —
HEVC is the usual one. Press **Encode** on a file, and it converts in the
background with a progress bar; queue as many as you like and they run one at a
time.

Do this **before** people arrive. Nothing is converted at playback time any
more, so an unconverted file will not play — the notice tells you to queue it.
A feature-length film takes a few minutes at roughly 7× real time.

### 6. If you get locked out

```bash
npm run reset-admin -- <username>
```

Prompts for a new password and promotes that account to admin. It needs shell
access to the machine, which is the point — there is no URL that grants control.

## Joining — viewer

You need one thing from whoever is hosting: **an invite link**. (Some hosts
send a plain code and the site address instead — both work.)

1. Open the invite link you were sent. The code is already filled in — pick a
   username and a password (8 characters or more). If you were given a bare
   code instead, open the link, choose **Register**, and type it in.
2. You'll land on a holding page — the host has to approve you. It does not
   refresh by itself, so reload once they say they've done it.
3. Once approved, the video appears and follows the host automatically. Don't
   try to keep in sync manually; play, pause and seeking are theirs.

**If the picture is frozen, or there's no sound:** your browser blocked
autoplay. Click anywhere on the video — there is usually a "Click to join"
overlay saying so. This is the single most common thing to go wrong, and one
click fixes it.

You control your own volume and fullscreen. Everything else is the host's.

You get the same slim header the host has — title, "N watching", connection
status — and a normal windowed player under it, with a fullscreen button
(`⛶`) in the header alongside the rest; double-clicking the picture or
pressing `f` does the same thing. Fullscreen always takes the whole stage,
not just the `<video>`, so the subtitle canvas comes with you and you can
still read the bottom line. The sidebar of tabs — library, stats, log,
accounts — is the host's; you don't get it, but you do get everything else.

Two things that will happen and are not faults: **signing in on another device
signs this one out** — one account is one browser — and **the film pauses for
everyone if someone's connection drops**, with a notice saying who. It resumes
when the host presses play.

If you were watching and it stops: the page reconnects on its own after a
network blip. If it says your session ended, sign in again.

## Files

```
server.js    HTTP + WebSocket server. Library index, range serving, room state,
             track discovery, subtitle and font extraction, the encode queue,
             the access gate.
db.js        SQLite: users, invites, settings. No dependency — node:sqlite.
auth.js      Session cookies and the per-IP rate limiter.
pages.js     Server-rendered login / register / setup pages.
watch.html   The player, sidebar, encode panel and accounts panel. No build
             step.
test/        Plain-node tests: the access-gate matrix, account management,
             room behaviour, request-body decoding, and encoder lifetime.
             `npm test`.
memory/      Notes for whoever works on this next: how it is built, and which
             bugs were expensive to find.
data/        app.db lives here. Gitignored.
```

## Media compatibility

Browsers agree on far less than you'd expect, and not in the way the folklore
says. Measured with `canPlayType` and `MediaCapabilities` in Edge/Chromium:

| | Verdict |
|---|---|
| MKV container | fine in Chromium (`maybe`); Firefox has no MKV demuxer at all |
| FLAC audio | fine — `probably`, in MP4 or standalone |
| H.264, VP9, AV1 | fine |
| **HEVC / H.265** | **unsupported, every container, 8-bit and 10-bit alike** |
| 10-bit | unsupported even where the codec is |
| DTS, TrueHD | decode nowhere |
| Subtitles | WebVTT only — but ASS/SSA is rendered with libass, below. PGS and VOBSUB are bitmaps needing OCR, so they are filtered out. |

**HEVC is almost always the real culprit.** A file named
`(BD HEVC 1920x1080 FLAC).mkv` looks like three problems and is one: Chromium
demuxes the MKV and decodes the FLAC without complaint. The symptom is
distinctive — **audio plays, video does not** — because the container and audio
are fine and only the video track has no decoder.

Chrome and Edge on Windows *can* do HEVC, but only with Microsoft's paid
**HEVC Video Extensions** installed, and then subject to hardware support.
That is no use for a watch party: every viewer would need it, and it excludes
Firefox and Linux entirely.

So unplayable files are transcoded instead — see below.

### Misleading error messages

A missing codec surfaces as `MEDIA_ERR_NETWORK` with
`PIPELINE_ERROR_READ: FFmpegDemuxer: data source error`, which reads as a
network or tunnel fault and sends you debugging the wrong thing entirely.

`GET /tracks/<id>` therefore reports a verdict alongside the track list, from
the ffprobe data it was already collecting:

```json
{ "video": { "codec": "hevc", "pixFmt": "yuv420p10le" },
  "play": { "ok": false,
            "reasons": [{ "what": "video",
                          "text": "This file is HEVC (H.265), which browsers cannot decode without an OS codec" }] } }
```

Without ffprobe the verdict is always `ok: true` — claiming nothing beats
warning wrongly.

### Encoding, from the Encode panel

Unplayable files are converted ahead of time. The host opens **Encode** in the
sidebar, queues what they want, and plays it once it is ready.

This used to happen during playback: asking for an unplayable file started an
ffmpeg pipe and the viewer watched the output live. It worked, and it was the
wrong shape. A fragmented-MP4 pipe has no index, so the browser could not seek
in it — every seek restarted the encoder, which cost far more than the seek
saved. Working around that meant the client grew a substitute scrub bar, a
substitute clock, and a subtitle time offset, and two encoders ran at once on a
machine that was also serving video. All of that has gone. `GET /transcode/<id>`
now serves a finished file or answers `409`; it never starts an encoder.

The panel lists every file the probe says a browser cannot decode, with the
reason, plus anything queued and anything already converted:

| State | What it means |
|---|---|
| *(button)* | Not converted. **Encode** queues it. |
| `waiting` | Queued behind something else. **Remove** takes it out. |
| `42%` | Converting now, with a progress bar. **Stop** kills it. |
| `ready` | Converted. Play it and it just works. |
| `failed` | ffmpeg's own error is shown. **Retry** re-queues it. |

Progress comes from ffmpeg's `-progress` stream rather than by parsing its
human-readable stderr, which changes wording between releases.

**Clear finished** empties the finished and failed rows. It does not delete
anything — the converted files stay on disk, and the panel goes on listing them
as ready.

### What it costs while it runs

- **One conversion at a time**, however much is queued. Two encoders on a
  machine that is also serving video is how playback starts stuttering for
  everyone.
- **It keeps going when the room empties.** The opposite of the old rule: a
  background build used to be cancelled when the last viewer left, because it
  only existed to serve someone who was waiting. A queued encode is work the
  host asked for ahead of time, and an empty room is exactly when it should be
  getting on with it.
- **A thread budget.** `TRANSCODE_THREADS` defaults to half the cores so the
  server can still read files and serve video while it encodes. If playback
  stutters during a conversion, set it to `1`.

Since nothing encodes at playback time any more, the way to keep a small server
idle while people are watching is simply to queue conversions beforehand.

### The encoder settings

Benchmarked on a 30s 1080p source rather than assumed, and the intuitive
choices turned out wrong:

| preset / CRF | speed | bitrate |
|---|---|---|
| ultrafast, 23 | 14.3× | 14.1 Mbps |
| veryfast, 23 | 10.4× | 4.3 Mbps |
| **veryfast, 26** | **11.1×** | **2.8 Mbps** |
| faster, 26 | 9.1× | 2.9 Mbps |
| fast, 26 | 7.7× | 3.2 Mbps |
| medium, 26 | 6.7× | 3.1 Mbps |

`ultrafast` trades away five times the bandwidth for its speed, which is a bad
deal over a tunnel. Presets slower than `veryfast` came out **both slower and
larger** — they buy nothing here. So: `veryfast`, CRF 25, capped at 5 Mbps,
128k stereo AAC, and threads left below the core count so the server can still
serve. In practice that runs about **7× real time at 3 Mbps**.

Hardware encoding is not used, and that was measured too: NVENC reports "no
capable devices", QSV and AMF fail to initialise, and `h264_mf` — the only one
that works here — has no profile control and emitted Constrained Baseline.
libx264 matched its speed with High profile and proper rate control. On a
machine with working NVENC or QSV, `TRANSCODE_VIDEO` in `server.js` is the
constant to revisit.

### Where converted files live

A finished encode is written to `DATA_DIR/transcoded/<id>.mp4` and served as an
ordinary file: byte ranges work, the duration is real, and the browser's own
controls do the seeking. A `.done` marker distinguishes a finished encode from
one killed halfway, which would otherwise play as a truncated film.

A cancelled encode's `.part` file is removed once ffmpeg has actually exited —
not at the moment it is killed, since the signal is asynchronous and on Windows
the open handle makes the delete fail outright. Any `.part` files left by a
crash are swept at startup.

`TRANSCODE_CACHE_GB` (default 20) caps the directory; oldest files are evicted
once it is exceeded. `CACHE_DIR` moves it off the data directory entirely, which
is worth doing when the system disk is small or slow — an SD card, say.

**Orphans.** A converted file whose source has gone — deleted, moved, or
`MEDIA_DIRS` reordered, which changes every id — is listed at the bottom of the
panel with its size and a **Delete** button. Nothing will ever ask for one
again, but it goes on counting against the disk budget, so a reorganised
library can quietly lose most of its cache to files it can no longer reach. The
delete refuses any id still in the library, so it cannot be turned into a way
to remove the film everyone is about to watch.

## Audio and subtitle tracks

Both are room state: the host picks, everyone follows. Selectors appear in the
footer only when a file actually has a choice to make.

- `GET /tracks/<id>` lists the audio and text-subtitle streams (needs ffprobe;
  without it the pickers just stay hidden).
- `GET /subs/<id>/<n>.vtt` converts one subtitle stream to WebVTT on demand.
- `GET /subs/<id>/<n>.ass` serves the same stream untouched, for libass.
- `GET /fonts/<id>.bin` returns the fonts attached to the container.

**`<n>` indexes the published list, not ffmpeg's.** The list has the bitmap
formats filtered out of it, so `-map 0:s:<n>` — which counts every subtitle
stream in the file, PGS included — hands back the wrong track. On a release
with `[3] ass, [4] ass, [5] pgs, [6] pgs` it happens to agree; reorder those
and picking "English" silently returns a PGS stream the browser cannot use, so
the subtitles simply never appear. The probe already records each stream's
absolute index, and the route maps by that instead. A track number outside the
list is a `404` rather than an empty `200` that hangs.

### ASS subtitles are rendered with libass

ffmpeg's WebVTT muxer keeps timing and line breaks and throws away everything
else — font, size, colour, outline, border style, position. Two differently
styled tracks come out looking identical, and typeset signs land in the wrong
place. For plain dialogue that is fine; for anything styled it is not.

So ASS and SSA tracks are rendered with [libass](https://github.com/libass/libass)
instead, compiled to WebAssembly via [JASSUB](https://github.com/ThaUnknown/jassub) —
the same library mpv uses. The raw ASS goes to the browser untouched and is
painted on a canvas over the video, with the fonts attached to the MKV extracted
and handed to the renderer so signs keep their intended metrics. Everything else
still takes the WebVTT path, and so does ASS if libass fails to start.

Two consequences worth knowing:

**The watch page is cross-origin isolated.** libass is a pthreads build and
needs `SharedArrayBuffer`, which browsers only grant to a page sending
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp`. Everything the page loads is same-origin so this costs nothing
today — but any third-party script, font or image added later will be blocked
unless it sends its own CORP header.

**Rendering is driven by `requestVideoFrameCallback`**, which only fires while
frames are actually being presented. Subtitles appear when playback starts; a
long pause simply holds the last drawn frame.

**Audio switching is the weak spot.** `HTMLMediaElement.audioTracks` is
unimplemented in Chrome and Firefox, so on those browsers the selection syncs
and displays but cannot actually change the playing track. Safari honours it.
For dual-audio files where this matters, the workaround is a file with a
single audio track.

**The host heartbeat used to tear down a working libass renderer.** Track
selection is re-applied on every state message rather than only once, so that
a renderer torn down by a reconnect gets rebuilt — but re-applying fell
through to the WebVTT branch, which begins by calling `destroyJassub()`,
whenever the track list wasn't loaded yet. A routine heartbeat arriving while
the `/tracks/` probe for a just-opened file was still in flight tore down a
working canvas that had rendered a moment earlier, and nothing rebuilt it. The
obvious guard doesn't work: the flag that names which file `tracks` is being
read for is claimed before the fetch even starts, so it's already set to the
new file and can't tell "not loaded yet" from "loaded, and this one". A
second flag, `tracksReadyFor`, now records which file the list actually
*describes*, and applying tracks returns early unless it matches — the
re-assertion on every state message stays, only the teardown-on-unknown-list
is gone.

## The player

The stage — the box the video, the subtitle canvas and the click-to-join
overlay all live in — takes the space available and gives itself the picture's
own `aspect-ratio`, carried in a `--ar` custom property set from
`videoWidth`/`videoHeight` on `loadedmetadata`. Whichever of width or height
binds first, the other follows, and the centring grid around it absorbs what is
left over.

That one rule fixes two things at once. The player now **grows to the window**:
it used to be sized `width: auto; height: auto`, which means the file's own
pixel size, so a 1080p file sat at 1080p in a larger window with a black border
around it. And because the stage is now exactly the rendered picture rather
than the pane containing it, **subtitles land on the frame** — the canvas is
positioned against the stage, so a stage bigger than the picture drew the
bottom line on the letterbox, or past the bottom edge where the shell clips.

**Fullscreen goes to the stage, never the `<video>`.** The browser's own
fullscreen button takes the video element alone, and the subtitle canvas is a
sibling of it, not a child — so it stays behind on the page and subtitles
vanish at the moment a viewer most wants them. A `fullscreenchange` handler
catches that and promotes the stage instead; Safari's element-only fullscreen
is caught through `webkitbeginfullscreen`, and double-clicking the stage does
the same thing directly. There is also an explicit fullscreen button (`⛶`)
in the header, and the `f` key, for anyone who would not think to
double-click the picture.

## The sidebar

**Admins only.** A viewer has nothing to administer and nothing to choose — the
library, stats, log and account controls are all the host's — so the sidebar
is removed from the layout rather than hidden, and the video takes the full
width. They keep the header, though, and get a normal windowed player rather
than an edge-to-edge one: chasing "no chrome at all" for viewers used to mean
solving every overflow problem by making the picture exactly the viewport and
clipping anything that didn't fit, which is more fragile than just giving
them a header and letting the player be a window like the host's.

The page itself never scrolls, at any window size. `body` is a hard `100dvh`
with `overflow: hidden`, and every list that can grow scrolls inside its own
pane. Panels are bounded by their container rather than by `dvh` units, which
is what used to overflow: a `78dvh` video ignores the header above it, and a
stacked sidebar below 60rem took its natural height on top of that.

That bounding has to hold the stage and the video to the *same* rectangle, or
the subtitle canvas — which is positioned against the stage, not the video —
comes loose from the picture. Below the 60rem breakpoint the video was capped
at `max-height: 45dvh` but the surrounding `#stage` box was not, so at
800x600 as an admin the stage sat 436.5px tall around a 270px picture and
subtitles were drawn into the gap below the frame instead of on it. The cap
now goes on `#stage` itself, so the two shrink together. Checked by driving
headless Edge over CDP across 8 viewport sizes and both roles (16
combinations, including boundary probes either side of 960px): the stage and
video rects coincide exactly in all 16, and the page never scrolls in any of
them.

Four tabs beside the video, replacing what used to be a row of controls along
the bottom.

**Library** filters on the full path, so typing a folder name finds everything
under it. The list caps at 400 rendered rows and says so — filtering is cheaper
than drawing thousands of nodes.

**People** shows one row per connected client. `buffering` is the server's own
view, since it is already holding the room for those clients. Latency and drift
are **self-reported**: the server cannot observe a viewer's playback position
any other way. Clamped on arrival, and shown as `no data` if a client goes
quiet for 20 seconds.

**Encode** is admin-only. Rows are keyed by file id and merged from two
sources — `/list` says what is in the library and which ids already have an
encode on disk, the server's `encode` message says what is queued, running or
failed — so a file that appears in both does not get two rows. Working out
which files *need* converting costs an ffprobe each, so the probing only starts
when the tab is first opened, and its answers are remembered.

**Stats** is admin-only and sampled every 2 seconds:

| Figure | Source |
|---|---|
| CPU (machine) | Delta between two readings of `os.cpus()` time counters. `os.loadavg()` is zeros on Windows, so it can't be used. |
| CPU (this app) | `process.cpuUsage()` delta, divided by elapsed time and core count. |
| Upload | Bytes written to media responses. Counted at the read stream, so it is payload only — no TLS or framing overhead. |
| Disk read | Same counter at the source; it tracks upload closely unless the OS cache is serving. |

One timer drives the whole server, and it returns early when nobody is
connected, so an idle deployment samples nothing.

## Keeping everyone in step

Room time is an anchor — a position and the server clock it was true at — and
every viewer extrapolates from it. Four things have to be right for that to
work, and each of them was wrong in a way that showed up as "the sync is
horrible".

**The host is the reference, not a follower.** The drift correction runs on
viewers only. Measuring the host against room time is circular — room time *is*
the host's last report — so the correction ended up fighting the person it was
supposed to be following, nudging their playback rate and eventually seeking
them mid-scene.

**The anchor is refreshed while the film plays.** It used to move only when the
host pressed something, so an hour into an untouched film everyone was
extrapolating from an hour-old reading. The host's own playback rate is never
exactly 1.0, so the reference itself had drifted from what viewers were being
held to, and nothing could correct it. The host now reports its real position
every two seconds; the server re-anchors on it and only tells the room when the
figure moved more than 0.5s, so a steady stream of heartbeats is not itself a
source of jitter. It is not a control — it never plays, pauses or seeks anyone —
and it is ignored while the room is paused or holding for a buffering viewer,
where the anchor is deliberately frozen.

**Corrections are continuous.** Two bands, and nothing falls between them:

| drift | what happens |
|---|---|
| under 0.15s | left alone |
| 0.15s to 2.5s | `playbackRate` leans, scaled with the error and capped at ±12% |
| over 2.5s | a seek |

The gap that used to sit between them is the "it's ahead and not even trying"
case: the code hard-seeked above 2s, but on the transcode path the seek
declined to act for anything under 3s. A viewer between the two took the seek
branch, got nothing, and never reached the rate branch either — so they stayed
wrong indefinitely. The thresholds are now defined next to each other so they
cannot drift apart again.

**The clock estimate is not one sample.** `offset` is derived from ping/pong,
and the old code took the newest reading as truth every fifteen seconds — so a
single round trip that queued behind a video segment moved every sync decision
by however long that took. Eight samples are kept and the one with the *lowest*
round trip wins, which is the trick NTP uses and the right one here: latency is
only ever added to a packet, never subtracted, so the quickest exchange is the
least contaminated. A fresh connection measures five times in two seconds to get
an estimate quickly, then every five seconds after that — which doubles as the
keepalive through the tunnel. The correction refuses to act at all until the
clock has been measured once.

**The echo guard only covers `control`.** Obeying a state message means
calling seek/play/pause on our own element, which fires the same events a
person pressing the button would — and echoing those back would bounce the
room's own state at it, so outbound messages are suppressed for 300ms after
applying one. That guard used to cover every outbound message, which was
three separate bugs at once: a seek fires the `waiting` event inside exactly
that window, so `stall` was swallowed and the server never learned a viewer
was buffering; the matching `ready` could be dropped too, leaving the viewer
stopped on a still frame while the host played on; and the host's own
heartbeat, every two seconds, made that window of silence come round
constantly. It also ate admin commands that arrived at the wrong moment —
clicking Encode just after a state message did nothing. The guard now names
what it actually applies to (an `ECHOABLE` set containing only `control`),
and `ready` additionally restarts playback if the room is playing and we are
paused, so a seek can no longer strand a viewer on a frozen frame.

## Interruptions

**Someone's connection drops mid-film and the room pauses**, with a notice
naming who. Nobody watches on without them, and the reason is on screen rather
than left to guess. Closing a tab deliberately sends a `bye` first, which is
treated as leaving rather than dropping — so tidying up your own tabs does not
stop everyone else.

A viewer whose own socket closes pauses their player locally too, and says why.
Left alone it would drift on out of sync against a room it can no longer hear
from.

Joins and leaves are announced to everyone as transient notices over the video.

## One account, one browser

Signing in bumps a `session_epoch` on the user row, and that epoch is part of
the signed session cookie. An older cookie no longer verifies, so **logging in
somewhere new signs the previous browser out**. The alternative — the same
account in two tabs — shows up as a duplicate in People and makes the drop
detection meaningless.

Sessions remain stateless signed cookies; there is no session table to sweep.
The epoch is read on every request, alongside role and status, which were
already being read live.

## Guests see a frozen video

Almost always browser autoplay policy, not a sync bug. A browser will not start
playback with sound until that viewer has interacted with the page, so a guest
who just opens the link sits on a still frame while the host sees "N watching"
and assumes everyone is fine.

The tell is that **pause propagates but play doesn't** — `v.pause()` never needs
permission, `v.play()` does.

Handled in two steps. Playback is retried muted, which browsers do allow, so the
picture moves for everyone; an overlay on the video then asks for a click to
restore sound. If even muted playback is refused, the overlay says so instead.
Clicking anywhere on it unmutes, re-syncs, and starts playing.

## Debugging

```bash
node server.js <dir> --verbose      # or VERBOSE=1
```

Logs every join, leave, load, play/pause, track change, buffering stall and
range request, with timestamps. Range lines show both what was asked for and
what was sent, which is what you want when seeking misbehaves.

Add `?debug=1` to any viewer's URL for an on-page log panel under the player —
websocket events, state messages, drift, decode errors, and every autoplay
decision. It exists because guests can't be talked through devtools.

Guests' important failures — decode errors, autoplay blocks — are also
forwarded to the server log, prefixed with their name, so the host sees them
without having to ask:

```
15:48:07.910 [Dana] autoplay blocked — nothing will play until this viewer clicks
15:52:06.799 [guest44] trying muted playback
```

## Known issues

**WebSocket idle timeout through the tunnel.** `cloudflared` drops idle
WebSockets at ~100s. The clock ping now runs every 5 seconds, which keeps it
alive with room to spare; unverified over a multi-hour session. The client
reconnects automatically, so the symptom is a brief desync rather than a
failure.

**Cloudflare free-plan terms.** Section 2.8 restricts serving large non-HTML
content through the proxy, and video is the named example.

**Echo suppression is timing-based.** `applying` is released on a 300ms timer
rather than on the promise, because `v.play()` can stay pending indefinitely
while buffering. It now only gates the one message type that can actually
echo (`control`), so a stuck timer can no longer swallow `stall`, `ready` or
an admin command — but a `control` sent by a person, not the room, in that
300ms window is still dropped. A sequence number on state messages would be
correct.

**The rate limiter trusts `X-Forwarded-For`.** Behind the tunnel every request
arrives from the same socket, so the client IP has to come from that header —
which is spoofable without a trusted-proxy allowlist. It stops sustained
guessing from a single host and is not more than that. Cloudflare Access in
front of the tunnel remains the stronger answer.

## Design notes worth preserving

Two longer documents sit in `memory/`, for anyone about to change something
rather than just run it. [architecture.md](memory/architecture.md) covers how
the pieces fit and which parts are load-bearing;
[mistakes.md](memory/mistakes.md) records the bugs that were expensive to find,
with what would have found each one sooner. Worth reading before touching sync,
subtitles or layout — all three have bitten more than once.

**Files are addressed by opaque id, never by path.** `/media/<sha1-prefix>`
looks up a pre-built index, so there is no traversal to defend against. The id
is a hash of the path *relative to its root*, mixed with the root's index, so
moving the library keeps every id stable — but reordering `MEDIA_DIRS` does
change them.

**The access gate is default-deny, and asset requests never get a redirect.**
Unauthenticated HTML requests go to `/login`; media, API and WebSocket requests
get 401/403 with a non-HTML body. Redirecting a `<video>` element's request
feeds it a login page, which the decoder reports as a corrupt file rather than
as "you are signed out".

**Identity comes from the session, never the client.** The WebSocket
authenticates in `verifyClient`, so an unauthorised socket is never
established, and the username in "waiting for Dana" is the authenticated one.

**Range requests clamp rather than reject**, and suffix ranges (`bytes=-65536`,
"the last 64KB") are honoured as suffixes. Getting this wrong returns the head
of the file under a `Content-Range` claiming it is the tail, which browsers
report as a corrupt file the moment you seek.

**Joins don't broadcast full state.** New arrivals get the state; existing
viewers get only a headcount, so nobody re-seeks when someone walks in.

## Next steps, roughly in order of value

1. Cloudflare Access in front of the tunnel.
2. A "transfer host" control, so you can hand off without restarting.
3. Encoding housekeeping. Orphaned conversions can now be deleted from the
   panel, but nothing notices them automatically, and the cache is keyed by
   file id rather than content — so the same film under a new name is encoded
   twice.
4. The queue does not survive a restart. A conversion interrupted by one has to
   be queued again — the `.part` file is swept at startup rather than resumed,
   since ffmpeg cannot append to it.
5. **Queue a whole folder at once.** Queueing a 26-episode season one row at a
   time is the obvious next annoyance now that encoding is explicit.
6. A sequence number on state messages, which would let the echo guard drop
   its 300ms timer entirely. Less urgent now that the guard only covers
   `control` — the failure modes that made it costly are gone — but the
   remaining edge (a real `control` sent by a person in the same window as a
   remote one) is still there in principle.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

The short version: you can use, modify and share this freely, but if you run a
modified version as a network service, the people using it are entitled to
your changes.
