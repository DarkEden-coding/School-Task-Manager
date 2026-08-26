# Linux installation and operations

This guide installs one trusted user's Email Event Manager on a systemd Linux
host. The service is intentionally local-only: it runs as the unprivileged
`email-event-manager` user, has application files in `/opt/email-event-manager`,
and keeps durable state (database, OAuth tokens, sessions, and settings) in
`/var/lib/email-event-manager`.

## 1. Prepare the host

Install Node.js **22.13 or newer** and npm using your distribution's supported
Node 22 package source. Confirm `node --version` reports v22 or later. Check out
a release on the host; do not use an untrusted writable checkout for deployment.

Run the native installer from that checkout:

```sh
sudo ./scripts/install-linux.sh
sudo systemctl is-enabled email-event-manager
sudo systemctl status email-event-manager
```

The installer uses `npm ci`, builds before replacing the live release, prunes
development dependencies, creates a no-login system user, enables the service,
and preserves existing state and `/etc/email-event-manager/environment`. A build
failure leaves the currently running release and state intact. Use `--no-start`
to install without starting it, or `--source /path/to/checkout` when launching
the script from elsewhere.

The systemd unit sets `EMAIL_MANAGER_HOST` to `127.0.0.1`, `EMAIL_MANAGER_PORT` to
`8787`, and `EMAIL_MANAGER_STATE_DIR` to `/var/lib/email-event-manager`. Deployment-specific
overrides can be put in `/etc/email-event-manager/environment` (owned
`root:email-event-manager`, mode 0640), then applied with:

```sh
sudo systemctl restart email-event-manager
```

Keep the binding on `127.0.0.1`. Do not change it to `0.0.0.0` as a shortcut for
remote access.

## 2. Configure Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), select or create
   a project and configure the OAuth consent screen. Add yourself as a test user
   while the app is in testing, if applicable.
2. Under **APIs & Services → Library**, enable **Gmail API** and **Google Calendar
   API** for that project.
3. Under **Credentials**, create an OAuth 2.0 Client ID of type **Web
   application**. Do not create a Desktop client for this service.
4. Add this exact **Authorized redirect URI**:

   ```text
   http://127.0.0.1:8787/api/google/callback
   ```

   If you deliberately override the local port, use that same port in the URI.
   The hostname must remain `127.0.0.1`; `localhost` is a different redirect URI
   registration.
5. Open `http://127.0.0.1:8787` on the host and enter/connect the Google client
   as prompted by the app. Complete consent with the Google account whose Gmail
   and Calendar are to be used.

The required Google permissions are
`https://www.googleapis.com/auth/gmail.readonly` for read-only mail access,
`https://www.googleapis.com/auth/calendar.readonly` to list calendars, and
`https://www.googleapis.com/auth/calendar.events` to apply only the Calendar
changes you approve. Review the consent screen carefully. If your
organization restricts OAuth apps, have an administrator approve the client and
scopes.

## 3. Connect ChatGPT Plus and choose processing settings

At first launch, set a unique password of at least 12 characters in the setup
screen before connecting accounts. This is the single-user application's login;
store it in a password manager.

From the app's setup/settings screen, select **Connect ChatGPT/OpenAI** and
complete the browser OAuth flow using the same account that has ChatGPT Plus.
The application uses its pinned `@earendil-works/pi-ai` subscription provider.
This is not an OpenAI Platform API-key integration and does **not** imply generic
Platform API billing; manage the applicable ChatGPT subscription separately.

After authorization, choose a listed model and its supported reasoning level in
the app. Start with a lower or medium reasoning setting for routine mail, then
raise it only when the quality benefit justifies it. The available models and
reasoning choices come from the authorized subscription; do not assume every
model supports every level.

## 4. First scan and normal operation

Choose the Gmail labels/folders, target Calendar, timezone, interests/filter
rules, and scan schedule in the app. The initial scan first counts eligible
messages and asks for confirmation. Verify the count, selected labels, and date
scope before confirming—this is the opportunity to avoid processing an unwanted
mail archive.

During normal operation:

- Inspect every proposed event, including dates, timezone, attendees/links, and
  source excerpt.
- Approve, edit, or deny proposals. Calendar writes happen only for approved
  proposals.
- Use the dashboard for queue state, last scan, and errors; use
  `journalctl -u email-event-manager -f` for service diagnostics.
- Pause scanning before changing broad filters or investigating a problem. A
  manual scan should still be reviewed like the first scan.

## Local and remote access

On the host, browse to `http://127.0.0.1:8787`. From another machine, use SSH
port forwarding instead of exposing the port:

```sh
ssh -L 3000:127.0.0.1:8787 user@server
```

Then browse to `http://127.0.0.1:8787` on the client machine. Optionally, a user
who manages their own Tailscale network may provide access through a Tailscale
Serve configuration that proxies to `http://127.0.0.1:8787`. Keep the app bound
to loopback, restrict the Tailnet ACL to the intended user/device, use HTTPS
provided by Tailscale, and understand that Tailscale configuration is your
responsibility. Do not use Tailscale Funnel or public reverse proxies for this
single-user service.

## Updates, backup, and recovery

Before an update, pause scans and make a state backup. A consistent simple backup
is to stop the service, archive state, then start it again:

```sh
sudo systemctl stop email-event-manager
sudo tar -C /var/lib -czf /root/email-event-manager-state-$(date +%F).tgz email-event-manager
sudo systemctl start email-event-manager
```

Protect that archive like a password: it can contain OAuth credentials and
private email-derived data. Keep encrypted, access-controlled backups and test a
restore on a separate host. To update, check out the intended version and rerun:

```sh
sudo ./scripts/install-linux.sh
```

The installer replaces only `/opt/email-event-manager`; it retains state and the
environment file. Roll back code by checking out the prior trusted version and
rerunning it. Restore state only while the service is stopped, preserving owner
`email-event-manager:email-event-manager` and mode 0700 on the state directory.

If Google or ChatGPT authorization fails, pause scans, use the app's disconnect/
reconnect control, and reauthorize. If that cannot be done, stop the service and
back up state before removing only the affected credentials through the app's
recovery instructions or restoring a known-good state backup. Do not casually
delete `/var/lib/email-event-manager`: doing so loses settings, review history,
sessions, and stored connections. After recovery, confirm labels/calendar/model
and perform the first-scan confirmation again.

## Security checklist

- Keep the service loopback-bound and use SSH forwarding or restricted,
  user-managed Tailscale for remote access.
- Restrict host login, apply OS/Node security updates, and review service logs.
- Keep `/etc/email-event-manager/environment` and state backups private; never
  commit credentials, tokens, or client secrets.
- Grant the minimum Google access, use the intended Google account/calendar, and
  revoke the OAuth grant in Google Account security settings if the host is lost.
- Treat approved calendar changes and model output as user-reviewed work, not
  automatically trustworthy instructions.

## Uninstall

Stop and remove the service and installed program:

```sh
sudo systemctl disable --now email-event-manager
sudo rm -f /etc/systemd/system/email-event-manager.service
sudo systemctl daemon-reload
sudo rm -rf /opt/email-event-manager
```

This intentionally **does not delete** `/var/lib/email-event-manager` or
`/etc/email-event-manager/environment`. Keep them for recovery, or back them up
before deliberate permanent deletion. If you truly intend to erase all local
credentials and history, stop the service first, remove those two paths, then
optionally remove the `email-event-manager` system user and group after verifying
nothing else uses them.
