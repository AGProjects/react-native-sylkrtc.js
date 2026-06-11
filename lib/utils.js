'use strict';

import transform from 'sdp-transform';
import attachMediaStream from '@rifflearning/attachmediastream';
import xss from 'xss';

class Identity {
    constructor(uri, displayName=null) {
        this._uri = uri;
        this._displayName = displayName;
    }

    get uri() {
        return this._uri;
    }

    get displayName() {
        return this._displayName;
    }

    toString() {
        if (!this._displayName) {
            return this._uri;
        } else {
            return `${this._displayName} <${this._uri}>`;
        }
    }
}


class SharedFile {
    constructor(filename, filesize, uploader, session) {
        this._filename = filename;
        this._filesize = filesize;
        this._uploader = uploader;
        this._session = session;
    }

    get filename() {
        return this._filename;
    }

    get filesize() {
        return this._filesize;
    }

    get uploader() {
        return this._uploader;
    }

    get session() {
        return this._session;
    }
}


// Reorder the video transceiver's codec preferences so the answerer's
// preferred codec is first BEFORE createAnswer runs. This makes
// pc.localDescription agree with the wire SDP we'll later send — without
// it, mungeSdp re-sorts the m=video payloads but pc.localDescription
// still holds libwebrtc's natural ordering (typically H.264-first on
// Android), and libwebrtc's encoder picks based on pc.localDescription.
// The two ends then disagree on the negotiated codec, the answerer ends
// up encoding one codec while the offerer waits for another, and video
// breaks in both directions.
//
// We source the codec list from RTCRtpReceiver.getCapabilities('video')
// — the local platform's own recv capabilities — rather than from the
// remote offer's m=video. The offer can include codecs this device's
// libwebrtc can't handle (H265, AV1, VP9 profile-id=2 from Safari's
// offer); passing those to setCodecPreferences makes libwebrtc throw
// "Codec is not supported" and the whole reorder no-ops, leaving
// pc.localDescription in its default H.264-first order. (This was the
// real cause of the Sony XQ-EC72 regression: the H.265 entry in
// Safari's offer poisoned the list.) Capabilities from
// RTCRtpReceiver.getCapabilities are guaranteed to be acceptable to
// setCodecPreferences — they're the same descriptors libwebrtc
// generates from the platform's encoder/decoder factories.
//
// Sort order: real preferred codec first, every other real codec in
// original order, then any rtx entries last. Keeping rtx at the end
// preserves NACK/RTX support without giving rtx itself the negotiation
// preference (rtx is paired via apt=, not chosen as a primary).
//
// Returns true when the reorder was actually applied to at least one
// video transceiver, false when nothing changed (no transceiver yet, no
// setCodecPreferences support, preferred codec absent from local
// capabilities, or setCodecPreferences threw). Callers should consult
// this and only ask mungeSdp to promote the same codec in the WIRE SDP
// when the function returned true — otherwise pc.localDescription stays
// in its default order while the wire SDP gets reordered, the two
// disagree, and the encoder/decoder pick mismatch breaks video.
function reorderTransceiverCodecs(pc, preferredCodec) {
    if (!pc || !preferredCodec) return false;
    if (typeof pc.getTransceivers !== 'function') return false;
    try {
        // Resolve RTCRtpReceiver: prefer the global the react-native-
        // webrtc module installs at import time; otherwise look on the
        // peer-connection's constructor namespace for legacy builds.
        // No capability API → no reorder.
        const Rx = (typeof global !== 'undefined' && global.RTCRtpReceiver)
                || (pc.constructor && pc.constructor.RTCRtpReceiver);
        if (!Rx || typeof Rx.getCapabilities !== 'function') return false;

        const caps = Rx.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return false;

        const wantLower = preferredCodec.toLowerCase();
        const isPreferred = (c) =>
            c && c.mimeType && c.mimeType.toLowerCase() === 'video/' + wantLower;
        const isRtx = (c) =>
            c && c.mimeType && c.mimeType.toLowerCase() === 'video/rtx';

        const preferredList = caps.codecs.filter(isPreferred);
        if (preferredList.length === 0) return false; // pref not available locally

        const sorted = [
            ...preferredList,
            ...caps.codecs.filter(c => !isPreferred(c) && !isRtx(c)),
            ...caps.codecs.filter(isRtx),
        ];

        const transceivers = pc.getTransceivers() || [];
        let applied = false;
        for (const t of transceivers) {
            const trackKind = (t.receiver && t.receiver.track && t.receiver.track.kind)
                              || (t.sender && t.sender.track && t.sender.track.kind);
            if (trackKind !== 'video') continue;
            if (typeof t.setCodecPreferences !== 'function') continue;
            try {
                t.setCodecPreferences(sorted);
                applied = true;
            } catch (e) {
                // shouldn't happen now that we're passing platform
                // capabilities verbatim, but stay defensive
            }
        }
        return applied;
    } catch (e) {
        return false;
    }
}


