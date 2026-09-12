# ColdX plugin marketplace

The sidebar gains a Plugin marketplace action immediately above Settings using
DSH's existing `sidebar.footer.action` slot. It opens a searchable, themed dialog
with repository details, validated package installation and installed status.
The catalog starts from GitHub's `dsh-plugin` topic. A topic is discovery data,
not proof that a repository is installable or approved by DeepSeek.

Use DSH as the sole package, composition and plugin runtime. Resolve versioned
package metadata before installation; only supported manifests receive an
install action. Never execute README commands, arbitrary shell strings or HTML.
The native profile installation command installs dependencies, then native
composition refresh reloads bundle layers in the existing Cordis loader. Report
configuration failures and restart requirements separately from successful
activation. Do not interrupt a running conversation to restart the host.

UI and AI share one Host service. Native tools search the catalog, inspect a
repository, install a validated package and read status. Agent installation is
enabled as requested and can be switched off in the market. Installation tools
remain subject to the native execution guards and require a live calling Agent.
The UI may open without creating a conversation. Installation state is scoped
to the profile, survives reopening and records errors honestly; concurrent
duplicates share one operation and writes are serialized.

Network reads are bounded and cached. Remote metadata and readmes stay untrusted
data. On rate limits/offline conditions, show cache age/notice or a retryable
error, never fabricate catalog entries. Local paths, credentials and unrelated
configuration are not sent to the catalog. User labels/configuration remain
owned by the existing DSH settings and profile layers.

Acceptance: live catalog retrieval, native bundle installation into an isolated
profile, activation evidence without a restart, preserved existing profile data,
shared UI/AI results, keyboard and dark/narrow layouts, failed/repeated/concurrent
installs, and current conversation continuity after live integration.
