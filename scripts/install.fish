#!/usr/bin/env fish
# Build the plugin and copy it into one or more vaults.
#
#   scripts/install.fish ~/vault-a ~/vault-b

if test (count $argv) -eq 0
    echo "usage: scripts/install.fish <vault>..." >&2
    exit 1
end

set -l root (realpath (dirname (status filename))/..)
npm --prefix $root run --silent build; or exit 1

for vault in $argv
    set -l dest $vault/.obsidian/plugins/artoo-veetoo
    mkdir -p $dest; or exit 1
    cp $root/main.js $root/manifest.json $dest/; or exit 1
    echo "installed into $dest"
end
