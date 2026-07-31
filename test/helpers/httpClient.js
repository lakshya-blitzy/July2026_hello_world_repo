'use strict';

/**
 * Promise wrapper over the core HTTP request API, pooling DISABLED. Serves the
 * end-to-end tiers (bootstrap, lifecycle) where a PARSED response is wanted - a
 * status code, a header map, a body string - or where a refusal must surface as
 * a rejection; raw byte exchanges belong to the sibling helper rawExchange.js.
 *
 * Surface: request({ port, host, path, method, headers, body, maxResponseBytes })
 * and get(port, path), each resolving exactly { status, headers, body }; only
 * `port` is required, and every option is detailed on the functions below.
 *
 * EVERY OPTION IS VALIDATED BEFORE A REQUEST EXISTS, AND VALIDATION FAILS
 * CLOSED. The port must be an integer in 1..65535 and a supplied host must be a
 * non-empty string, so a mistyped destination rejects here rather than being
 * coerced by the runtime or - worse - defaulted back to loopback, which would
 * turn the loopback-confinement scenario's expected refusal into a 200 against
 * the local server. Nothing is created before these checks pass, so a rejection
 * on this path leaves nothing to release.
 *
 * EVERY FAILURE RELEASES THE REQUEST. One internal failure path destroys the
 * ClientRequest before rejecting, because a request that is created and then
 * abandoned keeps a live server-side connection: an invalid `body` would reject
 * correctly yet strand the request, and the target server's `close()` would then
 * never complete. `body` is therefore type-checked BEFORE the request is
 * constructed, and the write/end pair is wrapped so any late throw still
 * destroys it. The response body is also byte-bounded, so a hostile or
 * malformed peer cannot exhaust the runner's memory.
 *
 * `agent: false` is mandatory on every request and is the point of this file: no
 * client-side keep-alive socket may survive a test. The consequence on the wire -
 * responses carry `connection: close` and only FOUR header keys (connection,
 * content-length, content-type, date), `keep-alive` ABSENT - so this helper is
 * NOT suitable for asserting the five-key HEADER_KEYS set in
 * test/fixtures/expected.js; that belongs to the L2 supertest contract tier, and
 * the fixture must never be repaired by deleting 'keep-alive'.
 *
 * A closed port rejects with the ORIGINAL, unwrapped Error, so err.code reads
 * 'ECONNREFUSED'. No timer is created here: the promise settles on the response
 * 'end' event or on an 'error' from either the request or the response stream.
 * A request that is still in flight naturally still holds its socket, so a
 * caller must let every request settle before its test ends.
 */

const http = require('http');

/**
 * Loopback default for the destination host, matching the subject's bind address.
 *
 * Applied ONLY when `host` is omitted altogether. A supplied host is validated and then used
 * verbatim - it is never replaced by this default - because the loopback-confinement scenario
 * aims deliberately at the machine's routable address and needs that request to be refused
 * rather than silently redirected back to loopback. The port is pointedly NOT defaulted: port
 * ownership belongs to the calling tier (standard S-5), not to this helper.
 */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Lowest and highest values a TCP port number may take.
 *
 * Named rather than inlined so the bound this helper enforces is the same one a reader can
 * check against the protocol, and so the two comparisons below cannot drift apart.
 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Default ceiling on the accumulated response body, in bytes (1 MiB).
 *
 * A resource bound, not a protocol limit: the subject's only body is 14 bytes, so this leaves
 * five orders of magnitude of headroom for legitimate use while making runner-memory
 * exhaustion by a hostile or malformed peer impossible. Overridable per call.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 1048576;

/** Upper bound on how much of a body a rejection quotes, so a diagnostic cannot flood CI. */
const DIAGNOSTIC_PREFIX_CHARS = 200;

/**
 * Can the runtime write this value as a request body?
 *
 * Deliberately narrower than the raw-socket helper's test: `OutgoingMessage#write` accepts
 * only a string or a `Uint8Array` (which `Buffer` is), and rejects a `DataView` or any other
 * TypedArray. The check is written with `Object.prototype.toString` rather than `instanceof`
 * so it stays correct across realms - a real concern under a test runner that evaluates test
 * files in their own context. Nothing is coerced: silently stringifying an object would send
 * bytes the caller never asked for.
 *
 * @param {*} value The candidate body.
 * @returns {boolean} True when `value` can be written without the runtime throwing.
 */