// ----- codec-negotiation logging --------------------------------------------
//
// Diagnostic helper used by createLocalSdp to surface the codec story
// each time we generate an offer or answer. Four lines, all greppable
// with `[video] [media] [call]`:
//
//   Local [video] [media] [call] supported codecs:  <list>
//   Local [video] [media] [call] preferred codec:   <pref>
//   Local [video] [media] [call] sending codec:     <codec> pt=<pt> [<fmtp>]
//   Remote [video] [media] [call] receiving codec:  <codec> pt=<pt> [<fmtp>]
//
// "Supported" is what RTCRtpReceiver.getCapabilities exposes for this
// device — the same list setCodecPreferences accepts. "Preferred" is
// whatever the host app pushed in via setPreferredVideoCodec (which
// comes from the user's Preferences screen, default 'VP9'). "Sending"
// is the first real codec in the SDP we're about to ship (so after any
// setCodecPreferences + mungeSdp reordering) — that's the codec the
// peer will negotiate to and ours will encode in. "Receiving" is the
// first real codec in the remote SDP's m=video — for an answer that's
// the codec the offerer would have liked us to send (Safari typically
// puts H.264 High first), useful for spotting the High-vs-Baseline
// gap that shows up as a black-window interop bug.
//
// Each codec line includes fmtp params (profile-level-id +
// packetization-mode for H.264; profile-id for VP9) so a quick grep
// makes the High vs Baseline vs VP9-profile-0 vs profile-2 distinction
// obvious. Skips rtx / red / ulpfec / flexfec entries — those are
// retransmit / FEC plumbing, not the user-facing codec choice.
// Walks an SDP's m=video, returns one descriptor per real codec PT
// (skipping rtx / red / ulpfec / flexfec / cn — those are retransmit
// / FEC plumbing). Each descriptor is the same shape the single-codec
// helper used to emit: "<NAME> pt=<PT> [<fmtp>]" with fmtp omitted
// when there's no a=fmtp:<pt> line. PTs are walked in the same order
// they appear in the m=video payloads list, so the first entry is
// always the codec the offerer or answerer listed first (i.e. the
// negotiated codec for the session).
function _realVideoCodecsFromSdp(sdp) {
    const out = [];
    if (!sdp) return out;
    try {
        const parsed = transform.parse(sdp);
        const v = parsed.media && parsed.media.find(m => m.type === 'video');
        if (!v || !v.payloads || !v.rtp) return out;
        const ignored = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03', 'cn']);
        const pts = String(v.payloads).split(' ').map(p => parseInt(p, 10));
        const fmtpByPt = {};
        if (v.fmtp) {
            for (const f of v.fmtp) fmtpByPt[f.payload] = f.config;
        }
        for (const pt of pts) {
            const rtp = v.rtp.find(r => r.payload === pt);
            if (!rtp || !rtp.codec) continue;
            if (ignored.has(rtp.codec.toLowerCase())) continue;
            const fmtp = fmtpByPt[pt];
            out.push(fmtp
                ? rtp.codec + ' pt=' + pt + ' [' + fmtp + ']'
                : rtp.codec + ' pt=' + pt);
        }
    } catch (e) { /* fall through */ }
    return out;
}

// Back-compat thin wrapper for callers that only care about the
// first / negotiated codec.
function _firstRealVideoCodecFromSdp(sdp) {
    const all = _realVideoCodecsFromSdp(sdp);
    return all.length > 0 ? all[0] : null;
}

// console.log shim that mirrors the host app's timestampedLog format
// ([APPLOG] <iso-ts> ...). Lets these lines grep alongside the rest
// of the [APPLOG] stream in metro.log without plumbing the host's
// logger through. Used by _logCodecNegotiation; safe to call from
// anywhere in this module.
function _applog() {
    try {
        const ts = new Date().toISOString();
        const args = Array.prototype.slice.call(arguments);
        // eslint-disable-next-line no-console
        console.log.apply(console, ['[APPLOG]', ts].concat(args));
    } catch (e) { /* never throw out of a logger */ }
}

