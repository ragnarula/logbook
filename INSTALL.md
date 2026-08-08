# Installing Logbook

Logbook runs as a single small container with one SQLite file on a persistent
disk. These instructions deploy it to [Fly.io](https://fly.io), which is how the
author runs it.

## What you need

- A Fly.io account with a payment method. Logbook is small, so expect a low
  single-digit monthly cost: a 1GB volume plus a machine that stops while idle.
- `flyctl`, signed in:

  ```sh
  curl -L https://fly.io/install.sh | sh
  fly auth login
  ```

## Deploy

```sh
git clone git@github.com:ragnarula/logbook.git
cd logbook
./install.sh
```

The script asks for an app name, then creates the app, a 1GB encrypted volume
with daily snapshots, and a sign-in passcode, and deploys. It prints the URL and
the passcode at the end.

Non-interactive:

```sh
./install.sh --app my-logbook --region lhr --yes
```

Run `./install.sh --help` for the full list of options.

**Save the passcode.** It is stored as a Fly secret, which you cannot read back.
To change it later:

```sh
fly secrets set LOGBOOK_PASSCODE='new-passcode' --app my-logbook
```

## Using it on a phone

Open the URL, sign in, then use the browser's share menu and choose **Add to
Home Screen**. After that it opens like an app and works with no network.

## Your own domain

```sh
./install.sh --app my-logbook --domain logbook.example.com
```

The script prints the DNS record to add at your provider. Add it, and Fly issues
the certificate on its own. Use the CNAME record rather than the A and AAAA
records Fly suggests: the IPv4 address is shared between Fly apps and can
change, while the CNAME target is stable.

Check progress with `fly certs check logbook.example.com --app my-logbook`.

## Updating

Pull the latest code and run the script again:

```sh
git pull
./install.sh --app my-logbook --yes
```

Re-running reuses the existing app and volume, so **your data is not touched**.
Passing `--passcode` changes the passcode; leaving it out generates a new one,
so pass the one you already use if you want it kept.

## One deployment, one household

Logbook has no user accounts. One deployment holds one set of projects, and
everyone who knows the passcode sees the same data. That is the intended shape:
two parents share one deployment. For a second household, run the script again
with a different app name.

## Backups

Fly takes daily snapshots of the volume and keeps them for five days. That is
the recovery window: if you delete something and do not notice within five days,
the snapshot holding it is gone.

You can also export any project as CSV from the app, under **History → Export
CSV**, which gives you a copy that does not depend on Fly.

## Without Fly

The repository includes a `compose.yml` for running it under Docker Compose
instead. It expects an external network and a data path, so read it and adjust
before using it — the Fly path is the one that is tested.
