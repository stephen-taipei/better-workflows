# JSON key-set audit

This read-only reference recipe compares the nested key sets and object-key
order of two or more JSON documents supplied explicitly as strings. It writes a
machine-readable JSON report and a Markdown report. It never modifies its
inputs.

After `sbw recipe init`, run `sbw recipe scaffold json-keyset-audit`, inspect
the generated files, and use the governed promotion lifecycle. The included
fixture is deterministic and exists for candidate parity validation.