function isWritableBody(value) {
  return (
    typeof value === 'string' ||
    (ArrayBuffer.isView(value) &&
      Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

/**
 * Perform one HTTP request and resolve with the parsed response.
 *
 * @param {Object} options                Single object argument; there is no
 *                                        positional variant of this function.
 * @param {number} options.port           REQUIRED, and required to be an
 *                                        integer in 1..65535. Never defaulted
 *                                        here: port ownership is a property of
 *                                        the calling tier, not of this helper
 *                                        (standard S-5). A missing port rejects
 *                                        with a misuse Error; a non-integer,
 *                                        numeric-string, or out-of-range value
 *                                        rejects with a TypeError - both BEFORE
 *                                        a request exists.
 * @param {string} [options.host]         Defaults to the loopback address when
 *                                        OMITTED; a supplied value must be a
 *                                        non-empty string and is then used
 *                                        verbatim. Overridable precisely
 *                                        because the loopback-confinement
 *                                        scenario aims at the host's routable
 *                                        address and expects ECONNREFUSED - a
 *                                        malformed host must therefore fail
 *                                        loudly rather than fall back to
 *                                        loopback and turn that refusal into a
 *                                        200.
 * @param {string} [options.path]         Defaults to '/'.
 * @param {string} [options.method]       Defaults to 'GET'. Passed straight
 *                                        through, so 'HEAD' and any other
 *                                        method work unchanged.
 * @param {Object} [options.headers]      Passed straight through. The key is
 *                                        omitted entirely when not supplied.
 * @param {string|Buffer|Uint8Array} [options.body]
 *                                        Written before the request is ended.
 *                                        Type-checked BEFORE the request is
 *                                        constructed, so an unwritable value
 *                                        rejects without ever creating - and
 *                                        therefore without ever stranding - a
 *                                        request or a socket.
 * @param {number} [options.maxResponseBytes=1048576]
 *                                        Ceiling on the accumulated response
 *                                        body in bytes. On overflow the response
 *                                        and the request are destroyed and the
 *                                        promise rejects with the byte count and
 *                                        a bounded prefix.
 * @returns {Promise<{status: number, headers: Object, body: string}>} Resolves
 *          with exactly three properties: `status` is res.statusCode as a
 *          number; `headers` is res.headers verbatim - Node's lowercase keys
 *          with string values, so content-length arrives as the string '14';
 *          `body` is the accumulated utf8 body, and is '' when there is none
 *          (a HEAD response, for instance). Nothing is added, coerced,
 *          normalised, retried or redirected: the caller sees exactly what the
 *          runtime produced.
 */
function request(options) {
  const opts = options || {};

  return new Promise((resolve, reject) => {
    // A loud misuse alarm beats an obscure socket failure. Every falsy value -
    // undefined, null, '' and 0 - is refused here, because none of them names a
    // connectable destination port.
    if (!opts.port) {
      reject(new Error('httpClient: options.port is required'));
      return;
    }

    // Documented as a number, so a numeric string, a float, a boolean or an
    // out-of-range value is misuse. `http.request` would coerce some of those
    // and refuse others much later - from inside the request, after a socket
    // exists - so the check is made here, where there is still nothing to
    // release. Fail closed: a mistyped port must never be silently repaired
    // into a connectable one.
    if (!Number.isInteger(opts.port) || opts.port < MIN_PORT || opts.port > MAX_PORT) {
      reject(new TypeError(
        'httpClient: options.port must be an integer between ' + MIN_PORT + ' and ' + MAX_PORT
      ));
      return;
    }

    // A host is optional, but a SUPPLIED host must be usable. Without this, an
    // empty string or a non-string would fall through the default below and be
    // replaced by loopback, so a request aimed at another address would quietly
    // succeed against the local server - which is exactly the confusion the
    // loopback-confinement scenario exists to rule out.
    if (opts.host !== undefined && (typeof opts.host !== 'string' || opts.host.length === 0)) {
      reject(new TypeError('httpClient: options.host must be a non-empty string'));
      return;
    }

    // An unwritable body throws ERR_INVALID_ARG_TYPE from `req.write` AFTER
    // `http.request` has already created the request and begun connecting. The
    // rejection is correct, but the request is then neither ended nor destroyed,
    // so the peer keeps a live connection and its `close()` never completes.
    // Checking the type here - before anything is created - means there is
    // nothing to release on this path at all.
    if (opts.body !== undefined && opts.body !== null && !isWritableBody(opts.body)) {
      reject(new TypeError(
        'httpClient: options.body must be a string, Buffer or Uint8Array (nothing is ' +
        'coerced); received ' +
        (typeof opts.body === 'object' ? Object.prototype.toString.call(opts.body)
          : typeof opts.body)
      ));
      return;
    }

    if (opts.maxResponseBytes !== undefined &&
        (!Number.isInteger(opts.maxResponseBytes) || opts.maxResponseBytes <= 0)) {
      reject(new TypeError(
        'httpClient: options.maxResponseBytes must be a positive integer number of bytes'
      ));
      return;
    }

    const maxResponseBytes = opts.maxResponseBytes === undefined
      ? DEFAULT_MAX_RESPONSE_BYTES
      : opts.maxResponseBytes;

    const requestOptions = {
      // Defaulted only when the key is absent, never when it is falsy: a
      // supplied host has already been validated above and is passed through
      // exactly as given.
      host: opts.host === undefined ? DEFAULT_HOST : opts.host,
      port: opts.port,
      path: opts.path || '/',
      method: opts.method || 'GET',
      // Pooling disabled: no client-side keep-alive socket may survive a test.
      // No agent object is constructed and no socket pool is shared between
      // calls.
      agent: false
    };

    // Omit the key entirely rather than handing the runtime an undefined header
    // collection.
    if (opts.headers) {
      requestOptions.headers = opts.headers;
    }

    // `req` is declared before it is assigned so that `fail` - which every
    // failure route goes through - can reach it even from inside the response
    // callback, without the ordering being ambiguous.
    let req = null;
    let settled = false;

    /**
     * THE single failure path. Destroys the request before rejecting, so no
     * abandoned request can hold a server-side connection open, and is
     * idempotent so whichever failure arrives first wins.
     *
     * @param {Error} error The failure to report, passed through unwrapped so
     *   `err.code` stays readable - 'ECONNREFUSED' for a closed port.
     * @returns {void}
     */
    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (req && !req.destroyed) {
        // Destroying with the error keeps the diagnostic attached for anything
        // else observing the request. The re-entrant 'error' this emits is a
        // no-op, because `settled` is already true.
        req.destroy(error);
      }
      reject(error);
    }

    /**
     * THE single success path, guarded so a late event cannot re-settle.
     *
     * @param {{status: number, headers: Object, body: string}} value The parsed response.
     * @returns {void}
     */
    function succeed(value) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    }

    req = http.request(requestOptions, (res) => {
      let body = '';
      let receivedBytes = 0;

      // Set the encoding BEFORE subscribing, so chunks arrive as strings and the
      // accumulator stays a plain string.
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        if (settled) {
          return;
        }

        // Size bound checked BEFORE the chunk is appended, so the accumulator can
        // never exceed the ceiling even momentarily. `Buffer.byteLength` is used
        // because `String#length` counts UTF-16 code units, not bytes.
        receivedBytes += Buffer.byteLength(chunk, 'utf8');
        if (receivedBytes > maxResponseBytes) {
          res.destroy();
          fail(new Error(
            'httpClient: response body exceeded the ' + maxResponseBytes +
            '-byte bound (received ' + receivedBytes + ' bytes: ' +
            JSON.stringify(body.slice(0, DIAGNOSTIC_PREFIX_CHARS)) + ')'
          ));
          return;
        }

        body += chunk;
      });

      res.on('end', () => {
        // Exactly three properties, values untouched, so callers can assert
        // exact numbers, exact header strings and exact byte counts.
        succeed({ status: res.statusCode, headers: res.headers, body: body });
      });

      // A connection destroyed mid-body - the subject terminating without
      // draining, for example - surfaces on the response stream. Reject with the
      // original error instead of letting an unhandled 'error' escape.
      res.on('error', fail);
    });

    // Attached before the request is sent, so a connect or resolution failure
    // cannot escape.
    req.on('error', fail);

    // Wrapped because both calls can throw synchronously on an already-created
    // request, which is exactly how a request gets stranded. Routing them
    // through `fail` destroys that request instead of abandoning it.
    try {
      if (opts.body !== undefined && opts.body !== null) {
        req.write(opts.body);
      }

      req.end();
    } catch (sendError) {
      fail(sendError);
    }
  });
}

/**
 * Positional convenience for the common case: a GET with no headers and no
 * body. Delegates to request(), so pooling is disabled here too.
 *
 * @param {number} port   REQUIRED, as for request().
 * @param {string} [path] Defaults to '/'.
 * @returns {Promise<{status: number, headers: Object, body: string}>} The same
 *          promise request() returns.
 */
function get(port, path) {
  return request({ port: port, path: path || '/', method: 'GET' });
}

module.exports = { request, get };
