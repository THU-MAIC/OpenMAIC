import http from 'node:http';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { createHmac } from 'node:crypto';

/** One authorized TCP connection carried by the host's SDK channel, without app-facing credentials. */
export function previewAgent({ backend, gatewayKey, ticket, host }) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = (_options, callback) => {
    const url = new URL('/api/sandbox/preview/tunnel', backend);
    const descriptor = JSON.stringify({ ticket, host });
    const at = String(Date.now());
    const auth =
      at +
      '.' +
      createHmac('sha256', gatewayKey)
        .update(at + '.' + descriptor)
        .digest('hex');
    let request;
    let response;
    let connected = false;
    const socket = new Duplex({
      read() {
        response?.resume();
      },
      write(chunk, _encoding, done) {
        if (!request || request.destroyed) {
          done(new Error('Preview disconnected.'));
          return;
        }
        request.write(chunk, done);
      },
      final(done) {
        request?.end();
        done();
      },
      destroy(error, done) {
        request?.destroy();
        response?.destroy();
        done(error);
      },
    });
    socket.setNoDelay = () => socket;
    socket.setKeepAlive = () => socket;
    socket.setTimeout = (ms, listener) => {
      if (listener) socket.once('timeout', listener);
      request?.setTimeout(ms, () => socket.emit('timeout'));
      return socket;
    };
    const fail = (status) => {
      if (!connected) {
        connected = true;
        const error = new Error('Preview transport unavailable.');
        if (status === 429) error.statusCode = 429;
        callback(error);
      }
      socket.destroy();
    };
    request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-openmaic-preview-request': descriptor,
          'x-openmaic-preview-gateway': auth,
        },
        timeout: 30000,
      },
      (incoming) => {
        response = incoming;
        if (incoming.statusCode !== 200) {
          incoming.resume();
          fail(incoming.statusCode);
          return;
        }
        let first = true;
        incoming.on('data', (chunk) => {
          if (first) {
            first = false;
            if (chunk[0] !== 1) {
              fail();
              return;
            }
            chunk = chunk.subarray(1);
            connected = true;
            callback(null, socket);
          }
          if (chunk.length && !socket.push(chunk)) incoming.pause();
        });
        incoming.on('end', () => {
          if (!connected) fail();
          else socket.push(null);
        });
        incoming.on('error', fail);
        incoming.on('aborted', fail);
      },
    );
    request.on('error', fail);
    request.on('timeout', fail);
    request.flushHeaders();
    return undefined;
  };
  return agent;
}
