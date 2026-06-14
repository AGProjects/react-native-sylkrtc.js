# Changelog

## 2.0.2 - 2026-06-14

### Fixed

#### Addressbook
- `Addressbook._populate()` now **replaces** the contact/group/policy caches on
  a full load instead of merging into them. Previously a contact or group that
  had been deleted on another device lingered in the cache forever — a re-fetch
  could never drop it — so deleted groups kept showing.
- `Addressbook._update()` now **removes** the item from its cache on a `delete`
  action (it previously only emitted `dataDeleted`, leaving the stale entry in
  the map until app restart).
- `Addressbook._updateFailed()` now forwards the server's `retryable` flag on
  the `dataUpdateFailed` event, so clients can queue transient write failures
  for retry and drop permanent (4xx) ones.

  (These were previously carried as a `patch-package` patch in the consuming
  app; folded into the library here.)

## 2.0.1 - 2026-06-14

### Fixed

#### DTMF (call)
- `Call.sendDtmf()` no longer calls the non-existent
  `RTCPeerConnection.sendDTMF()`, which threw
  `TypeError: this._pc.sendDTMF is not a function` under react-native-webrtc
  124 / unified plan and broke outgoing DTMF. Tones are now sent through the
  audio `RTCRtpSender`'s `dtmf` channel (`RTCDTMFSender.insertDTMF`), with a
  lazy fallback that resolves `_dtmfSender` from `_audioSender.dtmf` if it
  wasn't captured during `call()` / `answer()`.

## 2.0.0 - 2026-06-13

Ports the addressbook API from sylkrtc.js.

### Added

#### Addressbook (addressbook, connection, account)
- New `Addressbook` class managing contacts, policies and groups across all
  accounts on a connection, exposed via `connection.addressbook`.
- `Account.addressbookFetched` getter; the addressbook is fetched
  automatically once an account becomes `registered`.
- Handles the `addressbook-fetched`, `addressbook-updated` and
  `addressbook-update-failed` server events, emitting `dataLoaded`,
  `dataCacheLoaded`, `dataUpdated`, `dataUpdateFailed` and `dataDeleted`.

Folds in the sylk-mobile field patch (previously
`react-native-sylkrtc+1.7.0.patch`):

#### Messaging (account, call)
- Skip the automatic `delivered` IMDN for
  `application/sylk-message-metadata` messages (location ticks, meeting
  handshakes, control markers) so transient control traffic doesn't
  generate per-tick delivery receipts over the wire.

#### Call (call)
- Stash the raw answer SDP as `Call._answerSdp` before it round-trips
  through the native peer connection, so consumers can still read the
  remote's `s=` product token (libwebrtc rewrites the session name to
  `s=-` on `setRemoteDescription`).

#### Statistics (statistics)
- In-flight guard on the stats monitoring poller: skip a tick while a
  previous `getStats()` is still pending (with a stale-timeout escape) to
  avoid piling up pending native callbacks under load.

## 1.7.0 - 2026-06-11

Folds in the sylk-mobile field changes: react-native-webrtc M124 support,
codec negotiation, mid-call video, conference moderation, audio levels and
graceful-restart resume.

### Added

#### Codec preferences (utils, sylkrtc)
- Application-selectable preferred codecs: `setPreferredVideoCodec` /
  `getPreferredVideoCodec` (default `VP8`) and `setPreferredAudioCodec` /
  `getPreferredAudioCodec` (default `opus`), exported on `sylkrtc.utils`.
- `pickAnswerVideoCodec` / `pickAnswerAudioCodec` choose the answer codec
  from the offer, honouring the user preference when the offer advertises
  it and falling back to the offerer's first real codec otherwise.
- `mungeSdp`, `pickAnswerVideoCodec` and `pickAnswerAudioCodec` are now
  exported on `sylkrtc.utils` so callers can log/inspect the wire SDP.

#### Mid-call renegotiation (call)
- `Call.addVideo({ localStream })` upgrades an established audio call to
  audio+video via a SIP re-INVITE / Janus update, reusing the existing
  RTCPeerConnection so audio is not interrupted.
- `Call.answerUpdate({ localStream })` answers a peer-initiated re-INVITE.
- New events: `updateRequest`, `mediaUpdated`, `updateFailed`.

