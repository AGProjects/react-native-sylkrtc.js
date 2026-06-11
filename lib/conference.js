'use strict';

import debug from 'react-native-debug';
import uuid from 'react-native-uuid';
import utils from './utils';

import { EventEmitter } from 'events';
import { Message } from './message';
import { Statistics } from './statistics';

const uuidv4 = uuid.v4;

const DEBUG = debug('sylkrtc:Conference');
//debug.enable('*');

class Participant extends EventEmitter {
    constructor(publisherId, identity, conference, options={}) {
        super();
        this._id = uuidv4();
        this._publisherId = publisherId;
        this._identity = identity;
        this._conference = conference;
        this._state = null;
        this._pc = null;
        this._stream = new MediaStream();
        this._videoSubscriptionPaused = false;
        this._audioSubscriptionPaused = false;
        this._videoPublishingPaused = false;
        this._audioPublishingPaused = false;
        // Participant classification, fixed at creation and never changed:
        //   'webrtc' - a Janus publisher with its own video feed
        //   'sip'    - a caller behind the audio bridge (surrogate; audio
        //              only, nothing to attach a subscription to)
        //   'bridge' - the audio bridge itself (the UI hides it)
        this._type = options.type || 'webrtc';
        // Server-side input-mute state reported by the conference focus.
        // null until the server tells us; otherwise a boolean.
        this._muted = options.muted === undefined ? null : !!options.muted;
        // Latest audio level for a SIP surrogate (the focus streams these
        // via conference-audio-levels keyed by this participant's id).
        // WebRTC tiles get their level from getStats instead, so this stays
        // 0 for them.
        this._audioLevel = 0;
    }

    get id() {
        return this._id;
    }

    get publisherId() {
        return this._publisherId;
    }

    get identity() {
        return this._identity;
    }

    get conference() {
        return this._conference;
    }

    get videoPaused() {
        return this._videoSubscriptionPaused;
    }

    get state() {
        return this._state;
    }

    get type() {
        return this._type;
    }

    get muted() {
        return this._muted;
    }

    get audioLevel() {
        return this._audioLevel;
    }

    // Update the server-reported mute state. Emits 'muteChanged'
    // (oldMuted, newMuted) on this participant only when the value
    // actually changes, so a tile can subscribe to its own participant
    // and re-render without the conference re-broadcasting to everyone.
    setMuted(muted) {
        const newMuted = !!muted;
        if (this._muted === newMuted) {
            return;
        }
        const oldMuted = this._muted;
        this._muted = newMuted;
        DEBUG(`Participant ${this.id} muted change: ${oldMuted} -> ${newMuted}`);
        this.emit('muteChanged', oldMuted, newMuted);
    }

    // Update the latest audio level (SIP surrogates only). Emits 'updated'
    // when the value changes so a subscribed VU meter can repaint.
    setAudioLevel(level) {
        const lvl = Number(level) || 0;
        if (this._audioLevel === lvl) {
            return;
        }
        this._audioLevel = lvl;
        this.emit('updated', {audioLevel: lvl});
    }

    getReceivers() {
        if (this._pc !== null) {
           return this._pc.getReceivers();
        } else {
            return [];
        }
    }

    get streams() {
        if (this._pc !== null) {
            if (this._pc.getReceivers) {
                this._pc.getReceivers().forEach((e) => {
                    this._stream.addTrack(e.track);
                });
                return [this._stream];
            } else {
                return this._pc.getRemoteStreams();
            }
        } else {
            return [];
        }
    }


    attach() {
        if (this._state !== null) {
            return;
        }
        this._setState('progress');
        this._sendAttach();
    }

    detach(isRemoved=false) {
        if (this._state !== null) {
            if (!isRemoved) {
                this._sendDetach();
            } else {
                this._close();
            }
        }
    }

    pauseVideo() {
        this._sendUpdate({video: false});
        this._videoSubscriptionPaused = true;
    }

