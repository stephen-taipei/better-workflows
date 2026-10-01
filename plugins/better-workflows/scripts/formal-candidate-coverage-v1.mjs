#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Inspect an existing exact-candidate formal attempt; never executes suites.
import { runFormalCandidateCoverageCliV1 } from './lib/formal-candidate-coverage-v1.mjs';
await runFormalCandidateCoverageCliV1(process.argv.slice(2));
