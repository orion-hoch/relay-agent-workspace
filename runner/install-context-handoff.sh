#!/bin/sh
set -eu
# Run inside the existing sandbox after uploading the adjacent plugin package.
package_dir=${1:?Pass the sandbox path containing openclaw.plugin.json}
test -f "$package_dir/openclaw.plugin.json"
node "$package_dir/check.mjs"
openclaw plugins install "$package_dir" --link
openclaw config validate
printf '%s\n' 'Registered. When the gateway is idle, use the host NemoClaw gateway restart command to activate it.'
