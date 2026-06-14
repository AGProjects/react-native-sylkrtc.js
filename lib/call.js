'use strict';

import debug from 'react-native-debug';
import uuid from 'react-native-uuid';
import transform from 'sdp-transform';
import utils from './utils';

import { EventEmitter } from 'events';

import { Message } from './message';
import { Statistics } from './statistics';

const uuidv4 = uuid.v4;

const DEBUG = debug('sylkrtc:Call');
//debug.enable('*');

// APPLOG helper for terminate paths.
//
// Without this, every internal terminate inside sylkrtc-js (caused by
// setRemoteDescription failures, createAnswer failures, trickle/answer
// request errors, etc.) is swallowed into DEBUG() calls — invisible
// in metro.log unless debug is globally enabled. That made it
// impossible to tell whether a "incoming -> terminated" was a real
// upstream cancel, a server-side decline, or sylkrtc-js auto-
// terminating after a silent WebRTC error.
//
// The format `[APPLOG] <iso-ts> [call] [sylkrtc] [terminate] ...`
// mirrors the host app's utils.timestampedLog output (which prefixes
// every line with "[APPLOG]" via log2file). That keeps these lines
// greppable alongside the app's normal call/[ui] log stream in
// metro.log, without needing to plumb the host's logger through.
//
// Pure diagnostic — never throws, never changes flow.
function _terminateLog(callRef, path, extra) {
    try {
        const ts = new Date().toISOString();
        const callId = (callRef && (callRef._callId || callRef._id)) || '?';
        const state = (callRef && callRef._state) || '?';
        const direction = (callRef && callRef._direction) || '?';
        let line = '[APPLOG] ' + ts + ' [call] [sylkrtc] [terminate]'
            + ' path=' + path
            + ' call_id=' + callId
            + ' state=' + state
            + ' direction=' + direction;
        if (extra !== undefined && extra !== null) {
            let detail;
            if (extra instanceof Error) {
                detail = (extra.name || 'Error') + ': ' + (extra.message || String(extra));
                if (extra.stack) {
                    detail += ' | ' + String(extra.stack).replace(/\r?\n/g, ' \\n ');
                }
            } else if (typeof extra === 'object') {
                try { detail = JSON.stringify(extra); } catch (e) { detail = String(extra); }
            } else {
                detail = String(extra);
            }
            line += ' reason=' + detail;
        }
        // Flatten any embedded newlines so the line stays grep-friendly
        // and matches the format the host app uses for its own logs.
        console.log(line.replace(/\r?\n/g, ' \\n '));
    } catch (e) {
        // Never let the diagnostic itself break the terminate flow.
        try { console.log('[APPLOG] [call] [sylkrtc] [terminate] log helper threw: ' + e.message); } catch (e2) {}
    }
}

