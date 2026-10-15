# Administrator customer lookup — Milestone 1F

Read-only administrator contact search and historical order navigation. No permanent customer accounts or verified identity relationships are created.

## Search and identity rules

One field accepts exact email or a full name / first or last whitespace-delimited name token. Names use Unicode NFC, trim, collapsed Unicode whitespace, and JavaScript Unicode lowercase. Apostrophes, hyphens and accents remain intact. Tokens are not asserted to be legal given/family names. Interior tokens, fuzzy matching, transliteration and arbitrary substrings are unsupported. Email search trims and lowercases the complete address; it does not rewrite the stored address.

Results group only the exact recorded `[name, email, phone]` tuple. Even a shared email or name does not merge different tuples. Identical tuples are a contact-snapshot grouping, not proof of one person. A changed spelling or phone remains separate. No lifetime counts or spending totals are presented. Groups can reappear on another bounded search page. History displays frozen Order item names, quantities and totals; available Drop names are explicitly current labels, not historical snapshots. Existing OrderDetails is reused.

## Access pattern and atomic creation

Commerce companion records use `CUSTOMER_LOOKUP#v1#<name|email|contact>#<sha256>` partition keys and `ORDER#<createdAt>#<orderId>` sort keys. Full name, first token and last token are deduplicated, plus one email and one exact-contact key: at most five records per Order. Rows contain only orderId and contactKey besides keys. Deterministic hashes are NOT anonymization: low-entropy names/emails remain guessable and must stay administrator-protected.

The existing payment-start transaction adds conditional create-only companion Puts to the existing twelve actions, for a maximum of seventeen, well below DynamoDB's 100-action limit. It retains the original Cart/Drop/pickup conditions, reference and submission collision protection, receipt replay, prices, totals, inventory and Stripe behavior. Lookup collision aborts the entire handoff; no new IDs or unsafe rebasing after ambiguous results. Existing replay does not create duplicate Orders or companions. No new table, GSI or search service is introduced.

Search/history use consistent base-table Query, Limit 20, descending sort keys, with a scoped bounded continuation. Authoritative Order re-reads validate the lookup key, sort order and exact contact tuple before returning data. Missing or mismatched companions cannot disclose unrelated Orders. Pages are not a cross-page snapshot; an empty page can still have continuation. Contact snapshots are immutable under current writers. Any future contact-edit workflow must atomically reconcile companions; stale rows are rejected but missing rows cannot be inferred.

`POST /admin/customers/search` accepts query and optional cursor. `POST /admin/customers/history` accepts the contact hash and optional cursor. POST is read-only here and keeps terms out of URLs. Backend Cognito administrator checks and protected SSR relays retain encrypted HttpOnly sessions, origin checks, bounded JSON and no-store responses. No browser persistence, analytics or search-term logging is added. Knowing a name, email, hash or order reference grants no public access.

## Coverage and release gates

All Orders created before this writer rollout, or afterward by any older writer, lack some or all v1 companions and require separately approved reconciliation/backfill. Existing Orders and prices are never rewritten by this feature. A future backfill must derive exact v1 keys from authoritative snapshots, verify ownership/collisions and complete coverage before claiming complete history. Search may omit unindexed Orders until then; the UI states this limitation.

Deployment requires separately approved frontend/API rollout, two JWT routes, base-Commerce Query permission, lookup backfill, and the existing compatible payment-worker/index rollout gates. Accepted Lambda artifacts remain unchanged; ordinary full-stack deployment remains blocked. No deployment, live writes, migration, IAM/SSM/S3 modification, artifact publication, media/catalog activation or payment admission is authorized. Hosted duplicate-activation acceptance remains NOT PASSED.

## Local validation

Use `node backend/scripts/test-customers-local.mjs` for synthetic loopback DynamoDB acceptance and the existing `test-orders-local.mjs` for actual payment-start transaction/replay, companion persistence and unchanged inventory. `node web/scripts/preview-customers.mjs` serves only loopback with synthetic identity and disposable local fixtures, never production authentication. These checks do not establish managed-DynamoDB or hosted acceptance.
