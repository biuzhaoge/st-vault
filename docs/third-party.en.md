# Third-party components

[简体中文](third-party.md) · **English**

ST-Vault's original source is licensed under Apache-2.0. Dependency and system-component licenses remain applicable separately; this repository does not relicense them.

The release build generates a license inventory from the dependencies bundled for the browser, including React's scheduler dependency and the on-demand Hls.js player. A running instance serves it at `/assets/third-party-licenses.md`. The file lives at `/app/apps/ui/dist/assets/third-party-licenses.md` inside the container. Additional upstream notices ship in `/app/licenses/`.

- Node.js and npm: upstream notices distributed with the official Node image.
- Fastify, React, Vite, Zod, Prettier, i18next and react-i18next: MIT.
- Undici (MIT) provides SOCKS5 transport. Its upstream license ships in the installed package in the runtime image.
- Timezone calculations use `@date-fns/tz` (MIT); its [upstream license](../licenses/date-fns-tz.txt) ships with the application.
- node-postgres (`pg`) and its runtime dependencies retain their upstream notices in the installed packages. PostgreSQL is embedded in the runtime and QA images and uses the PostgreSQL License. Preserve `/usr/share/doc` notices when redistributing the database image or binaries.
- Hls.js, Playwright and TypeScript: Apache-2.0.
- Chromium (QA only): installed from Debian packages; retain the distribution's component notices and comply with their respective licenses when redistributing images.
- Runtime FFmpeg uses the upstream 5.1.10 source release, native decoders and libdav1d in the local MP4/JPEG pipeline. GPL and nonfree components are disabled. The Docker `media-build` stage uses Debian compiler hardening and builds the binary with `deploy/build-ffmpeg.sh`. QA uses Debian's full FFmpeg package, which may include GPL components.

The build pins the upstream archive by SHA-256 and verifies its detached signature against the FFmpeg release key, fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`. It preserves Debian Bookworm’s range encoder patch and includes the upstream fixes for MOV cleanup and low-bit-depth raw video. `/usr/local/share/doc/ffmpeg/` contains the exact patched source, license, configuration log, three patches, and the signature and key for the original upstream archive. [Signed releases](https://ffmpeg.org/download.html#verify) · [Debian patches](https://sources.debian.org/patches/ffmpeg/7%3A5.1.9-0%2Bdeb12u1/) · [MOV fix](https://github.com/FFmpeg/FFmpeg/commit/969c7eb091989a664cb7bf66a1f02051cc46cb52) · [Raw video fix](https://github.com/FFmpeg/FFmpeg/commit/01a395b935b9da12dbeca588a7130c4db6a14689)

For an offline source build, put the verified upstream archive in a directory as `ffmpeg.tar.xz` and pass `--build-context ffmpeg-source=<directory>` to Docker Buildx. The media stage checks the release signature with either input method. The compiler and package dependencies have their own build inputs.

Third-party product names and API references identify compatibility; they do not imply affiliation or endorsement. The included application icon is inherited from the existing ST-Vault project. Contributors must verify the rights to any new asset before submitting it.

For exact versions see package-lock.json; inspect each installed package's LICENSE/NOTICE and the image's /usr/share/doc for complete terms.
