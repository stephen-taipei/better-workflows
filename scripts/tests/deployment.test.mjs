import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../..");

async function source(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("isolated ingress changes only Better Workflows service paths", async () => {
  const release = await source("deploy/ansible/release.yml");
  const playbook = await source("deploy/ansible/isolated-ingress.yml");
  const nginx = await source("deploy/ansible/templates/betterworkflows-isolated-nginx.conf.j2");
  const service = await source("deploy/ansible/templates/betterworkflows-nginx.service.j2");
  const certbotHook = await source("deploy/ansible/templates/betterworkflows-certbot-deploy-hook.sh.j2");

  assert.match(playbook, /frontend_isolated_service_name: betterworkflows-nginx/);
  assert.match(playbook, /frontend_isolated_config_path: \/etc\/nginx\/betterworkflows\/nginx\.conf/);
  assert.match(playbook, /frontend_http_origin_port: 8880/);
  assert.match(playbook, /frontend_https_origin_port: 8443/);
  assert.match(playbook, /frontend_manage_ufw: true/);
  assert.match(playbook, /community\.general\.ufw:/);
  assert.match(playbook, /from_ip: "\{\{ item\.0 \}\}"/);
  assert.match(playbook, /comment: Better Workflows Cloudflare origin/);
  assert.match(playbook, /frontend_letsencrypt_webroot: \/var\/www\/betterworkflows\.dev\/shared\/letsencrypt/);
  assert.match(playbook, /option: authenticator\s+value: webroot/);
  assert.match(playbook, /option: webroot_path/);
  assert.match(playbook, /frontend_certbot_dry_run: false/);
  assert.doesNotMatch(playbook, /from_ip:\s*(?:any|0\.0\.0\.0\/0|::\/0)/i);
  assert.doesNotMatch(playbook, /name:\s*["']?nginx["']?\s*$/m);
  assert.doesNotMatch(playbook, /\/etc\/nginx\/(?:conf\.d|sites-available|sites-enabled)\//);
  assert.doesNotMatch(playbook, /api\.sdi\.internal|sdi-web|sdi\.stephen\.taipei/);

  assert.match(nginx, /listen \{\{ frontend_https_origin_port \}\} ssl/);
  assert.match(nginx, /listen \{\{ frontend_http_origin_port \}\}/);
  assert.doesNotMatch(nginx, /listen (?:80|443)(?:\s|;)/);
  assert.doesNotMatch(nginx, /include \/etc\/nginx\/(?:nginx\.conf|conf\.d|sites-enabled)/);
  assert.match(nginx, /deny all;/);
  assert.match(nginx, /gzip on;/);
  assert.match(nginx, /error_page 404 \/404\.html;/);
  assert.match(nginx, /location \/ \{ try_files \$uri \$uri\/ =404; \}/);
  assert.doesNotMatch(nginx, /try_files \$uri \$uri\/ \/index\.html/);
  for (const header of [
    "Strict-Transport-Security",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy"
  ]) assert.equal((nginx.match(new RegExp(`add_header ${header}`, "g")) ?? []).length, 4, header);
  assert.match(nginx, /location \^~ \/\.well-known\/acme-challenge\//);
  assert.equal((nginx.match(/allow \{\{ network \}\};/g) ?? []).length, 5);

  assert.match(playbook, /frontend_isolated_runtime_root: \/run\/betterworkflows-nginx/);
  assert.match(service, /PIDFile=\{\{ frontend_isolated_runtime_root \}\}\/nginx\.pid/);
  assert.match(service, /ExecStart=.* -c \{\{ frontend_isolated_config_path \}\}/);
  assert.doesNotMatch(service, /nginx\.service|systemctl/);
  assert.match(certbotHook, /RENEWED_LINEAGE/);
  assert.match(certbotHook, /reload \{\{ frontend_isolated_service_name \}\}\.service/);
  assert.doesNotMatch(certbotHook, /reload nginx\.service/);

  assert.match(release, /frontend_deploy_root: \/var\/www\/betterworkflows\.dev/);
  assert.match(release, /frontend_expected_content_digest/);
  assert.match(release, /frontend_candidate_receipt\.contentDigest == frontend_expected_content_digest/);
  assert.match(release, /frontend_candidate_receipt\.locales \| int == 41/);
  assert.match(release, /Restore the previous Better Workflows release target/);
  assert.doesNotMatch(release, /\/etc\//);
  assert.doesNotMatch(release, /systemd|community\.general\.ufw|nginx\.service/);
  assert.doesNotMatch(release, /api\.sdi\.internal|sdi-web|sdi\.stephen\.taipei/);
});
