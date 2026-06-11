'use strict';

import { Platform } from 'react-native';
import { getModel, getBrand } from 'react-native-device-info';
import debug from 'react-native-debug';
import uuid from 'react-native-uuid';

import { EventEmitter } from 'events';
import setImmediate from 'async/setImmediate';
import { w3cwebsocket as W3CWebSocket } from 'websocket';
import { Account } from './account';

const uuidv4 = uuid.v4;

const SYLKRTC_PROTO = 'sylkRTC-2';
const DEBUG = debug('sylkrtc:Connection');
//debug.enable('*');

const MSECS = 1000;
const INITIAL_DELAY = 0.5 * MSECS;
const MAX_DELAY = 16 * MSECS;

let platform = Platform.OS;

if (Platform.Version) {
    platform = `${platform} ${Platform.Version}`
}
let USER_AGENT = `SylkRTC (${getBrand()} ${getModel()} on ${platform})`;


class Connection extends EventEmitter {
    constructor(options = {}) {
        if (!options.server) {
            throw new Error('"server" must be specified');
        }
        super();
        this._wsUri = options.server;
        this._sock = null;
        this._state = null;
        this._closed = false;
        this._timer = null;
        this._delay = INITIAL_DELAY;
        this._accounts = new Map();
        this._requests = new Map();
        if (options.userAgent) {
            // The application fully controls how it identifies itself.
            // Accept either a ready-made string (used verbatim) or a
            // { name, version } object, and REPLACE the library default
            // rather than appending to it.
            if (typeof options.userAgent === 'string') {
                USER_AGENT = options.userAgent;
            } else {
                let userAgent = options.userAgent.name && options.userAgent.name !== ''  ? options.userAgent.name : 'Unknown';
                if (options.userAgent.version) {
                    userAgent = `${userAgent} ${options.userAgent.version}`;
                }
                USER_AGENT = userAgent;
            }
        }
    }

    get state() {
        return this._state;
    }

