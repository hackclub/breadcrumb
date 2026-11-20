# Windows validation

Interactive setup tests run through the Amp Windows runner on Windows 11 Pro 25H2 (26200.9974), x64. The runner's service session is not a normal desktop: installer and app interactions run separately as an unelevated user in an interactive session. Capture tests use a synthetic editor and password-manager fixture.

## Test coverage

| Scenario                                                              | Result                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Per-user setup wizard, shortcuts and sidecars                         | Passed                                                                     |
| Full-display capture and focused-window metadata                      | Passed; 2560 × 1600 fixture display                                        |
| Editable/password accessibility values                                | Omitted from the captured tree                                             |
| Display-name, executable-name and default password-manager exclusions | Capture skipped; recovered after excluded window closed                    |
| Start, pause, resume and unchanged-image reuse                        | Passed; separate observations reused one JPEG                              |
| Escape, close, click outside and duplicate launch                     | Passed; one engine remained                                                |
| Visible console windows during normal capture                         | None observed by a 10 ms polling monitor                                   |
| Same-version repair, newer-version upgrade and downgrade rejection    | Passed                                                                     |
| Normal uninstall                                                      | App/helpers stopped; synthetic history and settings retained byte-for-byte |

Executable-name tests used a fixture whose file description differed from its basename. Both focused and visible background windows were blocked, including case-insensitive matches; an unreadable executable identity rejected the sample. Removing the fixture restored capture.

The tests found and fixed executable-name exclusions being ignored, invisible event windows blocking capture, release binaries falling back to checkout helpers, explicit launches staying hidden, and the silent data-deletion flag being ignored. The reusable [installer lifecycle check](../scripts/windows-installer-smoke.ps1) also runs on disposable GitHub Windows runners.

## Limits

The interactive machine already has WebView2. Setup bundles Microsoft's offline runtime installer, but installing it on a genuinely clean machine without WebView2 is a separate test; an invalid runtime-path simulation does not establish that case.

These results do not establish compatibility with Windows 10, ARM64, every antivirus policy, or every protected/elevated application. Preview installers are unsigned, so SmartScreen reputation and trusted-publisher behavior remain release work. The tests do not disable Windows protections or remove the host's shared WebView2 runtime.
