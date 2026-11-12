#!/bin/sh
# Builds the contract for NEAR: plain MVP WebAssembly, std included.
#
# Rust 1.82+ ships its wasm standard library with reference types and
# sign-extension turned on, and the NEAR runtime refuses both. Rebuilding std
# for the MVP (nightly's -Zbuild-std, which needs the rust-src component) is
# what keeps them out. `cargo near build` is the alternative once installed.
set -eu
cd "$(dirname "$0")"
RUSTFLAGS="-C target-cpu=mvp -C link-arg=-s" \
  cargo +nightly build -Zbuild-std=std,panic_abort \
  --target wasm32-unknown-unknown --release --target-dir target/mvp
mkdir -p res
cp target/mvp/wasm32-unknown-unknown/release/near_badges.wasm res/near_badges.wasm
echo "res/near_badges.wasm ($(wc -c < res/near_badges.wasm) bytes)"