class Call extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._callId = null;
        this._direction = null;
        this._pc = null;
        this._state = null;
        this._terminated = false;
        this._incomingSdp = null;
        this._remoteMediaDirections = {};
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._remoteIdentity = null;
        this._remoteStreams = new MediaStream();
        this._localStreams = new MediaStream();
        this._previousTrack = null;
        this._sharingScreen = false;
        this._dtmfSender = null;
        this._delay_established = false;  // set to true when we need to delay posting the state change to 'established'
        this._setup_in_progress = false;  // set while we set the remote description and setup the peer copnnection
        this._headers = []
        this._messages = new Map();
        // 5000ms instead of the default 1000ms: on rn-webrtc 124.x the
        // per-second pc.getStats() call disturbs the video renderer
        // enough to cause a periodic visible freeze. 5s is plenty for a
        // bandwidth / packet-loss readout in the UI.
        this._statistics = new Statistics({ getStatsInterval: 5000 });
        // Inline (in-dialog / session-event) chat handling. A legacy
        // feature that let chat messages exchanged BETWEEN the two
        // call parties be received on the Call object itself instead
        // of the parent Account — useful when a UI wanted a strictly
        // "this conversation belongs to this call" view. Modern
        // consumers (sylk-mobile) no longer want this split: the same
        // chat thread should look identical whether or not a call is
        // active, and the duplicated dispatch path was the source of
        // the "this.sendDispositionNotification is not a function"
        // class of bugs (Call doesn't define sendDispositionNotification,
        // only Account does).
        //
        // Default is OFF — incoming session-event messages are
        // forwarded to the Account so the app's account.on('incomingMessage')
        // listeners fire exactly once and the IMDN reply runs through
        // the Account's well-tested method. Apps that still need the
        // legacy behaviour can flip `enableInlineMessaging = true`
        // on the Call instance after construction.
        this.enableInlineMessaging = false;
        // Mid-call renegotiation (Janus SIP plugin "update" / SIP
        // re-INVITE) lifecycle flags. _upgrading is true between the
        // moment a local or remote update starts and the moment the
        // matching answer / failure event arrives — used to reject
        // overlapping addVideo() calls and to gate setRemoteDescription
        // until the PC is back in a state that accepts an answer.
        // _pendingVideoAddition holds the senders + tracks we added
        // optimistically before the update was confirmed, so we can
        // roll them back if the remote rejects the offer with
        // m=video 0 or returns an error.
        this._upgrading = false;
        this._pendingVideoAddition = null;
        // bind some handlers to this instance
        // this._onDtmf = this._onDtmf.bind(this);
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
    }

    get callId() {
        return this._callId;
    }

    get headers() {
        return this._headers;
    }

    get sharingScreen() {
        return this._sharingScreen;
    }

    get direction() {
        return this._direction;
    }

    get state() {
        return this._state;
    }

    get localIdentity() {
        return this._localIdentity;
    }

    get remoteIdentity() {
        return this._remoteIdentity;
    }

    get remoteMediaDirections() {
        return this._remoteMediaDirections;
    }

    get statistics() {
        return this._statistics;
    }

    getLocalStreams() {
        if (this._pc !== null) {
            if (this._pc.getSenders) {
                this._pc.getSenders().forEach((e) => {
                    if (e.track != null) {
                        if (e.track.readyState !== "ended") {
                            this._localStreams.addTrack(e.track);
                        } else {
                            this._localStreams.removeTrack(e.track);
                        }
                    }
                });
                return [this._localStreams];
            } else {
                return this._pc.getLocalStreams();
            }
        } else {
            return [];
        }
    }

    getRemoteStreams() {
        if (this._pc === null) return [];
        // Prefer the native-backed stream captured on the 'track' event.
        // It already includes the receiver tracks and is wired to the
        // renderer pipeline, so RTCView can display its frames. The
        // JS-side _remoteStreams synthesis below is a fallback for code
        // paths where the 'track' event hasn't fired yet (very early
        // call states) or older WebRTC builds.
        if (this._nativeRemoteStream) {
            return [this._nativeRemoteStream];
        }
        if (this._pc.getReceivers) {
            this._pc.getReceivers().forEach((e) => {
                if (e.track.readyState !== "ended") {
                    this._remoteStreams.addTrack(e.track);
                }
            });
            return [this._remoteStreams];
        }
        return this._pc.getRemoteStreams();
    }

    getSenders() {
        if (this._pc !== null) {
           return this._pc.getSenders();
        } else {
            return [];
        }
    }

    getReceivers() {
        if (this._pc !== null) {
           return this._pc.getReceivers();
        } else {
            return [];
        }
    }

    /**
     * Pre-warm the RTCPeerConnection during the ringing window so that
     * by the time the user presses Accept, the PC is constructed, the
     * remote SDP (offer) is parsed, transceivers are created with the
     * audio (and optionally video) direction set to sendrecv, the local
     * answer SDP is created, setLocalDescription has been called, and
     * ICE candidate gathering has started — host-only with iceServers
     * empty, but still saves the libwebrtc state-machine setup time.
     *
     * answer() then only does the work that requires the local media:
     *   - replaceTrack() on the existing transceiver senders (no
     *     renegotiation; faster than addTrack which can trigger one);
     *   - _sendAnswer with the prewarmed localDescription.sdp.
     *
     * Saves ~200–500 ms of synchronous work plus whatever ICE gathering
     * managed to finish during the ringing window. Safe to call
     * multiple times — only the first does work. If anything fails,
     * the PC is torn down and answer() falls back to the original
     * from-scratch flow.
     *
     * @param {Object} pcConfig - { iceServers: [...] }, same shape that
     *                            answer() expects in options.pcConfig.
     * @returns {Promise} resolves when local description is set.
     */
    prewarm(pcConfig) {
        if (this._state !== 'incoming') {
            return Promise.reject(new Error(
                'prewarm: call is not in the incoming state: ' + this._state));
        }
        if (this._prewarmed || this._prewarming) {
            return this._prewarming || Promise.resolve();
        }
        try {
            this._initRTCPeerConnection(pcConfig || {iceServers: []});
        } catch (e) {
            return Promise.reject(e);
        }

        // Parse the offer's m-lines so we know what kinds to addTransceiver
        // for. We need to mirror the offer's media list so the answer's
        // m-lines line up with the offer's. addTransceiver with no track
        // creates a sendrecv direction by default — when answer() later
        // calls replaceTrack(localTrack), the sender gains its track
        // without renegotiation.
        let offeredKinds;
        try {
            const parsed = transform.parse(this._incomingSdp);
            offeredKinds = (parsed.media || [])
                .filter(m => m.type === 'audio' || m.type === 'video')
                .map(m => m.type);
        } catch (e) {
            offeredKinds = ['audio'];
        }

        this._prewarming = this._pc.setRemoteDescription(
                new RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}))
            .then(() => {
                // After setRemoteDescription, the PC's transceiver list
                // already contains transceivers mirroring the offer
                // (recvonly direction by default in modern libwebrtc when
                // there's no local track yet). Flip them to sendrecv so
                // replaceTrack on the sender side works without
                // renegotiation. Some libwebrtc builds expose
                // transceiver.direction as a settable property; others
                // require setDirection(). Try both.
                const transceivers = this._pc.getTransceivers ? this._pc.getTransceivers() : [];
                for (const t of transceivers) {
                    const trackKind = t && t.receiver && t.receiver.track && t.receiver.track.kind;
                    if (trackKind === 'audio' || trackKind === 'video') {
                        try {
                            t.direction = 'sendrecv';
                        } catch (_) {
                            try { t.setDirection && t.setDirection('sendrecv'); } catch (__) {}
                        }
                    }
                }
                // Some offer shapes (or older libwebrtc) don't auto-create
                // transceivers from the remote offer; explicitly create
                // any missing ones for kinds we know are in the offer.
                if (transceivers.length === 0) {
                    for (const kind of offeredKinds) {
                        try {
                            this._pc.addTransceiver(kind, {direction: 'sendrecv'});
                        } catch (_) {}
                    }
                }
                return utils.createLocalSdp(this._pc, 'answer', undefined,
                    utils.pickAnswerVideoCodec(this._incomingSdp),
                    utils.pickAnswerAudioCodec(this._incomingSdp));
            })
            .then((sdp) => {
                this._prewarmedLocalSdp = sdp;
                this._prewarmed = true;
                this._prewarming = null;
                DEBUG('Call ' + this._id + ' prewarmed: local answer SDP ready ('
                    + sdp.length + ' bytes), ICE gathering started');
            })
            .catch((err) => {
                // Tear down the half-built PC so answer() can build a
                // fresh one from scratch. Don't leak the broken state.
                DEBUG('Call ' + this._id + ' prewarm failed: ' + (err && err.message || err));
                try {
                    if (this._pc) {
                        this._pc.close();
                    }
                } catch (_) {}
                this._pc = null;
                this._prewarmed = false;
                this._prewarmedLocalSdp = null;
                this._prewarming = null;
                throw err;
            });
        return this._prewarming;
    }

    answer(options = {}) {
        if (this._state !== 'incoming') {
            throw new Error('Call is not in the incoming state: ' + this._state);
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        // Race guard: if a prewarm() is still in flight, defer the
        // answer until it settles (either resolves with a usable
        // _prewarmedLocalSdp or rejects, in which case _prewarmed
        // is left false). Without this guard, the partial-prewarm
        // branch below tries createAnswer on a PC that prewarm has
        // already advanced into 'stable' state (prewarm does the
        // full setRemoteDescription + createAnswer + setLocalDescription
        // chain), which throws:
        //   "PeerConnection cannot create an answer in a state other
        //    than have-remote-offer or have-local-pranswer"
        // and triggers _terminateLog path=incoming_answer_chain.
        //
        // Deferring here means we always observe a settled prewarm
        // state when we evaluate fullPrewarm below — either both
        // _prewarmed AND _prewarmedLocalSdp are set (fullPrewarm
        // fast path), or both are false (cold path with no PC bias).
        if (this._prewarming) {
            const pending = this._prewarming;
            DEBUG('Call ' + this._id + ' answer: deferring until prewarm settles');
            // Use .then/.catch instead of .finally for older runtimes.
            const reenter = () => {
                try {
                    this.answer(options);
                } catch (e) {
                    DEBUG('Call ' + this._id + ' deferred answer threw: '
                          + (e && e.message || e));
                    _terminateLog(this, 'answer_deferred_reentry_threw', e);
                    this.terminate();
                }
            };
            pending.then(reenter, reenter);
            return;
        }

        const pcConfig = options.pcConfig || {iceServers:[]};
        const answerOptions = options.answerOptions;

        // Three accept paths converge here:
        //   1) Full prewarm (PC + remoteDesc + localDesc): the fast path.
        //      replaceTrack on the existing sendrecv transceivers, then
        //      ship the prewarmed local SDP straight to _sendAnswer.
        //      Skips _initRTCPeerConnection, setRemoteDescription,
        //      createAnswer, and setLocalDescription — the four steps
        //      that used to live on the press-Accept critical path.
        //   2) Partial prewarm (PC + remoteDesc only): _prewarmed is
        //      true but _prewarmedLocalSdp is null (e.g. the
        //      addTransceiver / createAnswer call threw on this
        //      libwebrtc build). Skip RTCPeerConnection construction
        //      and setRemoteDescription; do addTrack + createAnswer
        //      + setLocalDescription as usual.
        //   3) No prewarm (cold accept): _pc is null. Original flow.
        const fullPrewarm = (this._prewarmed === true) && !!this._prewarmedLocalSdp;

        if (this._pc === null) {
            this._initRTCPeerConnection(pcConfig);
        }

        this._audioSender = null;
        if (fullPrewarm) {
            // Map each local track onto the matching prewarmed sender
            // (audio→audio, video→video) via replaceTrack. The sender
            // exists because addTransceiver(kind, {direction:'sendrecv'})
            // ran during prewarm. replaceTrack doesn't trigger
            // renegotiation, so the prewarmed local SDP stays valid.
            const senders = this._pc.getSenders ? this._pc.getSenders() : [];
            options.localStream.getTracks().forEach((track) => {
                let target = null;
                for (const s of senders) {
                    const matches =
                        // sender.track may be null if addTransceiver
                        // created it without a track (typical for
                        // prewarmed sendrecv); fall back to matching
                        // against the linked transceiver's receiver.track.kind
                        (s.track && s.track.kind === track.kind)
                        || (s._unusedKind === track.kind)
                        || (s.transport === undefined && !s.track);
                    // The transceiver-receiver kind is the cleanest
                    // discriminator since prewarmed senders all have
                    // null tracks initially.
                    let transceiverKind = null;
                    try {
                        const tcvrs = this._pc.getTransceivers ? this._pc.getTransceivers() : [];
                        for (const t of tcvrs) {
                            if (t.sender === s
                                && t.receiver && t.receiver.track) {
                                transceiverKind = t.receiver.track.kind;
                                break;
                            }
                        }
                    } catch (_) {}
                    if (transceiverKind === track.kind) {
                        target = s;
                        break;
                    }
                }
                if (target && typeof target.replaceTrack === 'function') {
                    try {
                        target.replaceTrack(track);
                        if (track.kind === 'audio') {
                            this._audioSender = target;
                        }
                    } catch (e) {
                        DEBUG('Call ' + this._id + ' replaceTrack failed: ' + (e && e.message || e));
                    }
                } else {
                    // Fallback: addTrack. This may force renegotiation
                    // and the prewarmed SDP will be stale — answer()
                    // would then have to take the partial-prewarm
                    // path below, but we're already past that branch.
                    // Best-effort.
                    const sender = this._pc.addTrack(track, options.localStream);
                    if (track.kind === 'audio') {
                        this._audioSender = sender;
                    }
                }
            });

            DEBUG('Call ' + this._id + ' answer: full-prewarm fast path, shipping prewarmed local SDP');
            // DTMF wiring — same one-tick defer as the cold path so
            // the sender's dtmf accessor has time to attach.
            setTimeout(() => {
                if (this._audioSender && this._audioSender.dtmf) {
                    DEBUG("DTMF sender now available (answerer, prewarm)");
                    this._dtmfSender = this._audioSender.dtmf;
                    this._dtmfSender.addEventListener('tonechange', this._onDtmf);
                }
            }, 0);
            this._sendAnswer(this._prewarmedLocalSdp, options.headers);
            return;
        }

        // Partial prewarm or no prewarm — original addTrack flow.
        options.localStream.getTracks().forEach((track) => {
            const sender = this._pc.addTrack(track, options.localStream);
            if (track.kind === 'audio') {
                this._audioSender = sender;
            }
        });

        // If prewarm applied the remote description during ringing
        // but not the local description, skip the remote-desc step
        // and proceed with createAnswer.
        const remoteDescAlreadyApplied = this._prewarmed === true;
        const remoteDescPromise = remoteDescAlreadyApplied
            ? (DEBUG('Call ' + this._id + ' answer: reusing prewarmed remote description'),
               Promise.resolve())
            : this._prewarming
                ? this._prewarming.catch(() => {
                    // Prewarm raced and failed mid-accept — fall back
                    // to setting remote description ourselves.
                    return this._pc.setRemoteDescription(
                        new RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}));
                  })
                : this._pc.setRemoteDescription(
                    new RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}));
        remoteDescPromise
            // success
            .then(() => {
                // Mirror the caller's first video codec in the answer
                // instead of using our own local preference. If the
                // callee uses its own preferredCodec here, caller and
                // callee end up with different codecs in their views of
                // the SDP — which silently breaks E2EE because the
                // FrameEncryptor's per-codec unencrypted-prefix size
                // differs (VP8=3, VP9=3, H264=2, AV1=1) and the receiver
                // reads the wrong byte as the v|keyId header.
                const answerCodec = utils.pickAnswerVideoCodec(this._incomingSdp);
                // Same logic for audio: mirror whichever audio codec
                // the caller listed first instead of imposing our own
                // local preference. Keeps offer / answer in agreement
                // for everything downstream that introspects the
                // negotiated codec (NetworkSpeedometer, AudioSpeedometer,
                // BarChart). Falls back to the local preferred audio
                // codec if the offer can't be parsed.
                const answerAudioCodec = utils.pickAnswerAudioCodec(this._incomingSdp);
                utils.createLocalSdp(this._pc, 'answer', answerOptions, answerCodec, answerAudioCodec)
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        // Outgoing answer for an incoming call. Logged
                        // alongside the OUTGOING / INCOMING offer dumps
                        // above so the full negotiation round-trip is
                        // greppable from a single log file.
                        console.log('[sylkrtc][sdp] OUTGOING answer (call=', this._id, ')\n' + sdp);
                        // DTMF sender becomes available after the
                        // local description is set inside
                        // createLocalSdp (above). Same one-tick defer
                        // _initOutgoing uses, for the same reason.
                        setTimeout(() => {
                            if (this._audioSender && this._audioSender.dtmf) {
                                DEBUG("DTMF sender now available (answerer)");
                                this._dtmfSender = this._audioSender.dtmf;
                                this._dtmfSender.addEventListener('tonechange', this._onDtmf);
                            } else {
                                DEBUG("No DTMF sender even after answer");
                            }
                        }, 0);
                        this._sendAnswer(sdp, options.headers);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        _terminateLog(this, 'incoming_answer_chain', reason);
                        this.terminate();
                    });
            })
            // failure
            .catch((error) => {
                DEBUG('Error setting remote description: %s', error);
                _terminateLog(this, 'incoming_setRemoteDescription', error);
                this.terminate();
            });
    }

    startScreensharing(newTrack) {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, newTrack, true, (value) => {
            this._sharingScreen = value;
        });
    }

    stopScreensharing() {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, this._previousTrack);
        this._sharingScreen = false;
    }

    replaceTrack(oldTrack, newTrack, keep=false, cb=null) {
        let sender;
        for (sender of this._pc.getSenders()) {
            if (sender.track === oldTrack) {
                break;
            }
        }

        sender.replaceTrack(newTrack)
            .then(() => {
                if (keep) {
                    this._previousTrack = oldTrack;
                } else {
                    if (oldTrack) {
                        oldTrack.stop();
                    }
                    if (newTrack === this._previousTrack) {
                        this._previousTrack = null;
                    }
                }

                if (oldTrack) {
                    this._localStreams.removeTrack(oldTrack);
                }
                this._localStreams.addTrack(newTrack);

                if (cb) {
                    cb(true);
                }
            }).catch((error)=> {
                DEBUG('Error replacing track: %s', error);
            });
    }

    // ---- Mid-call upgrade (audio -> audio+video, or other media changes) ----
    //
    // Public surface for the Janus SIP plugin "update" request, which
    // performs a SIP re-INVITE under the hood. The app calls
    // addVideo({ localStream }) when the user taps "Start video" on
    // an established audio-only call; we reuse the existing
    // RTCPeerConnection (so audio RTP is uninterrupted across the
    // renegotiation), addTrack the new video sender, build a fresh
    // offer with createOffer, and ship it on the new session-update
    // wire request. The server forwards it to Janus, Janus issues a
    // SIP re-INVITE downstream, the peer answers, and the answer
    // comes back as a session-event with event=update / state=accepted
    // (see the 'update' case in _handleEvent below).
    //
    // For the inverse direction (peer sends a re-INVITE that adds
    // m=video to an originally audio-only call), the server sends us
    // a session-event with event=update / state=received and the
    // peer's new offer SDP. We surface that to the app via the
    // 'updateRequest' event so the UI can ask for camera permission
    // and decide whether to capture local video; the app then calls
    // answerUpdate({ localStream }) to complete the renegotiation.
    addVideo(options = {}) {
        console.log('Adding video...');
        if (this._state !== 'established' && this._state !== 'accepted') {
            throw new Error('Call is not active: ' + this._state);
        }
        if (!options.localStream) {
            throw new Error('Missing localStream');
        }
        if (this._upgrading) {
            throw new Error('A renegotiation is already in progress');
        }
        if (this._pc === null || this._pc.signalingState !== 'stable') {
            throw new Error('Peer connection is not stable: ' +
                (this._pc && this._pc.signalingState));
        }
        this._upgrading = true;

        // Attach the new video tracks to the existing peer connection.
        // We deliberately do NOT close & re-open _pc — that would tear
        // down the active audio RTP stream and the user would hear a
        // gap. addTrack on a stable PC triggers a renegotiationneeded
        // event which we ignore; we drive the renegotiation manually
        // via createOffer below so the timing matches what the server
        // and Janus expect.
        const addedTracks = [];
        for (const track of options.localStream.getVideoTracks()) {
            const sender = this._pc.addTrack(track, options.localStream);
            addedTracks.push({ sender, track });
            this._localStreams.addTrack(track);
        }
        if (addedTracks.length === 0) {
            this._upgrading = false;
            throw new Error('localStream contains no video tracks');
        }
        this._pendingVideoAddition = addedTracks;

        utils.createLocalSdp(this._pc, 'offer', null,
                             utils.getPreferredVideoCodec(),
                             utils.getPreferredAudioCodec())
            .then((sdp) => {
                DEBUG('Local update SDP: %s', sdp);
                console.log('[sylkrtc][sdp] OUTGOING update offer (call=',
                    this._id, ')\n' + sdp);
                this._sendUpdate(sdp);
            })
            .catch((reason) => {
                DEBUG('Error creating update offer: %s', reason);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', reason);
            });

        this.emit('localStreamAdded', options.localStream);
    }

    answerUpdate(options = {}) {
        // Called by the app after it received an 'updateRequest' event
        // and gathered whatever local tracks (typically video) it
        // wants to send back. Audio is already flowing through the
        // existing audio sender so we don't re-add it; we only add
        // any new video tracks contained in options.localStream, then
        // createAnswer and ship it on the same session-update wire
        // request as the outgoing-upgrade flow uses.
        if (!this._upgrading) {
            throw new Error('No update in progress');
        }
        if (this._pc === null || this._pc.signalingState !== 'have-remote-offer') {
            throw new Error('Peer connection not in have-remote-offer: ' +
                (this._pc && this._pc.signalingState));
        }

        const addedTracks = [];
        if (options.localStream) {
            for (const track of options.localStream.getVideoTracks()) {
                const sender = this._pc.addTrack(track, options.localStream);
                addedTracks.push({ sender, track });
                this._localStreams.addTrack(track);
            }
        }
        this._pendingVideoAddition = addedTracks;

        const remoteSdp = this._pc.remoteDescription && this._pc.remoteDescription.sdp;
        const answerCodec = utils.pickAnswerVideoCodec(remoteSdp);
        const answerAudioCodec = utils.pickAnswerAudioCodec(remoteSdp);
        utils.createLocalSdp(this._pc, 'answer', null, answerCodec, answerAudioCodec)
            .then((sdp) => {
                console.log('Local update answer SDP: %s', sdp);
                console.log('[sylkrtc][sdp] OUTGOING update answer (call=',
                    this._id, ')\n' + sdp);
                this._sendUpdate(sdp);
                // Our local PC is back in 'stable' as soon as
                // setLocalDescription resolves inside createLocalSdp.
                // The renegotiation is effectively complete from our
                // side; the server will not echo a state=accepted for
                // remote-initiated updates (Janus's "updated" event
                // for the answerer side carries no JSEP), so we clear
                // _upgrading and emit mediaUpdated right here.
                this._upgrading = false;
                this._pendingVideoAddition = null;
                this.emit('mediaUpdated', {
                    hasLocalVideo: this._localStreams.getVideoTracks().length > 0,
                    hasRemoteVideo: this._remoteMediaDirections.video.some(
                        d => d && d !== 'inactive'),
                });
            })
            .catch((reason) => {
                DEBUG('Error creating update answer: %s', reason);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', reason);
            });
    }

    _handleRemoteUpdate(sdp) {
        // The server forwarded a remote-initiated re-INVITE (Janus
        // "updatingcall" event with JSEP offer). Apply the new
        // remote description, then surface to the app via
        // 'updateRequest' so the UI can decide whether to grant
        // camera access and call answerUpdate(). We do not call
        // getUserMedia from inside the library — camera permission
        // prompts belong in the UI layer.
        const remoteSdp = utils.mungeSdp(sdp);
        DEBUG('Remote update SDP: %s', remoteSdp);
        console.log('[sylkrtc][sdp] INCOMING update offer (call=',
            this._id, ')\n' + remoteSdp);
        console.log('[sylkrtc][update] _handleRemoteUpdate entry (call=', this._id,
            ') sdp_len=', remoteSdp ? remoteSdp.length : 0,
            'has_m_video=', /\bm=video\s+[1-9]\d*\b/.test(remoteSdp));

        if (this._upgrading) {
            // Glare: we sent an update and the peer's update arrived
            // at the same time. RFC 3261 calls for a 491; for our
            // case we tell the app and let it retry. The server-side
            // glare check should normally catch this first, but we
            // defend in depth.
            DEBUG('Glare: remote update arrived while we are upgrading');
            console.log('[sylkrtc][update] GLARE detected (call=', this._id,
                ') — local update already in flight, rejecting remote');
            this.emit('updateFailed', new Error('glare'));
            return;
        }
        this._upgrading = true;

        this._pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: remoteSdp}))
            .then(() => {
                this._remoteMediaDirections = Object.assign(
                    {audio: [], video:[]}, utils.getMediaDirections(remoteSdp)
                );
                console.log('[sylkrtc][update] remote offer applied OK (call=', this._id,
                    ') emitting updateRequest, remoteMediaDirections=',
                    JSON.stringify(this._remoteMediaDirections));
                this.emit('updateRequest', {
                    sdp: remoteSdp,
                    remoteMediaDirections: this._remoteMediaDirections,
                });
            })
            .catch((error) => {
                DEBUG('Error applying remote update offer: %s', error);
                console.log('[sylkrtc][update] remote offer setRemoteDescription FAILED',
                    '(call=', this._id, ')', error && error.message);
                this._upgrading = false;
                this.emit('updateFailed', error);
            });
    }

    _rollbackPendingVideo() {
        // Undo the addTrack calls done optimistically before the
        // server / peer confirmed the update. Used when the remote
        // rejects the offer with m=video 0, when an answer never
        // arrives, or when createOffer / setLocalDescription throws.
        if (!this._pendingVideoAddition) return;
        for (const { sender, track } of this._pendingVideoAddition) {
            try {
                this._pc.removeTrack(sender);
            } catch (e) {
                // sender already detached by close(); ignore
            }
            try {
                track.stop();
                this._localStreams.removeTrack(track);
            } catch (e) {
                // ignore
            }
        }
        this._pendingVideoAddition = null;
    }

    sendMessage(message, contentType='text/plain', options={}, cb=null) {
        const outgoingMessage = new Message({
            account: this.remoteIdentity.uri,
            content: message,
            contentType,
            timestamp: options.timestamp || new Date().toISOString(),
            type: 'normal'
        }, new utils.Identity(this._account._id, this._account._displayName), 'pending');

        if (contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
            this._messages.set(outgoingMessage.id, outgoingMessage);
        }
        const req = {
            sylkrtc: 'session-message',
            session: this._id,
            message_id: outgoingMessage.id,
            content: message,
            content_type: outgoingMessage.contentType,
            timestamp: outgoingMessage.timestamp
        };
        this.emit('sendingMessage', outgoingMessage);
        DEBUG('Sending in dialog message: %o', outgoingMessage);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
                outgoingMessage._setState('failed');
            }
            if (cb) {
                cb(error);
            }
        });
        return outgoingMessage;
    }

    terminate() {
        if (this._terminated) {
            return;
        }
        DEBUG('Terminating call');
        _terminateLog(this, 'terminate_entry');
        this._sendTerminate();
    }

    sendDtmf(tones, duration=100, interToneGap=70) {
        DEBUG('sendDtmf()');
        // if (this._dtmfSender === null) {
        //     if (this._pc !== null) {
        //         let track = null;
        //         try {
        //             track = this._pc.getLocalStreams()[0].getAudioTracks()[0];
        //         } catch (e) {
        //             // ignore
        //         }
        //         if (track !== null) {
        //             DEBUG('Creating DTMF sender');
        //             this._dtmfSender = this._pc.createDTMFSender(track);
        //             if (this._dtmfSender) {
        //                 this._dtmfSender.addEventListener('tonechange', this._onDtmf);
        //             }
        //         }
        //     }
        // }
        // M124 / unified-plan: RTCPeerConnection has no sendDTMF().
        // DTMF goes through the audio RTCRtpSender's `dtmf` accessor
        // (RTCDTMFSender.insertDTMF), which the rn-webrtc fork bridges
        // to libwebrtc's DtmfSender. The sender is normally captured
        // in call()/answer(); resolve it lazily here as a fallback.
        if (this._dtmfSender === null && this._audioSender && this._audioSender.dtmf) {
            this._dtmfSender = this._audioSender.dtmf;
        }
        if (this._dtmfSender) {
            DEBUG('Sending DTMF tones via RTCRtpSender.dtmf.insertDTMF');
            this._dtmfSender.insertDTMF(tones, duration, interToneGap);
        } else {
            DEBUG('sendDtmf: no DTMF sender available (no audio sender / sender.dtmf)');
        }
    }

    // Private API

    _initOutgoing(uri, options={}) {
        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        this._id = options.id || uuidv4();
        this._direction = 'outgoing';
        this._remoteIdentity = new utils.Identity(uri);
        this._headers = options.headers;

        const pcConfig = options.pcConfig || {iceServers:[]};
        const offerOptions = options.offerOptions;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        // M124 / unified-plan: RTCPeerConnection.addStream was
        // removed; use addTrack per the W3C spec. Capture the audio
        // RTCRtpSender on the way in so the DTMF setTimeout below
        // can attach to sender.dtmf once setLocalDescription
        // resolves. Without this swap, the entire outgoing-call
        // flow throws on `addStream is not a function` and the call
        // never actually dials.
        this._audioSender = null;
        options.localStream.getTracks().forEach((track) => {
            const sender = this._pc.addTrack(track, options.localStream);
            if (track.kind === 'audio') {
                this._audioSender = sender;
            }
        });
        this.emit('localStreamAdded', options.localStream);
        utils.createLocalSdp(this._pc, 'offer', offerOptions, utils.getPreferredVideoCodec(), utils.getPreferredAudioCodec())
            .then((sdp) => {
                DEBUG('Local SDP: %s', sdp);
                // Surface the negotiation traffic via console.log too —
                // DEBUG only fires when the `debug` package's namespace
                // is enabled, which it isn't in production builds. The
                // SDP dump goes to Metro / device logs (and the on-
                // device log file via the standard console wiring) so
                // it's reachable when triaging codec-negotiation or
                // ICE-gathering issues without needing to flip a debug
                // flag and rebuild.
                console.log('[sylkrtc][sdp] OUTGOING offer (call=', this._id,
                    'to=', uri, ')\n' + sdp);
                // DTMF sender becomes available after the local
                // description is set inside createLocalSdp (above).
                // Same one-tick defer that answer() uses, for the
                // same reason.
                setTimeout(() => {
                    if (this._audioSender && this._audioSender.dtmf) {
                        DEBUG("DTMF sender now available (caller)");
                        this._dtmfSender = this._audioSender.dtmf;
                        this._dtmfSender.addEventListener('tonechange', this._onDtmf);
                    } else {
                        DEBUG("No DTMF sender even after offer");
                    }
                }, 0);
                this._sendCall(uri, sdp);
            })
            .catch((reason) => {
                DEBUG(reason);
                _terminateLog(this, 'outgoing_initOutgoing_chain', reason);
                this._localTerminate(reason);
            });
    }

    _initIncoming(id, caller, sdp, callId, headers = {}) {
        this._id = id;
        this._remoteIdentity = new utils.Identity(caller.uri, caller.display_name);
        // Run the incoming offer through mungeSdp ONCE here, before any
        // setRemoteDescription downstream sees it. Critical for the
        // prewarm path (a few lines below in _prewarm: this._pc.
        // setRemoteDescription(this._incomingSdp)) and for the fallback
        // accept paths (~line 510 / 513). Both used to set the raw
        // offer on the PC, so all subsequent SDP transforms
        // (H.264 profile-level-id rewrite, telephone-event filter, etc.)
        // never reached the wire — libwebrtc saw the original offer,
        // generated an answer based on it, and Safari's H.264 High
        // profile PT 96 ended up dropped from the answer with no codec
        // bound on our side to decode it. By munging here, every
        // consumer of _incomingSdp gets the same transformed string
        // and pc.remoteDescription matches what sdp-dump prints later.
        try {
            this._incomingSdp = utils.mungeSdp(sdp);
        } catch (e) {
            // Defensive: if mungeSdp somehow fails on a pathological
            // SDP, fall back to the raw offer rather than terminating
            // the call. Worst case we're back to the pre-fix behaviour.
            DEBUG('mungeSdp on incoming offer failed, using raw: %o', e);
            this._incomingSdp = sdp;
        }
        this._direction = 'incoming';
        this._state = 'incoming';
        this._callId = callId;
        this._remoteMediaDirections = Object.assign(
            {audio: [], video:[]}, utils.getMediaDirections(this._incomingSdp)
        );
        this._headers = Object.keys(headers).map(key => {return {name: key, value: headers[key]}});
        DEBUG('Remote SDP: %s', this._incomingSdp);
        // Surface the offer SDP from the caller in the standard log
        // stream (see the OUTGOING-offer console.log above for why we
        // duplicate this from DEBUG).
        console.log('[sylkrtc][sdp] INCOMING offer (call=', id,
            'from=', caller && caller.uri, ')\n' + this._incomingSdp);
    }

    _handleEvent(message) {
        DEBUG('Call event: %o', message);
        switch (message.event) {
            case 'state':
                let oldState = this._state;
                let newState = message.state;

                // Re-INVITE guard: once the call is established, the
                // peer's 180 Ringing / proceeding responses to a
                // mid-call UPDATE (e.g. addVideo) must NOT regress the
                // call FSM. Those provisional states are only valid in
                // the pre-established setup phase. Drop the event
                // silently so neither this._state nor any listener
                // sees an 'established -> ringing' / 'established ->
                // proceeding' transition during renegotiation.
                if (oldState === 'established' &&
                        (newState === 'ringing' || newState === 'proceeding')) {
                    DEBUG('Ignoring %s state during re-INVITE (call already established)', newState);
                    break;
                }

                this._state = newState;

                // Capture the SIP Call-ID from ANY state event that
                // carries it, not just accepted/early-media. The server
                // now also includes call_id on the terminated event, so
                // outgoing calls cancelled / unanswered before being
                // accepted still get their Call-ID here — which the app
                // needs to converge the call-history entry. Set before
                // the branches below so the 'terminated' stateChanged
                // listeners already see the populated _callId.
                if (message.call_id && !this._callId) {
                    this._callId = message.call_id;
                }

                if (newState === 'accepted' || newState === 'early-media' && this._direction === 'outgoing') {
                    DEBUG('Call accepted or early media');
                    let headers = message.headers || {};
                    let mapped_headers = Object.keys(headers).map(key => {return {name: key, value: headers[key]}});
                    this.emit('stateChanged', oldState, newState, {id: this._id, headers: mapped_headers});
                    if (message.sdp !== undefined) {
                        const sdp = utils.mungeSdp(message.sdp);
                        DEBUG('Remote SDP: %s', sdp);
                        // Stash the RAW answer SDP (as received from the
                        // server, before it round-trips through the native
                        // PC). setRemoteDescription re-serializes the SDP
                        // and libwebrtc hardcodes the session name to
                        // `s=-`, so pc.remoteDescription.sdp loses the
                        // remote's `s=` product token. Consumers that want
                        // the callee's client identity (the s= line, e.g.
                        // `s=Blink 9.3.2 (MacOSX)`) must read this field —
                        // the outgoing-call analogue of _incomingSdp.
                        this._answerSdp = sdp;
                        // Incoming answer for our outgoing call. Last
                        // of the four exchange points; pairs with the
                        // OUTGOING-offer dump in _initOutgoing above.
                        console.log('[sylkrtc][sdp] INCOMING answer (call=', this._id, ')\n' + sdp);
                        this._remoteMediaDirections = Object.assign(
                            {audio: [], video:[]}, utils.getMediaDirections(sdp)
                        );
                        this._setup_in_progress = true;
                        this._callId = message.call_id;
                        this._pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}))
                            // success
                            .then(() => {
                                this._setup_in_progress = false;
                                if (!this._terminated) {
                                    if (this._delay_established) {
                                        oldState = this._state;
                                        this._state = 'established';
                                        DEBUG('Setting delayed established state!');
                                        this.emit('stateChanged', oldState, this._state, {id: this._id});
                                        this._delay_established = false;
                                    }
                                }
                            })
                            // failure
                            .catch((error) => {
                                DEBUG('Error accepting call or early media: %s', error);
                                _terminateLog(this, 'outgoing_acceptedSetRemoteDescription', error);
                                this.terminate();
                            });
                    }
                } else if (newState === 'established' && this._direction === 'outgoing') {
                    if (this._setup_in_progress) {
                        this._delay_established = true;
                    } else {
                        this.emit('stateChanged', oldState, newState, {id: this._id});
                    }
                } else if (newState === 'proceeding') {
                    this.emit('stateChanged', oldState, newState, { id: this._id, code: message.code });
                } else if (newState === 'terminated') {
                    this.emit('stateChanged', oldState, newState, {reason: message.reason, id: this._id});
                    this._terminated = true;
                    this._account._calls.delete(this.id);
                    this._closeRTCPeerConnection();
                } else {
                    this.emit('stateChanged', oldState, newState, {id: this._id});
                }
                break;
            case 'message':
                // Default path: hand the in-dialog message off to the
                // parent Account so consumers see it on
                // account.on('incomingMessage') exactly like an
                // out-of-call message — single dispatch path, single
                // IMDN reply, no Call-vs-Account divergence. Set
                // call.enableInlineMessaging = true to opt back into
                // the legacy behaviour below (the original code path
                // that emits 'incomingMessage' on the Call itself).
                if (!this.enableInlineMessaging) {
                    DEBUG('Forwarding in-dialog message to Account: %o', message);
                    this._account._handleEvent(message);
                    break;
                }
                DEBUG('Incoming in dialog message from %s (inline): %o', message.sender.uri, message);
                const incomingMessage = this._messages.get(message.message_id);
                if (!incomingMessage) {
                    if (message.content_type === 'text/pgp-private-key') {
                        DEBUG('Skipping message');
                        return;
                    }
                    if (message.content_type === 'application/sylk-contact-update') {
                        DEBUG('Skipping message');
                        return;
                    }

                    const mappedMessage = new Message(
                        message,
                        new utils.Identity(message.sender.uri, message.sender.display_name),
                        'received'
                    );

                    this._messages.set(mappedMessage.id, mappedMessage);
                    this.emit('incomingMessage', mappedMessage);

                    // sylk-message-metadata (location ticks, meeting
                    // handshakes, control markers) are transient — skip the
                    // auto 'delivered' IMDN for them so location refresh ticks
                    // don't generate per-tick delivery receipts over the wire.
                    if (message.content_type !== 'application/sylk-message-metadata' &&
                        message.disposition_notification &&
                        message.disposition_notification.indexOf('positive-delivery') !== -1
                    ) {
                        // sendDispositionNotification lives on Account, not
                        // on Call. Delegate to the parent Account so the
                        // IMDN actually leaves the device.
                        this._account.sendDispositionNotification(
                            message.sender.uri,
                            message.message_id,
                            message.timestamp,
                            'delivered'
                        );
                    }
                }
                break;
            case 'disposition-notification':
                // Same default-vs-inline split as 'message' above.
                // Outgoing-message state changes are tracked on the
                // Account's _messages map by sendMessage; sending
                // the disposition event back through the Account makes
                // the messageStateChanged listener fire once, on the
                // same emitter the app subscribed to before the call
                // was placed.
                if (!this.enableInlineMessaging) {
                    this._account._handleEvent(message);
                    break;
                }
                const outgoingMessage = this._messages.get(message.message_id);
                if (outgoingMessage) {
                    if (outgoingMessage.state === 'displayed') {
                        break;
                    }
                    outgoingMessage._setState(message.state);
                }
                const {reason, code} = message;
                this.emit('messageStateChanged', message.message_id, message.state, {reason, code});
                break;
            case 'update':
                // Renegotiation lifecycle. The server emits this on
                // the session-event channel for three reasons:
                //   state=received : peer initiated a re-INVITE; sdp
                //                    is their new offer. We hand it
                //                    off to _handleRemoteUpdate which
                //                    surfaces an 'updateRequest' event
                //                    so the UI can answer with
                //                    answerUpdate({ localStream }).
                //   state=accepted : our outgoing addVideo() update
                //                    was answered; sdp is the remote
                //                    answer. We apply it and emit
                //                    'mediaUpdated' to the app.
                //   state=failed   : update rejected; reason carries
                //                    a human-readable cause. Roll
                //                    back any tracks we optimistically
                //                    added and emit 'updateFailed'.
                console.log('[sylkrtc][update] event received',
                    'call=', this._id,
                    'state=', message.state,
                    'has_sdp=', !!message.sdp,
                    'sdp_len=', message.sdp ? message.sdp.length : 0,
                    'reason=', message.reason || null);
                if (message.state === 'received') {
                    console.log('[sylkrtc][update] remote-initiated re-INVITE arrived,',
                        'handing to _handleRemoteUpdate (call=', this._id, ')');
                    this._handleRemoteUpdate(message.sdp);
                } else if (message.state === 'accepted') {
                    const sdp = utils.mungeSdp(message.sdp);
                    DEBUG('Remote update answer SDP: %s', sdp);
                    console.log('[sylkrtc][update] applying remote answer (call=',
                        this._id, '), upgrading was=', this._upgrading);
                    console.log('[sylkrtc][sdp] INCOMING update answer (call=',
                        this._id, ')\n' + sdp);
                    this._pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}))
                        .then(() => {
                            this._remoteMediaDirections = Object.assign(
                                {audio: [], video:[]}, utils.getMediaDirections(sdp)
                            );
                            this._upgrading = false;
                            this._pendingVideoAddition = null;
                            const payload = {
                                hasLocalVideo: this._localStreams.getVideoTracks().length > 0,
                                hasRemoteVideo: this._remoteMediaDirections.video.some(
                                    d => d && d !== 'inactive'),
                            };
                            console.log('[sylkrtc][update] setRemoteDescription OK,',
                                'emitting mediaUpdated (call=', this._id, ')',
                                'payload=', JSON.stringify(payload),
                                'remoteMediaDirections=', JSON.stringify(this._remoteMediaDirections));
                            this.emit('mediaUpdated', payload);
                        })
                        .catch((error) => {
                            DEBUG('Error applying update answer: %s', error);
                            console.log('[sylkrtc][update] setRemoteDescription FAILED',
                                '(call=', this._id, ')', error && error.message);
                            this._rollbackPendingVideo();
                            this._upgrading = false;
                            this.emit('updateFailed', error);
                        });
                } else if (message.state === 'failed') {
                    console.log('[sylkrtc][update] server reported failure',
                        '(call=', this._id, ') reason=', message.reason);
                    this._rollbackPendingVideo();
                    this._upgrading = false;
                    this.emit('updateFailed', new Error(message.reason || 'update rejected'));
                } else {
                    console.log('[sylkrtc][update] unknown state',
                        '(call=', this._id, ') state=', message.state);
                }
                break;
            default:
                break;
        }
    }

	_initRTCPeerConnection(pcConfig) {
		if (this._pc !== null) {
			throw new Error('RTCPeerConnection already initialized');
		}

		this._pc = new RTCPeerConnection(pcConfig);

		this._pc.addEventListener('track', (event) => {
			const stream = event.streams && event.streams[0];
			if (stream) {
				// Capture the native-backed stream that libwebrtc emits
				// on the 'track' event. Synthesizing a JS-side MediaStream
				// with new MediaStream() and adding receiver tracks to it
				// does not hook the renderer pipeline correctly on M124,
				// so we prefer this native stream for getRemoteStreams().
				this._nativeRemoteStream = stream;
				this.emit('streamAdded', stream);
			} else {
				DEBUG('Track added without stream');
			}
		});

		this._pc.addEventListener('icecandidate', (event) => {
			if (event.candidate) {
				DEBUG('New ICE candidate', event.candidate);
			} else {
				DEBUG('ICE candidate gathering finished');
			}

			this._sendTrickle(event.candidate);
		});

        this._statistics.addConnection({pc:this._pc, peerId: this._id});
	}

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _sendCall(uri, sdp) {
        const req = {
            sylkrtc: 'session-create',
            account: this.account.id,
            session: this.id,
            uri: uri,
            sdp: sdp,
            headers: this.headers
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Call error: %s', error);
                _terminateLog(this, 'sendCall_request_error', error);
                this._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        _terminateLog(this, 'sendTerminate_entry');
        const req = {
            sylkrtc: 'session-terminate',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating call: %s', error);
                _terminateLog(this, 'sendTerminate_request_error', error);
                this._localTerminate(error);
            }
        });
        setTimeout(() => {
            if (!this._terminated) {
                DEBUG('Timeout terminating call');
                _terminateLog(this, 'sendTerminate_ack_timeout_150ms');
                this._localTerminate('200 OK');
            }
            this._terminated = true;
        }, 150);
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : [],
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                _terminateLog(this, 'sendTrickle_request_error', error);
                this._localTerminate(error);
            }
        });
    }

    _sendAnswer(sdp, headers=[]) {
        const req = {
            sylkrtc: 'session-answer',
            session: this.id,
            sdp: sdp,
            headers: headers
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                _terminateLog(this, 'sendAnswer_request_error', error);
                this.terminate();
            }
        });
    }

    _sendUpdate(sdp) {
        // Wire request for the Janus SIP plugin "update" / SIP
        // re-INVITE. Used for both:
        //   - the offer that addVideo() generates locally (server
        //     decides "this session is established, treat the SDP
        //     as an offer and feed it to Janus as an offer JSEP")
        //   - the answer that answerUpdate() generates after a
        //     remote re-INVITE (server decides "this session is
        //     in remote-updating, treat the SDP as an answer JSEP").
        // The server does not need a separate request type to
        // distinguish — it tracks the session's update state.
        const req = {
            sylkrtc: 'session-update',
            session: this.id,
            sdp: sdp,
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Update error: %s', error);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', error);
            }
        });
    }

    _closeRTCPeerConnection() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    if (track.track != null ) {
                        tracks = tracks.concat(track.track);
                    }
                    if (this._previousTrack !== null) {
                        tracks = tracks.concat(this._previousTrack);
                    }
                }
                if (tracks.length !== 0) {
                    tempStream = new MediaStream(tracks);
                    utils.closeMediaStream(tempStream);
                }
            } else {
                for (let stream of this._pc.getLocalStreams()) {
                    if (this._previousTrack !== null) {
                        stream = stream.concat(this._previousTrack);
                    }
                    utils.closeMediaStream(stream);
                }
            }

            if (this._pc.getReceivers) {
                let tracks = [];
                for (let track of this._pc.getReceivers()) {
                    tracks = tracks.concat(track.track);
                }
                tempStream = new MediaStream(tracks);
                utils.closeMediaStream(tempStream);
            } else {
                for (let stream of this._pc.getRemoteStreams()) {
                    utils.closeMediaStream(stream);
                }
            }
            this._statistics.removeConnection({pc:this._pc, peerId: this._id});
            this._pc.close();
            this._pc = null;
            // if (this._dtmfSender !== null) {
            //     this._dtmfSender.removeEventListener('tonechange', this._onDtmf);
            //     this._dtmfSender = null;
            // }
        }
    }

    _localTerminate(error) {
        if (this._terminated) {
            return;
        }
        DEBUG('Local terminate');
        _terminateLog(this, 'localTerminate_entry', error);
        this._account._calls.delete(this.id);
        this._terminated = true;
        const oldState = this._state;
        const newState = 'terminated';
        const data = {
            reason: error.toString(),
            id: this._id
        };
        this._closeRTCPeerConnection();
        this.emit('stateChanged', oldState, newState, data);
    }

    // _onDtmf(event) {
    //     DEBUG('Sent DTMF tone %s', event.tone);
    //     this.emit('dtmfToneSent', event.tone);
    // }
}


export { Call };
