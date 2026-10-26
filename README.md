# climb-your-apex

An Apex-only Salesforce DX project. There are no Lightning Web Components, Aura components, or other JavaScript code.

## Dependencies

Node is used only for formatting. The dev dependencies are kept to that purpose:

- `prettier` - code formatter.
- `prettier-plugin-apex` - formats Apex classes (`.cls`) and triggers (`.trigger`).
- `@prettier/plugin-xml` - formats Salesforce metadata XML.

The ESLint, Jest, and LWC tooling from the default Salesforce DX template was removed because the project has no JavaScript to lint or test.

## Pinned versions

Dependency versions are pinned to reduce supply chain risk. A version range would let a newly published, possibly compromised release install automatically.

- `package.json` lists exact versions, and `.npmrc` sets `save-exact=true` so new dependencies are also saved without a range.
- `package-lock.json` pins every transitive dependency with an integrity hash. Commit it.
- Install with `npm ci`, which installs exactly what the lockfile specifies and fails if it is out of sync with `package.json`.
- To upgrade, change a version deliberately, review the new release, then run `npm install` and commit the updated lockfile.

## Commands

- `npm ci` - install the pinned dependencies.
- `npm run prettier` - format all files.
- `npm run prettier:verify` - check formatting without writing changes.
