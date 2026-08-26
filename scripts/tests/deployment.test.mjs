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
  const inventoryExample = await source("deploy/ansible/inventory/frontend.ini.example");
  const ci = await source(".github/workflows/ci.yml");

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
  ]) assert.equal((nginx.match(new RegExp(`add_header ${header}`, "g")) ?? []).length, 5, header);
  assert.match(nginx, /Cache-Control "public, immutable"/);
  assert.match(nginx, /Cache-Control "public, max-age=3600, must-revalidate"/);
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
  assert.match(release, /frontend_expected_receipt_digest/);
  assert.match(release, /\^\[a-f0-9\]\{12\}-\[0-9\]\{8\}T\[0-9\]\{6\}Z\$/);
  assert.doesNotMatch(release, /\^\[A-Za-z0-9\._-\]\+\$/);
  assert.match(release, /frontend_expected_artifact_digest/);
  assert.match(release, /frontend_artifact\.stat\.checksum == frontend_expected_artifact_digest/);
  assert.match(release, /sha256sum/);
  assert.match(release, /frontend_incoming_path/);
  assert.match(release, /Refuse unowned or mismatched interrupted release state/);
  assert.match(release, /frontend_transaction_receipt_path/);
  assert.match(release, /Restore the persisted previous release before cleaning an interrupted active candidate/);
  assert.match(release, /Verify interrupted-candidate rollback before cleanup/);
  assert.match(release, /frontend_interrupted_rollback_verified/);
  assert.match(
    release,
    /frontend_previous_target:[\s\S]*?frontend_previous_current\.stdout[\s\S]*?if frontend_release_state\.results\[1\]\.stat\.exists/
  );
  assert.ok(
    release.indexOf("Persist the exact transaction owner before artifact extraction") <
      release.indexOf("Create a new isolated incoming release directory")
  );
  assert.match(release, /Verify the exact extracted tree and every payload digest/);
  assert.match(release, /! -type f ! -type d/);
  assert.match(release, /manifest\.directories/);
  assert.match(release, /frontend_deploy_lock: \/run\/lock\/betterworkflows-deploy\.lock/);
  assert.match(release, /Start the kernel-released project deployment lock/);
  assert.match(release, /Release the project-only deployment lock lease/);
  assert.match(release, /\/usr\/bin\/flock/);
  assert.match(release, /frontend_lock_lifetime_seconds: 3600/);
  assert.match(release, /frontend_publish_deadline_seconds: 3300/);
  assert.match(release, /Refuse to publish after the bounded lock-safe deadline/);
  assert.match(release, /Start the kernel-released project deployment lock[\s\S]*?changed_when: false/);
  assert.match(release, /Seal the immutable release after activation succeeds[\s\S]*?when: not frontend_release_is_sealed/);
  assert.match(release, /Release the project-only deployment lock lease[\s\S]*?changed_when: false/);
  assert.match(release, /Remove only this transaction's unpublished incoming tree/);
  assert.match(release, /Remove only this transaction's failed unsealed published release/);
  assert.match(release, /\$0 != "release\.json"/);
  assert.match(release, /manifest\.sha256/);
  assert.match(release, /frontend_manifest\.stat\.checksum == frontend_expected_content_digest/);
  assert.match(release, /frontend_receipt\.stat\.checksum == frontend_expected_receipt_digest/);
  assert.match(release, /frontend_candidate_receipt\.contentDigest == frontend_expected_content_digest/);
  assert.match(release, /frontend_candidate_receipt\.sponsorMode == 'one-time-only'/);
  assert.match(release, /frontend_candidate_receipt\.locales \| int == 41/);
  assert.match(release, /Restore the previous Better Workflows release target/);
  assert.match(release, /Remove the failed first-release activation symlink/);
  assert.match(release, /Verify rollback before authorizing candidate cleanup/);
  assert.match(release, /frontend_rollback_verified/);
  assert.match(playbook, /Reconcile the isolated ingress as one rollback-bounded transaction/);
  assert.match(playbook, /frontend_ingress_lock: \/run\/lock\/betterworkflows-ingress\.lock/);
  assert.match(playbook, /Atomically acquire the persistent project ingress lock/);
  assert.match(playbook, /Bind the persistent ingress lock to this exact transaction/);
  assert.match(playbook, /register: frontend_ingress_lock_directory/);
  assert.match(
    playbook,
    /Remove only this failed contender's owner directory[\s\S]*?frontend_ingress_lock_directory\.rc \| default\(1\)/
  );
  assert.match(playbook, /Verify exact ingress lock ownership before release/);
  assert.match(playbook, /Release only this transaction's persistent ingress lock/);
  assert.match(
    playbook,
    /Release only this transaction's persistent ingress lock[\s\S]*?frontend_ingress_transaction_complete[\s\S]*?frontend_ingress_rollback_complete/
  );
  assert.doesNotMatch(playbook, /frontend_ingress_lock_lifetime_seconds|async:.*frontend_ingress_lock/s);
  assert.ok(
    playbook.indexOf("Record ownership of the project ingress lock") <
      playbook.indexOf("Inspect every project-owned mutable ingress file")
  );
  assert.match(playbook, /Back up every existing project-owned ingress file/);
  assert.match(playbook, /Remove only firewall rules added by this failed transaction/);
  assert.match(playbook, /Restore only the isolated service's prior state and loaded configuration/);
  assert.match(
    playbook,
    /state: "\{\{ 'restarted' if frontend_prior_service_active\.stdout == 'active' else 'stopped' \}\}"/
  );
  assert.match(playbook, /frontend_ingress_rollback_complete/);
  assert.match(playbook, /frontend_ingress_transaction_complete/);
  const ingressTransaction = playbook.slice(
    playbook.indexOf("Reconcile the isolated ingress as one rollback-bounded transaction")
  );
  assert.doesNotMatch(
    ingressTransaction.match(/rescue:[\s\S]*?always:/)?.[0] ?? "",
    /failed_when: false/
  );
  assert.doesNotMatch(release, /\/etc\//);
  assert.doesNotMatch(release, /systemd|community\.general\.ufw|nginx\.service/);
  assert.doesNotMatch(release, /api\.sdi\.internal|sdi-web|sdi\.stephen\.taipei/);

  await assert.rejects(source("deploy/ansible/site.yml"), { code: "ENOENT" });
  await assert.rejects(source("deploy/ansible/templates/betterworkflows.conf.j2"), { code: "ENOENT" });
  assert.doesNotMatch(`${release}\n${playbook}\n${nginx}\n${service}\n${certbotHook}`, /sites-(?:available|enabled)|reload nginx\.service/);
  assert.match(inventoryExample, /ansible_host=192\.0\.2\.10/);
  assert.doesNotMatch(inventoryExample, /64\.176\.35\.245|stephen|\/Users\//);
  assert.match(ci, /node --test scripts\/tests\/\*\.test\.mjs/);
  assert.match(ci, /ansible-core==2\.21\.3/);
  assert.match(ci, /community\.general:==13\.0\.1/);
  assert.equal((ci.match(/ansible-playbook .*--syntax-check/g) ?? []).length, 2);
});
