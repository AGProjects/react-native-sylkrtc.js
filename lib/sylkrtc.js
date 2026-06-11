'use strict';

import adapter from 'webrtc-adapter';
import { Connection } from './connection';
import _utils from './utils';


// Public API

function createConnection(options = {}) {
    if (!window.RTCPeerConnection) {
        throw new Error('WebRTC support not detected');
    }

    const conn = new Connection(options);
    conn._initialize();
    return conn;
}


const utils = {
    'attachMediaStream'      : _utils.attachMediaStream,
    'closeMediaStream'       : _utils.closeMediaStream,
    'setPreferredVideoCodec' : _utils.setPreferredVideoCodec,
    'getPreferredVideoCodec' : _utils.getPreferredVideoCodec,
    'setPreferredAudioCodec' : _utils.setPreferredAudioCodec,
    'getPreferredAudioCodec' : _utils.getPreferredAudioCodec,
    // mungeSdp + pickAnswer* are useful to callers that want to log /
    // dry-run the SDP that sylkrtc actually ships on the wire (e.g.
    // AudioCallBox._logProposedCodec re-mungeSdps the localDescription
    // so the proposed-codec log line reflects what was sent, not the
    // un-munged version webrtc stored on the PeerConnection).
    'mungeSdp'               : _utils.mungeSdp,
    'pickAnswerVideoCodec'   : _utils.pickAnswerVideoCodec,
    'pickAnswerAudioCodec'   : _utils.pickAnswerAudioCodec,
};


export {
    createConnection,
    utils
};
