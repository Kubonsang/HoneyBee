# TestPlay shared-content cache follow-up

`shared-content-cache.patch` contains the corresponding TestPlay implementation
and tests. Its base is commit `95d65521ec2d56419b5b0e2351a70e0e1b2059ee` of
`https://github.com/Kubonsang/testplay-runner.git` (v0.14.0-dev source).

Apply in an isolated TestPlay checkout at that exact commit:

```powershell
git apply --check <path-to-shared-content-cache.patch>
git apply <path-to-shared-content-cache.patch>
go test ./...
go vet ./...
go test -race ./internal/contentcache ./internal/runsvc ./internal/shadow
go build -o testplay-shared-cache.exe ./cmd/testplay
```

The implementation checkout for this task is `tmp/testplay-shared-cache` on
branch `feat/shared-content-cache`. The installed TestPlay and original source
checkout were preserved. This patch is not a published TestPlay release.

See HoneyBee's [operation guide](../../docs/operations/shared-testplay-cache.md)
and [validation record](../../docs/validation/shared-cache-usage.md) for opt-in,
measurement and cleanup boundaries.
