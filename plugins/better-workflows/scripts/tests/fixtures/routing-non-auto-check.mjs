// This entrypoint is copied with the test fixture so its static import resolves
// against the copied plugin rather than the source checkout.
import { loadEntrypointCatalog } from "../../lib/routing.mjs";

await loadEntrypointCatalog();
