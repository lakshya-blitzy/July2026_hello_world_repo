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
 * Surface: rawExchange({ port, payload, host, timeout, until, maxBytes }) -> Promise<string>;
 * `port` and `payload` are required, and every option is documented on the function's JSDoc
 * below.
 *
 * MISUSE AND HOSTILE PEERS ARE BOUNDED, NOT UNCAUGHT. Three deliberate guards, each closing a
 * path on which the unguarded form fails:
 *   (1) `payload` is type-checked BEFORE a socket exists, and the write itself is wrapped, so a
 *       value the runtime cannot write can never become an uncaught ERR_INVALID_ARG_TYPE thrown
 *       from inside the asynchronous 'connect' handler - which bypassed settle() entirely,
 *       leaving the promise pending, the guard timer live and the socket undestroyed.
 *   (2) A caller-supplied `until` predicate runs inside the 'data' listener, so a throwing
 *       predicate is caught and converted into a controlled rejection rather than an uncaught
 *       exception.
 *   (3) The accumulator is byte-bounded (`maxBytes`). The guard timer is a TIME bound and is not
 *       a size bound: an allowed peer that streams without ever closing could exhaust the
 *       runner's memory long before the timeout fires.
 * All three funnel through the same single settle() path, so each one still clears the guard,
 * removes every listener and destroys the socket.
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

// Upper bound on how much of the accumulator a rejection quotes, so that neither a
// 20,000-character case nor an overflowing peer can flood the test reporter.
const DIAGNOSTIC_PREFIX_CHARS = 200;

// Default ceiling on accumulated response bytes, in bytes (1 MiB). A resource bound, and a
// separate concern from the guard timer: the guard limits how LONG an exchange may take,
// this limits how MUCH it may buffer. The protocol tier's largest expected response is the
// 67-byte 431, so this is four orders of magnitude of headroom for legitimate use while still
// making runner-memory exhaustion impossible. Overridable per call via `maxBytes`.
const DEFAULT_MAX_BYTES = 1048576;

/**
 * Can the runtime write this value to a socket verbatim?
 *
 * Mirrors exactly what `net.Socket#write` accepts - a string, or any `ArrayBuffer` view, which
 * covers `Buffer` (itself a `Uint8Array`), every other TypedArray and `DataView`. Nothing is
 * coerced: this helper writes raw bytes, so silently stringifying an object would corrupt the
 * very bytes the protocol tier asserts on.
 *
 * @param {*} value The candidate payload.
 * @returns {boolean} True when `value` can be written without the runtime throwing.
 */
function isWritablePayload(value) {
  return typeof value === 'string' || ArrayBuffer.isView(value);
}

