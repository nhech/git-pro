#!/bin/bash
# Runs inside the image (scripts/screenshots.cjs): copies what VS Code needs out of the read-only checkout and takes the shots on a virtual display of 2160x1410 (the 2160x1350 picture plus the title bar that is cut off).
set -eu
mkdir -p /work && cd /src
cp -r .test-build dist media package.json package.nls.json LICENSE CHANGELOG.md README.md /work/
ln -s /src/node_modules /work/node_modules
cd /work
git config --global user.name fixture
git config --global user.email fixture@example.invalid
xvfb-run -a -s "-screen 0 2160x1410x24" node /src/scripts/screenshots/inner.cjs
