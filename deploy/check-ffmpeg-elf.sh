#!/bin/sh
set -eu
export LC_ALL=C
binary=${1:?FFmpeg binary required}
program=$(readelf --program-headers --wide "$binary")
dynamic=$(readelf --dynamic --wide "$binary")
symbols=$(readelf --dyn-syms --wide "$binary")

require() {
    if ! printf '%s\n' "$1" | grep -Eq "$2"; then
        printf 'Missing FFmpeg ELF protection: %s\n' "$3" >&2
        return 1
    fi
}

require "$program" 'GNU_RELRO' 'read-only relocations'
require "$dynamic" 'BIND_NOW|Flags:.*NOW' 'immediate binding (full RELRO)'
require "$symbols" 'UND +__stack_chk_fail@' 'stack protection'
require "$symbols" 'UND +__[[:alnum:]_]+_chk@' 'fortified libc calls'
