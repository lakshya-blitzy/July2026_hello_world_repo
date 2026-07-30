'use strict';

/**
 * rawExchange - write raw bytes to a TCP peer and resolve with everything it sends back.
 *
 * The protocol tier must reach behaviour BENEATH the request handler - the Node HTTP parser's
 * own rejections - and no compliant client will emit an invalid request line, so the bytes are
 * written by hand. Raw bytes in, raw bytes out: the accumulator resolves exactly as received,
 * with no trim, re-framing or line-ending normalisation, so callers assert byte-exactly. A 400
 * or a 431 is a NORMAL runtime response: this helper RESOLVES with those bytes and never
 * treats them as a thrown or rejected operation.
 *
 * Surface: rawExchange({ port, payload, host, timeout, until }) -> Promise<string>; `port` and
 * `payload` are required, and every option is documented on the function's JSDoc below.
 *
 * Two termination routes, both event-driven and never wall-clock: (1) the socket's 'close'
 * event - put `Connection: close` on the LAST pipelined request and close fires in single-digit
 * milliseconds; or (2) a truthy `until` predicate evaluated as each chunk arrives, which a pair
 * that stays keep-alive throughout requires because such a socket never closes, for example
 * (d) => (d.match(/HTTP\/1\.1 200 OK/g) || []).length >= 2.
 *
 * The guard timer is an unref()-ed safety bound that REJECTS with a diagnostic, never a
 * synchronisation mechanism, and every outcome funnels through ONE idempotent settle() that
 * clears the guard, removes each named listener and destroys the socket, so no handle outlives
 * the exchange. If the runner will not exit, the defect is here and is fixed here - forcing the
 * runner to exit is never the remedy, because it hides exactly this defect class.
 */

const net = require('net');

// Loopback default, matching the subject's bind address. The port is deliberately NOT
// defaulted: contract-level tiers pass an ephemeral port allocated by their own server, and
// the repository's fixed port belongs to the bootstrap tier alone.
const DEFAULT_HOST = '127.0.0.1';

// Default guard bound, in milliseconds. An unref()-ed safety bound that rejects - never a
// wait: a healthy exchange settles on 'close' or on `until` in single-digit milliseconds and
// never reaches it.
const DEFAULT_TIMEOUT_MS = 2000;

// Upper bound on how much of the accumulator a guard rejection quotes, so that a
// 20,000-character case cannot flood the test reporter.
const DIAGNOSTIC_PREFIX_CHARS = 200;

/**
 * Open a TCP connection, write `payload` verbatim once connected, and resolve with every byte
 * the peer sends back, exactly as received.
 *
 * @param {object} options Single options object; there is no positional-argument variant.
 * @param {number} options.port Required. Port of the caller's already-listening server.
 * @param {string|Buffer} options.payload Required. The exact raw bytes to write; this helper
 *   adds no framing, header or newline of its own.
 * @param {string} [options.host='127.0.0.1'] Host to connect to.
 * @param {number} [options.timeout=2000] unref()-ed guard bound in milliseconds. On expiry
 *   the returned promise REJECTS with a diagnostic naming the bound, the byte count received
 *   and a bounded prefix of those bytes.
 * @param {function(string): boolean} [options.until] Evaluated after each chunk is appended;
 *   a truthy result settles the exchange early and successfully with the bytes collected so
 *   far. This is a pattern match on received bytes - an event-driven condition, not a sleep.
 * @returns {Promise<string>} The complete accumulated response text, untouched.
 */
function rawExchange(options) {
  const opts = options || {};

  // Misuse is reported loudly, and BEFORE any socket or timer exists, so that settle() below
  // remains the one and only path that resolves, rejects, clears the guard, removes a
  // listener or destroys the socket. Rejecting rather than throwing synchronously keeps the
  // helper uniformly promise-shaped for every caller.
  if (!opts.port) {
    return Promise.reject(new Error('rawExchange: options.port is required'));
  }
  if (opts.payload === undefined || opts.payload === null) {
    return Promise.reject(new Error('rawExchange: options.payload is required'));
  }
  if (opts.host !== undefined && (typeof opts.host !== 'string' || opts.host.length === 0)) {
    return Promise.reject(new TypeError('rawExchange: options.host must be a non-empty string'));
  }
  // Number.isFinite does not coerce, so this rejects strings, booleans, NaN and Infinity too.
  if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) {
    return Promise.reject(new TypeError(
      'rawExchange: options.timeout must be a positive finite number of milliseconds'
    ));
  }
  // A mistyped predicate would otherwise be ignored in silence and surface much later as a
  // confusing guard timeout, so it is rejected here instead.
  if (opts.until !== undefined && typeof opts.until !== 'function') {
    return Promise.reject(new TypeError('rawExchange: options.until must be a function'));
  }

  const host = opts.host === undefined ? DEFAULT_HOST : opts.host;
  const timeoutMs = opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout;

  return new Promise((resolve, reject) => {
    // Every mutable value lives inside this executor - there is no module-level state - so
    // concurrent exchanges cannot interfere and nothing survives the promise. The socket is
    // created before the guard so that a synchronous connection failure can never orphan a
    // timer; such a throw simply rejects this promise.
    const socket = net.createConnection({ host, port: opts.port });
    let data = '';
    let settled = false;

    // Safety bound only - NEVER a synchronisation mechanism. unref()-ed immediately at
    // creation, so the timer on its own can never hold the event loop open.
    const guard = setTimeout(onGuard, timeoutMs);
    guard.unref();

    // THE single settle path. Nothing else clears the guard, removes a listener, destroys the
    // socket, resolves or rejects. Idempotent, so whichever outcome arrives first wins and
    // every later one is a no-op.
    function settle(err) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(guard);
      socket.removeListener('connect', onConnect);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    }

    // Written only once the connection is established, and written verbatim.
    function onConnect() {
      socket.write(opts.payload);
    }

    function onData(chunk) {
      data += chunk;
      if (typeof opts.until === 'function' && opts.until(data)) {
        settle(null);
      }
    }

    function onClose() {
      settle(null);
    }

    function onError(err) {
      // Deliberate, and not to be "simplified" into an unconditional reject: a peer that
      // sends a complete response and then resets the connection is a normal outcome for the
      // 400 and 431 cases, so bytes already received ARE the result. When nothing was
      // received - ECONNREFUSED, for instance - the error itself is the result.
      settle(data.length > 0 ? null : err);
    }

    function onGuard() {
      settle(new Error(
        'rawExchange: no socket close within ' + timeoutMs + ' ms (received ' +
        data.length + ' bytes: ' +
        JSON.stringify(data.slice(0, DIAGNOSTIC_PREFIX_CHARS)) + ')'
      ));
    }

    // Strings rather than Buffers: the protocol tier compares byte-exact ASCII, and the
    // decoder handles a multi-byte character split across chunks, so no Buffer concatenation
    // or re-decoding is needed and none may be introduced.
    socket.setEncoding('utf8');
    socket.on('connect', onConnect);
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onError);
  });
}

module.exports = { rawExchange };
