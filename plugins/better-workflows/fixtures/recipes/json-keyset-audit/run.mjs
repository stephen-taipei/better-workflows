import { writeFile } from "node:fs/promises";
import path from "node:path";

function walk(value, prefix = "", records = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return records;
  Object.keys(value).forEach((key, index) => {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    records.push({ path: keyPath, order: index });
    walk(value[key], keyPath, records);
  });
  return records;
}

export default async function run(context) {
  const documents = context.input.documents.map((document) => {
    let value;
    try {
      value = JSON.parse(document.json);
    } catch (error) {
      throw new Error(`Invalid JSON in ${document.label}: ${error.message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`JSON root must be an object: ${document.label}`);
    }
    return { label: document.label, keys: walk(value) };
  });
  const allPaths = [...new Set(documents.flatMap((document) => document.keys.map((item) => item.path)))].sort();
  const rows = allPaths.map((keyPath) => ({
    path: keyPath,
    documents: Object.fromEntries(
      documents.map((document) => {
        const match = document.keys.find((item) => item.path === keyPath);
        return [document.label, match ? match.order : null];
      })
    )
  }));
  const report = {
    schemaVersion: 1,
    labels: documents.map((document) => document.label),
    identicalKeySets: rows.every((row) => Object.values(row.documents).every((order) => order !== null)),
    identicalOrder: rows.every((row) => {
      const orders = Object.values(row.documents);
      return orders.every((order) => order !== null && order === orders[0]);
    }),
    rows
  };
  const header = `| Key | ${report.labels.join(" | ")} |`;
  const separator = `| --- | ${report.labels.map(() => "---:").join(" | ")} |`;
  const body = report.rows.map(
    (row) => `| \`${row.path}\` | ${report.labels.map((label) => row.documents[label] ?? "missing").join(" | ")} |`
  );
  const markdown = [
    "# JSON key-set audit",
    "",
    `Key sets identical: **${report.identicalKeySets ? "yes" : "no"}**`,
    "",
    `Key order identical: **${report.identicalOrder ? "yes" : "no"}**`,
    "",
    header,
    separator,
    ...body,
    ""
  ].join("\n");
  await writeFile(
    path.join(context.artifactStagingPath, "keyset-report.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  await writeFile(
    path.join(context.artifactStagingPath, "keyset-report.md"),
    markdown
  );
  return {
    summary: `Compared ${documents.length} JSON documents across ${rows.length} key paths.`,
    evidenceCandidates: [
      {
        kind: "json-keyset-audit",
        reportDigestSubject: "keyset-report.json"
      }
    ],
    artifacts: [
      {
        id: "report-json"
      },
      {
        id: "report-markdown"
      }
    ],
    proposals: []
  };
}
