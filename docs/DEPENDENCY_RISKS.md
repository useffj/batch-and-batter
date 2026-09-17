# Known Dependency Risks

## Next.js transitive PostCSS dependency

- **Decision:** Safe to commit with documented dependency risk.
- **Owner:** Batch & Batter project.
- **Status:** Accepted temporarily for development.
- **Next.js version:** 15.5.24.
- **Transitive dependency:** postcss 8.4.31.
- **Dependency path:** application → next@15.5.24 → postcss@8.4.31.
- **Audit result:** npm audit currently reports one moderate and one high affected package. Next.js inherits the finding from PostCSS; these package counts cover the four advisories below.

### Relevant advisories

- [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93)
- [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q)
- [GHSA-fxqj-rqcc-2cmp](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)
- [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849)

### Current exposure assessment

- Primarily build/development CSS processing for this application.
- The current application does not process user-supplied CSS.
- The project is not yet deployed.

### Current mitigation and review requirements

- Stay on the supported Next.js 15.5.24 project baseline. This version retains the known PostCSS risk; retaining the baseline does not fix the advisories.
- Do not use `npm audit fix --force`.
- Do not add unsupported PostCSS overrides without review.
- Re-check when a newer supported Next.js 15 release is available.
- Reassess before any production deployment.

**Review again before production deployment.** This is temporary acceptance for development, not production risk acceptance.
