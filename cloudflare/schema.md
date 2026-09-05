# Cloudflare deployment and storage

The public `shop-gallery.pages.dev` Pages Function proxies requests
through an `APP` service binding to the private `dubuzzang-toss-gallery-app`
Worker. The Worker binds the `dubuzzang-toss-gallery-data` R2 bucket and stores
the migrated Railway volume data without committing it to Git:

- `data/data.json`
- `data/og.json`
- `uploads/<filename>`

Preview deployments are disabled because they would otherwise write to the same
production bucket. Runtime secrets are configured on the private Worker and are
never stored in this repository.

The former `dubuzzang-toss-gallery.pages.dev` address is retained as a
path-and-query-preserving redirect to this site.

All mutating requests pass through one `RequestCoordinator` Durable Object and
wait for their R2 snapshot writes before returning, preventing overlapping admin
actions from losing data.