    close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._sock) {
            this._sock.close();
            this._sock = null;
        } else {
            setImmediate(() => {
                this._setState('closed');
            });
        }
    }

    addAccount(options = {}, cb = null) {
        if (typeof options.account !== 'string' || typeof options.password !== 'string') {
            throw new Error('Invalid options, "account" and "password" must be supplied');
        }
        if (this._accounts.has(options.account)) {
            throw new Error('Account already added');
        }

        const acc = new Account(options, this);
        // add it early to the set so we don't add it more than once, ever
        this._accounts.set(acc.id, acc);

        const req = {
            sylkrtc: 'account-add',
            account: acc.id,
            password: acc.password,
            display_name: acc.displayName,
            user_agent: USER_AGENT,
            incoming_header_prefixes: acc.incomingHeaderPrefixes
        };
        // Graceful-restart resume hook. When the app passes a
        // `previousSessionToken` (the resume_token it stashed from the
        // previous run's account-add ack), echo it back so the server
        // can fold this WebSocket onto whatever Janus state it
        // snapshotted at shutdown. Without this field the server takes
        // the fresh-session path, the Python-side videoroom rebuild
        // never fires, and old session UUIDs the app still holds
        // (videoroom_session ids) come back as "Unknown room session"
        // on the first invite / mute / kick. The server validates the
        // token against its PENDING_RESUMES table; an unknown / expired
        // token is silently ignored and the connection proceeds fresh.
        if (typeof options.previousSessionToken === 'string'
                && options.previousSessionToken.length > 0) {
            req.previous_session_token = options.previousSessionToken;
        }
        this._sendRequest(req, (error, ack) => {
            if (error) {
                DEBUG('add_account error: %s', error);
                this._accounts.delete(acc.id);
            }
            if (cb) {
                // Pass through the resume_token / resumed flag (lifted
                // by _onMessage onto the Connection) so the caller can
                // persist the new token without having to poll
                // `connection.resumeToken` after the fact. The third
                // arg is optional — older callers that take cb(err, acc)
                // simply ignore it.
                const meta = {
                    resumeToken: (ack && ack.resume_token) || null,
                    resumed: !!(ack && ack.resumed),
                };
                cb(error, error ? null : acc, meta);
            }
        });

    }

    removeAccount(account, cb=null) {
        const acc = this._accounts.get(account.id);
        if (account !== acc) {
            cb(new Error('Unknown account'));
            return;
        }

        // delete the account from the mapping, regardless of the result
        this._accounts.delete(account.id);

        const req = {
            sylkrtc: 'account-remove',
            account: acc.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('remove_account error: %s', error);
            }
            if (cb) {
                cb(error);
            }
        });

    }

    lookupPublicKey(uri) {
        const req = {
            sylkrtc: 'lookup-public-key',
            uri: uri
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('lookup public key error: %s', error);
            }
        });
    }

    reconnect() {
        if (this._state === 'disconnected') {
            clearTimeout(this._timer);
            this._delay = INITIAL_DELAY;
            this._timer = setTimeout(() => {
                this._connect();
            }, this._delay);
        }
    }

    /**
     * Send an explicit sylkrtc ping and resolve as soon as the server
     * acks it (or reject on timeout / error / non-ready connection).
     *
     * Uses the same `{sylkrtc: 'ping'}` round-trip as the internal
     * keep-alive watchdog, but on-demand — gives callers a way to
     * detect a ghost socket (state='ready' but no traffic actually
     * reaching the server) in seconds instead of the ~45 s the
     * watchdog needs to accumulate enough missed acks. Useful when an
     * out-of-band signal (e.g. an FCM push announcing an incoming
     * call) suggests a WSS message should be in flight but hasn't
     * arrived: a fast probe failure means reconnect immediately
     * rather than waiting the watchdog out.
     *
     * @param {number} [timeoutMs=2000] – how long to wait for the ack
     * @returns {Promise<void>} resolves on ack, rejects on
     *          timeout/error/not-ready
     */
    ping(timeoutMs = 2000) {
        return new Promise((resolve, reject) => {
            if (this._state !== 'ready') {
                reject(new Error('Connection is not ready'));
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('ping timeout after ' + timeoutMs + ' ms'));
            }, timeoutMs);
            this._sendRequest({sylkrtc: 'ping'}, (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    // Private API

    _initialize() {
        if (this._sock !== null) {
            throw new Error('WebSocket already initialized');
        }
        if (this._timer !== null) {
            throw new Error('Initialize is in progress');
        }

        DEBUG('Initializing');

        // if (process.browser) {
        //     window.addEventListener('beforeunload', () => {
        //         if (this._sock !== null) {
        //             const noop = function() {};
        //             this._sock.onerror = noop;
        //             this._sock.onmessage = noop;
        //             this._sock.onclose = noop;
        //             this._sock.close();
        //         }
        //     });
        // }

        this._timer = setTimeout(() => {
            this._connect();
        }, this._delay);
    }

    _connect() {
        DEBUG('WebSocket connecting');
        this._setState('connecting');

        this._sock = new W3CWebSocket(this._wsUri, SYLKRTC_PROTO);
        this._sock.onopen = () => {
            DEBUG('WebSocket connection open');
            this._onOpen();
        };
        this._sock.onerror = () => {
            DEBUG('WebSocket connection got error');
        };
        this._sock.onclose = (event) => {
            DEBUG('WebSocket connection closed: %d: (reason="%s", clean=%s)', event.code, event.reason, event.wasClean);
            this._onClose();
        };
        this._sock.onmessage = (event) => {
            DEBUG('WebSocket received message: %o', event);
            this._onMessage(event);
        };
    }

    _sendRequest(req, cb) {
        const transaction = uuidv4();
        req.transaction = transaction;
        if (this._state !== 'ready') {
            setImmediate(() => {
                cb(new Error('Connection is not ready'));
            });
            return;
        }
        this._requests.set(transaction, {req: req, cb: cb});
        if (this._sock) {
            this._sock.send(JSON.stringify(req));
        }
    }

    _setState(newState) {
        DEBUG('Set state: %s -> %s', this._state, newState);
        const oldState = this._state;
        this._state = newState;
        this.emit('stateChanged', oldState, newState);
    }

    // WebSocket callbacks

    _onOpen() {
        clearTimeout(this._timer);
        this._timer = null;
        this._delay = INITIAL_DELAY;
        this._setState('connected');

        // Application-layer keep-alive for the Sylk WSS control plane.
        //
        // Previously: ping every 3 s, drop after 7 missed acks (~21 s
        // budget). That was too aggressive in the field — a single
        // cell handover, NAT pinhole rotation, brief Wi-Fi-to-cell
        // transition or transient SylkServer hiccup would trip the
        // watchdog while the media plane (Janus RTCPeerConnection over
        // DTLS/SRTP, with its own ICE keepalive) was still perfectly
        // healthy. The call got torn down for no real reason.
        //
        // New: ping every 5 s, drop after 9 missed acks (~45 s
        // budget). That's long enough to ride out transient network
        // events without making genuine outages take too long to
        // detect.
        const PING_INTERVAL_MS = 5000;
        const MAX_MISSED_PINGS = 9;
        this._missedPings = 0;
        this._pingInterval = setInterval(() => {
            const req = {
                sylkrtc: 'ping',
            };
            this._sendRequest(req, (error) => {
                if (error) {
                    DEBUG('Error sending ping: %s', error);
                }
            });
            this._missedPings = this._missedPings + 1;
            if (this._missedPings >= MAX_MISSED_PINGS) {
                DEBUG('Disconnected, %d pings are missed (~%d s)',
                    this._missedPings, (PING_INTERVAL_MS * this._missedPings) / 1000);
                clearInterval(this._pingInterval);
                if (this._sock !== null) {
                    const noop = function() {};
                    this._sock.onerror = noop;
                    this._sock.onmessage = noop;
                    this._sock.onclose = noop;
                    this._sock.close();
                }
                this._onClose();
            }
        }, PING_INTERVAL_MS);
    }

    _onClose() {
        this._sock = null;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        // remove all accounts, the server no longer has them anyway
        this._accounts.clear();
        clearInterval(this._pingInterval);
        this._setState('disconnected');
        if (!this._closed) {
            this._delay = this._delay * 2;
            if (this._delay > MAX_DELAY) {
                DEBUG('Connection retry timeout (%s/%s) reached, reset', this._delay / MSECS, MAX_DELAY);
                this._delay = INITIAL_DELAY;
            }
            DEBUG('Retrying connection in %s seconds', this._delay / MSECS);
            this._timer = setTimeout(() => {
                this._connect();
            }, this._delay);
        } else {
            this._setState('closed');
        }
    }

    _onMessage(event) {
        const message = JSON.parse(event.data);
        if (typeof message.sylkrtc === 'undefined') {
            DEBUG('Unrecognized message received');
            return;
        }

        DEBUG('Received "%s" message: %o', message.sylkrtc, message);

        if (message.sylkrtc === 'ready-event') {
            DEBUG('Received ready-event');
            this._setState('ready');
        } else if (message.sylkrtc === 'lookup-public-key-event') {
            this.emit('publicKey', {publicKey: message.public_key, uri: message.uri});
        } else if (message.sylkrtc === 'account-event') {
            let acc = this._accounts.get(message.account);
            if (!acc) {
                DEBUG('Account %s not found', message.account);
                return;
            }
            acc._handleEvent(message);
        } else if (message.sylkrtc === 'session-event') {
            const sessionId = message.session;
            for (let acc of this._accounts.values()) {
                let call = acc._calls.get(sessionId);
                if (call) {
                    call._handleEvent(message);
                    break;
                }
            }
        } else if (message.sylkrtc === 'videoroom-event') {
            const confId = message.session;
            for (let acc of this._accounts.values()) {
                 let confCall = acc._confCalls.get(confId);
                 if (confCall) {
                     confCall._handleEvent(message);
                     break;
                 }
            }
        } else if (message.sylkrtc === 'ack' || message.sylkrtc === 'error') {
            const transaction = message.transaction;
            const data = this._requests.get(transaction);
            if (!data) {
                DEBUG('Could not find transaction %s', transaction);
                return;
            }
            this._requests.delete(transaction);
            DEBUG('Received "%s" for request: %o', message.sylkrtc, data.req);
            if (data.req.sylkrtc === 'ping') {
                this._missedPings = 0;
            }
            // Graceful-restart resume_token book-keeping. The server
            // sends a fresh `resume_token` (and a `resumed` flag) on
            // every successful account-add ack — see
            // _RH_account_add in sylkserver. We stash the most recent
            // one on the Connection so the embedding app can persist
            // it and echo it as `previousSessionToken` on the next
            // addAccount(), letting the server fold the connection
            // back onto whatever Janus state it snapshotted at
            // shutdown. We also emit a `resumeToken` event so apps
            // that prefer a push model don't have to poll the getter.
            if (message.sylkrtc === 'ack'
                    && data.req.sylkrtc === 'account-add'
                    && typeof message.resume_token === 'string'
                    && message.resume_token.length > 0) {
                this._resumeToken = message.resume_token;
                this._resumed = !!message.resumed;
                try {
                    this.emit('resumeToken', {
                        token: this._resumeToken,
                        resumed: this._resumed,
                        account: data.req.account,
                    });
                } catch (e) {
                    DEBUG('resumeToken emit failed: %o', e);
                }
            }
            if (data.cb) {
                if (message.sylkrtc === 'ack') {
                    // Pass the full ack message as a second arg so
                    // callers that care about extra fields
                    // (resume_token, resumed, etc.) can read them
                    // without having to poll the connection. Backward
                    // compatible — existing cb(error) callers just
                    // ignore the extra positional arg.
                    data.cb(null, message);
                } else {
                    data.cb(new Error(message.error));
                }
            }
        }
    }

    // Most-recent resume token returned by the server on account-add.
    // The embedding app should persist this (to whatever storage it
    // already uses for credentials) and pass it back as
    // `options.previousSessionToken` on the next addAccount() so the
    // server can fold this connection onto the Janus state it kept
    // across its last shutdown. Null until at least one successful
    // account-add ack has arrived; null after disconnect (since a
    // fresh Connection always starts without state to resume).
    get resumeToken() {
        return this._resumeToken || null;
    }

    // True when the most-recent account-add was acked with
    // `resumed: true` by the server (i.e. the server successfully
    // folded this connection onto a snapshotted Janus session).
    // Lets the app distinguish "I came back to my old session" from
    // "I got a fresh one" without consulting the cb's ack arg.
    get resumed() {
        return !!this._resumed;
    }

}


export { Connection };
