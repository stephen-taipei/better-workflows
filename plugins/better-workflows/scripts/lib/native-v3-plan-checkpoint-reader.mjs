import { readJson } from "./core.mjs";

const CHECKPOINT_READ_RETRY_MS = 10;
const CHECKPOINT_READ_ATTEMPTS = 26;

function isTransientCheckpointPublication(error) {
  return error?.code === "EUNSAFE_JSON_PATH" &&
    error?.observation?.isSymbolicLink === false &&
    error?.observation?.isFile === true &&
    // A path lookup can complete against the old regular inode while a
    // cooperating atomic rename unlinks it. Its captured nlink is then 0;
    // the next strict path read must still observe a safe single-link file.
    (error?.observation?.nlink === 0 || error?.observation?.nlink === 2);
}

// Internal checkpoint I/O only. Every attempt retains readJson's ordinary
// private-state and single-link checks.
export async function readCheckpointJson(runnerRoot, target) {
  for (let attempt = 1; attempt <= CHECKPOINT_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readJson(runnerRoot, target);
    } catch (error) {
      if (!isTransientCheckpointPublication(error) || attempt === CHECKPOINT_READ_ATTEMPTS) throw error;
      // Keep the timer referenced while this bounded read is active.
      await new Promise((resolve) => setTimeout(resolve, CHECKPOINT_READ_RETRY_MS));
    }
  }
  throw new Error(`Unsafe JSON path: ${target}`);
}

// Only observations outside the plan lease use this wrapper. Writers already
// holding that lease must call their ordinary validating reader directly.
export async function readCheckpointWithFence(readUnfenced, withPlanLock) {
  try {
    return await readUnfenced();
  } catch (error) {
    if (!isTransientCheckpointPublication(error)) throw error;
    // Wait for a cooperating publisher to leave its critical section, then
    // repeat the strict read. A persistent unsafe link remains rejected.
    return withPlanLock(() => readUnfenced());
  }
}