/**
 * Open a TCP connection, write `payload` verbatim once connected, and resolve with every byte
 * the peer sends back, exactly as received.
 *
 * @param {object} options Single options object; there is no positional-argument variant.
 * @param {number} options.port Required. Port of the caller's already-listening server.
 * @param {string|Buffer|TypedArray|DataView} options.payload Required. The exact raw bytes to
 *   write; this helper adds no framing, header or newline of its own. Type-checked up front:
 *   anything the runtime could not write - an object, a number, a boolean - REJECTS before a
 *   socket is created rather than throwing asynchronously out of the 'connect' handler.
 * @param {string} [options.host='127.0.0.1'] Host to connect to.
 * @param {number} [options.timeout=2000] unref()-ed guard bound in milliseconds. On expiry
 *   the returned promise REJECTS with a diagnostic naming the bound, the byte count received
 *   and a bounded prefix of those bytes.
 * @param {function(string): boolean} [options.until] Evaluated after each chunk is appended;
 *   a truthy result settles the exchange early and successfully with the bytes collected so
 *   far. This is a pattern match on received bytes - an event-driven condition, not a sleep.
 *   A predicate that THROWS rejects the exchange with the predicate's own error attached as
 *   `cause`; it never escapes as an uncaught exception.
 * @param {number} [options.maxBytes=1048576] Ceiling on accumulated response bytes. On
 *   overflow the exchange REJECTS with the byte count and a bounded prefix, and the socket is
 *   destroyed through the single settle path. A size bound, complementing - never replacing -
 *   the guard timer's time bound.
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
  // Documented as a number, so a numeric string, a float, a boolean or an out-of-range value
  // is misuse. net.createConnection would coerce some of them and refuse others much later,
  // from inside the socket rather than from here.
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    return Promise.reject(new TypeError(
      'rawExchange: options.port must be an integer between 1 and 65535'
    ));
  }
  if (opts.payload === undefined || opts.payload === null) {
    return Promise.reject(new Error('rawExchange: options.payload is required'));
  }
  // An unwritable payload throws ERR_INVALID_ARG_TYPE from inside the asynchronous 'connect'
  // handler, which is outside every promise boundary - so it becomes an uncaught exception that
  // never reaches settle(), leaving the promise pending, the guard timer live and the socket
  // undestroyed. Checking the type here, before a socket or a timer exists, converts that into
  // an ordinary rejection with nothing to clean up.
  if (!isWritablePayload(opts.payload)) {
    return Promise.reject(new TypeError(
      'rawExchange: options.payload must be a string, Buffer, TypedArray or DataView (this ' +
      'helper writes raw bytes and coerces nothing); received ' +
      (typeof opts.payload === 'object' ? Object.prototype.toString.call(opts.payload)
        : typeof opts.payload)
    ));
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
  if (opts.maxBytes !== undefined && (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0)) {
    return Promise.reject(new TypeError(
      'rawExchange: options.maxBytes must be a positive integer number of bytes'
    ));
  }

  const host = opts.host === undefined ? DEFAULT_HOST : opts.host;
  const timeoutMs = opts.timeout === undefined ? DEFAULT_TIMEOUT_MS : opts.timeout;
  const maxBytes = opts.maxBytes === undefined ? DEFAULT_MAX_BYTES : opts.maxBytes;

  return new Promise((resolve, reject) => {
    // Every mutable value lives inside this executor - there is no module-level state - so
    // concurrent exchanges cannot interfere and nothing survives the promise. The socket is
    // created before the guard so that a synchronous connection failure can never orphan a
    // timer; such a throw simply rejects this promise.
    const socket = net.createConnection({ host, port: opts.port });
    let data = '';
    let settled = false;
    // Real byte count of the accumulator, tracked incrementally. `data.length` counts UTF-16
    // code units, not bytes, so it is the wrong measure for both the size bound and the
    // diagnostics. The utf8 decoder buffers a split multi-byte character rather than emitting
    // half of one, so summing each decoded chunk's byte length is exact.
    let receivedBytes = 0;

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
    //
    // The write is wrapped even though `payload` was already type-checked: this handler runs
    // asynchronously, outside every promise boundary, so ANY throw from here would become an
    // uncaught exception that bypasses settle() rather than a rejection. Belt and braces for
    // the rest of that failure class - a destroyed socket, for instance, makes write() throw
    // ERR_STREAM_DESTROYED.
    function onConnect() {
      try {
        socket.write(opts.payload);
      } catch (writeError) {
        settle(writeError);
      }
    }

    function onData(chunk) {
      data += chunk;
      receivedBytes += Buffer.byteLength(chunk, 'utf8');

      // Size bound, enforced before the predicate so an overflowing peer cannot keep the
      // exchange alive by never satisfying `until`. Routed through settle(), so the socket is
      // destroyed and the guard cleared exactly as on every other path.
      if (receivedBytes > maxBytes) {
        settle(new Error(
          'rawExchange: response exceeded the ' + maxBytes + '-byte bound (received ' +
          receivedBytes + ' bytes: ' +
          JSON.stringify(data.slice(0, DIAGNOSTIC_PREFIX_CHARS)) + ')'
        ));
        return;
      }

      if (typeof opts.until === 'function') {
        let matched;
        try {
          matched = opts.until(data);
        } catch (predicateError) {
          // A caller's predicate runs inside this listener, so an exception it raises would
          // otherwise escape as an uncaught exception instead of failing the exchange. The
          // original error is attached as `cause` so the caller keeps the real stack.
          settle(new Error(
            'rawExchange: options.until threw after ' + receivedBytes + ' bytes (' +
            predicateError.message + ')',
            { cause: predicateError }
          ));
          return;
        }
        if (matched) {
          settle(null);
        }
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
      settle(receivedBytes > 0 ? null : err);
    }

    function onGuard() {
      settle(new Error(
        'rawExchange: no socket close within ' + timeoutMs + ' ms (received ' +
        receivedBytes + ' bytes: ' +
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
