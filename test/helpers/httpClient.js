'use strict';

/**
 * Promise wrapper over the core HTTP request API, pooling DISABLED. Serves the
 * end-to-end tiers (bootstrap, lifecycle) where a PARSED response is wanted - a
 * status code, a header map, a body string - or where a refusal must surface as
 * a rejection; raw byte exchanges belong to the sibling helper rawExchange.js.
 *
 * Surface: request({ port, host, path, method, headers, body }) and
 * get(port, path), each resolving exactly { status, headers, body }; only
 * `port` is required, and every option is detailed on the functions below.
 *
 * `agent: false` is mandatory on every request and is the point of this file: no
 * client-side keep-alive socket may survive a test (S-3). MEASURED consequence -
 * responses carry `connection: close` and only FOUR header keys (connection,
 * content-length, content-type, date), `keep-alive` ABSENT - so this helper is
 * NOT suitable for asserting the five-key HEADER_KEYS set in
 * test/fixtures/expected.js; that belongs to the L2 supertest contract tier, and
 * the fixture must never be repaired by deleting 'keep-alive'.
 *
 * A closed port rejects with the ORIGINAL, unwrapped Error, so err.code reads
 * 'ECONNREFUSED'. No timers are created here - the promise settles on the
 * response 'end' and 'error' events - so there is no handle to leak (S-2, S-3).
 */

const http = require('http');

/**
 * Perform one HTTP request and resolve with the parsed response.
 *
 * @param {Object} options                Single object argument; there is no
 *                                        positional variant of this function.
 * @param {number} options.port           REQUIRED. Never defaulted here: port
 *                                        ownership is a property of the calling
 *                                        tier, not of this helper (standard
 *                                        S-5). A missing port rejects with a
 *                                        clear misuse Error.
 * @param {string} [options.host]         Defaults to the loopback address.
 *                                        Overridable, because the loopback
 *                                        confinement scenario aims at the
 *                                        host's routable address and expects
 *                                        ECONNREFUSED.
 * @param {string} [options.path]         Defaults to '/'.
 * @param {string} [options.method]       Defaults to 'GET'. Passed straight
 *                                        through, so 'HEAD' and any other
 *                                        method work unchanged.
 * @param {Object} [options.headers]      Passed straight through. The key is
 *                                        omitted entirely when not supplied.
 * @param {string|Buffer} [options.body]  Written before the request is ended.
 * @returns {Promise<{status: number, headers: Object, body: string}>} Resolves
 *          with exactly three properties: `status` is res.statusCode as a
 *          number; `headers` is res.headers verbatim - Node's lowercase keys
 *          with string values, so content-length arrives as the string '14';
 *          `body` is the accumulated utf8 body, and is '' when there is none
 *          (a HEAD response, for instance). Nothing is added, coerced,
 *          normalised, retried or redirected: the caller sees exactly what the
 *          runtime produced (standard S-11).
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

    const requestOptions = {
      host: opts.host || '127.0.0.1',
      port: opts.port,
      path: opts.path || '/',
      method: opts.method || 'GET',
      // Pooling disabled: no client-side keep-alive socket may survive a test
      // (standard S-3). No agent object is constructed and no socket pool is
      // shared between calls.
      agent: false
    };

    // Omit the key entirely rather than handing the runtime an undefined header
    // collection.
    if (opts.headers) {
      requestOptions.headers = opts.headers;
    }

    const req = http.request(requestOptions, (res) => {
      let body = '';

      // Set the encoding BEFORE subscribing, so chunks arrive as strings and the
      // accumulator stays a plain string.
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        // Exactly three properties, values untouched, so callers can assert
        // exact numbers, exact header strings and exact byte counts (S-6).
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });

      // A connection destroyed mid-body - the subject terminating without
      // draining, for example - surfaces on the response stream. Reject with the
      // original error instead of letting an unhandled 'error' escape.
      res.on('error', reject);
    });

    // Attached before the request is sent, so a connect or resolution failure
    // cannot escape. The original Error is passed through unwrapped, which is
    // what keeps err.code readable - 'ECONNREFUSED' for a closed port (S-11).
    req.on('error', reject);

    if (opts.body !== undefined && opts.body !== null) {
      req.write(opts.body);
    }

    req.end();
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
