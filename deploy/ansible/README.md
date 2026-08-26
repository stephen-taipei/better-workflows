# Better Workflows frontend deployment

This is a static-only deployment for `betterworkflows.dev` with
`betterworkflows.org` as the canonical redirect alias. It follows the release
layout used by the reference frontend projects:

```text
/var/www/betterworkflows.dev/
├── current -> releases/<release-id>
├── releases/<release-id>/
└── shared/
```

The playbook is deliberately narrow. It creates or updates only:

- `/var/www/betterworkflows.dev/**`
- `/etc/nginx/betterworkflows/nginx.conf`
- `/etc/systemd/system/betterworkflows-nginx.service`
- `/run/betterworkflows-nginx/**`
- `/var/log/nginx/betterworkflows/**`
- this project's own certificate renewal profile and deploy hook

It does not create or edit shared `sites-available`, `sites-enabled`,
`conf.d`, the host-level `nginx.conf`, or `nginx.service`. The legacy shared
Nginx playbook is intentionally absent from this repository.

## Isolated project origin

If an unrelated host-level vhost prevents the shared `nginx.service` from
starting, `isolated-ingress.yml` runs this site in a separate Nginx process.
It is intentionally limited to these additional project-owned resources:

- `/etc/nginx/betterworkflows/nginx.conf`
- `/etc/systemd/system/betterworkflows-nginx.service`
- `/run/betterworkflows-nginx/`
- `/var/log/nginx/betterworkflows/`
- TCP 8443 for HTTPS origin traffic and TCP 8880 for HTTP origin traffic

The process does not include `/etc/nginx/nginx.conf`, `conf.d`, or
`sites-enabled`; it therefore cannot load or mutate another project's vhost.
Origin access is limited to localhost and Cloudflare's published proxy
networks. The playbook validates only this isolated config, starts only
`betterworkflows-nginx.service`, and performs local health, redirect, and
release-receipt probes. When the host's UFW firewall is already active, it
also adds only source-CIDR-scoped TCP rules from Cloudflare's published proxy
networks to ports 8443 and 8880. It refuses to enable, disable, reset, or alter
the global firewall state:

```sh
ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/isolated-ingress.yml
```

The isolated HTTP origin serves `/.well-known/acme-challenge/` from
`/var/www/betterworkflows.dev/shared/letsencrypt` before applying the HTTPS
redirect. The playbook changes only `betterworkflows.dev`'s renewal profile
from `standalone` to `webroot` and installs a certificate-specific deploy hook
that reloads only `betterworkflows-nginx.service`. Prove the complete renewal
path against Let's Encrypt staging after changing ingress or certificate
configuration:

```sh
ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/isolated-ingress.yml \
  -e frontend_certbot_dry_run=true
```

With proxied DNS enabled, add apex-hostname-scoped Cloudflare Origin Rules in
each domain's zone: HTTPS requests route to origin port 8443 and HTTP requests
route to origin port 8880. Reconcile the rules from the provider after writing
them before considering the deployment complete.

## Build

From the repository root:

```sh
node scripts/build-website.mjs
tar -C dist/website -czf /tmp/betterworkflows-website-<release-id>.tar.gz .
```

The artifact contains the official landing page at `/`, the existing
`docs/html` experience at `/docs/`, and the source paths required by its
evidence links under `/plugins/better-workflows/`.

## Later isolated releases

After the isolated origin and certificate exist, deploy content with the
release-only playbook. It changes only `/var/www/betterworkflows.dev/**`,
verifies the 41-locale receipt and expected content digest, and rolls the
`current` symlink back if the local origin probe fails:

```sh
export SITE_RELEASE_ID="$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
export SITE_ARTIFACT_PATH="/tmp/betterworkflows-website-${SITE_RELEASE_ID}.tar.gz"
export SITE_CONTENT_DIGEST="$(node -p \"require('./dist/website/release.json').contentDigest\")"
export SITE_ARTIFACT_SHA256="$(shasum -a 256 \"${SITE_ARTIFACT_PATH}\" | awk '{print $1}')"
export SITE_RECEIPT_SHA256="$(shasum -a 256 dist/website/release.json | awk '{print $1}')"
export SITE_REVISION="$(git rev-parse HEAD)"

ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/release.yml

ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/isolated-ingress.yml
```

The second command reconciles only the project-owned isolated Nginx process;
it does not load or restart the host's shared Nginx service or another vhost.
The release playbook verifies the externally supplied tarball SHA-256 before
upload, then verifies every extracted payload file against `manifest.sha256`
and checks that manifest against `SITE_CONTENT_DIGEST` before activation. It
also rejects special files, unexpected files or directories, reused unsealed
release IDs, and concurrent deployment transactions. New content is verified
inside a fresh `.incoming-<release-id>` directory before an atomic rename. The
kernel releases the project-only `flock` lease if its holder exits, and normal
failures remove only the incoming or unsealed release owned by that transaction.
An exact project-only transaction receipt lets a later invocation recover a
matching interrupted release, including restoring the persisted previous
`current` target before rebuilding the candidate. The isolated-ingress play
backs up its own config, unit, renewal file, hook, firewall additions, and
service state, then restores only those Better Workflows resources on failure.

## Dry checks

```sh
ANSIBLE_LOCAL_TEMP=/tmp/betterworkflows-ansible-local \
  ansible-playbook -i deploy/ansible/inventory/frontend.ini.example \
  deploy/ansible/release.yml --syntax-check

ANSIBLE_LOCAL_TEMP=/tmp/betterworkflows-ansible-local \
  ansible-playbook -i deploy/ansible/inventory/frontend.ini.example \
  deploy/ansible/isolated-ingress.yml --syntax-check
```

Do not commit a real inventory file or private key material. Verify the
host's pinned SSH key before using the inventory, and inspect the Ansible
diff/check output before authorizing a live run.
