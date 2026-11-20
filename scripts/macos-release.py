#!/usr/bin/env python3
"""Package macOS downloads and updater archives. Signing keys stay on the signing Mac."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--target", required=True, choices=["aarch64-apple-darwin", "x86_64-apple-darwin"])
parser.add_argument("--unsigned", action="store_true", help="Build CI artifacts, not public releases")
parser.add_argument("--skip-notarization", action="store_true", help="Prepare a signed local preview only")
args = parser.parse_args()
if os.uname().sysname != "Darwin":
    parser.error("macOS packaging requires a Mac")
arch = args.target.split("-")[0]
name = "Apple-Silicon" if arch == "aarch64" else "Intel"
version = json.loads((root / "desktop/src-tauri/tauri.conf.json").read_text())["version"]
output = root / "build/macos-release" / arch
output.mkdir(parents=True, exist_ok=True)
# A failed rebuild must not retain a previous success marker.
(output / "release.json").unlink(missing_ok=True)
(output / "SHA256SUMS.txt").unlink(missing_ok=True)
env = dict(os.environ, MACOSX_DEPLOYMENT_TARGET="14.0")
identity = env.get("APPLE_SIGNING_IDENTITY")
if not identity and (root / ".breadcrumb-signing-identity").exists():
    identity = (root / ".breadcrumb-signing-identity").read_text().strip()
if not args.unsigned and (not identity or identity == "-"):
    parser.error("Set APPLE_SIGNING_IDENTITY to a Developer ID certificate")
if not args.unsigned and not args.skip_notarization and not (
    env.get("BREADCRUMB_NOTARY_PROFILE")
    or (env.get("APPLE_API_KEY_PATH") and env.get("APPLE_API_KEY"))
    or (env.get("APPLE_ID") and env.get("APPLE_PASSWORD"))
):
    parser.error("Provide notarization credentials or use --skip-notarization for a local preview")


def run(command, *, process_env=env, label="Build"):
    result = subprocess.run(command, cwd=root, env=process_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # Build/notary diagnostics are local records, not release assets.
    with (output / "build.log").open("a") as log:
        log.write(result.stdout)
    os.chmod(output / "build.log", 0o600)
    if result.returncode:
        raise SystemExit(f"{label} failed. See the local build log.")
    return result.stdout


run(["python3", "scripts/desktop-prepare.py", "--target", args.target], label="Native helpers")
build_env = {key: value for key, value in env.items() if key not in ["APPLE_ID", "APPLE_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_PATH", "APPLE_API_ISSUER"]}
build_env["APPLE_SIGNING_IDENTITY"] = "-" if args.unsigned else identity
run(["bun", "run", "--cwd", "desktop", "tauri", "build", "--target", args.target, "--bundles", "app"], process_env=build_env)
app = root / "desktop/src-tauri/target" / args.target / "release/bundle/macos/Breadcrumb.app"
run(["codesign", "--verify", "--deep", "--strict", str(app)], label="Signature verification")
details = run(["codesign", "-dv", "--verbose=4", str(app)])
if not args.unsigned and "Authority=Developer ID Application:" not in details:
    raise SystemExit("Public releases require a Developer ID signature")
for binary in (app / "Contents/MacOS").iterdir():
    if binary.is_file():
        actual = run(["lipo", "-archs", str(binary)]).strip()
        expected = "arm64" if arch == "aarch64" else "x86_64"
        if actual != expected:
            raise SystemExit("The app contains a helper built for the wrong architecture")


def notarize(path, ticket=None):
    profile = env.get("BREADCRUMB_NOTARY_PROFILE")
    if profile:
        auth = ["--keychain-profile", profile]
    elif env.get("APPLE_API_KEY_PATH"):
        auth = ["--key", env["APPLE_API_KEY_PATH"], "--key-id", env["APPLE_API_KEY"]]
        if env.get("APPLE_API_ISSUER"):
            auth += ["--issuer", env["APPLE_API_ISSUER"]]
    else:
        team = env.get("APPLE_TEAM_ID") or next(line.split("=", 1)[1] for line in details.splitlines() if line.startswith("TeamIdentifier="))
        auth = ["--apple-id", env["APPLE_ID"], "--password", env["APPLE_PASSWORD"], "--team-id", team]
    result = json.loads(run(["xcrun", "notarytool", "submit", str(path), *auth, "--wait", "--timeout", "20m", "--output-format", "json"], label="Notarization"))
    if result.get("status") != "Accepted":
        raise SystemExit("Apple did not accept this package; do not publish it")
    target = ticket or path
    run(["xcrun", "stapler", "staple", str(target)], label="Notarization ticket")
    run(["xcrun", "stapler", "validate", str(target)], label="Ticket verification")


notarized = not args.unsigned and not args.skip_notarization
if notarized:
    zipped = output / "notarization.zip"
    run(["ditto", "-c", "-k", "--keepParent", str(app), str(zipped)])
    notarize(zipped, app)
    zipped.unlink(missing_ok=True)

archive = output / f"Breadcrumb-{version}-macOS-{arch}.app.tar.gz"
run(["tar", "-czf", str(archive), "-C", str(app.parent), "Breadcrumb.app"], process_env=dict(env, COPYFILE_DISABLE="1"))
if not args.unsigned:
    run(["bun", "run", "--cwd", "desktop", "tauri", "signer", "sign", "--app-version", version, str(archive)], label="Update signature")
dmg = output / f"Breadcrumb-macOS-{name}.dmg"
with tempfile.TemporaryDirectory(prefix="breadcrumb-package-") as temp:
    stage = Path(temp)
    run(["ditto", str(app), str(stage / "Breadcrumb.app")])
    (stage / "Applications").symlink_to("/Applications")
    shutil.copyfile(root / "Resources/Install.txt", stage / "Read Me.txt")
    run(["hdiutil", "create", "-volname", "Breadcrumb", "-srcfolder", str(stage), "-format", "UDZO", "-ov", str(dmg)])
if not args.unsigned:
    run(["codesign", "--force", "--timestamp", "--sign", identity, str(dmg)], label="Disk image signature")
if notarized:
    notarize(dmg)
    run(["spctl", "--assess", "--type", "execute", str(app)], label="Gatekeeper app assessment")
    run(["spctl", "--assess", "--type", "open", "--context", "context:primary-signature", str(dmg)], label="Gatekeeper disk image assessment")
(output / "SHA256SUMS.txt").write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in [dmg, archive]))
(output / "release.json").write_text(json.dumps({"version": version, "architecture": arch, "signed": not args.unsigned, "notarized": notarized}, indent=2) + "\n")
print(f"Prepared macOS {name} packages. " + ("Ready to publish." if notarized else "Preview only; not notarized."))
