#!/usr/bin/env bash
set -euo pipefail

NAME="${CHIIKAWA_NAME:?缺少 CHIIKAWA_NAME}"
PERSONA="${CHIIKAWA_PERSONA:-}"

if [ -z "$PERSONA" ]; then
  if [ "${1:-}" = "detect" ]; then exit 0; fi
  printf '未指定人格模板，无事可做\n' >&2
  exit 1
fi
[ -f "$PERSONA" ] || { printf '找不到人格模板：%s\n' "$PERSONA" >&2; exit 1; }

SRC="$(cd "$(dirname "$PERSONA")" && pwd)/$(basename "$PERSONA")"
BASENAME="$(basename "$SRC")"
LEGACY_OPEN="<!-- >>> ${NAME} 资料库 · 人格锚（install.sh 写入，撤销请跑 --uninstall） >>>"
LEGACY_CLOSE="<!-- <<< ${NAME} 资料库 · 人格锚 <<<"
MARK_OPEN="$LEGACY_OPEN -->"
MARK_CLOSE="$LEGACY_CLOSE -->"

ROOT=""; AGENTS=""; LEGACY_COPY=""
setup_for() {
  ROOT="$(cd "$1" 2>/dev/null && pwd)" || { printf '目标项目不存在：%s\n' "$1" >&2; return 1; }
  AGENTS="$ROOT/AGENTS.md"
  LEGACY_COPY=""
  if [ -f "$AGENTS" ] && [ "$SRC" != "$ROOT/.${NAME}/${BASENAME}" ] &&
    managed_block | grep -qxF "<!-- persona: .${NAME}/${BASENAME} -->"; then
    LEGACY_COPY="$ROOT/.${NAME}/${BASENAME}"
  fi
}

managed_block() {
  awk -v opened="$MARK_OPEN" -v closed="$MARK_CLOSE" -v old_opened="$LEGACY_OPEN" -v old_closed="$LEGACY_CLOSE" '
    $0 == opened || $0 == old_opened { inside = 1 }
    inside { print }
    $0 == closed || $0 == old_closed { inside = 0 }
  ' "$AGENTS"
}

remove_legacy_copy() {
  if [ -n "$LEGACY_COPY" ]; then
    if [ -f "$LEGACY_COPY" ]; then
      rm -f "$LEGACY_COPY"
      printf '  已删除旧人格副本：%s\n' "$LEGACY_COPY"
    fi
    rmdir "$(dirname "$LEGACY_COPY")" 2>/dev/null || true
  fi
}

strip_block() {
  local target="$1" temporary
  temporary="$(mktemp)"
  awk -v opened="$MARK_OPEN" -v closed="$MARK_CLOSE" -v old_opened="$LEGACY_OPEN" -v old_closed="$LEGACY_CLOSE" '
    $0 == opened || $0 == old_opened { pending_blank = 0; skip = 1; next }
    skip { if ($0 == closed || $0 == old_closed) skip = 0; next }
    /^$/ { if (pending_blank) print ""; pending_blank = 1; next }
    {
      if (pending_blank) { print ""; pending_blank = 0 }
      print
    }
    END { if (pending_blank) print "" }
  ' "$target" > "$temporary"

  if [ -n "$(tr -d '[:space:]' < "$temporary")" ]; then
    cat "$temporary" > "$target"
    rm -f "$temporary"
  else
    rm -f "$temporary" "$target"
    printf '  剥离后文件为空，已连同该文件一并删除\n'
  fi
}

block() {
  printf '%s\n' "$MARK_OPEN"
  cat "$SRC"
  if [ -s "$SRC" ] && [ "$(tail -c1 "$SRC" | wc -l | tr -d ' ')" = "0" ]; then
    printf '\n'
  fi
  printf '%s\n' "$MARK_CLOSE"
}

case "${1:-}" in
  detect)
    target="${CHIIKAWA_TARGET_PROJECT:-}"
    [ -n "$target" ] || exit 0
    [ -d "$target" ] || exit 0
    ( cd "$target" && pwd )
    ;;

  installed)
    setup_for "${2:?}" || exit 1
    [ -f "$AGENTS" ] || exit 1
    cmp -s <(managed_block) <(block)
    ;;

  plan)
    setup_for "${2:?}" || exit 1
    printf '把人格正文直接注入目标项目：%s\n' "$ROOT"
    printf '    · 人格模板：%s\n' "$SRC"
    if [ -f "$AGENTS" ]; then
      if grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS"; then
        printf '    ~ AGENTS.md（替换本资料库的旧段）\n'
      else
        printf '    ~ AGENTS.md（追加正文，保留已有内容）\n'
      fi
    else
      printf '    + AGENTS.md（新建）\n'
    fi
    if [ -n "$LEGACY_COPY" ] && [ -f "$LEGACY_COPY" ]; then
      printf '    - %s（删除旧副本，并清理变空的目录）\n' "${LEGACY_COPY#$ROOT/}"
    fi
    block
    printf '\n%s\n' '（撤销时摘掉这一整段；若文件因此变空则一并删除。）'
    ;;

  apply)
    setup_for "${2:?}" || exit 1
    if [ -f "$AGENTS" ] && grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS"; then
      strip_block "$AGENTS"
    fi
    if [ -s "$AGENTS" ] && [ "$(tail -c1 "$AGENTS" | wc -l | tr -d ' ')" = "0" ]; then
      printf '\n' >> "$AGENTS"
    fi
    printf '\n' >> "$AGENTS"
    block >> "$AGENTS"
    remove_legacy_copy
    ;;

  remove)
    setup_for "${2:?}" || exit 1
    [ -f "$AGENTS" ] || exit 1
    grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS" || exit 1
    strip_block "$AGENTS"
    remove_legacy_copy
    ;;

  *)
    printf '用法：%s {detect|installed|plan|apply|remove} [项目根]\n' "$0" >&2
    exit 2
    ;;
esac
