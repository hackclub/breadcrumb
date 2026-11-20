# App detection

Breadcrumb uses app metadata to identify the focused app and record other windows on the same display. Friendly names do not replace executable-name privacy exclusions.

| App              | Context                                                   |
| ---------------- | --------------------------------------------------------- |
| Helium           | Browser controls and visible page context                 |
| VLC              | Media-player controls                                     |
| GitHub Desktop   | App identity; limited accessibility detail                |
| Steam            | App identity and available interface controls             |
| Counter-Strike 2 | App identity and screenshot; limited accessibility detail |

GitHub Desktop is identified by its product metadata rather than a generic Electron label. Steam's web helper is grouped under Steam. Counter-Strike 2 is identified from its executable.

Exclusions accept friendly names or executable names. Excluding Steam also covers its web helper. When an excluded app may be visible alongside another app, Breadcrumb skips the sample.

App presence does not establish attention, playback, gameplay or productive work. Accessibility detail varies by app; a screenshot can still provide context when an app exposes little text.
