#!/usr/bin/env bash
# Adds a "Wonderboy AI Studio" launcher to the applications menu and the desktop (Linux).
# Run once: bash scripts/install-launcher.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chmod +x "$APP_DIR/scripts/start-wonderboy.sh"

ENTRY="[Desktop Entry]
Type=Application
Name=Wonderboy AI Studio
Comment=Start Wonderboy and open it in the browser
Exec=bash \"$APP_DIR/scripts/start-wonderboy.sh\"
Path=$APP_DIR
Icon=applications-multimedia
Terminal=true
Categories=AudioVideo;Video;"

MENU_DIR="$HOME/.local/share/applications"
mkdir -p "$MENU_DIR"
printf '%s\n' "$ENTRY" > "$MENU_DIR/wonderboy.desktop"
chmod +x "$MENU_DIR/wonderboy.desktop"
echo "Added to the applications menu."

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP_DIR" ]; then
  printf '%s\n' "$ENTRY" > "$DESKTOP_DIR/wonderboy.desktop"
  chmod +x "$DESKTOP_DIR/wonderboy.desktop"
  # Cinnamon/GNOME: mark it trusted so it runs on double-click without a warning.
  gio set "$DESKTOP_DIR/wonderboy.desktop" metadata::trusted true 2>/dev/null || true
  echo "Added to the desktop: $DESKTOP_DIR/wonderboy.desktop"
fi
