#!/usr/bin/env bash
# Publishes the desktop version in tauri.conf.json to the GitHub release. Packages go up
# first, then checksums, the release notes and the version tag. The update feed goes last,
# so installed apps never see a version whose files are missing.
# Usage: scripts/desktop-publish.sh <artifact directory>
set -euo pipefail
artifacts="$(cd "${1:?artifact directory required}" && pwd)"
release="${RELEASE:-windows-preview}"
repo="${GITHUB_REPOSITORY:-hackclub/breadcrumb}"
version="$(jq -r .version desktop/src-tauri/tauri.conf.json)"
notes="docs/releases/$version.md"
base="https://github.com/$repo/releases/download/$release"
work="build/publish"
[ -f "$notes" ] || { echo "Write $notes before publishing $version." >&2; exit 1; }
rm -rf "$work" && mkdir -p "$work"

upload() {
  for attempt in 1 2 3 4; do
    gh release upload "$release" "$@" --repo "$repo" --clobber && return 0
    sleep $((attempt * 15))
  done
  echo "Upload failed: $*" >&2
  return 1
}

# Windows: a full installer for new users and a lightweight versioned update for the feed.
for name in Breadcrumb-Windows-x64-setup.exe Breadcrumb-Windows-x64-update.exe; do
  cp "$artifacts/$name" "$artifacts/$name.sig" "$work/"
done
cp "$work/Breadcrumb-Windows-x64-update.exe" "$work/Breadcrumb-Windows-$version-x64-update.exe"
cp "$work/Breadcrumb-Windows-x64-update.exe.sig" "$work/Breadcrumb-Windows-$version-x64-update.exe.sig"

# macOS: use CI builds when present; otherwise the signed packages already on the release.
mac_built=false
for arch in aarch64 x86_64; do
  name="Apple-Silicon"; [ "$arch" = x86_64 ] && name="Intel"
  archive="Breadcrumb-$version-macOS-$arch.app.tar.gz"
  found="$(find "$artifacts" -name "$archive" -print -quit)"
  if [ -n "$found" ]; then
    mac_built=true
    dir="$(dirname "$found")"
    cp "$dir/$archive" "$dir/$archive.sig" "$dir/Breadcrumb-macOS-$name.dmg" "$work/"
  else
    gh release download "$release" --repo "$repo" --dir "$work" \
      --pattern "$archive" --pattern "$archive.sig" --pattern "Breadcrumb-macOS-$name.dmg" ||
      { echo "No $version macOS $arch packages were built or attached." >&2; exit 1; }
  fi
done

windows_update="Breadcrumb-Windows-$version-x64-update.exe"
bun scripts/desktop-update-manifest.ts --platform windows-x86_64 --url "$base/$windows_update" \
  --signature "$work/$windows_update.sig" --notes "$notes" --output "$work/latest.json"
for arch in aarch64 x86_64; do
  archive="Breadcrumb-$version-macOS-$arch.app.tar.gz"
  bun scripts/desktop-update-manifest.ts --platform "darwin-$arch" --url "$base/$archive" \
    --signature "$work/$archive.sig" --notes "$notes" --output "$work/latest.json"
done

packages=(
  "Breadcrumb-$version-macOS-aarch64.app.tar.gz" "Breadcrumb-$version-macOS-aarch64.app.tar.gz.sig"
  "Breadcrumb-$version-macOS-x86_64.app.tar.gz" "Breadcrumb-$version-macOS-x86_64.app.tar.gz.sig"
  "Breadcrumb-macOS-Apple-Silicon.dmg" "Breadcrumb-macOS-Intel.dmg"
  "$windows_update" "$windows_update.sig"
  "Breadcrumb-Windows-x64-setup.exe" "Breadcrumb-Windows-x64-setup.exe.sig"
)
(cd "$work" && sha256sum "${packages[@]}" > SHA256SUMS.txt)

uploads=("$work/Breadcrumb-Windows-x64-setup.exe" "$work/Breadcrumb-Windows-x64-setup.exe.sig"
  "$work/Breadcrumb-Windows-x64-update.exe" "$work/Breadcrumb-Windows-x64-update.exe.sig"
  "$work/$windows_update" "$work/$windows_update.sig")
if [ "$mac_built" = true ]; then
  for name in "${packages[@]:0:6}"; do uploads+=("$work/$name"); done
fi
for file in "${uploads[@]}"; do upload "$file"; done
upload "$work/SHA256SUMS.txt"

gh release edit "$release" --repo "$repo" --title "Breadcrumb $version" --notes-file "$notes"
if ! git ls-remote --exit-code --tags origin "refs/tags/v$version" > /dev/null; then
  git tag "v$version" "${GITHUB_SHA:-HEAD}"
  git push origin "v$version"
fi

upload "$work/latest.json"
echo "Published Breadcrumb $version (macOS built in CI: $mac_built)."
