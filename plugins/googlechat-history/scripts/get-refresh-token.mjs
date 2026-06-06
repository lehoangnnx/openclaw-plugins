#!/usr/bin/env node
// One-time consent helper: obtain a Google OAuth refresh token to read Google
// Chat as YOUR OWN user (user authentication). This needs NO Workspace-admin
// approval when the OAuth consent screen is an "Internal" app in your org.
//
// Prereqs (Google Cloud Console, all doable by a non-admin user):
//   1. OAuth consent screen -> User type = Internal -> add scope
//      https://www.googleapis.com/auth/chat.messages.readonly
//   2. Credentials -> Create OAuth client ID -> Application type = Desktop app
//      -> copy the Client ID + Client secret.
//
// Run (from this plugin directory):
//   GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com \
//   GOOGLE_OAUTH_CLIENT_SECRET=yyy \
//   node scripts/get-refresh-token.mjs
//
// Open the printed URL, sign in as YOURSELF (a member of the spaces), approve.
// The refresh_token prints to the terminal. Store it as a secret; never commit it.

import http from "node:http";
import { OAuth2Client } from "google-auth-library";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const scope = process.env.GOOGLE_OAUTH_SCOPE || "https://www.googleapis.com/auth/chat.messages.readonly";
const port = Number(process.env.PORT || 53682);

if (!clientId || !clientSecret) {
  console.error(
    "Missing credentials. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET\n" +
      "from your Desktop OAuth client (Google Cloud Console -> Credentials).",
  );
  process.exit(1);
}

const redirectUri = `http://localhost:${port}`;
const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });

const authUrl = oauth.generateAuthUrl({
  access_type: "offline", // request a refresh token
  prompt: "consent", // force a refresh token even on re-consent
  scope: [scope],
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    res.end(`OAuth error: ${error}. Return to the terminal.`);
    console.error(`\nOAuth error: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    // Ignore favicon / unrelated hits while waiting for the real redirect.
    res.end("Waiting for the OAuth redirect...");
    return;
  }

  try {
    const { tokens } = await oauth.getToken(code);
    res.end("Done. You can close this tab and return to the terminal.");
    server.close();

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token returned. Revoke the app's prior access at\n" +
          "https://myaccount.google.com/permissions and run again (prompt=consent forces a new one).",
      );
      process.exit(1);
    }

    console.log("\n=== SUCCESS ===");
    console.log("refresh_token:\n" + tokens.refresh_token);
    console.log("\nStore the three values as Fly secrets (do NOT commit them), e.g.:");
    console.log("  fly secrets set \\");
    console.log("    GOOGLE_CHAT_OAUTH_CLIENT_ID='" + clientId + "' \\");
    console.log("    GOOGLE_CHAT_OAUTH_CLIENT_SECRET='<client-secret>' \\");
    console.log("    GOOGLE_CHAT_OAUTH_REFRESH_TOKEN='<the token above>' \\");
    console.log("    -a openclaw-lehoang");
    process.exit(0);
  } catch (err) {
    res.end("Token exchange failed. Check the terminal.");
    console.error("\nToken exchange failed:", err);
    server.close();
    process.exit(1);
  }
});

server.listen(port, () => {
  console.log("\n1) Open this URL in your browser and sign in as YOURSELF");
  console.log("   (the account that is a member of the Google Chat spaces):\n");
  console.log(authUrl + "\n");
  console.log(`2) After you approve, Google redirects to ${redirectUri} and the`);
  console.log("   refresh token prints here.\n");
  console.log(`Listening on ${redirectUri} ...`);
});
