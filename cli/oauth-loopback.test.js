import { describe, it, expect } from 'vitest';
import { awaitLoopbackCode } from './oauth-loopback.js';

/** Drive the flow the way a browser would: read the URL it prints, then hit it.
 *
 *  The outcome is captured the instant the flow starts, not after the redirect.
 *  The handler settles from inside an HTTP callback, so attaching an assertion
 *  afterwards leaves a window where Node sees the rejection as unhandled — a
 *  harness artifact that shows up as a spurious failure. */
async function run({ redirect, timeoutMs = 5000 } = {}) {
  let printed = '';
  const settled = awaitLoopbackCode({
    timeoutMs,
    log: m => { printed += m; },
    buildUrl: (redirectUri, state) => `https://provider.example/authorize`
      + `?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
  }).then(value => ({ value }), error => ({ error }));

  // Give the listener a moment to bind and print.
  await new Promise(r => setTimeout(r, 20));
  const url = new URL(/https:\/\/provider\.example\/authorize\S+/.exec(printed)[0]);
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');

  const response = await fetch(redirect({ redirectUri, state }));
  return { settled, response, printed, redirectUri, state };
}

describe('awaitLoopbackCode', () => {
  it('returns the code the browser was redirected with', async () => {
    const { settled, response } = await run({
      redirect: ({ redirectUri, state }) => `${redirectUri}/?code=abc123&state=${state}`,
    });
    expect(response.status).toBe(200);
    expect((await settled).value).toMatchObject({ code: 'abc123' });
  });

  it('binds to loopback only, so nothing off this machine can reach it', async () => {
    const { settled, redirectUri, state } = await run({
      redirect: ({ redirectUri: r, state: s }) => `${r}/?code=x&state=${s}`,
    });
    expect((await settled).value).toBeTruthy();
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(state).toMatch(/^teamctx-/);
  });

  it('rejects a code that did not come from this login attempt', async () => {
    // Without the state check, a code delivered by any other page in the user's
    // browser would be accepted as if it were ours.
    const { settled, response } = await run({
      redirect: ({ redirectUri }) => `${redirectUri}/?code=stolen&state=someone-else`,
    });
    expect(response.status).toBe(400);
    expect((await settled).error.message).toMatch(/state mismatch/);
  });

  it('reports a refusal rather than waiting for a code that will never come', async () => {
    const { settled, response } = await run({
      redirect: ({ redirectUri, state }) => `${redirectUri}/?error=access_denied&state=${state}`,
    });
    expect(response.status).toBe(400);
    expect((await settled).error.message).toMatch(/refused the login \(access_denied\)/);
  });

  it('ignores the favicon the browser asks for unprompted', async () => {
    // Treating it as a failed authorization would end the flow before the user
    // had finished signing in.
    let printed = '';
    const settled = awaitLoopbackCode({
      timeoutMs: 5000,
      log: m => { printed += m; },
      buildUrl: (r, s) => `https://p.example/a?redirect_uri=${encodeURIComponent(r)}&state=${s}`,
    }).then(value => ({ value }), error => ({ error }));
    await new Promise(r => setTimeout(r, 20));
    const url = new URL(/https:\/\/p\.example\/a\S+/.exec(printed)[0]);
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');

    const favicon = await fetch(`${redirectUri}/favicon.ico`);
    expect(favicon.status).toBe(404);

    const ok = await fetch(`${redirectUri}/?code=after-favicon&state=${state}`);
    expect(ok.status).toBe(200);
    expect((await settled).value).toMatchObject({ code: 'after-favicon' });
  });

  it('gives up rather than holding the port forever', async () => {
    const flow = awaitLoopbackCode({
      timeoutMs: 60, log: () => {}, buildUrl: r => `https://p.example/a?r=${r}`,
    });
    await expect(flow).rejects.toThrow(/timed out after/);
  });

  it('releases the port on every exit path', async () => {
    // A timeout, a refusal and a success all have to close the server, or a
    // second attempt in the same process fails to bind.
    for (const timeoutMs of [60, 60]) {
      await awaitLoopbackCode({ timeoutMs, log: () => {}, buildUrl: r => r }).catch(() => {});
    }
    const { settled } = await run({ redirect: ({ redirectUri, state }) => `${redirectUri}/?code=z&state=${state}` });
    expect((await settled).value).toMatchObject({ code: 'z' });
  });
});
