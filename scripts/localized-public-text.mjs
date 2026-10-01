import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildPolicyCatalog, loadPolicies } from "./localized-policies.mjs";
import { loadAdditionalTextSources, loadGuideTextSources } from "./public-text-source.mjs";
import { architectureCatalog } from "./architecture-source.mjs";
import { securityCatalog } from "./security-source.mjs";
import { cliReferenceCatalog } from "./cli-reference-source.mjs";
import { CONNECTORS_LOCALES } from "./website-locales.mjs";
import { loadOnboardingSources } from "./onboarding-source.mjs";
import { loadWorkflowSources } from "./workflow-source.mjs";

export async function loadPublicTexts(root) {
  const policies = await loadPolicies(root);
  const sources = await loadAdditionalTextSources(root);
  const guideSources = await loadGuideTextSources(root);
  const colorSource = sources.find((source) => source.id === "color-system");
  const catalogSources = sources.filter((source) => source.id !== "color-system");
  const catalogs = await Promise.all(["core", "asia", "europe"].map(async (group) => JSON.parse(
    await readFile(path.join(root, "docs/rc1-catalogs/public-docs", `${group}.json`), "utf8"))));
  const colorCatalog = JSON.parse(await readFile(path.join(root, "docs/rc1-catalogs/public-docs", "color-system.json"), "utf8"));
  const onboarding = await loadOnboardingSources(root);
  const onboardingCatalogs = await Promise.all(["core", "asia", "europe"].map(async (group) => JSON.parse(
    await readFile(path.join(root, "docs/rc1-catalogs/onboarding", `${group}.json`), "utf8"))));
  const workflows = await loadWorkflowSources(root);
  const workflowCatalogs = await Promise.all(["core", "asia", "europe"].map(async (group) => JSON.parse(
    await readFile(path.join(root, "docs/rc1-catalogs/workflows", `${group}.json`), "utf8"))));
  const architecture = architectureCatalog(guideSources[0]);
  const security = securityCatalog(guideSources[1]);
  const cliReference = cliReferenceCatalog(guideSources[2]);
  const guideCatalog = {
    sourceDigests: { ...architecture.sourceDigests, ...security.sourceDigests, ...cliReference.sourceDigests },
    locales: Object.fromEntries(CONNECTORS_LOCALES.filter((code) => code !== "en").map((code) => [code,
      { ...architecture.locales[code], ...security.locales[code], ...cliReference.locales[code] }] ))
  };
  return [...policies, ...buildPolicyCatalog(catalogSources, catalogs), ...buildPolicyCatalog([colorSource], [colorCatalog]),
    ...buildPolicyCatalog(guideSources, [guideCatalog]),
    ...buildPolicyCatalog(onboarding, onboardingCatalogs), ...buildPolicyCatalog(workflows, workflowCatalogs)];
}