#### Faster call answer (call)
- `Call.prewarm(pcConfig)` builds the RTCPeerConnection, applies the
  remote offer and pre-generates the local answer during the ringing
  window, so `answer()` ships the prewarmed SDP immediately. `answer()`
  now has full-prewarm / partial-prewarm / cold paths.

#### Conference moderation & roster (conference)
- `ConferenceCall.removeParticipants(ids)` (REFER ;method=BYE via the
  gateway) and `ConferenceCall.muteParticipant(id, muted)`
  (per-participant mute/unmute, WebRTC or SIP).
- `Participant` now carries `type` (`webrtc` | `sip` | `bridge`),
  server-reported `muted`, and `audioLevel`, with `setMuted`
  (emits `muteChanged`) and `setAudioLevel` (emits `updated`).
- New conference events: `publisher-updated` (mute deltas),
  `mute-request` → `muteRequest`, `conference-audio-levels` (real-time
  per-participant levels), `invite-status` → `inviteStatus`, and
  `conferenceDuration` seeded from the gateway on join.

#### Graceful-restart resume (connection)
- `addAccount` accepts `options.previousSessionToken`; the server's
  `resume_token` / `resumed` are surfaced via the `cb(error, account,
  meta)` third argument, the `resumeToken` event, and the
  `connection.resumeToken` / `connection.resumed` getters — letting the
  app fold its session back onto server-side Janus state after a restart.
- `Connection.ping(timeoutMs = 2000)` — on-demand liveness probe that
  resolves on the server ack or rejects on timeout.

### Changed

- **User agent**: `createConnection`'s `userAgent` option now lets the
  application fully control the reported user agent — it accepts a string
  (used verbatim) or a `{ name, version }` object and **replaces** the
  library default instead of appending to it.
- **react-native-webrtc M124 / unified-plan**: replaced the removed
  `addStream` / `addstream` APIs with `addTrack` and the `track` event
  throughout call and conference; remote media is taken from the
  native-backed `track` stream so it renders correctly.
- **Keep-alive**: control-plane ping relaxed from every 3 s / 7 missed
  acks (~21 s) to every 5 s / 9 missed acks (~45 s) to avoid tearing
  down calls during transient network events.
- **Statistics**: default `getStatsInterval` raised to 5000 ms to stop
  the per-second `getStats()` from causing a periodic video freeze on
  react-native-webrtc 124.x.
- **In-dialog messaging**: in-call messages and disposition notifications
  are forwarded to the parent `Account` by default; set
  `call.enableInlineMessaging = true` for the legacy Call-level behaviour.
- Incoming offers are run through `mungeSdp` once in `_initIncoming`, so
  every consumer (prewarm and the accept paths) sees the same SDP.

### Fixed

- **H.264 interop (Android ↔ Safari)**: `mungeSdp` rewrites H.264
  `profile-level-id` to Constrained Baseline (keeping the level) so
  Android libwebrtc maps Safari's High-profile PT and inbound video no
  longer freezes to a black window.
- **Answer codec divergence**: the answer side now pins the video
  transceiver via `setCodecPreferences` (`reorderTransceiverCodecs`)
  before `createAnswer`, so `pc.localDescription` and the wire SDP agree
  on the negotiated codec (previously only the wire SDP was reordered,
  silently breaking video — and audio on incoming calls).
- **DTMF on Asterisk / PSTN**: high-clockrate `telephone-event` variants
  are stripped so libwebrtc emits DTMF on `telephone-event/8000`, which
  gateways and IVRs actually detect.
- **Re-INVITE FSM regression**: provisional (ringing/proceeding)
  responses to a mid-call update no longer regress an established call's
  state.
- Audio-codec ordering in `mungeSdp` is now family-aware (e.g. PCMA →
  PCMA, PCMU, G722, Opus) instead of only promoting the chosen codec.
- `parseStats` now reports codec `channels` and `sdpFmtpLine`.

### Diagnostics

- Added always-on, greppable SDP dumps (`[sylkrtc][sdp]`), codec
  negotiation lines (`[video] [media] [call]`) and call-terminate tracing
  (`[APPLOG] ... [terminate]`) to make codec/interop and teardown issues
  traceable from device logs without enabling the `debug` namespace.
