import { createServer } from 'http';

/**
 * The loopback half of an OAuth code flow.
 *
 * Dropbox lets a CLI omit `redirect_uri` entirely and shows the user a code to
 * paste back — no listener, no port, nothing running locally. Google used to
 * allow the same thing and
 * [removed it in January 2023](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration)
 * as a phishing risk. For providers that followed suit, a short-lived server on
 * 127.0.0.1 is the only supported route for a desktop app.
 *
 * It lives here rather than in a connector for the reason the whole `authorize`
 * split exists: a connector is a fetch adapter, and one that opens a socket has
 * stopped being one. Microsoft 365 will want exactly this too.
 *
 * Two properties worth stating, because they are the reason this is acceptable
 * at all:
 *
 *   - It binds to 127.0.0.1, not 0.0.0.0, so nothing off this machine can reach
 *     it — not another host on the network, not a container neighbour.
 *   - It lives for one request and one `state` value. The server is closed in a
 *     `finally`, so a timeout, a refusal or a thrown error all still release the
 *     port.
 */

/** Long enough to find the browser window, sign in, and pick an account. */
const DEFAULT_TIMEOUT_MS = 300000;

const page = (title, detail) => `<!doctype html><meta charset="utf-8">
<title>${title}</title>
<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center">
<h1 style="font-size:1.25rem">${title}</h1><p style="color:#555">${detail}</p>`;

/**
 * Start a listener, hand back its redirect URI, and wait for the code.
 *
 * `buildUrl(redirectUri)` is called once the port is known — the provider needs
 * the exact redirect in the authorize URL, and the port is not decided until
 * the socket is bound. Passing port 0 lets the OS pick a free one rather than
 * guessing at a number something else may already hold.
 */
export async function awaitLoopbackCode({
  buildUrl, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, host = '127.0.0.1', port = 0,
} = {}) {
  // Ties the redirect back to the request this process started. Without it, a
  // code delivered by any other page in the user's browser would be accepted.
  const state = `teamctx-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const pending = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const got = url.searchParams.get('state');

    const respond = (status, title, detail) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(title, detail));
    };
    const finish = (status, title, detail, result) => {
      respond(status, title, detail);
      pending.shift()?.(result);
    };

    // The browser asks for /favicon.ico unprompted, and it must not settle the
    // flow: answering it as an authorization would end things before the user
    // had even signed in.
    if (!code && !error) return respond(404, 'Not here', 'Nothing to see.');
    if (got !== state) {
      return finish(400, 'Ignored', 'That response did not come from this login attempt.',
        { error: new Error('the redirect did not match this login attempt (state mismatch)') });
    }
    if (error) {
      return finish(400, 'Login refused', 'You can close this tab.',
        { error: new Error(`the provider refused the login (${error})`) });
    }
    return finish(200, 'Signed in', 'You can close this tab and go back to the terminal.', { code });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

    const redirectUri = `http://${host}:${server.address().port}`;
    log(`\nOpen this and sign in:\n\n  ${buildUrl(redirectUri, state)}\n`);
    log(`Waiting for the browser to come back… (listening on ${redirectUri}, this machine only)\n`);

    const result = await new Promise((resolve, reject) => {
      pending.push(r => (r?.error ? reject(r.error) : resolve(r)));
      setTimeout(() => reject(new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser. `
        + 'Run the command again if you need longer.')), timeoutMs).unref?.();
    });

    return { code: result.code, redirectUri };
  } finally {
    // A refusal, a timeout and a thrown error all have to release the port.
    server.close();
  }
}
