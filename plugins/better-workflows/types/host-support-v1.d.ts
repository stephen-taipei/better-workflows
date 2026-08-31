export type HostId =
  | "codex"
  | "claude-code"
  | "gemini-cli"
  | "qwen-code"
  | "kimi-code-cli"
  | "kiro"
  | "grok-build"
  | "cursor"
  | "github-copilot";

export type HostOsId = "macos" | "linux" | "windows";
export type SupportTier = "tier1" | "preview" | "unsupported";
export type CapabilityStatus = "native" | "core-bridge" | "unavailable" | "unverified";

export interface HostConformancePackage {
  name: string;
  version: string;
}

export interface HostConformanceProbe {
  kind: "native-contract" | "cli-validate" | "isolated-install" | "cli-validate-install";
  arguments: string[];
  installArguments: string[] | null;
  installedManifestPath: string | null;
}

export interface HostAdapterManifest {
  id: HostId;
  displayName: string;
  supportTier: SupportTier;
  executable: string;
  conformancePackage: HostConformancePackage | null;
  conformanceProbe: HostConformanceProbe | null;
  distributionRoot: "plugin" | "repository" | null;
  helperPath: string | null;
  manifestPath: string | null;
  extensionMechanism: string;
  officialDocumentation: string | null;
  osSupport: Record<HostOsId, SupportTier>;
  capabilities: Record<string, CapabilityStatus>;
  limitations: string[];
}

export interface HostCapabilityResult {
  id: string;
  declared: CapabilityStatus;
  result: "PASS" | "FAIL";
  reason: string;
}

export interface HostCapabilityReceipt {
  schemaVersion: 1;
  kind: "HostCapabilityReceipt";
  producedAt: string;
  hostId: HostId;
  osId: HostOsId;
  supportTier: SupportTier;
  registryId: "host-support-v1";
  registryDigest: string;
  executable: Record<string, unknown> | null;
  manifest: Record<string, unknown> | null;
  versionProbe: Record<string, unknown>;
  extensionProbe: Record<string, unknown>;
  capabilities: HostCapabilityResult[];
  result: "PASS" | "FAIL";
  authentication: {
    status: "local-executable-binding";
    releaseEligible: false;
    requirement: string;
  };
  receiptDigest: string;
  receiptPath: string | null;
}
