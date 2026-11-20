# Windows validation

Windows releases are checked for installation, repair, upgrades, data retention and explicit data removal. Interactive checks also cover recording controls, app detection, exclusions, alongside context and signed updates.

| Behavior             | Coverage                                                                     |
| -------------------- | ---------------------------------------------------------------------------- |
| Install and repair   | Per-user setup, shortcuts and native helpers                                 |
| Record               | Full-display capture, pause/resume and unchanged-image reuse                 |
| Protect private apps | Friendly-name, executable-name and password-manager exclusions               |
| Use the tray         | Close, Escape, click outside and duplicate launches                          |
| Update               | Cancel/accept, signature verification, restart and retained history/settings |
| Uninstall            | Retained history by default; explicit data deletion                          |

The [installer check](../scripts/windows-installer-smoke.ps1) runs in CI. Detailed test records stay local.

## Compatibility

Interactive coverage currently includes Windows 11 x64. Windows 10, ARM64, a clean installation without WebView2, and every protected/elevated application have not been validated. Setup includes Microsoft's offline WebView2 installer.

Update signatures protect downloaded updates. Windows publisher signing is separate and is not yet configured, so Windows may show an unknown-publisher warning.
