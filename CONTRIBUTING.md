# Contributing

Edit packages here, not in the application's bundled snapshot. Preserve each
package's ATP name, increase its version for content changes, and keep channel.json
name/version/minDomios metadata accurate. Include every referenced file and retain
the Apache-2.0 license.

Download the checksum-verified `atp-validate` executable following
https://github.com/domios-dev/agentic-team-protocol/tree/main/validator.
Run `node scripts/channel.mjs validate . /path/to/atp-validate` before review.
The script validates the index and compares every entry with its ATP report.

After committing, package locally with:

```sh
node scripts/channel.mjs package <40-hex-commit> dist /path/to/atp-validate
```

Review and merge changes to master. Publication requires explicit owner approval
and one dispatch of channel-release.yml on the verified master commit. The same
run validates before publishing, uses hosted runners, and serializes publication.
Older or unrelated history cannot replace the rolling channel. Publication reads
back anonymous archive bytes, checksum and source receipt. Do not move published tags.

In the application repository, run `node scripts/sync-builtin-teams.mjs <commit>`
to refresh its bundled floor and record this repository's exact source commit.
