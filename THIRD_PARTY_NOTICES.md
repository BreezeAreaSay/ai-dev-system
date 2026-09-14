# Third-Party Notices

The public seed includes the following separately maintained MIT-licensed knowledge packages.
Their license files remain alongside their sources in the image, except where an upstream
repository ships none and states its licence in each file instead, as noted below.

## taste-skill

- Source: https://github.com/Leonxlnx/taste-skill
- Included revision: `5285855df6719b6efb95d5268359e752d3d79045`
- License: MIT

## ui-ux-pro-max-skill

- Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Included revision: `1307d97a72e6c1cda572cb65471ae5ce82995218`
- License: MIT

## ECC (Everything Claude Code)

- Source: https://github.com/affaan-m/ECC (selective import: 101 of the
  repository's 291 `skills/<name>` directories, chosen by
  `ai-dev-mcp-server/src/core/skill-import-policy.mjs`)
- Included revision: `c9148d0bb239ed01a95724a5928b98cdf9c30658`
- License: MIT
- Selection record: `03-skills-catalog/sources/external/ecc/upstream.json`

## Understand Anything

- Source: https://github.com/Egonex-AI/Understand-Anything (partial import: the
  nine skills from `understand-anything-plugin/skills`, not the TypeScript
  application they drive)
- Included revision: `6df3065f1d8ddc2ce3615314d1d493f36d6b1c80`
- License: MIT, © Yuxiang Lin and Infinite Universe, Inc.
- License text: `03-skills-catalog/sources/external/understand-anything/LICENSE`
- These skills read a knowledge graph the upstream tool builds; without that
  tool installed they describe a pipeline this system does not run.

## Membrane application skills

- Source: https://github.com/membranedev/application-skills (complete import:
  3,074 `skills/<app>` integration skills)
- Included revision: `f484c8265e70ec910a57342389cca5c5de7d8167`
- License: MIT, as declared by the upstream README and by the `license: MIT`
  field in every imported `SKILL.md`. The upstream repository ships no LICENSE
  file; the declaration travels with each skill.
- These skills describe third-party application integrations and state their own
  requirement: network access and a Membrane account. They are excluded from
  routing unless a task names the application (`membrane_policy`).

## mattpocock/skills

- Source: https://github.com/mattpocock/skills (selective import: the
  `grilling` interview protocol from `skills/productivity/grilling`, which the
  `grill-me` intent gate follows)
- Included revision: `3cca18b368ae95cdbdebbff572ccafa662551015`
- License: MIT
- License text: `03-skills-catalog/sources/external/mattpocock-skills/LICENSE`

## Archify

- Source: https://github.com/tt-a1i/archify (vendored from the repository's
  `archify/` subdirectory)
- Included revision: `06dd052602dd9a369e4d034e24faef0917b5a60c`
- License: MIT
- Additional mark and trademark terms: see
  `03-skills-catalog/sources/external/archify/THIRD_PARTY_NOTICES.md`.

The Archify runtime includes the following pinned dependencies. Their package
metadata and license text remain in the vendored package's `node_modules` tree.

| Package | Version | License |
| --- | --- | --- |
| ajv | 8.17.1 | MIT |
| parse5 | 7.3.0 | MIT |
| saxes | 6.0.0 | ISC |
| simple-icons | 16.28.0 | CC0-1.0 |

## Binaries bundled in the Docker image

The following prebuilt binary is copied into the image out of its upstream
image. It is not part of the public seed and is not redistributed by the npm
package or by any of the source packages.

### gitleaks

- Source: https://github.com/gitleaks/gitleaks
- Included image: `ghcr.io/gitleaks/gitleaks:v8.30.1`, pinned by the digest of
  its multi-arch index (`sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`),
  which covers `linux/amd64` and `linux/arm64`
- License: MIT, © 2019 Zachary Rice
- License text: https://github.com/gitleaks/gitleaks/blob/master/LICENSE
- Copied to `/usr/local/bin/gitleaks` by `docker/Dockerfile`. It is the one
  security scanner `run_security_scan` can use under `--network none`.
