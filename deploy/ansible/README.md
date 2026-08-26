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
- `/etc/nginx/sites-available/betterworkflows.conf`
- `/etc/nginx/sites-enabled/betterworkflows.conf`
- the two project's own certificate paths when certificate issuance is explicitly requested

It does not remove, disable, rewrite, or restart other projects, vhosts,
upstreams, release directories, or services. `nginx -t` validates the whole
host configuration and therefore fails closed if an unrelated existing config
is already invalid; the playbook does not repair that unrelated config.

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

ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/release.yml

ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/isolated-ingress.yml
```

The second command reconciles only the project-owned isolated Nginx process;
it does not load or restart the host's shared Nginx service or another vhost.

## Dry checks

```sh
ansible-playbook -i deploy/ansible/inventory/frontend.ini.example deploy/ansible/site.yml --syntax-check
```

For an actual release, use a fresh immutable release identifier and a local
artifact path. The first pass keeps TLS disabled so Nginx can serve the ACME
webroot and validates the host's whole configuration before any reload:

```sh
export SITE_RELEASE_ID="$(git rev-parse HEAD)"
export SITE_ARTIFACT_PATH="/tmp/betterworkflows-website-${SITE_RELEASE_ID}.tar.gz"
export CERTBOT_EMAIL="admin@betterworkflows.dev"

ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/site.yml \
```

Because this host currently has no listener on port 80 while its existing
Nginx configuration is invalid, a project-scoped standalone certificate pass
can be used without editing another vhost. It binds port 80 only for the
ACME challenge, writes only this project's certificate, then renders this
project's TLS config. The final whole-host `nginx -t` remains a hard gate:

```sh
ansible-playbook \
  -i deploy/ansible/inventory/frontend.ini \
  deploy/ansible/site.yml \
  -e frontend_issue_certificate=true \
  -e frontend_certbot_method=standalone
```

For later releases, set `frontend_tls_enabled=true` and leave
`frontend_issue_certificate=false`; the existing project certificate is then
referenced without requesting a new one.

Do not commit a real inventory file or private key material. Verify the
host's pinned SSH key before using the inventory, and inspect the Ansible
diff/check output before authorizing a live run.