function _logCodecNegotiation(type, preferredCodec, localSdp, remoteSdp) {
    try {
        let supported = [];
        const Rx = (typeof global !== 'undefined' && global.RTCRtpReceiver)
                || null;
        if (Rx && typeof Rx.getCapabilities === 'function') {
            const caps = Rx.getCapabilities('video');
            if (caps && Array.isArray(caps.codecs)) {
                // Compact "<NAME>[fmtp]" entries, skip rtx (it's a wrapper
                // PT, not a user-facing codec). Multiple H.264 profile
                // entries become e.g. "H264[42e01f] H264[640c1f]" so the
                // log shows both Baseline and the synthesised High.
                supported = caps.codecs
                    .filter(c => c && c.mimeType
                        && c.mimeType.toLowerCase() !== 'video/rtx')
                    .map(c => {
                        const name = c.mimeType.replace(/^video\//i, '');
                        return c.sdpFmtpLine
                            ? name + '[' + c.sdpFmtpLine + ']'
                            : name;
                    });
            }
        }
        _applog('Local [video] [media] [call] supported codecs:',
            supported.length ? supported.join(', ') : '(unknown — getCapabilities unavailable)');
        _applog('Local [video] [media] [call] preferred codec:',
            preferredCodec || '(default — libwebrtc natural order)');
        const sending = _firstRealVideoCodecFromSdp(localSdp);
        _applog('Local [video] [media] [call] sending codec ('
            + type + '):', sending || '(none)');
        // Only meaningful on the answer side — the offer is by definition
        // generated before there's any remote SDP.
        //
        // We list every real video codec the peer offered (not just the
        // first), in the same order the peer put them in m=video. The
        // first entry is what the peer would have preferred to negotiate
        // (typically H.264 High from Safari, VP8 from older Chrome,
        // etc.); the tail entries show the fallback list — useful for
        // spotting whether the peer offered a codec our local platform
        // doesn't recv (in which case our answer dropped it and we
        // would have ended up on a lower-pref shared codec).
        if (type === 'answer') {
            const receiving = _realVideoCodecsFromSdp(remoteSdp);
            if (receiving.length === 0) {
                _applog('Remote [video] [media] [call] receiving codecs: (none)');
            } else {
                _applog('Remote [video] [media] [call] receiving codecs ('
                    + receiving.length + '):', receiving.join(', '));
            }
        }
    } catch (e) {
        // best-effort logging — never throw out of here
    }
}


function createLocalSdp(pc, type, options, preferredCodec = null, preferredAudioCodec = null) {
    if (type !== 'offer' && type !== 'answer') {
        return Promise.reject('type must be "offer" or "answer", but "' +type+ '" was given');
    }
    let p = new Promise(function(resolve, reject) {
        let createFunc;
        if (type === 'offer' ) {
            createFunc = 'createOffer';
        } else {
            createFunc = 'createAnswer';
        }
        // On the answer side, pin the video transceiver's codec order to
        // our preferredCodec BEFORE createAnswer fires. Without this,
        // mungeSdp re-sorts the wire SDP but pc.localDescription keeps
        // libwebrtc's default order, the local encoder reads the wrong
        // codec, and the negotiation silently breaks (see notes on
        // reorderTransceiverCodecs above).
        //
        // Critical: we only ask mungeSdp to promote the same codec in
        // the wire SDP when reorderTransceiverCodecs actually applied
        // the change to pc.localDescription. If setCodecPreferences
        // failed (older libwebrtc, missing static API, preferred codec
        // not in local capabilities) and we still promoted in mungeSdp,
        // pc.localDescription and the wire SDP would diverge — exactly
        // the failure mode that breaks Safari interop.
        let codecPrefApplied = false;
        if (type === 'answer' && preferredCodec) {
            codecPrefApplied = reorderTransceiverCodecs(pc, preferredCodec);
        }
        pc[createFunc](options)
            .then((desc) => {
                return pc.setLocalDescription(desc);
            })
            .then(() => {
                const effectivePref = (type === 'answer' && !codecPrefApplied)
                    ? null
                    : preferredCodec;
                // AUDIO has the SAME localDescription-vs-wire hazard as video:
                // reordering the audio payloads in the ANSWER's wire SDP without
                // also pinning the audio transceiver makes pc.localDescription
                // and the wire answer disagree on the codec, so INCOMING calls
                // have NO audio. We don't pin the audio transceiver, so only
                // reorder audio on the OFFER.
                const out = mungeSdp(pc.localDescription.sdp, effectivePref, false, (type === 'answer') ? null : preferredAudioCodec);
                // Log the full codec story for this offer/answer round
                // trip. Cheap (one SDP parse) and only fires once per
                // negotiation, so we leave it on always — saves a lot
                // of pain when chasing the next interop bug.
                const remoteSdp = pc.remoteDescription && pc.remoteDescription.sdp;
                _logCodecNegotiation(type, preferredCodec, out, remoteSdp);
                resolve(out);
            })
            // failure
            .catch((error) => {
                reject('Error creating local SDP or setting local description: ' + error);
            });
    });
    return p;
}


function mungeSdp(sdp, preferredCodec = null, fixmsid=false, preferredAudioCodec = null) {
    let parsedSdp = transform.parse(sdp);
    let h264payload = null;
    let hasProfileLevelId = false;

    // try to fix H264 support
    for (let media of parsedSdp.media) {
        if (media.type === 'video') {
            for (let rtp of media.rtp) {
                if (rtp.codec === 'H264') {
                    h264payload = rtp.payload;
                    break;
                }
            }
            if (h264payload !== null) {
                for (let fmtp of media.fmtp) {
                    if (fmtp.payload === h264payload && fmtp.config.indexOf('profile-level-id') !== -1) {
                        hasProfileLevelId = true;
                        break;
                    }
                }
                if (!hasProfileLevelId) {
                    media.fmtp.push({payload: h264payload, config: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1'});
                }
                break;
            }
        }
    }

    // H.264 profile-level-id rewrite: collapse every non-Baseline
    // entry to Constrained Baseline at the original level.
    //
    // Why this exists: Android libwebrtc's recv codec list only
    // includes H.264 Constrained Baseline (42e01f, packetization-mode=1).
    // Adding the High-profile entry synthetically in the Java
    // H264AndSoftwareVideoDecoderFactory makes RTCRtpReceiver.
    // getCapabilities report it, but libwebrtc's answer-generation
    // logic queries an internal C++ codec database that the synthetic
    // Java entry doesn't reach — so the answer drops Safari's PT 96
    // (H.264 High, profile-level-id=640c1f) anyway. Janus is a
    // passthrough SFU; it keeps forwarding Safari's PT 96 stream
    // regardless of what our answer said. Our libwebrtc demuxer has
    // no codec mapped to PT 96 → "RX codec=? frames=0/0", black
    // window, watchdog tripping.
    //
    // The trick: rewrite every H.264 profile-level-id in the offer
    // (and any other SDP we munge) so it looks like Constrained
    // Baseline. libwebrtc then sees PT 96 as "H.264 Baseline pkt1",
    // matches it against its local capability, includes it in the
    // answer, and adds PT 96 to its session codec table pointing at
    // the H.264 decoder. The peer keeps sending PT 96 (Safari) /
    // pt=96 (Janus forwards) with the actual High-profile bitstream;
    // our libwebrtc routes those bytes to the H.264 decoder; the
    // Qualcomm c2.qti.avc.decoder (and every other Snapdragon /
    // Adreno / Mali HW H.264 decoder we've tested) accepts
    // High-profile NALs transparently — profile_idc in the SDP is
    // advisory, the actual decode pipeline doesn't enforce it.
    //
    // Side effect on the outbound side: the answer we ship also
    // carries the rewritten profile-level-id, so the peer thinks
    // we'll be sending Baseline. We do — Android's HW H.264 encoder
    // only emits Baseline regardless of what the SDP says. Peers
    // that strictly honour the negotiated profile-level-id will
    // re-encode in Baseline rather than High; slightly less
    // efficient than the High path that the iOS-build of this app
    // already gets natively (libwebrtc on iOS does honour the
    // synthetic Java entry), but interoperable.
    //
    // Format reminder: profile-level-id is six hex digits — two for
    // profile_idc, two for profile_iop (constraint flags), two for
    // level_idc. We replace profile_idc+iop with "42e0" (Constrained
    // Baseline) and keep level_idc verbatim so the level the offerer
    // requested is preserved.
    for (let media of parsedSdp.media) {
        if (media.type !== 'video' || !media.rtp || !media.fmtp) continue;
        const h264Pts = new Set();
        for (const r of media.rtp) {
            if (r.codec && r.codec.toLowerCase() === 'h264') {
                h264Pts.add(r.payload);
            }
        }
        if (h264Pts.size === 0) continue;
        for (const f of media.fmtp) {
            if (!h264Pts.has(f.payload)) continue;
            f.config = String(f.config).replace(
                /profile-level-id=([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/,
                (match, pIdc, _pIop, lIdc) => {
                    // Already Constrained Baseline → leave it alone
                    // so we don't churn the SDP on calls that never
                    // had High in the offer to begin with.
                    if (pIdc.toLowerCase() === '42') return match;
                    return 'profile-level-id=42e0' + lIdc;
                }
            );
        }
    }

    if (fixmsid === true) {
        const randomNumber = Math.floor(100000 + Math.random() * 900000);
        for (let media of parsedSdp.media) {
            media.msid = media.msid + '-' + randomNumber;
            for(let ssrc of media.ssrcs) {
                if (ssrc.attribute === 'msid') {
                    ssrc.value = ssrc.value + '-' + randomNumber;
                }
            }
        }
    }

    // remove bogus rtcp-fb elements
    for (let media of parsedSdp.media) {
        let payloads = String(media.payloads).split(' ');
        if (media.rtcpFb) {
            media.rtcpFb = media.rtcpFb.filter((item) => {
                return payloads.indexOf(String(item.payload)) !== -1;
            });
        }
    }

    // Drop high-clockrate telephone-event variants from the audio
    // m-line so libwebrtc's DtmfSender falls back to the universally-
    // compatible 8 kHz one (telephone-event/8000, the RFC 4733 PT
    // every Asterisk/PSTN/SBC understands).
    //
    // Why: libwebrtc picks the telephone-event codec whose clockrate
    // matches the active audio codec. With opus at 48 kHz active it
    // emits DTMF as telephone-event/48000 (PT 110 in our SDP). Most
    // Asterisk versions and every PSTN gateway only detect telephone-
    // event/8000 — a 48 kHz variant either doesn't get re-mapped on
    // the trunk or its detector simply ignores it. Result: the
    // SIP-Simple SDK on the other end happily decoded the digits in
    // testing (it accepts both rates), but Asterisk voicemail and
    // PSTN IVRs heard nothing.
    //
    // We leave the 8 kHz telephone-event in place. With only that
    // option, libwebrtc resamples the DTMF event packet timing onto
    // the 8 kHz clock and ships it on the same audio RTP stream;
    // Asterisk and PSTN endpoints decode it cleanly. Audio quality
    // (opus@48 kHz) is unaffected — we're only stripping a redundant
    // codec line, not changing the active audio codec.
    for (let media of parsedSdp.media) {
        if (media.type !== 'audio' || !media.rtp) continue;

        const drop = new Set();
        for (const rtp of media.rtp) {
            if (rtp.codec
                && String(rtp.codec).toLowerCase() === 'telephone-event'
                && rtp.rate
                && Number(rtp.rate) !== 8000) {
                drop.add(rtp.payload);
            }
        }
        if (drop.size === 0) continue;

        // strip from m=audio … <PTs>
        const payloads = String(media.payloads).split(' ').filter(p => !drop.has(parseInt(p, 10)));
        media.payloads = payloads.join(' ');

        // strip matching rtpmap / fmtp / rtcp-fb entries
        media.rtp = media.rtp.filter(r => !drop.has(r.payload));
        if (media.fmtp) {
            media.fmtp = media.fmtp.filter(f => !drop.has(f.payload));
        }
        if (media.rtcpFb) {
            media.rtcpFb = media.rtcpFb.filter(f => !drop.has(f.payload));
        }
    }

    if (preferredCodec !== null) {
        const videoMLine = parsedSdp.media.find(m => m.type === 'video');
        let payloadType = null;

        if (videoMLine !== undefined) {
            for (let i = 0; i < videoMLine.rtp.length; ++i) {
                const rtp = videoMLine.rtp[i];
                if (rtp.codec
                    && rtp.codec.toLowerCase() === preferredCodec.toLowerCase()) {
                        payloadType = rtp.payload;
                        break;
                    }
            }
            if (payloadType) {
                const payloadTypes = videoMLine.payloads.split(' ').map(p => parseInt(p, 10));
                const payloadIndex = payloadTypes.indexOf(payloadType);

                payloadTypes.splice(payloadIndex, 1);
                payloadTypes.unshift(payloadType);
                videoMLine.payloads = payloadTypes.join(' ');
            }
        }
    }

    // Audio-codec reorder. Rather than just promoting the preferred
    // codec to the front, we apply a "family-aware" preference list
    // that keeps closely-related codecs together as a sensible fallback
    // chain for the answerer:
    //
    //   PCMA selected  → PCMA, PCMU, G722, Opus
    //   PCMU selected  → PCMU, PCMA, G722, Opus
    //   Opus selected  → Opus, G722, PCMA, PCMU
    //   G722 selected  → G722, Opus, PCMA, PCMU
    //   anything else  → just promote it to first
    //
    // Telephone-event / CN / RED entries are signalling/FEC, not user-
    // facing codecs; they're left in their original relative order at
    // the END of the payload-type list.
    if (preferredAudioCodec !== null) {
        const audioMLine = parsedSdp.media.find(m => m.type === 'audio');
        if (audioMLine !== undefined && audioMLine.rtp) {
            // payload-type → codec-name (lowercase) lookup
            const ptToCodec = {};
            for (const r of audioMLine.rtp) {
                if (r.payload != null && r.codec) {
                    ptToCodec[r.payload] = r.codec.toLowerCase();
                }
            }

            const prefLower = preferredAudioCodec.toLowerCase();
            let codecOrder;
            switch (prefLower) {
                case 'pcma': codecOrder = ['pcma', 'pcmu', 'g722', 'opus']; break;
                case 'pcmu': codecOrder = ['pcmu', 'pcma', 'g722', 'opus']; break;
                case 'opus': codecOrder = ['opus', 'g722', 'pcma', 'pcmu']; break;
                case 'g722': codecOrder = ['g722', 'opus', 'pcma', 'pcmu']; break;
                default:     codecOrder = [prefLower]; break;
            }

            const originalPts = String(audioMLine.payloads).split(' ')
                                    .map(p => parseInt(p, 10));
            const newPts = [];
            const used   = new Set();

            // First pass: the preferred codecs in our preference order.
            // (Multiple payload types for the same codec name — e.g.
            // separate stereo/mono Opus entries — keep their relative
            // order among themselves.)
            for (const codecName of codecOrder) {
                for (const pt of originalPts) {
                    if (used.has(pt)) continue;
                    if (ptToCodec[pt] === codecName) {
                        newPts.push(pt);
                        used.add(pt);
                    }
                }
            }
            // Second pass: everything else (telephone-event, CN, RED,
            // unknown codecs) in original order.
            for (const pt of originalPts) {
                if (!used.has(pt)) {
                    newPts.push(pt);
                    used.add(pt);
                }
            }

            audioMLine.payloads = newPts.join(' ');
        }
    }

    return transform.write(parsedSdp);
}

function getMediaDirections(sdp) {
    const parsedSdp = transform.parse(sdp);
    const directions = {};
    for (let media of parsedSdp.media) {
        directions[media.type] = (directions[media.type] || []).concat(media.direction);
    }
    return directions;
}

function closeMediaStream(stream) {
    if (!stream) {
        return;
    }

    // Latest spec states that MediaStream has no stop() method and instead must
    // call stop() on every MediaStreamTrack.
    if (MediaStreamTrack && MediaStreamTrack.prototype && MediaStreamTrack.prototype.stop) {
        if (stream.getTracks) {
            for (let track of stream.getTracks()) {
                track.stop();
            }
        } else {
            for (let track of stream.getAudioTracks()) {
                track.stop();
            }

            for (let track of stream.getVideoTracks()) {
                track.stop();
            }
        }
    // Deprecated by the spec, but still in use.
    } else if (typeof stream.stop === 'function') {
        stream.stop();
    }
}

function sanatizeHtml(html) {
    html = html.replace(/\>[\r\n ]+\</g, "><");

    const whiteList = xss.whiteList;
    ['p', 'span', 'div'].forEach((tag) => {
        whiteList[tag].push('style');
    });
    whiteList.meta = ['style'];
    whiteList['!doctype'] = ['html'];
    whiteList.html= ['lang'];
    whiteList.head = [];
    whiteList.body = ['class'];
    whiteList.style = [];

    const xssFiltered = new xss.FilterXSS({
        whiteList
    });
    return xssFiltered.process(html.trim());
}

function _addAdditionalData(currentStats, previousStats) {
    // we need the previousStats stats to compute thse values
    if (!previousStats) {
        return currentStats;
    }

    // audio
    // inbound
    currentStats.audio.inbound.map((report) => {
        let prev = previousStats.audio.inbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesReceived');
        report.packetRate = _computeBitrate(report, prev, 'packetsReceived');
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });
    // outbound
    currentStats.audio.outbound.map((report) => {
        let prev = previousStats.audio.outbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesSent');
        report.packetRate = _computeBitrate(report, prev, 'packetsSent');
    });

    currentStats.remote.audio.inbound.map((report) => {
        let prev = previousStats.remote.audio.inbound.find(r => r.id === report.id);
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });

    // video
    // inbound
    currentStats.video.inbound.map((report) => {
        let prev = previousStats.video.inbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesReceived');
        report.packetRate = _computeRate(report, prev, 'packetsReceived');
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });
    // outbound
    currentStats.video.outbound.map((report) => {
        let prev = previousStats.video.outbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesSent');
        report.packetRate = _computeRate(report, prev, 'packetsSent');
    });

    currentStats.remote.video.inbound.map((report) => {
        let prev = previousStats.remote.video.inbound.find(r => r.id === report.id);
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });

    return currentStats;
}

function _getCandidatePairInfo(candidatePair, stats) {
    if (!candidatePair || !stats) {
        return {};
    }

    const connection = { ...candidatePair };

    if (connection.localCandidateId) {
        const localCandidate = stats.get(connection.localCandidateId);
        connection.local = { ...localCandidate };
    }

    if (connection.remoteCandidateId) {
        const remoteCandidate = stats.get(connection.remoteCandidateId);
        connection.remote = { ...remoteCandidate };
    }

    return connection;
}

// Takes two stats reports and determines the rate based on two counter readings
// and the time between them (which is in units of milliseconds).
function _computeRate(newReport, oldReport, statName) {
    const newVal = newReport[statName];
    const oldVal = oldReport ? oldReport[statName] : null;
    if (newVal === null || oldVal === null) {
        return null;
    }
    if (newVal < oldVal) {
        return 0;
    }
    return (newVal - oldVal) / (newReport.timestamp - oldReport.timestamp) * 1000;
}

// Convert a byte rate to a bit rate.
function _computeBitrate(newReport, oldReport, statName) {
    return _computeRate(newReport, oldReport, statName) * 8;
}

export function parseStats(stats, previousStats, options = {}) {
    // Create an object structure with all the needed stats and types that we care
    // about. This allows to map the getStats stats to other stats names.

    if (!stats) {
        return null;
    }

    /**
     * The starting object where we will save the details from the stats report
     * @type {Object}
     */
    let statsObject = {
        audio: {
            inbound: [],
            outbound: []
        },
        video: {
            inbound: [],
            outbound: []
        },
        connection: {
            inbound: [],
            outbound: []
        }
    };

    // if we want to collect remote data also
    if (options.remote) {
        statsObject.remote = {
            audio: {
                inbound: [],
                outbound: []
            },
            video: {
                inbound: [],
                outbound: []
            }
        };
    }

    for (const report of stats.values()) {
        switch (report.type) {
            case 'outbound-rtp': {
                // let outbound = {};
                const mediaType = report.mediaType || report.kind;
                const codecInfo = {};
                if (!['audio', 'video'].includes(mediaType)) {
                    continue;
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                        codecInfo.channels = codec.channels;
                        codecInfo.sdpFmtpLine = codec.sdpFmtpLine;
                    }
                }

                statsObject[mediaType].outbound.push({ ...report, ...codecInfo });
                break;
            }
            case 'inbound-rtp': {
                // let inbound = {};
                let mediaType = report.mediaType || report.kind;
                const codecInfo = {};

                // Safari is missing mediaType and kind for 'inbound-rtp'
                if (!['audio', 'video'].includes(mediaType)) {
                    if (report.id.includes('Video')) {
                        mediaType = 'video';
                    } else if (report.id.includes('Audio')) {
                        mediaType = 'audio';
                    } else {
                        continue;
                    }
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                        codecInfo.channels = codec.channels;
                        codecInfo.sdpFmtpLine = codec.sdpFmtpLine;
                    }
                }

                // if we don't have connection details already saved
                // and the transportId is present (most likely chrome)
                // get the details from the candidate-pair
                if (!statsObject.connection.id && report.transportId) {
                    const transport = stats.get(report.transportId);
                    if (transport && transport.selectedCandidatePairId) {
                        const candidatePair = stats.get(transport.selectedCandidatePairId);
                        statsObject.connection = _getCandidatePairInfo(candidatePair, stats);
                    }
                }

                statsObject[mediaType].inbound.push({ ...report, ...codecInfo });
                break;
            }
            case 'peer-connection': {
                statsObject.connection.dataChannelsClosed = report.dataChannelsClosed;
                statsObject.connection.dataChannelsOpened = report.dataChannelsOpened;
                break;
            }
            case 'remote-inbound-rtp': {
                if (!options.remote) {
                    break;
                }
                // let inbound = {};
                let mediaType = report.mediaType || report.kind;
                const codecInfo = {};

                // Safari is missing mediaType and kind for 'inbound-rtp'
                if (!['audio', 'video'].includes(mediaType)) {
                    if (report.id.includes('Video')) {
                        mediaType = 'video';
                    } else if (report.id.includes('Audio')) {
                        mediaType = 'audio';
                    } else {
                        continue;
                    }
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                        codecInfo.channels = codec.channels;
                        codecInfo.sdpFmtpLine = codec.sdpFmtpLine;
                    }
                }

                // if we don't have connection details already saved
                // and the transportId is present (most likely chrome)
                // get the details from the candidate-pair
                if (!statsObject.connection.id && report.transportId) {
                    const transport = stats.get(report.transportId);
                    if (transport && transport.selectedCandidatePairId) {
                        const candidatePair = stats.get(transport.selectedCandidatePairId);
                        statsObject.connection = _getCandidatePairInfo(candidatePair, stats);
                    }
                }

                statsObject.remote[mediaType].inbound.push({ ...report, ...codecInfo });
                break;
            }
            case 'remote-outbound-rtp': {
                if (!options.remote) {
                    break;
                }
                // let outbound = {};
                const mediaType = report.mediaType || report.kind;
                const codecInfo = {};
                if (!['audio', 'video'].includes(mediaType)) {
                    continue;
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                        codecInfo.channels = codec.channels;
                        codecInfo.sdpFmtpLine = codec.sdpFmtpLine;
                    }
                }

                statsObject.remote[mediaType].outbound.push({ ...report, ...codecInfo });
                break;
            }
            default:
        }
    }

    // if we didn't find a candidate-pair while going through inbound-rtp
    // look for it again
    if (!statsObject.connection.id) {
        for (const report of stats.values()) {
            // select the current active candidate-pair report
            if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
                statsObject.connection = _getCandidatePairInfo(report, stats);
            }
        }
}

    statsObject = _addAdditionalData(statsObject, previousStats);

    return statsObject;
}

