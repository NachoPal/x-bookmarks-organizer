import http from 'node:http';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { TwitterApi } from 'twitter-api-v2';
import type { Config } from '../config';
import type { Database } from '../db/database';
import { TwitterApiXClient } from './client';

/** Scopes required: read bookmarks + tweets + users, and refresh headlessly. */
const SCOPES = ['bookmark.read', 'tweet.read', 'users.read', 'offline.access'];

/** Best-effort open of a URL in the user's default browser. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.unref();
  } catch {
    // Non-fatal: the URL is also printed to the console for manual opening.
  }
}

/**
 * One-time interactive OAuth 2.0 Authorization Code + PKCE login.
 *
 * Opens the browser to X's consent screen, listens on the local callback port
 * for the redirect, exchanges the code, and persists the rotating refresh token
 * in the local DB so all later runs are headless.
 */
export async function login(config: Config, db: Database): Promise<void> {
  const app = new TwitterApi({ clientId: config.xClientId, clientSecret: config.xClientSecret });
  const { url, codeVerifier, state } = app.generateOAuth2AuthLink(config.redirectUri, {
    scope: SCOPES,
  });

  const code = await waitForCallback(config, state, url);
  const { refreshToken } = await app.loginWithOAuth2({
    code,
    codeVerifier,
    redirectUri: config.redirectUri,
  });

  if (!refreshToken) {
    throw new Error(
      'X did not return a refresh token. Ensure the "offline.access" scope is enabled and the app is configured as a confidential client.',
    );
  }
  db.setRefreshToken(refreshToken);
}

/** Run the local callback server, open the browser, and resolve with the code. */
function waitForCallback(config: Config, expectedState: string, authUrl: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const requestUrl = new URL(req.url, `http://127.0.0.1:${config.authCallbackPort}`);
      if (requestUrl.pathname !== new URL(config.redirectUri).pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      const respond = (message: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:2rem">
          <h2>${message}</h2><p>You can close this tab and return to X Bookmarks Organizer.</p></body>`);
      };
      if (state !== expectedState) {
        respond('Login failed: state mismatch.');
        server.close();
        reject(new Error('OAuth state mismatch - possible CSRF, aborting.'));
        return;
      }
      if (!code) {
        respond('Login failed: no authorization code.');
        server.close();
        reject(new Error('No authorization code returned by X.'));
        return;
      }
      respond('Login complete.');
      server.close();
      resolve(code);
    });

    server.on('error', reject);
    server.listen(config.authCallbackPort, '127.0.0.1', () => {
      console.log('Opening browser for X authorization...');
      console.log(`If it does not open automatically, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });
  });
}

/**
 * Build a headless, authenticated X client using the stored refresh token.
 * Rotates and persists the new refresh token that X returns on each refresh.
 * Throws with guidance if no token is stored yet.
 */
export async function getAuthenticatedClient(config: Config, db: Database): Promise<TwitterApiXClient> {
  const refreshToken = db.getRefreshToken();
  if (!refreshToken) {
    throw new Error('Not logged in to X yet. Run the one-time login first:\n  node dist/index.js login');
  }

  const app = new TwitterApi({ clientId: config.xClientId, clientSecret: config.xClientSecret });
  const { client, refreshToken: newRefreshToken } = await app.refreshOAuth2Token(refreshToken);
  if (newRefreshToken) db.setRefreshToken(newRefreshToken);

  const me = await client.v2.me();
  return new TwitterApiXClient(client, me.data.id);
}
