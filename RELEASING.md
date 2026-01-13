# Releasing Guide

This project uses [release-please](https://github.com/googleapis/release-please) for automated releases.

## How It Works

### Automatic Release Flow

```
Developer merges PR to main (with conventional commits)
                    ↓
    release-please creates/updates Release PR
                    ↓
         Maintainer merges Release PR
                    ↓
┌─────────────────────────────────────────────┐
│ Automatically:                              │
│  - Creates GitHub Release with notes        │
│  - Creates git tag (e.g., v0.2.0)          │
│  - Updates CHANGELOG.md                     │
│  - Bumps version in package.json            │
│  - Deploys to GitHub Pages                  │
└─────────────────────────────────────────────┘
```

### Commit Convention

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Your commit messages determine version bumps:

| Commit Type | Description | Version Bump |
|-------------|-------------|--------------|
| `feat:` | New feature | Minor (0.x.0) |
| `fix:` | Bug fix | Patch (0.0.x) |
| `feat!:` or `BREAKING CHANGE:` | Breaking change | Major (x.0.0) |
| `docs:` | Documentation only | No release |
| `chore:` | Maintenance | No release |
| `refactor:` | Code refactoring | Patch |
| `perf:` | Performance improvement | Patch |
| `test:` | Adding tests | No release |
| `ci:` | CI configuration | No release |
| `build:` | Build system changes | No release |

### Examples

```bash
# Feature - triggers minor version bump (0.1.0 → 0.2.0)
git commit -m "feat: add dark mode support"

# Bug fix - triggers patch version bump (0.1.0 → 0.1.1)
git commit -m "fix: resolve memory leak in GIF encoder"

# Breaking change - triggers major version bump (0.1.0 → 1.0.0)
git commit -m "feat!: redesign export API"
# or
git commit -m "feat: redesign export API

BREAKING CHANGE: Export function signature has changed"

# Documentation - no version bump
git commit -m "docs: update README installation instructions"

# Chore - no version bump
git commit -m "chore: update dependencies"
```

## Manual Release (If Needed)

In rare cases where you need to manually create a release:

1. Update `package.json` version
2. Update `CHANGELOG.md`
3. Update `.release-please-manifest.json`
4. Commit changes
5. Create and push a tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
6. Create GitHub Release manually from the tag

## Version Display

The app version is displayed in the header next to the logo. This is automatically injected at build time from `package.json`.

## Files Involved

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | Release automation workflow |
| `release-please-config.json` | Release-please configuration |
| `.release-please-manifest.json` | Tracks current version |
| `CHANGELOG.md` | Auto-generated changelog |
| `package.json` | Source of truth for version |

## Troubleshooting

### Release PR not created
- Ensure commits follow conventional commit format
- Check that the workflow has proper permissions (contents: write, pull-requests: write)

### Version not showing in app
- Run `npm run build` to regenerate with new version
- Check that `vite.config.js` properly reads from `package.json`

### Deployment not triggered after release
- The `deploy.yml` workflow triggers on push to main
- When release-please merges the Release PR, it pushes to main, triggering deployment