    resumeVideo() {
        this._sendUpdate({video: true});
        this._videoSubscriptionPaused = false;
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        DEBUG(`Participant ${this.id} state change: ${oldState} -> ${newState}`);
        this.emit('stateChanged', oldState, newState);
    }

    _handleOffer(offerSdp) {
        DEBUG('Handling SDP for participant offer: %s', offerSdp);
        const mungedSdp = utils.mungeSdp(offerSdp, null , true);

        // Create the RTCPeerConnection
        const pcConfig = this.conference._pcConfig;
        const pc = new RTCPeerConnection(pcConfig);
        this._conference._statistics.addConnection({pc: pc, peerId: this._id});

		pc.addEventListener('track', (event) => {
			const stream = event.streams && event.streams[0];
			if (stream) {
				this.emit('streamAdded', stream);
			} else {
				DEBUG('Track added without stream');
			}
		});

        pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });
        this._pc = pc;

        // no need for a local stream since we are only going to receive media here
        pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: mungedSdp}))
            // success
            .then(() => {
                utils.createLocalSdp(pc, 'answer')
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendAnswer(sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this._close();
                    });
            })
            // failure
            .catch((error) => {
                DEBUG('Error setting remote description: %s', error);
                this._close();
            });
    }

    _sendAttach() {
        const req = {
            sylkrtc: 'videoroom-feed-attach',
            session: this.conference.id,
            publisher: this._publisherId,
            feed: this.id
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error attaching to participant %s: %s', this._publisherId, error);
            }
        });
    }

    _sendDetach() {
        const req = {
            sylkrtc: 'videoroom-feed-detach',
            session: this.conference.id,
            feed: this.id
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error detaching to participant %s: %s', this._publisherId, error);
            }
            this._close();
        });
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'videoroom-session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : []
        };
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._close();
            }
        });
    }

    _sendAnswer(sdp) {
        const req = {
            sylkrtc: 'videoroom-feed-answer',
            session: this.conference.id,
            feed: this.id,
            sdp: sdp
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                this._close();
            }
        });
    }

    _sendUpdate(options = {}) {
        const req = {
            sylkrtc: 'videoroom-session-update',
            session: this.id,
            options: options
        };
        DEBUG('Sending update participant request %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
            }
        });
    }

    _close() {
        DEBUG('Closing Participant RTCPeerConnection');
        if (this._pc !== null) {
            this._conference._statistics.removeConnection({pc: this._pc, peerId: this._id});
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    if (track.track != null) {
                        tracks = tracks.concat(track.track);
                    }
                }
                if (tracks.length !== 0) {
                    tempStream = new MediaStream(tracks);
                    utils.closeMediaStream(tempStream);
                }
            } else {
                for (let stream of this._pc.getLocalStreams()) {
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
            this._pc.close();
            this._pc = null;
            this._setState(null);
        }
    }
}


