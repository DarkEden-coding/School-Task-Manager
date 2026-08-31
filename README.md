# School Manager

A single-user, local web application for classes, assignments, and reviewed
Gmail-to-Google Calendar changes. It tracks terms, class details, due work,
warning periods, pasted text, and screenshot imports. The service stays bound
to loopback by default, and consequential model-proposed changes require review.

## Linux quick start

Requirements: a systemd Linux host, Node.js **22.13+**, npm, and a checked-out
release containing `package-lock.json`. Install from the checkout:

```sh
sudo ./scripts/install-linux.sh
sudo systemctl status email-event-manager
journalctl -u email-event-manager -f
```

The installer builds a production release in `/opt/email-event-manager`, creates
the locked-down `email-event-manager` system user, and keeps mutable state in
`/var/lib/email-event-manager`. It creates (but never overwrites)
`/etc/email-event-manager/environment`. The service listens at
`http://127.0.0.1:8787` unless that file overrides the port. Open that URL in a
browser on the host.

For the complete production guide—including OAuth, first scan review, Tailscale,
updates, recovery, backups, security, and uninstall—see
[docs/linux-install.md](docs/linux-install.md).

## What you need before connecting

- A Google Cloud **Web application** OAuth client. Its authorized redirect URI
  must be `http://127.0.0.1:8787/api/google/callback` (change only the port
  if you intentionally changed `EMAIL_MANAGER_PORT`).
- Gmail readonly access and Calendar access needed to create/update reviewed
  events. The app requests `https://www.googleapis.com/auth/gmail.readonly`,
  `https://www.googleapis.com/auth/calendar.readonly`, and
  `https://www.googleapis.com/auth/calendar.events`.
- An OpenAI ChatGPT Plus account to authorize through the app's pinned
  `@earendil-works/pi-ai` subscription provider. This is subscription OAuth;
  it is not a generic OpenAI Platform API-key or Platform-billing setup.

Never expose this loopback-only service directly to the public Internet.
