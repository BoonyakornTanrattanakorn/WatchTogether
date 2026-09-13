// Server-rendered auth pages: login, register, setup, and the two holding
// pages (awaiting approval, access denied).
//
// Deliberately separate from watch.html. An unauthenticated visitor never
// receives the player source at all, and these pages stay small enough to read
// in one screen.

const SHELL = (title, body, { wide = false } = {}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --bg: #0b0b0d;
    --surface: #151519;
    --line: #26262c;
    --text: #e8e8ea;
    --dim: #8b8b94;
    --accent: #5b8cff;
    --bad: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main {
    width: 100%;
    max-width: ${wide ? '420px' : '340px'};
  }
  h1 {
    margin: 0 0 4px;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  p.sub {
    margin: 0 0 22px;
    color: var(--dim);
    font-size: 13.5px;
  }
  form { display: grid; gap: 12px; }
  label { display: grid; gap: 6px; font-size: 12.5px; color: var(--dim); }
  input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    transition: border-color 140ms ease;
  }
  input:focus { outline: none; border-color: var(--accent); }
  button {
    margin-top: 4px;
    padding: 10px 12px;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-weight: 550;
    cursor: pointer;
    transition: filter 140ms ease;
  }
  button:hover { filter: brightness(1.08); }
  .err {
    margin: 0 0 16px;
    padding: 9px 12px;
    border: 1px solid #4a2020;
    border-radius: 8px;
    background: #2a1414;
    color: var(--bad);
    font-size: 13px;
  }
  .note {
    margin: 18px 0 0;
    color: var(--dim);
    font-size: 12.5px;
    text-align: center;
  }
  .note a { color: var(--accent); text-decoration: none; }
  .note a:hover { text-decoration: underline; }
  .status {
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    text-align: center;
  }
  .status strong { display: block; margin-bottom: 6px; font-weight: 600; }
  .status span { color: var(--dim); font-size: 13.5px; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

const err = (m) => (m ? `<p class="err">${escapeHtml(m)}</p>` : '');

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// First run: no admin exists yet. Guarded by SETUP_TOKEN so that whoever finds
// the hostname first cannot claim the admin account.
function setup({ error, needsToken } = {}) {
  return SHELL(
    'Set up',
    `<h1>Set up your admin account</h1>
<p class="sub">This is the first run. Choose the account that will control playback.</p>
${err(error)}
<form method="POST" action="/setup">
  ${
    needsToken
      ? `<label>Setup token
    <input name="token" type="password" autocomplete="off" required>
  </label>`
      : ''
  }
  <label>Username
    <input name="username" autocomplete="username" required autofocus maxlength="24">
  </label>
  <label>Password
    <input name="password" type="password" autocomplete="new-password" required minlength="8">
  </label>
  <label>Confirm password
    <input name="confirm" type="password" autocomplete="new-password" required minlength="8">
  </label>
  <button type="submit">Create admin account</button>
</form>`
  );
}

function login({ error, registrationOpen } = {}) {
  return SHELL(
    'Sign in',
    `<h1>Sign in</h1>
<p class="sub">You need an account to watch.</p>
${err(error)}
<form method="POST" action="/login">
  <label>Username
    <input name="username" autocomplete="username" required autofocus maxlength="24">
  </label>
  <label>Password
    <input name="password" type="password" autocomplete="current-password" required>
  </label>
  <button type="submit">Sign in</button>
</form>
${registrationOpen ? '<p class="note">No account? <a href="/register">Request access</a></p>' : ''}`
  );
}

function register({ error, invite } = {}) {
  // Arriving from an invite link: the code is already filled in, so the first
  // thing to type is the username. Typing the code by hand still works.
  const code = String(invite || '');
  const prefilled = !!code;
  return SHELL(
    'Request access',
    `<h1>Request access</h1>
<p class="sub">${
      prefilled
        ? 'Your invite is filled in below. Pick a username and password — an admin approves new accounts before they can watch.'
        : "You'll need an invite code. An admin approves new accounts before they can watch."
    }</p>
${err(error)}
<form method="POST" action="/register">
  <label>Invite code
    <input name="invite" autocomplete="off" required maxlength="16"${
      prefilled ? ` value="${escapeHtml(code)}"` : ' autofocus'
    }>
  </label>
  <label>Username
    <input name="username" autocomplete="username" required maxlength="24"${
      prefilled ? ' autofocus' : ''
    }>
  </label>
  <label>Password
    <input name="password" type="password" autocomplete="new-password" required minlength="8">
  </label>
  <label>Confirm password
    <input name="confirm" type="password" autocomplete="new-password" required minlength="8">
  </label>
  <button type="submit">Request access</button>
</form>
<p class="note">Already have an account? <a href="/login">Sign in</a></p>`
  );
}

function pending() {
  return SHELL(
    'Awaiting approval',
    `<div class="status">
  <strong>Waiting for approval</strong>
  <span>An admin needs to approve your account before you can watch. This page will not update on its own &mdash; check back shortly.</span>
</div>
<p class="note"><a href="/logout">Sign out</a></p>`
  );
}

function denied() {
  return SHELL(
    'Access denied',
    `<div class="status">
  <strong>Access denied</strong>
  <span>This account cannot watch. If you think that's a mistake, ask the admin.</span>
</div>
<p class="note"><a href="/logout">Sign out</a></p>`
  );
}

module.exports = { setup, login, register, pending, denied, escapeHtml };