class ConferenceCall extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._pc = null;
        this._participants = new Map();
        this._terminated = false;
        this._state = null;
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._localStreams = new MediaStream();
        this._previousTrack = null;
        this._remoteIdentity = null;
        this._sharingScreen = false;
        this._activeParticpants = [];
        this._sharedFiles = [];
        this._raisedHands = [];
        this._messages = new Map();
        this._videoOffered = true;
        this._audioOffered = true;
        this._pcConfig = null;  // saved on initialize, used later for subscriptions
        this._delay_established = false;  // set to true when we need to delay posting the state change to 'established'
        this._setup_in_progress = false;  // set while we set the remote description and setup the peer copnnection
        this._statistics = new Statistics();
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
    }

    get sharingScreen() {
        return this._sharingScreen;
    }

    get sharedFiles () {
        return this._sharedFiles;
    }

    get raisedHands () {
        return this._raisedHands;
    }

    get direction() {
        // make this object API compatible with `Call`
        return 'outgoing';
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

    get participants() {
        return Array.from(new Set(this._participants.values()));
    }

    get activeParticipants() {
        return this._activeParticpants;
    }

    get messages() {
        return Array.from(this._messages.values());
    }

    get supportsAudio() {
        return this._audioOffered;
    }

    get supportsVideo() {
        return this._videoOffered;
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
        let streams = [];
        for (let participant of new Set(this._participants.values())) {
            streams = streams.concat(participant.streams);
        }
        return streams;
    }

    getSenders() {
        if (this._pc !== null) {
           return this._pc.getSenders();
        } else {
            return [];
        }
    }

    getReceivers() {
        let receivers = [];
        for (let participant of new Set(this._participants.values())) {
            receivers =  receivers.concat(participant.getReceivers());
        }
        return receivers;
    }

    scaleLocalTrack(oldTrack, divider) {
        DEBUG('Scaling track by %d', divider);

        let sender;

        for (sender of this._pc.getSenders()) {
            if (sender.track === oldTrack) {
                DEBUG('Found sender to modify track %o', sender);
                break;
            }
        }

        sender.setParameters({encodings: [{scaleResolutionDownBy: divider}]})
            .then(() => {
                DEBUG("Scale set to %o", divider);
                DEBUG('Active encodings %o', sender.getParameters().encodings);
            })
            .catch((error) => {
                DEBUG('Error %o', error);
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

    configureRoom(ps, cb=null) {
        if (!Array.isArray(ps)) {
            return;
        }
        this._sendConfigureRoom(ps, cb);
    }

    terminate() {
        if (this._terminated) {
            return;
        }
        DEBUG('Terminating conference');
        this._sendTerminate();
    }

    inviteParticipants(ps) {
        if (this._terminated) {
            return;
        }
        if (!Array.isArray(ps) || ps.length === 0) {
            return;
        }
        DEBUG('Inviting participants: %o', ps);
        const req = {
            sylkrtc: 'videoroom-invite',
            session: this.id,
            participants: ps
        };
        this._sendRequest(req, null);
    }

    // Symmetric counterpart of inviteParticipants. Asks the webrtc-
    // gateway to send REFER ;method=BYE (RFC 4579) for each named
    // participant — the conference focus then BYEs them out of the
    // room. Use this for explicit "remove from conference" UI
    // actions. The server-side auto-kick that fires when the last
    // WebRTC publisher leaves the room is independent of this call.
    removeParticipants(ps) {
        if (this._terminated) {
            return;
        }
        if (!Array.isArray(ps) || ps.length === 0) {
            return;
        }
        DEBUG('Removing participants: %o', ps);
        const req = {
            sylkrtc: 'videoroom-remove',
            session: this.id,
            participants: ps
        };
        this._sendRequest(req, null);
    }

    sendMessage(message, type) {
        return this._sendMessage(message, type);
    }

    sendComposing(state) {
        return this._sendComposing(state);
    }

    muteAudioParticipants() {
        DEBUG('Muting audio for all partcipants');
        const req = {
            sylkrtc: 'videoroom-mute-audio-participants',
            session: this.id
        };
        this._sendRequest(req, null);
    }

    // Mute or unmute a single participant's audio stream. Pass the
    // participant's `id` (Participant.id) — the videoroom session id for a
    // WebRTC peer, or the conference-focus token for a SIP surrogate. The
    // webrtcgateway routes the request based on the target:
    //   - WebRTC peer: a `mute-request` event is dispatched over WS to
    //     that participant, who flips its own microphone mute state.
    //     Surfaced on the recipient side as the `muteRequest` event.
    //   - SIP / bridge participant: the gateway sends a SIP REFER
    //     ;method=MUTE / UNMUTE to the conference focus so it mutes the
    //     participant at the mix.
    // `muted` is the desired boolean state (true=mute, false=unmute). Both
    // arguments are required; sending without them is a no-op so callers
    // can't fire a request with `undefined` fields the gateway would
    // reject. (The wire field is still named `participant_id` for protocol
    // compatibility; its value is the participant id described above.)
    muteParticipant(participantId, muted) {
        if (this._terminated) {
            return;
        }
        if (typeof participantId !== 'string' || participantId.length === 0) {
            DEBUG('muteParticipant: missing/empty participant id, ignoring');
            return;
        }
        DEBUG('Muting participant %s -> muted=%s', participantId, muted);
        const req = {
            sylkrtc: 'videoroom-mute-participant',
            session: this.id,
            participant_id: participantId,
            muted: !!muted
        };
        this._sendRequest(req, null);
    }

    toggleHand(session) {
        DEBUG('Toggle hand state');
        const req = {
            sylkrtc: 'videoroom-toggle-hand',
            session: this.id
        };
        if (session) {
            req.session_id = session;
        }
        this._sendRequest(req, null);
    }

    // Private API

    _initialize(uri, options={}) {
        if (this._id !== null) {
            throw new Error('Already initialized');
        }

        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        this._id = options.id || uuidv4();
        this._remoteIdentity = new utils.Identity(uri);

        options = Object.assign({}, options);
        const pcConfig = options.pcConfig || {iceServers:[]};
        this._pcConfig = pcConfig;
        this._initialParticipants = options.initialParticipants || [];
        const offerOptions = options.offerOptions || {};
        // only send audio / video through the publisher connection
        offerOptions.offerToReceiveAudio = false;
        offerOptions.offerToReceiveVideo = false;
        delete offerOptions.mandatory;
        // Create the RTCPeerConnection
        this._pc = new RTCPeerConnection(pcConfig);
        this._statistics.addConnection({pc:this._pc, peerId: this._id});
        this._pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });

		options.localStream.getTracks().forEach((track) => {
			this._pc.addTrack(track, options.localStream);
		});

        this.emit('localStreamAdded', options.localStream);
        DEBUG('Offer options: %o', offerOptions);
        utils.createLocalSdp(this._pc, 'offer', offerOptions)
            .then((sdp) => {
                DEBUG('Local SDP: %s', sdp);
                this._sendJoin(sdp, options);
            })
            .catch((reason) => {
                DEBUG('Error reason: %s', reason);
                this._localTerminate(reason);
            });
    }

    // Create a participant from a server publisher dict, or update an
    // existing one if we already have it (keyed by the server-side id).
    // Indexed by both the local uuid (used for feed lookups) and the
    // server id (used by publishers-left / publisher-updated /
    // conference-audio-levels). Returns the participant.
    _addOrUpdatePublisher(p) {
        let participant = this._participants.get(p.id);
        if (participant) {
            if (p.muted !== undefined) {
                participant.setMuted(p.muted);
            }
            return participant;
        }
        participant = new Participant(
            p.id,
            new utils.Identity(p.uri, p.display_name),
            this,
            {type: p.type, muted: p.muted}
        );
        this._participants.set(participant.id, participant);
        this._participants.set(p.id, participant);
        return participant;
    }

    _handleEvent(message) {
        DEBUG('Conference event: %o', message);
        let participant;
        switch (message.event) {
            case 'session-state':
                let oldState = this._state;
                let newState = message.state;
                this._state = newState;

                if (newState === 'accepted') {
                    // Capture the server-reported conference duration on
                    // the very first state transition. The webrtcgateway
                    // stamps VideoroomSessionAcceptedEvent with a
                    // gateway-side duration (seconds since the videoroom
                    // was created), independent of any SIP focus clock.
                    // Re-emitting it as `conferenceDuration` lets the UI
                    // seed its local meter to "started N minutes ago"
                    // from the moment of join, before the first
                    // conference-info NOTIFY arrives.
                    if (typeof message.duration === 'number') {
                        this._conferenceDuration = message.duration;
                        this.emit('conferenceDuration', message.duration);
                    }
                    this.emit('stateChanged', oldState, newState, {id: this._id});
                    const sdp = utils.mungeSdp(message.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._setup_in_progress = true;
                    this._audioOffered = message.audio;
                    this._videoOffered = message.video;
                    this._pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}))
                        // success
                        .then(() => {
                            this._setup_in_progress = false;
                            if (!this._terminated) {
                                if (this._delay_established) {
                                    oldState = this._state;
                                    this._state = 'established';
                                    DEBUG('Setting delayed established state!');
                                    this.emit('stateChanged', oldState, this._state, {});
                                    this._delay_established = false;
                                }
                                DEBUG('Conference accepted');
                                if (this._initialParticipants.length > 0 ) {
                                    setTimeout(() => {
                                            this.inviteParticipants(this._initialParticipants);
                                    }, 50);
                                }
                            }
                        })
                        // failure
                        .catch((error) => {
                            DEBUG('Error processing conference accept: %s', error);
                            this.terminate();
                        });
                } else if (newState === 'established') {
                    if (this._setup_in_progress) {
                        DEBUG('established but SETUP IN PROGRESS');
                        this._delay_established = true;
                    } else {
                        DEBUG('established stateChanged');
                        this.emit('stateChanged', oldState, newState, {id: this._id});
                    }
                } else if (newState === 'terminated') {
                    this.emit('stateChanged', oldState, newState, {reason: message.reason, id: this._id});
                    this._terminated = true;
                    this._close();
                } else {
                    this.emit('stateChanged', oldState, newState, {id: this._id});
                }
                break;
            case 'initial-publishers':
                // this comes between 'accepted' and 'established' states.
                // Carries the full roster the server knows at join time:
                // WebRTC publishers, the audio bridge, and any SIP callers
                // behind it (as surrogate participants). Each entry carries
                // type and, for SIP/WebRTC, the server-side muted state.
                for (let p of message.publishers) {
                    this._addOrUpdatePublisher(p);
                }
                break;
            case 'publishers-joined':
                // New publishers. For SIP surrogates this is derived from
                // the conference focus's roster diff and may re-announce a
                // participant we already seeded via initial-publishers, so
                // _addOrUpdatePublisher upserts (keyed by id) and we only
                // emit participantJoined for genuinely new ones.
                for (let p of message.publishers) {
                    DEBUG('Participant joined: %o', p);
                    const known = this._participants.has(p.id);
                    participant = this._addOrUpdatePublisher(p);
                    if (!known) {
                        this.emit('participantJoined', participant);
                    }
                }
                break;
            case 'publisher-updated':
                // Per-participant delta (currently only muted). `publisher`
                // is the participant's id (videoroom session id for WebRTC,
                // focus token for a SIP surrogate). setMuted emits
                // 'muteChanged' on the participant when the value changes.
                participant = this._participants.get(message.publisher);
                if (participant && message.muted !== undefined) {
                    participant.setMuted(message.muted);
                }
                break;
            case 'publishers-left':
                for (let pId of message.publishers) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        this._participants.delete(participant.id);
                        this._participants.delete(pId);
                        this.emit('participantLeft', participant);
                    }
                }
                break;
            case 'feed-attached':
                participant = this._participants.get(message.feed);
                if (participant) {
                    participant._handleOffer(message.sdp);
                }
                break;
            case 'feed-established':
                participant = this._participants.get(message.feed);
                if (participant) {
                    participant._setState('established');
                }
                break;
            case 'configure':
                let activeParticipants = [];
                let originator;
                const mappedOriginator = this._participants.get(message.originator);

                if (mappedOriginator) {
                    originator = mappedOriginator.identity;
                } else if (message.originator === this.id) {
                    originator = this.localIdentity;
                } else if (message.originator === 'videoroom'){
                    originator = message.originator;
                }

                for (let pId of message.active_participants) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        activeParticipants.push(participant);
                    } else if (pId === this.id) {
                        activeParticipants.push({
                            id: this.id,
                            publisherId: this.id,
                            identity: this.localIdentity,
                            streams: this.getLocalStreams()
                        });
                    }
                }
                this._activeParticpants = activeParticipants;
                const roomConfig = {originator: originator, activeParticipants: this._activeParticpants};
                this.emit('roomConfigured', roomConfig);
                break;
            case 'file-sharing':
                const mappedFiles = message.files.map((file) => {
                    return new utils.SharedFile(
                        file.filename,
                        file.filesize,
                        new utils.Identity(file.uploader.uri, file.uploader.display_name),
                        file.session
                    );
                });
                this._sharedFiles = this._sharedFiles.concat(mappedFiles);
                this.emit('fileSharing', mappedFiles);
                break;
            case 'message':
                const mappedMessage = new Message(
                    message,
                    new utils.Identity(message.sender.uri, message.sender.display_name),
                    'received'
                );
                this._messages.set(mappedMessage.id, mappedMessage);
                this.emit('message', mappedMessage);
                break;
            case 'message-delivery':
                const outgoingMessage = this._messages.get(message.message_id);
                if (outgoingMessage) {
                    if (message.delivered) {
                        outgoingMessage._setState('delivered');
                    } else {
                        outgoingMessage._setState('failed');
                    }
                }
                break;
            case 'composing-indication':
                const mappedComposing  = {
                    refresh: message.refresh,
                    sender: new utils.Identity(message.sender.uri, message.sender.display_name),
                    state: message.state
                };
                this.emit('composingIndication', mappedComposing);
                break;
            case 'mute-audio':
                let identity;
                const mappedIdentity = this._participants.get(message.originator);
                if (mappedIdentity) {
                    identity = mappedIdentity.identity;
                } else if (message.originator === this.id) {
                    identity = this.localIdentity;
                }
                this.emit('muteAudio', {originator: identity});
                break;
            case 'mute-request':
                // Per-participant mute request from the webrtcgateway,
                // sent when another client invoked muteParticipant()
                // with our session as the target. Re-emitted to the
                // React layer as `muteRequest` so the UI can flip the
                // local mic mute state and update its own button. The
                // `originator` is the session that asked for the mute
                // (resolved to an Identity when known, in case the UI
                // wants to render "Muted by <name>"); it's a no-op
                // when self-initiated since the requester will have
                // already toggled its local mute state through the
                // usual button onPress.
                let requestOriginator;
                if (message.originator) {
                    const mappedOriginator = this._participants.get(message.originator);
                    if (mappedOriginator) {
                        requestOriginator = mappedOriginator.identity;
                    } else if (message.originator === this.id) {
                        requestOriginator = this.localIdentity;
                    }
                }
                this.emit('muteRequest', {
                    muted: !!message.muted,
                    originator: requestOriginator
                });
                break;
            case 'raised-hands':
                // Diagnostic: log what the server sent vs. what we
                // can resolve locally. self_id is this conference's
                // own session UUID — used as the fallback key for
                // the local user in message.raised_hands. The mapped
                // count tells us how many entries actually resolved
                // to a participant object (others vs self vs unknown).
                console.log('[Conference] raised-hands IN raw=' + JSON.stringify(message.raised_hands) +
                    ' self_id=' + this.id + ' known_participants=' + this._participants.size);
                let raisedHands = [];
                for (let pId of message.raised_hands) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        raisedHands.push(participant);
                    } else if (pId === this.id) {
                        raisedHands.push({
                            id: this.id,
                            publisherId: this.id,
                            identity: this.localIdentity,
                            streams: this.getLocalStreams()
                        });
                    } else {
                        console.log('[Conference] raised-hands: unresolved pId=' + pId
                            + ' (not in _participants and not self_id)');
                    }
                }
                this._raisedHands = raisedHands;
                console.log('[Conference] raised-hands OUT count=' + raisedHands.length
                    + ' ids=' + JSON.stringify(raisedHands.map(p => p && p.id)));
                this.emit('raisedHands', {raisedHands: this._raisedHands});
                break;
            case 'conference-audio-levels':
                // Real-time per-participant audio levels pushed by the
                // webrtcgateway at audio_level_notify_period (default
                // 250ms), picked up via UDP from the conference focus's
                // audio-level server. Each entry is keyed by participant_id,
                // which for a SIP surrogate equals that participant's id, so
                // we route the level straight onto the Participant object.
                // `rx` is the level INTO the bridge from this participant
                // (their own speech) — the right signal for a "who is
                // talking" VU meter — so we prefer rx_peak. WebRTC tiles get
                // their level from getStats and have no entry here. The
                // participant is found by its publisherId key (the focus
                // token), which is the same value the audio-level entry is
                // keyed by.
                for (const entry of (message.levels || [])) {
                    const pid = entry.participant_id;
                    if (!pid) continue;
                    const part = this._participants.get(pid);
                    if (part) {
                        const level = entry.rx_peak != null ? entry.rx_peak : (entry.rx || 0);
                        part.setAudioLevel(level);
                    }
                }
                break;
            case 'invite-status':
                // Outcome of a SIP REFER sent by webrtcgateway to the
                // conference focus on the user's behalf. Carries
                // participant URI, state ('progress'|'success'|'failed'),
                // SIP code and reason. Re-emitted so the UI can mark
                // the invited tile (e.g. show "403 Relaying denied").
                console.log('[Conference] invite-status raw=', message);
                console.log('[Conference] invite-status participant=' + message.participant +
                            ' state=' + message.state +
                            ' code=' + message.code +
                            ' reason=' + (message.reason || ''));
                this.emit('inviteStatus', {
                    participant: message.participant,
                    state: message.state,
                    code: message.code,
                    reason: message.reason,
                });
                break;
            default:
                break;
        }
    }

    _sendConfigureRoom(ps, cb = null) {
        const req = {
            sylkrtc: 'videoroom-configure',
            session: this.id,
            active_participants: ps
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error configuring room: %s', error);
                if (cb) {
                    cb(error);
                }
            } else {
                DEBUG('Configure room send: %o', ps);
            }
        });
    }

    _sendJoin(sdp, options) {
        const req = {
            sylkrtc: 'videoroom-join',
            account: this.account.id,
            session: this.id,
            uri: this.remoteIdentity.uri,
            sdp: sdp,
            audio: options.audio,
            video: options.video
        };
        DEBUG('Sending request: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                this._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        const req = {
            sylkrtc: 'videoroom-leave',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating conference: %s', error);
                this._localTerminate(error);
            }
        });
        setTimeout(() => {
            if (!this._terminated) {
                DEBUG('Timeout terminating call');
                this._localTerminate('');
            }
            this._terminated = true;
        }, 500);
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'videoroom-session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : []
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._localTerminate(error);
            }
        });
    }

    _sendMessage(message, contentType='text/plain') {
        const outgoingMessage = new Message({
            content: message,
            contentType,
            timestamp: new Date().toISOString(),
            type: 'normal'
        }, this._localIdentity, 'pending');
        const req = {
            sylkrtc: 'videoroom-message',
            session: this.id,
            message_id: outgoingMessage.id,
            content: outgoingMessage.content,
            content_type: outgoingMessage.contentType
        };
        this._messages.set(outgoingMessage.id, outgoingMessage);
        this.emit('sendingMessage', outgoingMessage);
        DEBUG('Sending message: %o', outgoingMessage);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
                outgoingMessage._setState('failed');
            }
        });
        return outgoingMessage;
    }


    _sendComposing(state) {
        const req = {
            sylkrtc: 'videoroom-composing-indication',
            session: this.id,
            state: state,
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
            }
        });
    }

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _close() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            this._statistics.removeConnection({pc: this._pc, peerId: this._id});
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    tracks = tracks.concat(track.track);
                }
                if (this._previousTrack !== null) {
                    tracks = tracks.concat(this._previousTrack);
                }
                tempStream = new MediaStream(tracks);
                utils.closeMediaStream(tempStream);
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

            this._pc.close();
            this._pc = null;
        }
        const participants = this.participants;
        this._participants = [];
        for (let p of participants) {
            p._close();
        }
    }

    _localTerminate(reason) {
        if (this._terminated) {
            return;
        }
        DEBUG(`Local terminate, reason: ${reason}`);
        this._account._confCalls.delete(this.id);
        this._terminated = true;
        const oldState = this._state;
        const newState = 'terminated';
        const data = {
            reason: reason.toString(),
            id: this._id
        };
        this._close();
        this.emit('stateChanged', oldState, newState, data);
    }

}


export { ConferenceCall };
