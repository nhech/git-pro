# The image the screenshots are taken in (scripts/screenshots.cjs): a virtual X display, ImageMagick to capture and resize it, xdotool to click, and
# the libraries and fonts VS Code needs. VS Code itself is downloaded by @vscode/test-electron into a volume, so it is fetched once.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth xdotool imagemagick dbus dbus-x11 \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxkbcommon0 libxshmfence1 libdrm2 libatk-bridge2.0-0 libcups2 libxkbfile1 libsecret-1-0 \
      fonts-inter fonts-firacode fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# VS Code asks for its UI font as system-ui; make that, and plain sans-serif, Inter.
RUN printf '%s\n' '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>' \
      '<alias binding="same"><family>sans-serif</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="same"><family>system-ui</family><prefer><family>Inter</family></prefer></alias>' \
      '<alias binding="same"><family>monospace</family><prefer><family>Fira Code</family></prefer></alias>' \
      '</fontconfig>' > /etc/fonts/local.conf \
    && mkdir -p /root/.config/gtk-3.0 \
    && printf '[Settings]\ngtk-font-name=Inter 10\n' > /root/.config/gtk-3.0/settings.ini \
    && fc-cache -f
