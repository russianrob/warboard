#!/bin/bash
# Deploy a userscript from server/scripts/ to server/public/scripts/.
#
# Refuses to deploy if any of:
#   - source .user.js doesn't parse (node --check fails)
#   - source .user.js @version != source .meta.js @version (header mismatch)
#   - source @version is OLDER than what's already served (regression)
#
# Use this instead of `cp scripts/* public/scripts/` for any userscript.
# A single bad blanket cp is what regressed OC Spawn from 3.1.91 → 3.1.71
# (May 2026); this script makes that mistake impossible to repeat silently.
#
# Usage:  bin/deploy-userscript.sh <name>
# Example: bin/deploy-userscript.sh oc-spawn-assistance
#          bin/deploy-userscript.sh factionops
#
# Override (when you genuinely need to publish an older version, e.g.
# rolling back a bad release):  FORCE_REGRESSION=1 bin/deploy-userscript.sh <name>

set -euo pipefail

NAME="${1:-}"
if [ -z "$NAME" ]; then
    echo "Usage: $0 <userscript-name-without-extension>"
    echo "Example: $0 factionops"
    exit 2
fi

ROOT="/opt/warboard/server"
SRC_USER="$ROOT/scripts/${NAME}.user.js"
SRC_META="$ROOT/scripts/${NAME}.meta.js"
DST_USER="$ROOT/public/scripts/${NAME}.user.js"
DST_META="$ROOT/public/scripts/${NAME}.meta.js"

[ -f "$SRC_USER" ] || { echo "ERROR: source missing: $SRC_USER"; exit 1; }
[ -f "$SRC_META" ] || { echo "ERROR: source missing: $SRC_META"; exit 1; }

# Extract the @version value from a userscript header.
extract_version() {
    grep -oE '^// @version[[:space:]]+[0-9]+(\.[0-9]+)+' "$1" 2>/dev/null \
        | awk '{print $3}' \
        | head -1
}

# Compare two semver-like dotted versions. Echoes "lt" / "eq" / "gt" for $1 vs $2.
version_cmp() {
    local A="$1" B="$2"
    if [ "$A" = "$B" ]; then echo eq; return; fi
    # sort -V handles dotted numerics correctly (3.1.92 > 3.1.9 > 3.1.71 etc.)
    local first
    first=$(printf '%s\n%s\n' "$A" "$B" | sort -V | head -1)
    if [ "$first" = "$A" ]; then echo lt; else echo gt; fi
}

SRC_USER_VER=$(extract_version "$SRC_USER")
SRC_META_VER=$(extract_version "$SRC_META")
[ -n "$SRC_USER_VER" ] || { echo "ERROR: could not parse @version from $SRC_USER"; exit 1; }
[ -n "$SRC_META_VER" ] || { echo "ERROR: could not parse @version from $SRC_META"; exit 1; }

if [ "$SRC_USER_VER" != "$SRC_META_VER" ]; then
    echo "ERROR: source header mismatch — .user.js is v$SRC_USER_VER but .meta.js is v$SRC_META_VER."
    echo "       Tampermonkey only checks .meta.js for updates; if these disagree, users on"
    echo "       the higher version will never get future updates. Fix both before deploying."
    exit 1
fi

echo "[deploy] $NAME source version: $SRC_USER_VER"

# Refuse regression unless explicitly overridden.
if [ -f "$DST_USER" ]; then
    DST_USER_VER=$(extract_version "$DST_USER")
    if [ -n "$DST_USER_VER" ]; then
        case "$(version_cmp "$SRC_USER_VER" "$DST_USER_VER")" in
            lt)
                if [ "${FORCE_REGRESSION:-0}" = "1" ]; then
                    echo "[deploy] WARNING: source v$SRC_USER_VER < served v$DST_USER_VER — proceeding because FORCE_REGRESSION=1."
                else
                    echo "ERROR: refusing to deploy — source v$SRC_USER_VER is OLDER than served v$DST_USER_VER."
                    echo "       This is the exact regression pattern that bit OC Spawn (3.1.91 → 3.1.71)."
                    echo "       If this is intentional (rollback), re-run with: FORCE_REGRESSION=1 $0 $NAME"
                    exit 1
                fi
                ;;
            eq) echo "[deploy] No version change (source == served at v$SRC_USER_VER). Continuing." ;;
            gt) echo "[deploy] Bumping served from v$DST_USER_VER → v$SRC_USER_VER." ;;
        esac
    fi
fi

# Same check for .meta.js — Tampermonkey reads this for updates, so it
# must never lag the .user.js (otherwise installs never see the new
# version).
if [ -f "$DST_META" ]; then
    DST_META_VER=$(extract_version "$DST_META")
    if [ -n "$DST_META_VER" ] && [ "$DST_META_VER" != "$SRC_META_VER" ]; then
        case "$(version_cmp "$SRC_META_VER" "$DST_META_VER")" in
            lt)
                if [ "${FORCE_REGRESSION:-0}" = "1" ]; then
                    echo "[deploy] WARNING: source meta v$SRC_META_VER < served meta v$DST_META_VER — proceeding because FORCE_REGRESSION=1."
                else
                    echo "ERROR: refusing to deploy — source meta.js v$SRC_META_VER is OLDER than served meta.js v$DST_META_VER."
                    exit 1
                fi
                ;;
        esac
    fi
fi

# Syntax check the .user.js — no point deploying broken JS.
if ! node --check "$SRC_USER" 2>&1; then
    echo "ERROR: source $SRC_USER has syntax errors. Aborting."
    exit 1
fi

cp "$SRC_USER" "$DST_USER"
cp "$SRC_META" "$DST_META"
echo "[deploy] ✓ $NAME v$SRC_USER_VER deployed."
echo "[deploy]   $DST_USER"
echo "[deploy]   $DST_META"