export function map2obj(stats) {
    if (!stats.entries) {
        return stats;
    }
    const o = {};
    stats.forEach(function(v, k) {
        o[k] = v;
    });
    return o;
}

// ----- preferred video codec ------------------------------------------------
//
// Module-level default for the video codec that appears first in both the
// offer's and answer's video m-line. Both sides need to agree, so set this
// once at app init via setPreferredVideoCodec(). Recognized values follow
// the names libwebrtc puts in `a=rtpmap` (case-insensitive on lookup):
// "VP8", "VP9", "H264", "AV1". Default 'VP8' — universally available, fits
// our FrameEncryptor's 1-byte unencrypted-prefix layout.
let _preferredVideoCodec = 'VP8';

function setPreferredVideoCodec(codec) {
    if (typeof codec === 'string' && codec.length > 0) {
        _preferredVideoCodec = codec;
    }
}

function getPreferredVideoCodec() {
    return _preferredVideoCodec;
}

// Answer-side codec selection driven by the user's Preferences.
//
// Pick order:
//   1. The codec the user explicitly chose in Preferences
//      (setPreferredVideoCodec, surfaced from rtp.preferredVideoCodec
//      in app.js). If the offerer advertised that codec at any
//      position in its m=video, return it. createLocalSdp's
//      setCodecPreferences call then promotes the matching codec to
//      first in pc.localDescription, and mungeSdp does the same to the
//      wire SDP — so both views agree.
//   2. Otherwise, the offerer's first real codec (skipping rtx / red
//      / ulpfec / flexfec / cn). This is the safety net for offers
//      that don't include our preferred codec at all — rare in
//      practice, since VP8/VP9/H264 are nearly universal.
//   3. Otherwise, the local preference verbatim. Only reached when
//      the offer can't be parsed.
//
// Why honour Preferences instead of just mirroring the offerer's
// first codec: Safari's macOS HW encoder lists H.264 High profile
// (profile-level-id=640c1f, PT 96) as its first video PT, but Android
// libwebrtc only handles Constrained Baseline 42e01f. With strict
// mirroring the answer promotes H.264 → Janus keeps forwarding the
// High-profile stream → our receiver has no decoder for it → inbound
// video freezes to a black window. Letting Preferences win pushes
// the negotiation onto VP9 (or whatever the user picked), which both
// ends decode natively.
//
// E2EE note: when two sylk peers are both using their own
// preferredVideoCodec, the answer ends up first-listing the
// answerer's preference rather than the offerer's. CallZrtp reads
// pc.remoteDescription on each side to compute the FrameEncryptor's
// per-codec prefix, so the caller sees the answerer's pref (from the
// answer) and the callee sees the offerer's pref (from the offer).
// As long as both ends have the same preferredVideoCodec — and the
// app-wide default 'VP9' guarantees they do unless explicitly
// changed — the two views agree and E2EE keeps working.
function pickAnswerVideoCodec(offerSdp) {
    const wanted = getPreferredVideoCodec();
    if (!offerSdp) return wanted;
    try {
        const parsed = transform.parse(offerSdp);
        const videoMLine = parsed.media && parsed.media.find(m => m.type === 'video');
        if (!videoMLine || !videoMLine.payloads) return wanted;
        const payloadOrder = String(videoMLine.payloads).split(' ').map(p => parseInt(p, 10));
        const ignored = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03', 'cn']);

        // Pass 1: the user's Preference, if the offer advertises it.
        if (wanted) {
            const want = String(wanted).toLowerCase();
            for (const pt of payloadOrder) {
                const rtp = videoMLine.rtp && videoMLine.rtp.find(r => r.payload === pt);
                if (!rtp || !rtp.codec) continue;
                if (ignored.has(rtp.codec.toLowerCase())) continue;
                if (rtp.codec.toLowerCase() === want) {
                    return rtp.codec;
                }
            }
        }

        // Pass 2: the offerer's first real codec (legacy mirror
        // behaviour). Only reached when the user's preferred codec
        // isn't in the offer at all.
        for (const pt of payloadOrder) {
            const rtp = videoMLine.rtp && videoMLine.rtp.find(r => r.payload === pt);
            if (!rtp || !rtp.codec) continue;
            if (ignored.has(rtp.codec.toLowerCase())) continue;
            return rtp.codec;
        }
    } catch (e) {
        // fall through to local default
    }
    return wanted;
}

