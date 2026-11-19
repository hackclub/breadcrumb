# GLib 0.18.5 security backport

This is the unmodified crates.io `glib` 0.18.5 source, except for the two-line fix in `src/variant_iter.rs` from gtk-rs/gtk-rs-core#1343 (upstream commit `05dff0ee696f9bcd8617cd48c4b812d046d440cb`). The original MIT license and copyright are retained. Package version is unchanged.

- Advisory: https://github.com/advisories/GHSA-wrw7-89jp-8q8g (RUSTSEC-2024-0429)
- Fix: https://github.com/gtk-rs/gtk-rs-core/pull/1343
- Constraint: Tauri 2's Linux GTK3 stack requires GLib 0.18; GLib 0.20 cannot be substituted without migrating that stack.

The FFI output pointer is mutable and passed as `&mut p`, eliminating the undefined behavior. The desktop Cargo patch applies this source to every transitive GLib dependency. No advisory is ignored. Remove the vendor override when Tauri supports a fixed GLib release.

Validate the original iterator tests with optimizations enabled:

```sh
cargo test --release --manifest-path desktop/src-tauri/vendor/glib/Cargo.toml --lib variant_iter
```
