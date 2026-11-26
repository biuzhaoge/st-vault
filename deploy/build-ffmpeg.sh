#!/bin/sh
set -eu
cd /source/ffmpeg-*/
set -- /ffmpeg-debian-rangecoder.patch /ffmpeg-encryption-info.patch /ffmpeg-raw-stride.patch
sha256sum -c <<'SHA256'
5b4110a2860b1bd7b400469c177aa97339e8d5ce007729731fdf551694d298d1  /ffmpeg-debian-rangecoder.patch
594a0cbca9527bc1edab7f76679af5a73cee23aadc878e2cc6a9001e22742c45  /ffmpeg-encryption-info.patch
50d080e61d3fa4fbadcdeb153dc524f2ba6552acf80012218293383ea5d765e2  /ffmpeg-raw-stride.patch
SHA256
# Keep the build valid when upstream picks up a change. An unfamiliar source
# revision must be reviewed before we can claim the upstream backport applies.
for backport do
    if patch --dry-run --forward --batch --fuzz=0 -p1 -i "$backport" >/dev/null; then
        patch --forward --batch --fuzz=0 --no-backup-if-mismatch -p1 -i "$backport"
    else
        patch --dry-run --reverse --force --fuzz=0 -p1 -i "$backport"
    fi
done
# Capture the compiler's actual input. FFmpeg distclean can leave target-specific
# objects, and patch updates file timestamps even when the source bytes match.
tar --sort=name --mtime="@$(stat -c %Y RELEASE)" --owner=0 --group=0 --numeric-owner \
    -czf /tmp/ffmpeg-source.tar.gz -C /source "$(basename "$PWD")"
export DEB_BUILD_MAINT_OPTIONS=hardening=+bindnow DEB_CFLAGS_MAINT_STRIP=-g
cflags="$(dpkg-buildflags --get CPPFLAGS) $(dpkg-buildflags --get CFLAGS)"
ldflags=$(dpkg-buildflags --get LDFLAGS)
./configure --prefix=/out --disable-autodetect --disable-hwaccels --disable-doc --disable-debug \
  --extra-cflags="$cflags" --extra-ldflags="$ldflags" \
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-postproc \
  --disable-network --disable-encoders --enable-encoder=mjpeg,rawvideo \
  --disable-muxers --enable-muxer=image2pipe,rawvideo \
  --disable-demuxers --enable-demuxer=mov,mjpeg \
  --disable-protocols --enable-protocol=pipe \
  --disable-filters --enable-filter=trim,scale,format,null \
  --enable-libdav1d
make -j2
make install
sh /check-ffmpeg-elf.sh /out/bin/ffmpeg
# Keep the exact patched source and configuration with the redistributable
# executable. No compiler, headers or static development libraries enter runtime.
mkdir -p /out/share/doc/ffmpeg
cp COPYING.LGPLv2.1 LICENSE.md /out/share/doc/ffmpeg/
cp "$@" /out/share/doc/ffmpeg/
cp /ffmpeg-release-key.gpg /ffmpeg-5.1.10.tar.xz.asc /out/share/doc/ffmpeg/
cp ffbuild/config.log /out/share/doc/ffmpeg/config.log
mv /tmp/ffmpeg-source.tar.gz /out/share/doc/ffmpeg/source.tar.gz
make distclean
rm -rf /out/include /out/lib /out/share/ffmpeg
