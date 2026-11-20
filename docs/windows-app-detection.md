# Windows app detection

Real-app validation on November 20, 2026 used Windows 11 Pro 25H2 x64 (build 26200.9974), an unelevated interactive desktop, and the native capture helper. Screenshots and accessibility contents stayed on the runner; no captures were uploaded or sent to a model.

| App              | Actual window executable | Observed accessibility nodes | Capture time |
| ---------------- | ------------------------ | ---------------------------: | -----------: |
| Helium           | `chrome.exe`             |                           31 |       189 ms |
| VLC media player | `vlc.exe`                |                           38 |       206 ms |
| GitHub Desktop   | `GitHubDesktop.exe`      |                           10 |       183 ms |
| Steam            | `steamwebhelper.exe`     |          180 (limit reached) |       401 ms |
| Counter-Strike 2 | `cs2.exe`                |                            1 |     2,731 ms |

Times include fresh helper startup and are medians of three captures except CS2, which was captured once. They describe this machine and app state, not a performance guarantee. Every tested app produced a nonblack frame. Ordinary desktop captures were 2560×1600; CS2 temporarily changed the display to 800×600, and the desktop returned to 2560×1600 after exit.

GitHub Desktop's file description was `Electron`; its ProductName correctly identified GitHub Desktop. Steam's web helper now reports Steam. CS2 has no useful version-resource name and uses a narrow `cs2.exe` alias for Counter-Strike 2. Specific descriptions such as Helium and VLC are preserved because ProductName sometimes describes an entire suite or operating system.

Helium/VLC and Helium/Steam alongside tests distinguished the focused app from other on-screen windows. All 25 identity, focus and exclusion assertions passed. Original executable exclusions still suppressed both image and tree. Excluding `Steam`, `steam.exe` or `steamwebhelper.exe` also blocked a sample when the Steam helper was visible beside focused Helium.

Steam exposed a useful tree after loading. GitHub Desktop exposed mostly containers; CS2 exposed only a window. Neither the tree nor app presence verifies attention, video playback, gameplay or productive work. CS2 menu recognition and in-match capture were not validated. The initial CS2 focus failure came from the test harness's foreground activation; a corrected harness captured its SDL window successfully.

The tests used temporary browser/app profiles, synthetic media and a public repository fixture. Task-owned processes and scheduled tasks were removed, existing Steam remained running, and both restored CS2 configuration directories matched their backups by SHA256. This does not establish equivalent results on Windows 10, ARM64, macOS or Linux.