// ----- preferred audio codec ------------------------------------------------
//
// Same module-level-default pattern as the video preference above, but for
// the audio m-line. Recognized values follow the names libwebrtc puts in
// `a=rtpmap` (case-insensitive on lookup): "opus", "G722", "PCMU", "PCMA".
// Default 'opus' — best quality and what libwebrtc would normally pick on
// its own; this only matters when the user wants to force a narrowband
// codec for PSTN / Asterisk compatibility.
let _preferredAudioCodec = 'opus';

function setPreferredAudioCodec(codec) {
    if (typeof codec === 'string' && codec.length > 0) {
        _preferredAudioCodec = codec;
    }
}

function getPreferredAudioCodec() {
    return _preferredAudioCodec;
}

// Mirror of pickAnswerVideoCodec for the audio m-line. The answerer
// must not name a codec the offerer didn't list, so we pick the first
// real audio codec from the offer's m=audio payloads (skipping
// telephone-event, comfort-noise, and red — those are signalling /
// FEC entries, not user-selectable codecs). Falls back to the local
// preference when the offer can't be parsed.
function pickAnswerAudioCodec(offerSdp) {
    const fallback = getPreferredAudioCodec();
    if (!offerSdp) return fallback;
    try {
        const parsed = transform.parse(offerSdp);
        const audioMLine = parsed.media && parsed.media.find(m => m.type === 'audio');
        if (!audioMLine || !audioMLine.payloads) return fallback;
        const payloadOrder = String(audioMLine.payloads).split(' ').map(p => parseInt(p, 10));
        const ignored = new Set(['telephone-event', 'cn', 'red']);
        for (const pt of payloadOrder) {
            const rtp = audioMLine.rtp && audioMLine.rtp.find(r => r.payload === pt);
            if (!rtp || !rtp.codec) continue;
            if (ignored.has(rtp.codec.toLowerCase())) continue;
            return rtp.codec;
        }
    } catch (e) {
        // fall through to local default
    }
    return fallback;
}

export default { Identity, SharedFile, createLocalSdp, mungeSdp, getMediaDirections, attachMediaStream, closeMediaStream,  sanatizeHtml, map2obj, parseStats, setPreferredVideoCodec, getPreferredVideoCodec, pickAnswerVideoCodec, setPreferredAudioCodec, getPreferredAudioCodec, pickAnswerAudioCodec};
